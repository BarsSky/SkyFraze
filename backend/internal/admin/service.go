// Package admin — администрирование развёртывания.
//
// Задача узкая и намеренно маленькая: владелец инсталляции решает, кого пускать
// (режим регистрации) и рассматривает заявки. Никакого «суперпользователя,
// который видит все проекты» здесь нет: админ не получает доступа к чужим
// историям — только к настройке входа и списку заявок.
package admin

import (
	"context"
	"errors"
	"strings"

	"github.com/google/uuid"

	"github.com/skyfraze/backend/internal/auth"
	"github.com/skyfraze/backend/internal/store"
)

var (
	ErrForbidden   = errors.New("admin rights required")
	ErrNotFound    = errors.New("not found")
	ErrBadMode     = errors.New("unknown registration mode")
	ErrEmailTaken  = errors.New("email already registered")
	ErrBadDecision = errors.New("unknown decision")
)

type Service struct {
	store *store.Store
	auth  *auth.Service
}

func New(s *store.Store, a *auth.Service) *Service {
	return &Service{store: s, auth: a}
}

// Settings — то, что админ читает и меняет.
type Settings struct {
	RegistrationMode string `json:"registration_mode"`
	Admins           int    `json:"admins"`
	Users            int    `json:"users"`
	PendingRequests  int    `json:"pending_requests"`
}

// RequireAdmin — проверка прав по контексту запроса.
func (s *Service) RequireAdmin(ctx context.Context, userID uuid.UUID) (*store.User, error) {
	u, err := s.store.GetUserByID(ctx, userID)
	if err != nil {
		return nil, ErrForbidden
	}
	// Развёртывание могло назначить админа уже после его регистрации.
	s.auth.GrantConfiguredAdmin(ctx, u)
	if !u.IsAdmin {
		return nil, ErrForbidden
	}
	return u, nil
}

func (s *Service) Settings(ctx context.Context) (*Settings, error) {
	users, err := s.store.ListUsers(ctx)
	if err != nil {
		return nil, err
	}
	pending, err := s.store.ListRegistrationRequests(ctx, "pending")
	if err != nil {
		return nil, err
	}
	admins := 0
	for _, u := range users {
		if u.IsAdmin {
			admins++
		}
	}
	return &Settings{
		RegistrationMode: s.auth.RegistrationMode(ctx),
		Admins:           admins,
		Users:            len(users),
		PendingRequests:  len(pending),
	}, nil
}

// SetRegistrationMode переключает режим: 'request' (по заявке) | 'open' (свободная).
func (s *Service) SetRegistrationMode(ctx context.Context, by uuid.UUID, mode string) (*Settings, error) {
	mode = strings.ToLower(strings.TrimSpace(mode))
	if mode != store.RegistrationModeOpen && mode != store.RegistrationModeRequest {
		return nil, ErrBadMode
	}
	if err := s.store.SetSetting(ctx, store.SettingRegistrationMode, mode, by); err != nil {
		return nil, err
	}
	return s.Settings(ctx)
}

// Requests — список заявок (status = pending/approved/rejected, пусто — все).
func (s *Service) Requests(ctx context.Context, status string) ([]store.RegistrationRequest, error) {
	status = strings.ToLower(strings.TrimSpace(status))
	switch status {
	case "", "pending", "approved", "rejected":
	default:
		return nil, ErrBadDecision
	}
	return s.store.ListRegistrationRequests(ctx, status)
}

// Approve создаёт аккаунт из заявки. Пароль берётся из заявки (там уже хэш),
// поэтому одобренный пользователь входит тем паролем, который указал при подаче.
func (s *Service) Approve(ctx context.Context, by, requestID uuid.UUID) (*store.User, error) {
	req, err := s.request(ctx, requestID)
	if err != nil {
		return nil, err
	}
	// Уже рассмотренная заявка — это «не найдено» для действия, а не «email занят»:
	// иначе повторный клик по «Одобрить» выглядел бы как конфликт данных.
	if req.Status != "pending" {
		return nil, ErrNotFound
	}
	if _, err := s.store.GetUserByEmail(ctx, req.Email); err == nil {
		return nil, ErrEmailTaken
	}
	u, err := s.store.ApproveRegistrationRequest(ctx, requestID, by, false)
	if err != nil {
		if errors.Is(err, store.ErrNotFound) {
			return nil, ErrNotFound
		}
		return nil, err
	}
	s.auth.GrantConfiguredAdmin(ctx, u)
	return u, nil
}

// Reject отклоняет заявку. Аккаунт не создаётся; при попытке входа человек
// получит понятное «заявка отклонена».
func (s *Service) Reject(ctx context.Context, by, requestID uuid.UUID, note string) error {
	if _, err := s.request(ctx, requestID); err != nil {
		return err
	}
	if err := s.store.DecideRegistrationRequest(ctx, requestID, "rejected", strings.TrimSpace(note), by); err != nil {
		if errors.Is(err, store.ErrNotFound) {
			// Заявку рассмотрели параллельно — это не ошибка клиента, но и не успех.
			return ErrNotFound
		}
		return err
	}
	return nil
}

func (s *Service) request(ctx context.Context, id uuid.UUID) (*store.RegistrationRequest, error) {
	req, err := s.store.GetRegistrationRequestByID(ctx, id)
	if err != nil {
		if errors.Is(err, store.ErrNotFound) {
			return nil, ErrNotFound
		}
		return nil, err
	}
	return req, nil
}
