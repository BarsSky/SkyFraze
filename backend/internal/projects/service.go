package projects

import (
	"context"
	"errors"

	"github.com/google/uuid"

	"github.com/skyfraze/backend/internal/auth"
	"github.com/skyfraze/backend/internal/store"
)

// Errors
var (
	ErrNotFound  = errors.New("project not found")
	ErrForbidden = errors.New("forbidden")
)

// Files — тот, кто умеет убрать файлы проекта за его удалением (реализует
// assets.Service).
//
// Интерфейс объявлен здесь, а реализация живёт в пакете вложений: проекты не
// должны знать про хранилище, им достаточно «скажи, что лежит» и «убери это».
// Два шага, а не один, потому что строки вложений уходят каскадом вместе с
// проектом: ключи нужно собрать ДО удаления строки.
type Files interface {
	ProjectFileKeys(ctx context.Context, projectID uuid.UUID) ([]string, error)
	DeleteFiles(ctx context.Context, keys []string) (int, error)
}

// UseFiles подключает удаление файлов при удалении проекта.
//
// Без него удаляется только строка проекта, а файлы остаются в хранилище навсегда
// (уборщик осиротевших их потом найдёт, но лучше не оставлять). Ошибку уборки
// глотаем: проект уже удалён, а файлы подберёт уборщик — валить запрос из-за них
// значило бы показать «не удалилось» там, где удалилось.
func (s *Service) UseFiles(files Files) { s.files = files }

type Service struct {
	store *store.Store
	files Files
}

func New(s *store.Store) *Service {
	return &Service{store: s}
}

// Create — пользователь становится владельцем, добавляется в team_memberships как owner.
func (s *Service) Create(ctx context.Context, userID uuid.UUID, title, desc string) (*store.Project, error) {
	p, err := s.store.CreateProject(ctx, userID, title, desc)
	if err != nil {
		return nil, err
	}
	if err := s.store.AddMembership(ctx, p.ID, userID, store.RoleOwner); err != nil {
		return nil, err
	}
	return p, nil
}

// Get — возвращает проект, проверяя membership.
func (s *Service) Get(ctx context.Context, userID, projectID uuid.UUID) (*store.Project, error) {
	if _, err := s.requireMember(ctx, userID, projectID, store.RoleViewer); err != nil {
		return nil, err
	}
	p, err := s.store.GetProject(ctx, projectID)
	if err != nil {
		if errors.Is(err, store.ErrNotFound) {
			return nil, ErrNotFound
		}
		return nil, err
	}
	return p, nil
}

func (s *Service) List(ctx context.Context, userID uuid.UUID) ([]store.Project, error) {
	return s.store.ListProjectsForUser(ctx, userID)
}

// ListSharedByCoauthors — закрытые проекты соавторов, открытые мне на чтение.
// Это не участие в проекте: роль здесь всегда viewer, правок нет.
func (s *Service) ListSharedByCoauthors(ctx context.Context, userID uuid.UUID) ([]store.Project, error) {
	return s.store.ListProjectsSharedByCoauthors(ctx, userID)
}

// Access описывает, как пользователь получил доступ к проекту: как участник
// команды или как соавтор, которому владелец открыл закрытый проект на чтение.
type Access struct {
	Role     store.Role
	Coauthor bool
}

// AccessOf — роль пользователя в проекте или ErrForbidden.
func (s *Service) AccessOf(ctx context.Context, userID, projectID uuid.UUID) (Access, error) {
	m, err := s.requireMember(ctx, userID, projectID, store.RoleViewer)
	if err != nil {
		return Access{}, err
	}
	return accessOf(m), nil
}

// accessOf: роль viewer, полученную НЕ через team_memberships, помечаем как
// соавторскую — интерфейс по этому признаку показывает «только чтение».
func accessOf(m *store.MembershipLite) Access {
	return Access{Role: m.Role, Coauthor: m.Coauthor}
}

// RequireViewer — чтение проекта: любая роль (owner/editor/viewer).
func (s *Service) RequireViewer(ctx context.Context, userID, projectID uuid.UUID) error {
	_, err := s.requireMember(ctx, userID, projectID, store.RoleViewer)
	return err
}

// RequireEditor — запись в проект: owner/editor. Viewer получает ErrForbidden.
// Используется там, где нет собственного «роль-зависимого» метода (например,
// запись CRDT-снапшота или CRUD событий).
func (s *Service) RequireEditor(ctx context.Context, userID, projectID uuid.UUID) error {
	_, err := s.requireMember(ctx, userID, projectID, store.RoleEditor)
	return err
}

// Role возвращает роль пользователя в проекте (для аудита/ответов API).
func (s *Service) Role(ctx context.Context, userID, projectID uuid.UUID) (store.Role, error) {
	m, err := s.requireMember(ctx, userID, projectID, store.RoleViewer)
	if err != nil {
		return "", err
	}
	return m.Role, nil
}

// Update — только owner/editor.
func (s *Service) Update(ctx context.Context, userID, projectID uuid.UUID, title, desc string) error {
	m, err := s.requireMember(ctx, userID, projectID, store.RoleEditor)
	if err != nil {
		return err
	}
	if m.Role != store.RoleOwner && m.Role != store.RoleEditor {
		return ErrForbidden
	}
	return s.store.UpdateProject(ctx, projectID, title, desc)
}

// Delete — только owner.
func (s *Service) Delete(ctx context.Context, userID, projectID uuid.UUID) error {
	m, err := s.requireMember(ctx, userID, projectID, store.RoleOwner)
	if err != nil {
		return err
	}
	if m.Role != store.RoleOwner {
		return ErrForbidden
	}
	// Ключи файлов собираем ДО удаления: строки вложений уходят каскадом вместе с
	// проектом, и после удаления о файлах уже нечего спросить.
	var files []string
	if s.files != nil {
		files, _ = s.files.ProjectFileKeys(ctx, projectID)
	}
	if err := s.store.DeleteProject(ctx, projectID); err != nil {
		return err
	}
	// Файлы — после строки: если уборка не удалась, проект всё равно удалён, а
	// потерянные объекты найдёт уборщик хранилища (maintenance.Sweeper).
	if len(files) > 0 {
		_, _ = s.files.DeleteFiles(ctx, files)
	}
	return nil
}

// requireMember — обёртка: получает membership, проверяет минимальную роль.
//
// Если участия нет, читать проект всё равно может соавтор, которому владелец
// открыл свои закрытые проекты (переключатель «видит мои закрытые проекты»).
// Соавтор получает РОВНО роль viewer: RequireEditor сравнивает ранги, поэтому
// правки для него закрыты по построению.
func (s *Service) requireMember(ctx context.Context, userID, projectID uuid.UUID, minRole store.Role) (*store.MembershipLite, error) {
	m, err := s.store.GetMembership(ctx, projectID, userID)
	if err != nil {
		if errors.Is(err, store.ErrNotFound) {
			// owner проекта — всегда член команды
			p, perr := s.store.GetProject(ctx, projectID)
			if perr == nil && p.OwnerID == userID {
				return &store.MembershipLite{ProjectID: projectID, UserID: userID, Role: store.RoleOwner}, nil
			}
			if perr == nil && minRole == store.RoleViewer && p.OwnerID != userID {
				allowed, aerr := s.store.CoauthorCanRead(ctx, p.OwnerID, userID)
				if aerr != nil {
					return nil, aerr
				}
				if allowed {
					return &store.MembershipLite{
						ProjectID: projectID, UserID: userID,
						Role: store.RoleViewer, Coauthor: true,
					}, nil
				}
			}
			return nil, ErrForbidden
		}
		return nil, err
	}
	if !roleAtLeast(m.Role, minRole) {
		return nil, ErrForbidden
	}
	return m, nil
}

// roleAtLeast — возвращает true если r >= minRole в иерархии owner > editor > viewer.
func roleAtLeast(r, min store.Role) bool {
	rank := func(role store.Role) int {
		switch role {
		case store.RoleOwner:
			return 3
		case store.RoleEditor:
			return 2
		case store.RoleViewer:
			return 1
		}
		return 0
	}
	return rank(r) >= rank(min)
}

// ensure auth import used
var _ = auth.UserIDFromCtx
