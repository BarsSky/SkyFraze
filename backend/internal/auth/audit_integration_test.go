package auth_test

// audit_integration_test.go — журнал входов (миграция 0029).
//
// Проверяем не «строки появились», а то, ради чего журнал существует:
//   - успешный вход записан с фактором (пароль / код / код восстановления / ключ);
//   - неудачная попытка записана, и по ней видно, что она была неудачной;
//   - попытка по НЕсуществующему адресу не пишется вовсе (не собираем чужие адреса);
//   - заблокированная по частоте попытка попадает в журнал владельца аккаунта;
//   - срок хранения соблюдается уборкой, а не только на словах;
//   - ручка отдаёт только свои входы и говорит срок хранения.

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/google/uuid"

	"github.com/skyfraze/backend/internal/auth"
	"github.com/skyfraze/backend/internal/platform/testdb"
	"github.com/skyfraze/backend/internal/store"
)

type auditEnv struct {
	st   *store.Store
	svc  *auth.Service
	user uuid.UUID
}

func setupAudit(t *testing.T) *auditEnv {
	t.Helper()
	pool := testdb.Setup(t, "audit")
	testdb.Truncate(t, pool,
		"login_audit", "webauthn_challenges", "user_webauthn_credentials",
		"user_recovery_codes", "user_totp", "comment_notifications", "comment_views",
		"event_comments", "project_revisions", "ai_changes", "ai_messages", "ai_conversations",
		"project_event_state", "project_ratings", "project_views", "sessions",
		"invitations", "event_assets", "assets", "events", "team_memberships",
		"projects", "users")
	st := store.New(pool)
	svc := auth.New(st, "test-secret-for-audit")
	if err := svc.UseWebAuthn(testBaseURL); err != nil {
		t.Fatalf("UseWebAuthn: %v", err)
	}
	ctx := context.Background()
	password, err := auth.HashPassword("hunter22!")
	if err != nil {
		t.Fatalf("хеш пароля: %v", err)
	}
	user, err := st.CreateUser(ctx, "author@example.com", password, "Автор")
	if err != nil {
		t.Fatalf("пользователь: %v", err)
	}
	return &auditEnv{st: st, svc: svc, user: user.ID}
}

func (e *auditEnv) entries(t *testing.T) []store.LoginAuditEntry {
	t.Helper()
	list, err := e.svc.Logins(context.Background(), e.user)
	if err != nil {
		t.Fatalf("журнал: %v", err)
	}
	return list
}

var testMeta = auth.LoginMeta{IP: "203.0.113.7", UserAgent: "Mozilla/5.0 (Windows NT 10.0) Chrome/120"}

// Успешный вход по паролю записан с адресом и браузером.
func TestLoginAuditRecordsPasswordLogin(t *testing.T) {
	e := setupAudit(t)
	ctx := context.Background()
	if _, _, err := e.svc.Login(ctx, "author@example.com", "hunter22!", testMeta); err != nil {
		t.Fatalf("вход: %v", err)
	}
	list := e.entries(t)
	if len(list) != 1 {
		t.Fatalf("ожидалась одна запись: %+v", list)
	}
	got := list[0]
	if got.Outcome != "ok" || got.Factor != "password" {
		t.Fatalf("ожидалось ok/password: %+v", got)
	}
	if got.IP != testMeta.IP || got.UserAgent != testMeta.UserAgent {
		t.Fatalf("адрес и браузер не записаны: %+v", got)
	}
}

// Неверный пароль записан как отказ без фактора.
func TestLoginAuditRecordsBadPassword(t *testing.T) {
	e := setupAudit(t)
	ctx := context.Background()
	if _, _, err := e.svc.Login(ctx, "author@example.com", "WRONG", testMeta); !errors.Is(err, auth.ErrInvalidCreds) {
		t.Fatalf("ожидался отказ: %v", err)
	}
	list := e.entries(t)
	if len(list) != 1 || list[0].Outcome != "bad_password" || list[0].Factor != "" {
		t.Fatalf("ожидалась запись bad_password: %+v", list)
	}
}

// Вход по несуществующему адресу не пишется: некому показать, и это чужие данные.
func TestLoginAuditSkipsUnknownAccount(t *testing.T) {
	e := setupAudit(t)
	ctx := context.Background()
	if _, _, err := e.svc.Login(ctx, "nobody@example.com", "hunter22!", testMeta); !errors.Is(err, auth.ErrInvalidCreds) {
		t.Fatalf("ожидался отказ: %v", err)
	}
	if list := e.entries(t); len(list) != 0 {
		t.Fatalf("по несуществующему адресу записей быть не должно: %+v", list)
	}
	// И в таблице вообще ничего: адрес не сохранён ни в каком виде.
	var total int
	if err := e.st.Pool.QueryRow(ctx, `SELECT count(*) FROM login_audit`).Scan(&total); err != nil {
		t.Fatalf("счётчик: %v", err)
	}
	if total != 0 {
		t.Fatalf("таблица должна быть пуста, а в ней %d", total)
	}
}

// Второй шаг: код из приложения и код восстановления различаются в журнале.
func TestLoginAuditRecordsSecondFactor(t *testing.T) {
	e := setupAudit(t)
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

	// Пароль верный, но токенов нет — в журнале пока ничего: попытка не завершена.
	if _, _, err := e.svc.Login(ctx, "author@example.com", "hunter22!", testMeta); !errors.Is(err, auth.ErrTOTPRequired) {
		t.Fatalf("ожидался второй шаг: %v", err)
	}
	if list := e.entries(t); len(list) != 0 {
		t.Fatalf("незавершённый вход не должен записываться: %+v", list)
	}

	ticket, err := e.svc.BeginTOTPChallenge(e.user)
	if err != nil {
		t.Fatalf("пропуск: %v", err)
	}
	totpCode, err := auth.TOTPCode(setup.Secret, time.Now().Add(30*time.Second))
	if err != nil {
		t.Fatalf("код 2: %v", err)
	}
	if _, _, err := e.svc.LoginTOTP(ctx, ticket, totpCode, testMeta); err != nil {
		t.Fatalf("вход по коду: %v", err)
	}
	list := e.entries(t)
	if len(list) != 1 || list[0].Outcome != "ok" || list[0].Factor != "totp" {
		t.Fatalf("ожидалась запись ok/totp: %+v", list)
	}

	// Код восстановления — отдельный фактор: «вошёл по листку» это сигнал.
	if _, _, err := e.svc.LoginTOTP(ctx, ticket, codes[0], testMeta); err != nil {
		t.Fatalf("вход по коду восстановления: %v", err)
	}
	list = e.entries(t)
	if len(list) != 2 || list[0].Outcome != "ok" || list[0].Factor != "recovery" {
		t.Fatalf("ожидалась запись ok/recovery: %+v", list)
	}

	// Неверный код — отказ, записан как bad_code.
	if _, _, err := e.svc.LoginTOTP(ctx, ticket, "000000", testMeta); !errors.Is(err, auth.ErrTOTPInvalid) {
		t.Fatalf("ожидался отказ: %v", err)
	}
	list = e.entries(t)
	if len(list) != 3 || list[0].Outcome != "bad_code" {
		t.Fatalf("ожидалась запись bad_code: %+v", list)
	}
}

// Вход ключом записан фактором passkey, а неудачная подпись — как bad_key.
func TestLoginAuditRecordsPasskey(t *testing.T) {
	e := setupAudit(t)
	ctx := context.Background()

	// Ключ привязываем тем же программным аутентификатором, что и в тестах WebAuthn.
	key := newSoftAuthenticator(t)
	creation, challengeID, err := e.svc.WebAuthnRegistrationStart(ctx, e.user)
	if err != nil {
		t.Fatalf("начало привязки: %v", err)
	}
	attemptID, _ := uuid.Parse(challengeID)
	body := key.registrationResponse(t, creation.Response.Challenge.String(), testOrigin)
	reg := httptest.NewRequest("POST", "/", bytes.NewReader(body))
	if _, _, err := e.svc.WebAuthnRegistrationFinish(ctx, e.user, attemptID, "ключ", reg); err != nil {
		t.Fatalf("привязка: %v", err)
	}

	ticket, err := e.svc.BeginTOTPChallenge(e.user)
	if err != nil {
		t.Fatalf("пропуск: %v", err)
	}
	assertion, loginChallenge, err := e.svc.WebAuthnLoginStart(ctx, ticket)
	if err != nil {
		t.Fatalf("начало входа ключом: %v", err)
	}
	loginID, _ := uuid.Parse(loginChallenge)

	// Испорченная подпись: отказ и запись bad_key.
	bad := httptest.NewRequest(
		"POST", "/", bytes.NewReader(key.assertionResponse(t, assertion.Response.Challenge.String(), testOrigin, false)),
	)
	bad.Header.Set("User-Agent", testMeta.UserAgent)
	if _, _, err := e.svc.WebAuthnLoginFinish(ctx, loginID, bad); !errors.Is(err, auth.ErrInvalidCreds) {
		t.Fatalf("ожидался отказ: %v", err)
	}
	list := e.entries(t)
	if len(list) != 1 || list[0].Outcome != "bad_key" {
		t.Fatalf("ожидалась запись bad_key: %+v", list)
	}

	// Настоящая подпись: успешный вход фактором passkey.
	assertion, loginChallenge, err = e.svc.WebAuthnLoginStart(ctx, ticket)
	if err != nil {
		t.Fatalf("начало входа ключом 2: %v", err)
	}
	loginID, _ = uuid.Parse(loginChallenge)
	ok := httptest.NewRequest(
		"POST", "/", bytes.NewReader(key.assertionResponse(t, assertion.Response.Challenge.String(), testOrigin, true)),
	)
	ok.Header.Set("User-Agent", testMeta.UserAgent)
	if _, _, err := e.svc.WebAuthnLoginFinish(ctx, loginID, ok); err != nil {
		t.Fatalf("вход ключом: %v", err)
	}
	list = e.entries(t)
	if len(list) != 2 || list[0].Outcome != "ok" || list[0].Factor != "passkey" {
		t.Fatalf("ожидалась запись ok/passkey: %+v", list)
	}
	if list[0].UserAgent != testMeta.UserAgent {
		t.Fatalf("браузер из запроса не записан: %+v", list[0])
	}
}

// Заблокированная по частоте попытка попадает в журнал владельца аккаунта.
func TestLoginAuditRecordsLocked(t *testing.T) {
	e := setupAudit(t)
	ctx := context.Background()
	e.svc.RecordLocked(ctx, "author@example.com", testMeta)
	list := e.entries(t)
	if len(list) != 1 || list[0].Outcome != "locked" {
		t.Fatalf("ожидалась запись locked: %+v", list)
	}
	// Несуществующий адрес — по-прежнему ничего.
	e.svc.RecordLocked(ctx, "nobody@example.com", testMeta)
	if list := e.entries(t); len(list) != 1 {
		t.Fatalf("чужая блокировка не должна писаться: %+v", list)
	}
}

// Срок хранения соблюдается уборкой.
func TestLoginAuditRetentionPurgesOldEntries(t *testing.T) {
	e := setupAudit(t)
	ctx := context.Background()
	if auth.LoginAuditRetention != 90*24*time.Hour {
		t.Fatalf("срок хранения изменился: %v", auth.LoginAuditRetention)
	}
	if _, _, err := e.svc.Login(ctx, "author@example.com", "hunter22!", testMeta); err != nil {
		t.Fatalf("вход: %v", err)
	}
	// Старая запись — мимо сервиса, потому что сервис всегда пишет «сейчас».
	if _, err := e.st.Pool.Exec(ctx,
		`INSERT INTO login_audit (user_id, outcome, factor, ip, created_at)
		 VALUES ($1, 'ok', 'password', '198.51.100.9', now() - interval '91 days')`,
		e.user); err != nil {
		t.Fatalf("старая запись: %v", err)
	}
	purged, err := e.st.PurgeLoginAudit(ctx, auth.LoginAuditRetention)
	if err != nil {
		t.Fatalf("уборка: %v", err)
	}
	if purged != 1 {
		t.Fatalf("ожидалась одна удалённая запись, удалено %d", purged)
	}
	if list := e.entries(t); len(list) != 1 {
		t.Fatalf("свежая запись должна остаться: %+v", list)
	}
}

// Ручка отдаёт только свои входы, свежие сверху, и говорит срок хранения.
func TestListLoginsHandler(t *testing.T) {
	e := setupAudit(t)
	ctx := context.Background()
	_, tok, err := e.svc.Login(ctx, "author@example.com", "hunter22!", testMeta)
	if err != nil {
		t.Fatalf("вход: %v", err)
	}
	// Журнал другого человека не должен попасть в ответ.
	other, err := e.st.CreateUser(ctx, "other@example.com", "$2a$10$notarealhash", "Другой")
	if err != nil {
		t.Fatalf("второй пользователь: %v", err)
	}
	e.svc.RecordLocked(ctx, "other@example.com", testMeta)
	if len(other.ID) == 0 {
		t.Fatal("второй пользователь без id")
	}
	_ = other

	h := auth.NewHandler(e.svc, e.st, slog.New(slog.NewTextHandler(io.Discard, nil)))
	srv := httptest.NewServer(e.svc.WithUser(http.HandlerFunc(h.ListLogins)))
	defer srv.Close()

	req, _ := http.NewRequest("GET", srv.URL, nil)
	req.Header.Set("Authorization", "Bearer "+tok.Access)
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatalf("запрос: %v", err)
	}
	defer res.Body.Close()
	if res.StatusCode != http.StatusOK {
		t.Fatalf("ожидался 200, получено %d", res.StatusCode)
	}
	var body struct {
		Logins []struct {
			Outcome string `json:"outcome"`
			Factor  string `json:"factor"`
			IP      string `json:"ip"`
		} `json:"logins"`
		RetentionDays int `json:"retention_days"`
	}
	if err := json.NewDecoder(res.Body).Decode(&body); err != nil {
		t.Fatalf("разбор ответа: %v", err)
	}
	if body.RetentionDays != 90 {
		t.Fatalf("срок хранения в ответе: %d", body.RetentionDays)
	}
	if len(body.Logins) != 1 {
		t.Fatalf("ожидалась одна своя запись, получено %d: %+v", len(body.Logins), body.Logins)
	}
	if body.Logins[0].Outcome != "ok" || body.Logins[0].Factor != "password" || body.Logins[0].IP != testMeta.IP {
		t.Fatalf("содержимое записи: %+v", body.Logins[0])
	}
	_ = other
}
