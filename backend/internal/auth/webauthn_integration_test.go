package auth_test

// webauthn_integration_test.go — ключи доступа целиком: привязка и вход (миграция 0028).
//
// Аутентификатор здесь программный: настоящий ключ — это ES256-подпись и CBOR-структуры,
// и проверять их «на словах» (без подписи) значило бы проверять только наш код вокруг
// библиотеки. Поэтому тест собирает те же байты, что присылает браузер:
//
//	clientDataJSON  — {"type","challenge","origin"}
//	authData        — rpIdHash + флаги + счётчик (+ attestedCredentialData при привязке)
//	подпись         — ECDSA-SHA256 над authData || sha256(clientDataJSON)
//
// Что проверяем (и что ломается чаще всего):
//   - привязка сохраняет ключ, а вход этим ключом выдаёт токены;
//   - чужой origin и испорченная подпись отвергаются — иначе ключ «работает» где угодно;
//   - подтверждение одноразовое: повтор того же ответа не проходит;
//   - неизвестный адрес и человек без ключей отвечают одинаково (не выдаём, у кого есть ключи);
//   - без APP_BASE_URL ручки говорят «не настроено», а не падают.

import (
	"bytes"
	"context"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"net/http/httptest"
	"testing"

	"github.com/google/uuid"

	"github.com/go-webauthn/webauthn/protocol/webauthncbor"
	"github.com/skyfraze/backend/internal/auth"
	"github.com/skyfraze/backend/internal/platform/testdb"
	"github.com/skyfraze/backend/internal/store"
)

const (
	// testBaseURL — публичный адрес стенда в тесте: из него берутся RP ID и origin.
	testBaseURL = "http://localhost:3000"
	testRPID    = "localhost"
	testOrigin  = "http://localhost:3000"
)

// softAuthenticator — программная замена ключа: приватный ключ и идентификатор.
type softAuthenticator struct {
	priv   *ecdsa.PrivateKey
	credID []byte
	// signCount растёт на каждый вход: так проверяется запись счётчика подписей.
	signCount uint32
}

func newSoftAuthenticator(t *testing.T) *softAuthenticator {
	t.Helper()
	priv, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatalf("ключ ES256: %v", err)
	}
	id := make([]byte, 32)
	if _, err := rand.Read(id); err != nil {
		t.Fatalf("идентификатор ключа: %v", err)
	}
	return &softAuthenticator{priv: priv, credID: id}
}

// coseKey — публичная часть в COSE-представлении (то, что сервер хранит для проверки).
func (a *softAuthenticator) coseKey(t *testing.T) []byte {
	t.Helper()
	// Форматы x и y фиксированы длиной кривой: иначе ведущий нулевой байт терялся бы и
	// ключ не совпал бы с подписью.
	size := (a.priv.Curve.Params().BitSize + 7) / 8
	x := a.priv.PublicKey.X.FillBytes(make([]byte, size))
	y := a.priv.PublicKey.Y.FillBytes(make([]byte, size))
	raw, err := marshalCBOR(map[int]any{
		1:  2,  // kty: EC2
		3:  -7, // alg: ES256
		-1: 1,  // crv: P-256
		-2: x,
		-3: y,
	})
	if err != nil {
		t.Fatalf("COSE-ключ: %v", err)
	}
	return raw
}

// registrationResponse собирает ответ navigator.credentials.create().
func (a *softAuthenticator) registrationResponse(t *testing.T, challenge, origin string) []byte {
	t.Helper()
	clientData := clientDataJSON(t, "webauthn.create", challenge, origin)

	rpIDHash := sha256.Sum256([]byte(testRPID))
	authData := append([]byte{}, rpIDHash[:]...)
	// Флаги: UP (пользователь присутствовал) + UV (проверен) + AT (есть данные ключа).
	authData = append(authData, 0x45)
	authData = append(authData, 0, 0, 0, 0)          // счётчик подписей
	authData = append(authData, make([]byte, 16)...) // AAGUID
	authData = append(authData, byte(len(a.credID)>>8), byte(len(a.credID)))
	authData = append(authData, a.credID...)
	authData = append(authData, a.coseKey(t)...)

	attObj, err := marshalCBOR(map[string]any{
		"fmt":      "none",
		"attStmt":  map[string]any{},
		"authData": authData,
	})
	if err != nil {
		t.Fatalf("attestationObject: %v", err)
	}
	return marshalJSON(t, map[string]any{
		"id":    b64(a.credID),
		"rawId": b64(a.credID),
		"type":  "public-key",
		"response": map[string]any{
			"clientDataJSON":    b64(clientData),
			"attestationObject": b64(attObj),
		},
	})
}

// assertionResponse собирает ответ navigator.credentials.get().
func (a *softAuthenticator) assertionResponse(
	t *testing.T, challenge, origin string, sign bool,
) []byte {
	t.Helper()
	clientData := clientDataJSON(t, "webauthn.get", challenge, origin)

	rpIDHash := sha256.Sum256([]byte(testRPID))
	authData := append([]byte{}, rpIDHash[:]...)
	authData = append(authData, 0x05) // UP + UV
	a.signCount++
	count := a.signCount
	authData = append(authData,
		byte(count>>24), byte(count>>16), byte(count>>8), byte(count))

	// Подпись считается над authData || sha256(clientDataJSON) — именно так её проверит
	// сервер, и никак иначе.
	clientHash := sha256.Sum256(clientData)
	digest := sha256.Sum256(append(append([]byte{}, authData...), clientHash[:]...))
	sig, err := ecdsa.SignASN1(rand.Reader, a.priv, digest[:])
	if err != nil {
		t.Fatalf("подпись: %v", err)
	}
	if !sign {
		// Испорченная подпись: последний байт меняется, длина остаётся правдоподобной.
		sig[len(sig)-1] ^= 0xff
	}
	return marshalJSON(t, map[string]any{
		"id":    b64(a.credID),
		"rawId": b64(a.credID),
		"type":  "public-key",
		"response": map[string]any{
			"clientDataJSON":    b64(clientData),
			"authenticatorData": b64(authData),
			"signature":         b64(sig),
			"userHandle":        "",
		},
	})
}

// marshalCBOR — та же каноническая CBOR-сборка, что у библиотеки: структуры должны
// совпадать с тем, что присылает браузер, а не быть «похожими».
func marshalCBOR(v any) ([]byte, error) { return webauthncbor.Marshal(v) }

// clientDataJSON — то, что браузер подписывает как контекст церемонии.
func clientDataJSON(t *testing.T, typ, challenge, origin string) []byte {
	t.Helper()
	return marshalJSON(t, map[string]any{
		"type":        typ,
		"challenge":   challenge,
		"origin":      origin,
		"crossOrigin": false,
	})
}

func marshalJSON(t *testing.T, v any) []byte {
	t.Helper()
	raw, err := json.Marshal(v)
	if err != nil {
		t.Fatalf("json: %v", err)
	}
	return raw
}

func b64(raw []byte) string { return base64.RawURLEncoding.EncodeToString(raw) }

// ---------------------------------------------------------------------------

type waEnv struct {
	st   *store.Store
	svc  *auth.Service
	user uuid.UUID
}

func setupWebAuthn(t *testing.T) *waEnv {
	t.Helper()
	pool := testdb.Setup(t, "webauthn")
	testdb.Truncate(t, pool,
		"webauthn_challenges", "user_webauthn_credentials",
		"user_recovery_codes", "user_totp", "comment_notifications", "comment_views",
		"event_comments", "project_revisions", "ai_changes", "ai_messages", "ai_conversations",
		"project_event_state", "project_ratings", "project_views", "sessions",
		"invitations", "event_assets", "assets", "events", "team_memberships",
		"projects", "users")
	st := store.New(pool)
	svc := auth.New(st, "test-secret-for-webauthn")
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
	return &waEnv{st: st, svc: svc, user: user.ID}
}

// enroll привязывает ключ и возвращает его и коды восстановления (если выданы).
func (e *waEnv) enroll(
	t *testing.T, key *softAuthenticator, name string,
) (*auth.WebAuthnKey, []string) {
	t.Helper()
	ctx := context.Background()
	creation, challengeID, err := e.svc.WebAuthnRegistrationStart(ctx, e.user)
	if err != nil {
		t.Fatalf("начало привязки: %v", err)
	}
	body := key.registrationResponse(t, creation.Response.Challenge.String(), testOrigin)
	req := httptest.NewRequest("POST", "/api/auth/keys/register/finish", bytes.NewReader(body))
	attemptID, err := uuid.Parse(challengeID)
	if err != nil {
		t.Fatalf("идентификатор церемонии: %v", err)
	}
	stored, recovery, err := e.svc.WebAuthnRegistrationFinish(ctx, e.user, attemptID, name, req)
	if err != nil {
		t.Fatalf("конец привязки: %v", err)
	}
	return stored, recovery
}

// secondFactorTicket — пропуск второго шага, который обработчик входа выдаёт после пароля.
func (e *waEnv) secondFactorTicket(t *testing.T) string {
	t.Helper()
	// Пароль проверяется тем же вызовом, что и в жизни: вход обязан упереться во второй шаг.
	if _, _, err := e.svc.Login(context.Background(), "author@example.com", "hunter22!"); !errors.Is(err, auth.ErrTOTPRequired) {
		t.Fatalf("вход с паролем должен требовать второй шаг: %v", err)
	}
	ticket, err := e.svc.BeginTOTPChallenge(e.user)
	if err != nil {
		t.Fatalf("пропуск второго шага: %v", err)
	}
	return ticket
}

// Привязка и вход: ключ сохраняется, вход им выдаёт токены.
func TestWebAuthnRegisterAndLogin(t *testing.T) {
	e := setupWebAuthn(t)
	ctx := context.Background()
	key := newSoftAuthenticator(t)
	stored, recovery := e.enroll(t, key, "Ключ на телефоне")

	if stored.Name != "Ключ на телефоне" {
		t.Fatalf("имя ключа не сохранено: %q", stored.Name)
	}
	// Коды восстановления выданы при привязке: иначе человек с одним ключом и без TOTP
	// остался бы без последнего пути в аккаунт.
	if len(recovery) != 8 {
		t.Fatalf("ожидались 8 кодов восстановления, получено %d", len(recovery))
	}
	keys, err := e.svc.WebAuthnKeys(ctx, e.user)
	if err != nil {
		t.Fatalf("список ключей: %v", err)
	}
	if len(keys) != 1 || keys[0].ID != stored.ID {
		t.Fatalf("ожидался один ключ: %+v", keys)
	}

	assertion, challengeID, err := e.svc.WebAuthnLoginStart(ctx, e.secondFactorTicket(t))
	if err != nil {
		t.Fatalf("начало входа: %v", err)
	}
	attemptID, err := uuid.Parse(challengeID)
	if err != nil {
		t.Fatalf("идентификатор церемонии: %v", err)
	}
	body := key.assertionResponse(t, assertion.Response.Challenge.String(), testOrigin, true)
	req := httptest.NewRequest("POST", "/api/auth/login/webauthn/finish", bytes.NewReader(body))
	u, tok, err := e.svc.WebAuthnLoginFinish(ctx, attemptID, req)
	if err != nil {
		t.Fatalf("вход ключом: %v", err)
	}
	if u.ID != e.user {
		t.Fatalf("вошёл не тот человек: %v", u.ID)
	}
	if tok == nil || tok.Access == "" || tok.Refresh == "" {
		t.Fatal("вход ключом должен выдавать токены")
	}

	// Счётчик подписей записан: по нему видно повторное использование клона.
	rows, err := e.st.WebAuthnCredentials(ctx, e.user)
	if err != nil {
		t.Fatalf("ключи из базы: %v", err)
	}
	if len(rows) != 1 || rows[0].SignCount != int64(key.signCount) {
		t.Fatalf("счётчик подписей не записан: %+v", rows)
	}
	if rows[0].LastUsedAt == nil {
		t.Fatal("время использования ключа не записано")
	}
}

// Ответ привязки одноразовый: повтор того же тела не проходит.
func TestWebAuthnChallengeIsOneShot(t *testing.T) {
	e := setupWebAuthn(t)
	ctx := context.Background()
	key := newSoftAuthenticator(t)
	creation, challengeID, err := e.svc.WebAuthnRegistrationStart(ctx, e.user)
	if err != nil {
		t.Fatalf("начало привязки: %v", err)
	}
	attemptID, err := uuid.Parse(challengeID)
	if err != nil {
		t.Fatalf("идентификатор церемонии: %v", err)
	}
	body := key.registrationResponse(t, creation.Response.Challenge.String(), testOrigin)

	first := httptest.NewRequest("POST", "/", bytes.NewReader(body))
	if _, _, err := e.svc.WebAuthnRegistrationFinish(ctx, e.user, attemptID, "", first); err != nil {
		t.Fatalf("первая привязка: %v", err)
	}
	second := httptest.NewRequest("POST", "/", bytes.NewReader(body))
	if _, _, err := e.svc.WebAuthnRegistrationFinish(ctx, e.user, attemptID, "", second); !errors.Is(err, auth.ErrWebAuthnChallenge) {
		t.Fatalf("повтор должен отвергаться: %v", err)
	}
}

// Чужой origin не проходит: ключ действует только на своём домене.
func TestWebAuthnRejectsForeignOrigin(t *testing.T) {
	e := setupWebAuthn(t)
	ctx := context.Background()
	key := newSoftAuthenticator(t)
	creation, challengeID, err := e.svc.WebAuthnRegistrationStart(ctx, e.user)
	if err != nil {
		t.Fatalf("начало привязки: %v", err)
	}
	attemptID, _ := uuid.Parse(challengeID)
	body := key.registrationResponse(t, creation.Response.Challenge.String(), "http://evil.example")
	req := httptest.NewRequest("POST", "/", bytes.NewReader(body))
	if _, _, err := e.svc.WebAuthnRegistrationFinish(ctx, e.user, attemptID, "", req); err == nil {
		t.Fatal("привязка с чужого origin должна отвергаться")
	}
	// Ключ не сохранён: отказ не должен оставлять полусостояние.
	keys, err := e.svc.WebAuthnKeys(ctx, e.user)
	if err != nil {
		t.Fatalf("список ключей: %v", err)
	}
	if len(keys) != 0 {
		t.Fatalf("после отказа ключей быть не должно: %+v", keys)
	}
}

// Испорченная подпись не даёт войти.
func TestWebAuthnRejectsBadSignature(t *testing.T) {
	e := setupWebAuthn(t)
	ctx := context.Background()
	key := newSoftAuthenticator(t)
	e.enroll(t, key, "ключ")

	assertion, challengeID, err := e.svc.WebAuthnLoginStart(ctx, e.secondFactorTicket(t))
	if err != nil {
		t.Fatalf("начало входа: %v", err)
	}
	attemptID, _ := uuid.Parse(challengeID)
	body := key.assertionResponse(t, assertion.Response.Challenge.String(), testOrigin, false)
	req := httptest.NewRequest("POST", "/", bytes.NewReader(body))
	if _, _, err := e.svc.WebAuthnLoginFinish(ctx, attemptID, req); !errors.Is(err, auth.ErrInvalidCreds) {
		t.Fatalf("испорченная подпись должна отвергаться: %v", err)
	}
}

// Вход ключом начинается только с пропуска второго шага: без пароля — отказ.
func TestWebAuthnLoginStartRequiresTicket(t *testing.T) {
	e := setupWebAuthn(t)
	ctx := context.Background()
	key := newSoftAuthenticator(t)
	e.enroll(t, key, "ключ")

	if _, _, err := e.svc.WebAuthnLoginStart(ctx, "не-пропуск"); !errors.Is(err, auth.ErrInvalidCreds) {
		t.Fatalf("мусор вместо пропуска: %v", err)
	}
	// Пропуск человека без ключей тоже не годится: ключей не осталось — начинай с пароля.
	password, err := auth.HashPassword("hunter22!")
	if err != nil {
		t.Fatalf("хеш: %v", err)
	}
	nokeys, err := e.st.CreateUser(ctx, "nokeys@example.com", password, "Без ключей")
	if err != nil {
		t.Fatalf("второй пользователь: %v", err)
	}
	ticket, err := e.svc.BeginTOTPChallenge(nokeys.ID)
	if err != nil {
		t.Fatalf("пропуск: %v", err)
	}
	if _, _, err := e.svc.WebAuthnLoginStart(ctx, ticket); !errors.Is(err, auth.ErrInvalidCreds) {
		t.Fatalf("пропуск без ключей: %v", err)
	}
}

// Код восстановления — последний путь в аккаунт, где второй фактор это только ключ.
func TestWebAuthnRecoveryCodeWithoutTOTP(t *testing.T) {
	e := setupWebAuthn(t)
	ctx := context.Background()
	key := newSoftAuthenticator(t)
	_, recovery := e.enroll(t, key, "ключ")
	if len(recovery) == 0 {
		t.Fatal("при привязке ключа должны выдаваться коды восстановления")
	}

	// TOTP не включён: единственный второй фактор — ключ. Пароль один токенов не даёт.
	if _, _, err := e.svc.LoginTOTP(ctx, e.secondFactorTicket(t), "000000"); err == nil {
		t.Fatal("код из приложения без TOTP проходить не должен")
	}
	u, tok, err := e.svc.LoginTOTP(ctx, e.secondFactorTicket(t), recovery[0])
	if err != nil {
		t.Fatalf("код восстановления: %v", err)
	}
	if u.ID != e.user || tok == nil || tok.Access == "" {
		t.Fatal("код восстановления должен выдавать токены")
	}
	// Код одноразовый.
	if _, _, err := e.svc.LoginTOTP(ctx, e.secondFactorTicket(t), recovery[0]); !errors.Is(err, auth.ErrTOTPInvalid) {
		t.Fatalf("использованный код должен отвергаться: %v", err)
	}
}

// Удаление ключа: чужой ключ не удаляется, свой — удаляется.
func TestWebAuthnDeleteKey(t *testing.T) {
	e := setupWebAuthn(t)
	ctx := context.Background()
	key := newSoftAuthenticator(t)
	stored, _ := e.enroll(t, key, "ключ")

	other, err := e.st.CreateUser(ctx, "other@example.com", "$2a$10$notarealhash", "Другой")
	if err != nil {
		t.Fatalf("второй пользователь: %v", err)
	}
	if err := e.svc.DeleteWebAuthnKey(ctx, other.ID, stored.ID); !errors.Is(err, store.ErrNotFound) {
		t.Fatalf("чужой ключ не должен удаляться: %v", err)
	}
	if err := e.svc.DeleteWebAuthnKey(ctx, e.user, stored.ID); err != nil {
		t.Fatalf("удаление своего ключа: %v", err)
	}
	keys, err := e.svc.WebAuthnKeys(ctx, e.user)
	if err != nil {
		t.Fatalf("список: %v", err)
	}
	if len(keys) != 0 {
		t.Fatalf("ключ должен исчезнуть: %+v", keys)
	}
}

// Без APP_BASE_URL ключи выключены, и это видно вызывающему, а не выясняется паникой.
func TestWebAuthnDisabledWithoutBaseURL(t *testing.T) {
	e := setupWebAuthn(t)
	ctx := context.Background()
	plain := auth.New(e.st, "test-secret-for-webauthn")
	if plain.WebAuthnEnabled() {
		t.Fatal("без APP_BASE_URL ключи должны быть выключены")
	}
	if err := plain.UseWebAuthn(""); !errors.Is(err, auth.ErrWebAuthnDisabled) {
		t.Fatalf("пустой адрес: %v", err)
	}
	if _, err := plain.WebAuthnKeys(ctx, e.user); !errors.Is(err, auth.ErrWebAuthnDisabled) {
		t.Fatalf("список ключей без настройки: %v", err)
	}
	if _, _, err := plain.WebAuthnRegistrationStart(ctx, e.user); !errors.Is(err, auth.ErrWebAuthnDisabled) {
		t.Fatalf("привязка без настройки: %v", err)
	}
}
