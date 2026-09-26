package teams

import (
	"context"
	"crypto/rand"
	"encoding/base64"
	"errors"
	"fmt"
	"time"

	"github.com/google/uuid"

	"github.com/skyfraze/backend/internal/projects"
	"github.com/skyfraze/backend/internal/store"
)

// Errors
var (
	ErrForbidden       = errors.New("forbidden")
	ErrInvitationUsed  = errors.New("invitation already accepted")
	ErrInvitationGone  = errors.New("invitation expired or not found")
	ErrSelfInviteOnly  = errors.New("cannot invite yourself")
)

type Service struct {
	store  *store.Store
	proj   *projects.Service
	inviteTTL time.Duration
}

func New(s *store.Store, proj *projects.Service) *Service {
	return &Service{store: s, proj: proj, inviteTTL: 7 * 24 * time.Hour}
}

// Invite — owner приглашает email в редакторы/viewer'ы проекта.
func (s *Service) Invite(ctx context.Context, actorID, projectID uuid.UUID, email string, role store.Role) (*store.Invitation, error) {
	// Только owner
	p, err := s.store.GetProject(ctx, projectID)
	if err != nil {
		return nil, err
	}
	if p.OwnerID != actorID {
		// проверим, может actor — owner через membership
		m, mErr := s.store.GetMembership(ctx, projectID, actorID)
		if mErr != nil || m.Role != store.RoleOwner {
			return nil, ErrForbidden
		}
	}
	if role != store.RoleEditor && role != store.RoleViewer {
		return nil, fmt.Errorf("invalid role: %q", role)
	}
	// запретим приглашение owner'а проекта самого себя
	if u, uerr := s.store.GetUserByEmail(ctx, email); uerr == nil && u.ID == p.OwnerID {
		return nil, ErrSelfInviteOnly
	}

	tok := newToken()
	inv := &store.Invitation{
		ProjectID: projectID,
		Email:     email,
		Role:      role,
		Token:     tok,
		InvitedBy: actorID,
		ExpiresAt: time.Now().Add(s.inviteTTL),
	}
	if err := s.store.CreateInvitation(ctx, inv); err != nil {
		return nil, fmt.Errorf("create invitation: %w", err)
	}
	return inv, nil
}

// Accept — пользователь (по userID) принимает приглашение по токену.
func (s *Service) Accept(ctx context.Context, userID uuid.UUID, token string) (*store.TeamMember, error) {
	inv, err := s.store.GetInvitationByToken(ctx, token)
	if err != nil {
		return nil, ErrInvitationGone
	}
	if inv.AcceptedAt != nil {
		return nil, ErrInvitationUsed
	}
	if time.Now().After(inv.ExpiresAt) {
		return nil, ErrInvitationGone
	}
	// email должен совпадать с email приглашённого, ИЛИ (если адресовал владельцу) — пропустим.
	u, err := s.store.GetUserByID(ctx, userID)
	if err != nil {
		return nil, err
	}
	if u.Email != inv.Email {
		// допустимо если это owner проекта
		p, _ := s.store.GetProject(ctx, inv.ProjectID)
		if p == nil || p.OwnerID != userID {
			return nil, ErrForbidden
		}
	}
	if err := s.store.AddMembership(ctx, inv.ProjectID, userID, inv.Role); err != nil {
		return nil, fmt.Errorf("add membership: %w", err)
	}
	if err := s.store.MarkInvitationAccepted(ctx, inv.ID); err != nil {
		return nil, fmt.Errorf("mark accepted: %w", err)
	}
	m, err := s.store.GetMembership(ctx, inv.ProjectID, userID)
	if err != nil {
		return nil, err
	}
	return m, nil
}

func (s *Service) ListMembers(ctx context.Context, actorID, projectID uuid.UUID) ([]store.TeamMember, error) {
	_, err := s.proj.Get(ctx, actorID, projectID) // проверка member
	if err != nil {
		return nil, err
	}
	return s.store.ListMembers(ctx, projectID)
}

func (s *Service) Remove(ctx context.Context, actorID, projectID, targetID uuid.UUID) error {
	// Только owner может удалять. Owner не может удалить себя.
	p, err := s.store.GetProject(ctx, projectID)
	if err != nil {
		return err
	}
	if p.OwnerID != actorID {
		return ErrForbidden
	}
	if p.OwnerID == targetID {
		return fmt.Errorf("cannot remove project owner")
	}
	return s.store.RemoveMembership(ctx, projectID, targetID)
}

func (s *Service) ChangeRole(ctx context.Context, actorID, projectID, targetID uuid.UUID, role store.Role) error {
	if role != store.RoleEditor && role != store.RoleViewer {
		return fmt.Errorf("invalid role: %q", role)
	}
	p, err := s.store.GetProject(ctx, projectID)
	if err != nil {
		return err
	}
	if p.OwnerID != actorID {
		return ErrForbidden
	}
	return s.store.AddMembership(ctx, projectID, targetID, role) // upsert
}

func (s *Service) ListInvitations(ctx context.Context, actorID, projectID uuid.UUID) ([]store.Invitation, error) {
	if _, err := s.proj.Get(ctx, actorID, projectID); err != nil {
		return nil, err
	}
	return s.store.ListPendingInvitations(ctx, projectID)
}

// newToken — криптостойкий URL-safe токен.
func newToken() string {
	var b [24]byte
	_, _ = rand.Read(b[:])
	return base64.RawURLEncoding.EncodeToString(b[:])
}
