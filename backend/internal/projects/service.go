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

type Service struct {
	store *store.Store
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
	return s.store.DeleteProject(ctx, projectID)
}

// requireMember — обёртка: получает membership, проверяет минимальную роль.
func (s *Service) requireMember(ctx context.Context, userID, projectID uuid.UUID, minRole store.Role) (*store.MembershipLite, error) {
	m, err := s.store.GetMembership(ctx, projectID, userID)
	if err != nil {
		if errors.Is(err, store.ErrNotFound) {
			// owner проекта — всегда член команды
			p, perr := s.store.GetProject(ctx, projectID)
			if perr == nil && p.OwnerID == userID {
				return &store.MembershipLite{ProjectID: projectID, UserID: userID, Role: store.RoleOwner}, nil
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
