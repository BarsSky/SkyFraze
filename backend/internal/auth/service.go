package auth

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/skyfraze/backend/internal/store"
)

// Errors
var (
	ErrEmailTaken     = errors.New("email already registered")
	ErrInvalidCreds   = errors.New("invalid credentials")
	ErrSessionRevoked = errors.New("session revoked")
	ErrSessionExpired = errors.New("session expired")
	ErrInvalidRefresh = errors.New("invalid refresh token")
	// ErrRegistrationClosed — регистрация только по заявке: прямой /register
	// запрещён, но заявку принять можно (POST /api/auth/registration-requests).
	ErrRegistrationClosed = errors.New("registration is by request only")
	// ErrRequestPending — заявка есть и ещё не рассмотрена.
	ErrRequestPending = errors.New("registration request is pending")
	// ErrRequestRejected — заявку отклонили.
	ErrRequestRejected = errors.New("registration request was rejected")
	// ErrInvalidUsername — ник не подходит: короткий, длинный или с недопустимыми
	// символами (латиница, цифры, точка, дефис, подчёркивание).
	ErrInvalidUsername = errors.New("invalid username")
	// ErrInvalidProfile — «о себе» или специализации не помещаются в пределы:
	// 600 рун на резюме, 12 специализаций по 60 рун.
	ErrInvalidProfile = errors.New("invalid profile")
)

// maxBioRunes — предел «о себе»: это абзац для карточки каталога, а не глава.
const maxBioRunes = 600

// ProfileUpdate — всё, что можно поменять в профиле. nil-поле означает «не
// прислали»: интерфейс отправляет только изменённое, и одно сохранение имени не
// должно стирать «о себе», специализации или галочку «показывать меня».
type ProfileUpdate struct {
	DisplayName  string
	Username     string
	Bio          *string
	Crafts       *[]string
	Discoverable *bool
}

// UpdateProfile меняет профиль: имя, ник (@username), «о себе», специализации и
// видимость в каталоге людей.
//
// Пустые имя и ник означают «не трогать» (как и раньше): ник подставляется
// текущий, а непустой проверяется на допустимость. Пределы bio/crafts проверяются
// здесь, а не в HTTP-слое: профиль правят и другие входы (например, одобрение
// заявки), и правило должно быть одно.
func (s *Service) UpdateProfile(ctx context.Context, userID uuid.UUID, upd ProfileUpdate) (*store.User, error) {
	u, err := s.store.GetUserByID(ctx, userID)
	if err != nil {
		return nil, err
	}

	name := strings.TrimSpace(upd.DisplayName)
	if name == "" {
		name = u.DisplayName
	}
	if len([]rune(name)) > 80 {
		return nil, ErrInvalidUsername
	}

	nick := store.NormalizeUsername(upd.Username)
	if strings.TrimSpace(upd.Username) == "" {
		nick = u.Username
	} else if !store.ValidUsername(upd.Username) {
		return nil, ErrInvalidUsername
	}

	change := store.ProfileUpdate{DisplayName: name, Username: nick}

	if upd.Bio != nil {
		bio := strings.TrimSpace(*upd.Bio)
		if utf8.RuneCountInString(bio) > maxBioRunes {
			return nil, ErrInvalidProfile
		}
		change.Bio = &bio
	}
	if upd.Crafts != nil {
		// Тот же предел и та же чистка (пустые, дубли без учёта регистра), что у
		// специализаций соавторов: специализация — одно понятие для обоих входов.
		crafts, err := store.CleanCrafts(*upd.Crafts)
		if err != nil {
			return nil, ErrInvalidProfile
		}
		change.Crafts = &crafts
	}
	change.Discoverable = upd.Discoverable

	return s.store.UpdateProfile(ctx, userID, change)
}

// Service — фасад auth-операций.
type Service struct {
	store       *store.Store
	secret      string
	adminEmails map[string]bool
}

func New(s *store.Store, secret string) *Service {
	return &Service{store: s, secret: secret, adminEmails: map[string]bool{}}
}

// SetAdminEmails — администраторы, назначенные развёртыванием (env ADMIN_EMAILS).
// Права выдаются и при старте (SyncConfiguredAdmins), и в момент входа/регистрации:
// админ может появиться уже после развёртывания.
func (s *Service) SetAdminEmails(emails []string) {
	m := map[string]bool{}
	for _, e := range emails {
		e = strings.ToLower(strings.TrimSpace(e))
		if e != "" {
			m[e] = true
		}
	}
	s.adminEmails = m
}

// AdminEmails — настроенный список (для логов/диагностики).
func (s *Service) AdminEmails() []string {
	out := make([]string, 0, len(s.adminEmails))
	for e := range s.adminEmails {
		out = append(out, e)
	}
	return out
}

// IsConfiguredAdmin — входит ли email в ADMIN_EMAILS.
func (s *Service) IsConfiguredAdmin(email string) bool {
	return s.adminEmails[strings.ToLower(strings.TrimSpace(email))]
}

// SyncConfiguredAdmins проставляет права уже зарегистрированным админам.
func (s *Service) SyncConfiguredAdmins(ctx context.Context) int {
	n := 0
	for email := range s.adminEmails {
		if err := s.store.SetUserAdmin(ctx, email, true); err == nil {
			n++
		}
	}
	return n
}

// GrantConfiguredAdmin выдаёт права администратора, если email задан развёртыванием.
// Возвращает true, если права были выданы сейчас.
func (s *Service) GrantConfiguredAdmin(ctx context.Context, u *store.User) bool {
	if u == nil || u.IsAdmin || !s.IsConfiguredAdmin(u.Email) {
		return false
	}
	if err := s.store.SetUserAdmin(ctx, u.Email, true); err != nil {
		return false
	}
	u.IsAdmin = true
	return true
}

// RegistrationMode — как на инсталляции пускают новых пользователей.
// Дефолт — «по заявке»: открытая регистрация должна быть осознанным решением.
func (s *Service) RegistrationMode(ctx context.Context) string {
	mode, err := s.store.GetSetting(ctx, store.SettingRegistrationMode)
	if err != nil || (mode != store.RegistrationModeOpen && mode != store.RegistrationModeRequest) {
		return store.RegistrationModeRequest
	}
	return mode
}

// IsOpenRegistration — можно ли регистрироваться напрямую.
func (s *Service) IsOpenRegistration(ctx context.Context) bool {
	return s.RegistrationMode(ctx) == store.RegistrationModeOpen
}

// Tokens — пара токенов после успешного login/refresh.
type Tokens struct {
	Access     string
	Refresh    string
	AccessExp  time.Time
	RefreshExp time.Time
}

// RegistrationInfo — режим регистрации и признак «инсталляция ещё пустая».
// Публичная ручка /api/auth/config отдаёт это форме регистрации: при пустой
// инсталляции показываем обычную форму, иначе — заявку.
func (s *Service) RegistrationInfo(ctx context.Context) (mode string, bootstrap bool) {
	mode = s.RegistrationMode(ctx)
	users, err := s.store.CountUsers(ctx)
	if err != nil {
		return mode, false
	}
	return mode, users == 0
}

// Register — прямая регистрация.
//
// Разрешена, если выполняется хотя бы одно условие:
//   - режим открытый (решение администратора в /admin);
//   - инсталляция пустая — первый аккаунт создаёт саму возможность управлять
//     развёртыванием (иначе при режиме «по заявке» одобрять заявки было бы некому);
//   - email входит в ADMIN_EMAILS: это администратор, назначенный развёртыванием,
//     и он должен уметь завести себе аккаунт независимо от режима.
//
// Во всех остальных случаях — ErrRegistrationClosed, а форма предлагает заявку.
func (s *Service) Register(ctx context.Context, email, password, displayName string) (*store.User, *Tokens, error) {
	if !s.IsOpenRegistration(ctx) && !s.IsConfiguredAdmin(email) {
		users, err := s.store.CountUsers(ctx)
		if err != nil {
			return nil, nil, fmt.Errorf("count users: %w", err)
		}
		if users > 0 {
			return nil, nil, ErrRegistrationClosed
		}
	}

	u, err := s.createUser(ctx, email, password, displayName)
	if err != nil {
		return nil, nil, err
	}
	s.GrantConfiguredAdmin(ctx, u)

	tok, err := s.issueTokens(ctx, u.ID, "")
	if err != nil {
		return nil, nil, err
	}
	return u, tok, nil
}

// createUser — общая часть регистрации и одобрения заявки: проверка занятости
// email, хэш пароля и (при необходимости) выдача прав администратора.
func (s *Service) createUser(ctx context.Context, email, password, displayName string) (*store.User, error) {
	email = strings.TrimSpace(strings.ToLower(email))
	displayName = strings.TrimSpace(displayName)

	if _, err := s.store.GetUserByEmail(ctx, email); err == nil {
		return nil, ErrEmailTaken
	} else if !errors.Is(err, store.ErrNotFound) && !errors.Is(err, pgx.ErrNoRows) {
		return nil, fmt.Errorf("check email: %w", err)
	}

	hash, err := HashPassword(password)
	if err != nil {
		return nil, err
	}

	admins, err := s.store.CountAdmins(ctx)
	if err != nil {
		return nil, fmt.Errorf("count admins: %w", err)
	}
	u, err := s.store.CreateUserWithHash(ctx, email, hash, displayName, admins == 0)
	if err != nil {
		return nil, fmt.Errorf("create user: %w", err)
	}
	return u, nil
}

// SubmitRegistrationRequest — приём заявки (режим «по заявке»).
// Пароль хэшируется сразу: одобрение создаст аккаунт с ним, без почтовых ссылок.
func (s *Service) SubmitRegistrationRequest(ctx context.Context, email, password, displayName, message string) (*store.RegistrationRequest, error) {
	email = strings.TrimSpace(strings.ToLower(email))
	displayName = strings.TrimSpace(displayName)
	if email == "" || password == "" || displayName == "" {
		return nil, ErrInvalidCreds
	}
	if _, err := s.store.GetUserByEmail(ctx, email); err == nil {
		return nil, ErrEmailTaken
	} else if !errors.Is(err, store.ErrNotFound) && !errors.Is(err, pgx.ErrNoRows) {
		return nil, fmt.Errorf("check email: %w", err)
	}
	hash, err := HashPassword(password)
	if err != nil {
		return nil, err
	}
	return s.store.CreateRegistrationRequest(ctx, email, displayName, hash, strings.TrimSpace(message))
}

// Login. Если пользователя нет, но есть его заявка — сообщаем об этом: человек
// ввёл те же данные, что и при заявке, значит это не утечка, а объяснение.
func (s *Service) Login(ctx context.Context, email, password string) (*store.User, *Tokens, error) {
	email = strings.TrimSpace(strings.ToLower(email))
	u, err := s.store.GetUserByEmail(ctx, email)
	if err != nil {
		if err := s.explainMissingAccount(ctx, email, password); err != nil {
			return nil, nil, err
		}
		return nil, nil, ErrInvalidCreds
	}
	if err := VerifyPassword(u.PasswordHash, password); err != nil {
		return nil, nil, ErrInvalidCreds
	}
	// Даже при наличии аккаунта незакрытая заявка означает, что доступ ещё не дан.
	if req, err := s.store.GetPendingRegistrationRequest(ctx, email); err == nil && req != nil {
		return nil, nil, ErrRequestPending
	}
	s.GrantConfiguredAdmin(ctx, u)
	tok, err := s.issueTokens(ctx, u.ID, "")
	if err != nil {
		return nil, nil, err
	}
	return u, tok, nil
}

// explainMissingAccount различает «заявка ждёт решения» и «заявку отклонили».
// Проверка пароля обязательна: без неё по одному email можно было бы узнать,
// кто подавал заявку.
func (s *Service) explainMissingAccount(ctx context.Context, email, password string) error {
	req, err := s.store.GetLatestRegistrationRequest(ctx, email)
	if err != nil || req == nil {
		return nil
	}
	if err := VerifyPassword(req.PasswordHash, password); err != nil {
		return nil
	}
	switch req.Status {
	case "pending":
		return ErrRequestPending
	case "rejected":
		return ErrRequestRejected
	}
	return nil
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
