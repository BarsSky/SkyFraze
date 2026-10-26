package projects

import (
	"context"
	"errors"
	"time"

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
	DeleteUnreferencedFiles(ctx context.Context, keys []string) (int, error)
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

// AssetBytesByProject — вес вложений по проектам: список показывает его у каждой
// карточки. Считается одним запросом (см. store.ProjectAssetBytes).
func (s *Service) AssetBytesByProject(ctx context.Context) (map[uuid.UUID]int64, error) {
	return s.store.ProjectAssetBytes(ctx)
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

// TrashRetention — сколько проект лежит в корзине до окончательного удаления.
//
// Тридцать дней — тот же срок, что у «Вернуть» для правок агента: месяц — граница, после
// которой отмена превращается в откат проекта. Корзина не должна становиться архивом.
const TrashRetention = 30 * 24 * time.Hour

// Delete — только owner: проект уезжает в КОРЗИНУ (миграция 0022).
//
// До 0.54.0 удаление было жёстким: строка проекта и всё, что на неё ссылается (события,
// вложения, история версий), исчезали сразу, и «случайно удалил не тот проект» лечилось
// только ночной копией. Теперь проект помечается удалённым: он пропадает из списка, из API и
// из публичной ленты, но 30 дней его можно вернуть одной кнопкой — с текстом, вложениями и
// историей. Файлы не удаляются: возврат должен быть полным, а не «почти».
func (s *Service) Delete(ctx context.Context, userID, projectID uuid.UUID) error {
	m, err := s.requireMember(ctx, userID, projectID, store.RoleOwner)
	if err != nil {
		// Повторное удаление: проекта для обычных проверок уже нет, и человек, нажавший
		// «удалить» дважды (или обновивший страницу с открытым диалогом), должен получить
		// успех, а не «forbidden» на то, что уже сделано. Чужой проект в корзине при этом
		// остаётся чужим.
		if errors.Is(err, ErrForbidden) {
			if p, derr := s.store.DeletedProject(ctx, projectID); derr == nil && p.OwnerID == userID {
				return s.store.SoftDeleteProject(ctx, projectID)
			}
		}
		return err
	}
	if m.Role != store.RoleOwner {
		return ErrForbidden
	}
	return s.store.SoftDeleteProject(ctx, projectID)
}

// GetForExport — проект для выгрузки: активный (роль viewer и выше) или СВОЙ проект в
// корзине.
//
// Почему корзина здесь исключение. «Удалить можно, а посмотреть перед возвратом — нельзя»
// звучит как шутка: человек, удаливший проект по ошибке, должен иметь возможность выгрузить
// его архивом, не возвращая в список. Право то же, что на возврат, — только владелец: у
// команды доступ закрыт вместе с проектом, и выгрузка не должна быть лазейкой.
//
// Отличие от Get намеренное: остальные чтения корзину не видят (иначе удалённый проект
// открывался бы по прямой ссылке), а выгрузка — это ровно «взять своё перед удалением».
func (s *Service) GetForExport(ctx context.Context, userID, projectID uuid.UUID) (*store.Project, error) {
	p, err := s.Get(ctx, userID, projectID)
	if err == nil {
		return p, nil
	}
	if !errors.Is(err, ErrForbidden) {
		return nil, err
	}
	if trashed, derr := s.store.DeletedProject(ctx, projectID); derr == nil && trashed.OwnerID == userID {
		return trashed, nil
	}
	return nil, ErrForbidden
}

// Trash — корзина владельца: что удалено и сколько осталось до окончательного удаления.
func (s *Service) Trash(ctx context.Context, userID uuid.UUID) ([]store.Project, error) {
	return s.store.DeletedProjects(ctx, userID)
}

// Restore — вернуть проект из корзины (только владелец).
//
// Права проверяются по записи корзины, а не по обычному requireMember: удалённый проект для
// обычных проверок «не существует», иначе он был бы доступен команде, пока лежит в корзине.
func (s *Service) Restore(ctx context.Context, userID, projectID uuid.UUID) error {
	p, err := s.store.DeletedProject(ctx, projectID)
	if err != nil {
		if errors.Is(err, store.ErrNotFound) {
			return ErrNotFound
		}
		return err
	}
	if p.OwnerID != userID {
		return ErrForbidden
	}
	return s.store.RestoreProject(ctx, projectID)
}

// Purge — удалить из корзины окончательно (только владелец и только из корзины).
//
// Это необратимо и осознанно: файлы удаляются вместе с проектом, история версий — тоже.
// Отдельный метод, а не «удалить дважды», чтобы окончательное удаление нельзя было нажать
// по ошибке той же кнопкой.
func (s *Service) Purge(ctx context.Context, userID, projectID uuid.UUID) error {
	p, err := s.store.DeletedProject(ctx, projectID)
	if err != nil {
		if errors.Is(err, store.ErrNotFound) {
			return ErrNotFound
		}
		return err
	}
	if p.OwnerID != userID {
		return ErrForbidden
	}
	files, err := s.store.PurgeProject(ctx, projectID)
	if err != nil {
		return err
	}
	// Файлы — после строки: если уборка не удалась, строки уже нет, а потерянные объекты
	// подберёт уборщик хранилища. Файл, которым пользуется другой проект (дедупликация),
	// остаётся: это решает DeleteUnreferencedFiles по числу оставшихся ссылок.
	if s.files != nil && len(files) > 0 {
		_, _ = s.files.DeleteUnreferencedFiles(ctx, files)
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
