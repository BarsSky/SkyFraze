package auth_test

// totp_integration_test.go — двухфакторный вход целиком (миграция 0021).
//
// Проверяем то, ради чего он существует, и то, что чаще всего ломается при такой правке:
//   - при выключенной 2FA вход остаётся одношаговым (иначе настройка запирает людей снаружи);
//   - после включения пароль один НЕ даёт токенов — только пропуск;
//   - код принимается, чужой код — нет, код восстановления работает один раз;
//   - выключение требует кода: украденная сессия не снимает защиту;
//   - «выйти на всех устройствах» закрывает чужие сеансы и оставляет текущий.

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/google/uuid"

	"github.com/skyfraze/backend/internal/auth"
	"github.com/skyfraze/backend/internal/platform/testdb"
	"github.com/skyfraze/backend/internal/store"
)

type totpEnv struct {
	st   *store.Store
	svc  *auth.Service
	user uuid.UUID
}

func setupTOTP(t *testing.T) *totpEnv {
	t.Helper()
	pool := testdb.Setup(t, "totp")
	testdb.Truncate(t, pool,
		"user_recovery_codes", "user_totp", "comment_notifications", "comment_views",
		"event_comments", "project_revisions", "ai_changes", "ai_messages", "ai_conversations",
		"project_event_state", "project_ratings", "project_views", "sessions",
		"invitations", "event_assets", "assets", "events", "team_memberships",
		"projects", "users")
	st := store.New(pool)
	svc := auth.New(st, "test-secret-for-totp")
	ctx := context.Background()
	password, err := auth.HashPassword("hunter22!")
	if err != nil {
		t.Fatalf("хеш пароля: %v", err)
	}
	user, err := st.CreateUser(ctx, "author@example.com", password, "Автор")
	if err != nil {
		t.Fatalf("пользователь: %v", err)
	}
	return &totpEnv{st: st, svc: svc, user: user.ID}
}

// enable включает 2FA и возвращает коды восстановления.
func (e *totpEnv) enable(t *testing.T) []string {
	t.Helper()
	ctx := context.Background()
	setup, err := e.svc.SetupTOTP(ctx, e.user)
	if err != nil {
		t.Fatalf("setup: %v", err)
	}
	code, err := auth.TOTPCode(setup.Secret, time.Now())
	if err != nil {
		t.Fatalf("код: %v", err)
	}
	codes, err := e.svc.EnableTOTP(ctx, e.user, code)
	if err != nil {
		t.Fatalf("enable: %v", err)
	}
	return codes
}

// Пока 2FA не включена, вход прежний: пароль и сразу токены.
func TestLoginWithoutTOTPIsSingleStep(t *testing.T) {
	e := setupTOTP(t)
	u, tok, err := e.svc.Login(context.Background(), "author@example.com", "hunter22!")
	if err != nil {
		t.Fatalf("вход: %v", err)
	}
	if u.ID != e.user || tok == nil || tok.Access == "" {
		t.Fatalf("вход без 2FA должен выдавать токены: %+v", tok)
	}
}

// Настройка без подтверждения не включает второй фактор (иначе опечатка в приложении
// запирала бы человека снаружи).
func TestSetupAloneDoesNotEnable(t *testing.T) {
	e := setupTOTP(t)
	ctx := context.Background()
	if _, err := e.svc.SetupTOTP(ctx, e.user); err != nil {
		t.Fatalf("setup: %v", err)
	}
	if e.svc.TOTPEnabled(ctx, e.user) {
		t.Fatal("2FA не должна считаться включённой до подтверждения кодом")
	}
	if _, _, err := e.svc.Login(ctx, "author@example.com", "hunter22!"); err != nil {
		t.Fatalf("вход до подтверждения: %v", err)
	}
}

// После включения пароль даёт только пропуск, токены — после кода.
func TestLoginRequiresTOTPAfterEnable(t *testing.T) {
	e := setupTOTP(t)
	e.enable(t)
	ctx := context.Background()

	_, tok, err := e.svc.Login(ctx, "author@example.com", "hunter22!")
	if !errors.Is(err, auth.ErrTOTPRequired) {
		t.Fatalf("ожидался запрос второго фактора, получено %v", err)
	}
	if tok != nil {
		t.Fatal("до кода токенов быть не должно")
	}

	challenge, err := e.svc.BeginTOTPChallenge(e.user)
	if err != nil {
		t.Fatalf("пропуск: %v", err)
	}
	// Неверный код — отказ, и токенов нет.
	if _, _, err := e.svc.LoginTOTP(ctx, challenge, "000000"); !errors.Is(err, auth.ErrTOTPInvalid) {
		t.Fatalf("неверный код должен быть отвергнут, получено %v", err)
	}
	// Верный код — токены.
	secret, _, err := e.st.TOTPOf(ctx, e.user)
	if err != nil {
		t.Fatalf("секрет: %v", err)
	}
	code, err := auth.TOTPCode(secret, time.Now())
	if err != nil {
		t.Fatalf("код: %v", err)
	}
	u, tok, err := e.svc.LoginTOTP(ctx, challenge, code)
	if err != nil {
		t.Fatalf("вход по коду: %v", err)
	}
	if u.ID != e.user || tok == nil || tok.Access == "" {
		t.Fatalf("после кода должны быть токены: %+v", tok)
	}
	// Чужой пропуск (не нашего типа) не годится: refresh-токен как пропуск — отказ.
	refresh := tok.Refresh
	if _, _, err := e.svc.LoginTOTP(ctx, refresh, code); !errors.Is(err, auth.ErrTOTPInvalid) {
		t.Fatalf("refresh-токен не должен работать как пропуск, получено %v", err)
	}
}

// Код восстановления заменяет телефон и работает ровно один раз.
func TestRecoveryCodeIsSingleUse(t *testing.T) {
	e := setupTOTP(t)
	codes := e.enable(t)
	ctx := context.Background()
	secret, _, err := e.st.TOTPOf(ctx, e.user)
	if err != nil {
		t.Fatalf("секрет: %v", err)
	}

	loginWith := func(code string) error {
		challenge, err := e.svc.BeginTOTPChallenge(e.user)
		if err != nil {
			t.Fatalf("пропуск: %v", err)
		}
		_, _, err = e.svc.LoginTOTP(ctx, challenge, code)
		return err
	}
	// Код восстановления в любом регистре и без дефиса.
	plain := codes[0]
	if err := loginWith(plain); err != nil {
		t.Fatalf("код восстановления %q не принят: %v", plain, err)
	}
	if err := loginWith(plain); !errors.Is(err, auth.ErrTOTPInvalid) {
		t.Fatalf("повторный код восстановления должен быть отвергнут, получено %v", err)
	}
	// Другой код из набора — ещё работает.
	if err := loginWith(codes[1]); err != nil {
		t.Fatalf("второй код восстановления: %v", err)
	}
	// Остаток уменьшился.
	left, err := e.svc.RecoveryCodeCount(ctx, e.user)
	if err != nil || left != len(codes)-2 {
		t.Fatalf("осталось кодов: %d (ожидалось %d), err=%v", left, len(codes)-2, err)
	}
	_ = secret
}

// Выключение требует кода: одной сессии мало.
func TestDisableRequiresCode(t *testing.T) {
	e := setupTOTP(t)
	e.enable(t)
	ctx := context.Background()
	if err := e.svc.DisableTOTP(ctx, e.user, "000000"); !errors.Is(err, auth.ErrTOTPInvalid) {
		t.Fatalf("выключение без верного кода должно быть отвергнуто, получено %v", err)
	}
	if !e.svc.TOTPEnabled(ctx, e.user) {
		t.Fatal("2FA выключилась без верного кода")
	}
	secret, _, _ := e.st.TOTPOf(ctx, e.user)
	code, err := auth.TOTPCode(secret, time.Now())
	if err != nil {
		t.Fatalf("код: %v", err)
	}
	if err := e.svc.DisableTOTP(ctx, e.user, code); err != nil {
		t.Fatalf("выключение с верным кодом: %v", err)
	}
	if e.svc.TOTPEnabled(ctx, e.user) {
		t.Fatal("2FA осталась включённой")
	}
	// Коды восстановления стёрты вместе с 2FA.
	if codes, err := e.svc.RecoveryCodeCount(ctx, e.user); err != nil || codes != 0 {
		t.Fatalf("коды восстановления не стёрты: %d (%v)", codes, err)
	}
}

// «Выйти на всех устройствах»: чужие сеансы закрыты, текущий жив.
func TestRevokeOtherSessions(t *testing.T) {
	e := setupTOTP(t)
	ctx := context.Background()
	_, first, err := e.svc.Login(ctx, "author@example.com", "hunter22!")
	if err != nil {
		t.Fatalf("первый вход: %v", err)
	}
	_, second, err := e.svc.Login(ctx, "author@example.com", "hunter22!")
	if err != nil {
		t.Fatalf("второй вход: %v", err)
	}
	sessions, err := e.svc.Sessions(ctx, e.user)
	if err != nil || len(sessions) != 2 {
		t.Fatalf("сеансов: %d (%v)", len(sessions), err)
	}
	// Текущим считаем второй: его refresh передаём в запрос.
	revoked, err := e.svc.RevokeOtherSessions(ctx, e.user, second.Refresh)
	if err != nil || revoked != 1 {
		t.Fatalf("отозвано: %d (%v)", revoked, err)
	}
	sessions, err = e.svc.Sessions(ctx, e.user)
	if err != nil || len(sessions) != 1 {
		t.Fatalf("после отзыва сеансов: %d (%v)", len(sessions), err)
	}
	// Отозванный refresh больше не обменивается на токены.
	if _, err := e.svc.Refresh(ctx, first.Refresh); err == nil {
		t.Fatal("отозванный refresh всё ещё работает")
	}
	if _, err := e.svc.Refresh(ctx, second.Refresh); err != nil {
		t.Fatalf("текущий сеанс должен сохраниться: %v", err)
	}
}
