package auth

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/skyfraze/backend/internal/store"
)

// Errors
var (
	ErrEmailTaken       = errors.New("email already registered")
	ErrInvalidCreds     = errors.New("invalid credentials")
	ErrSessionRevoked   = errors.New("session revoked")
	ErrSessionExpired   = errors.New("session expired")
	ErrInvalidRefresh   = errors.New("invalid refresh token")
)

// Service — фасад auth-операций.
type Service struct {
	store  *store.Store
	secret string
}

func New(s *store.Store, secret string) *Service {
	return &Service{store: s, secret: secret}
}

// Tokens — пара токенов после успешного login/refresh.
type Tokens struct {
	Access      string
	Refresh     string
	AccessExp   time.Time
	RefreshExp  time.Time
}

func (s *Service) Register(ctx context.Context, email, password, displayName string) (*store.User, *Tokens, error) {
	email = strings.TrimSpace(strings.ToLower(email))
	displayName = strings.TrimSpace(displayName)

	// Проверим, что email не занят — для скорости (без race-condition уникального индекса)
	if _, err := s.store.GetUserByEmail(ctx, email); err == nil {
		return nil, nil, ErrEmailTaken
	} else if !errors.Is(err, store.ErrNotFound) && !errors.Is(err, pgx.ErrNoRows) {
		return nil, nil, fmt.Errorf("check email: %w", err)
	}

	hash, err := HashPassword(password)
	if err != nil {
		return nil, nil, err
	}

	u, err := s.store.CreateUser(ctx, email, hash, displayName)
	if err != nil {
		return nil, nil, fmt.Errorf("create user: %w", err)
	}

	tok, err := s.issueTokens(ctx, u.ID, "")
	if err != nil {
		return nil, nil, err
	}
	return u, tok, nil
}

func (s *Service) Login(ctx context.Context, email, password string) (*store.User, *Tokens, error) {
	email = strings.TrimSpace(strings.ToLower(email))
	u, err := s.store.GetUserByEmail(ctx, email)
	if err != nil {
		return nil, nil, ErrInvalidCreds
	}
	if err := VerifyPassword(u.PasswordHash, password); err != nil {
		return nil, nil, ErrInvalidCreds
	}
	tok, err := s.issueTokens(ctx, u.ID, "")
	if err != nil {
		return nil, nil, err
	}
	return u, tok, nil
}

// Refresh — обменивает refresh на новую пару, отзывая старую сессию.
func (s *Service) Refresh(ctx context.Context, raw string) (*Tokens, error) {
	userID, jti, err := ParseRefresh(s.secret, raw)
	if err != nil {
		return nil, ErrInvalidRefresh
	}

	hash := sha256Hex(raw)
	sess, err := s.store.GetSessionByRefreshHash(ctx, hash)
	if err != nil {
		return nil, ErrInvalidRefresh
	}
	if sess.RevokedAt != nil {
		return nil, ErrSessionRevoked
	}
	if time.Now().After(sess.ExpiresAt) {
		return nil, ErrSessionExpired
	}
	if sess.UserID != userID {
		return nil, ErrInvalidRefresh
	}
	if sess.RefreshTokenHash != hash {
		return nil, ErrInvalidRefresh
	}
	if jti == "" {
		// legacy — без JTI; принимаем по хэшу
	}
	// отзываем старую сессию
	if err := s.store.RevokeSession(ctx, sess.ID); err != nil {
		return nil, fmt.Errorf("revoke session: %w", err)
	}
	return s.issueTokens(ctx, userID, "")
}

// issueTokens — выпускает пару токенов и сохраняет сессию.
func (s *Service) issueTokens(ctx context.Context, userID uuid.UUID, _ string) (*Tokens, error) {
	access, err := IssueAccess(s.secret, userID)
	if err != nil {
		return nil, err
	}
	refresh, _, err := IssueRefresh(s.secret, userID)
	if err != nil {
		return nil, err
	}
	hash := sha256Hex(refresh)
	sess := &store.Session{
		UserID:           userID,
		RefreshTokenHash: hash,
		UserAgent:        "",
		IP:               "",
		ExpiresAt:        time.Now().Add(refreshTokenTTL),
	}
	if err := s.store.CreateSession(ctx, sess); err != nil {
		return nil, fmt.Errorf("create session: %w", err)
	}

	return &Tokens{
		Access:     access,
		Refresh:    refresh,
		AccessExp:  time.Now().Add(accessTokenTTL),
		RefreshExp: time.Now().Add(refreshTokenTTL),
	}, nil
}

func sha256Hex(s string) string {
	h := sha256.Sum256([]byte(s))
	return hex.EncodeToString(h[:])
}
