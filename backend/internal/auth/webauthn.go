package auth

// webauthn.go — ключи доступа (WebAuthn) как второй фактор рядом с TOTP (миграция 0028).
//
// Что решено до кода (docs/webauthn.md):
//   - RP ID — домен приложения, а не родительский: ключ действует только здесь;
//   - ключ — ВТОРОЙ фактор, а не замена пароля: вход без пароля сломал бы восстановление,
//     а сброса по почте у нас нет;
//   - коды восстановления общие с TOTP: последний путь в аккаунт не должен зависеть от того,
//     каким фактором человек пользовался;
//   - sign_count не блокирует вход: часть платформ всегда отдаёт ноль, поэтому расхождение —
//     запись в журнал, а не отказ.
//
// Библиотека, а не свой код. CBOR, COSE-ключи, разбор authenticatorData и проверки
// origin/rpId — то место, где ошибка выглядит как «работает, но проверяет не то». Своя
// реализация здесь была бы риском, а не экономией.

import (
	"context"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"strings"
	"time"

	"github.com/go-webauthn/webauthn/protocol"
	"github.com/go-webauthn/webauthn/webauthn"
	"github.com/google/uuid"

	"github.com/skyfraze/backend/internal/store"
)

// Ошибки ключей доступа.
var (
	// ErrWebAuthnDisabled — стенд не настроен (нет APP_BASE_URL): ключи не предлагаются.
	ErrWebAuthnDisabled = errors.New("ключи доступа не настроены на этом стенде")
	// ErrWebAuthnChallenge — состояние церемонии не найдено или истекло.
	ErrWebAuthnChallenge = errors.New("подтверждение истекло — начните заново")
)

// webAuthnChallengeTTL — сколько живёт состояние церемонии.
//
// Пять минут — как у пропуска второго шага входа: человек успевает приложить палец, но
// брошенная вкладка не оставляет за собой вечных записей.
const webAuthnChallengeTTL = 5 * time.Minute

// webAuthnUser — пользователь в терминах go-webauthn.
//
// UserHandle — это идентификатор пользователя, а не email и не ник: по нему сервер решает, кто
// вошёл, и он не показывается человеку.
type webAuthnUser struct {
	id    uuid.UUID
	name  string
	creds []webauthn.Credential
}

func (u *webAuthnUser) WebAuthnID() []byte                         { return u.id[:] }
func (u *webAuthnUser) WebAuthnName() string                       { return u.name }
func (u *webAuthnUser) WebAuthnDisplayName() string                { return u.name }
func (u *webAuthnUser) WebAuthnCredentials() []webauthn.Credential { return u.creds }

// UseWebAuthn включает ключи доступа. baseURL — публичный адрес приложения
// (APP_BASE_URL): из него берутся RP ID и разрешённый origin.
//
// Почему из настройки, а не из заголовка запроса: Host и X-Forwarded-* приходят от прокси, и
// доверять им в проверке origin значило бы разрешить вход с чужого домена.
func (s *Service) UseWebAuthn(baseURL string) error {
	raw := strings.TrimSpace(baseURL)
	if raw == "" {
		return ErrWebAuthnDisabled
	}
	origin, err := url.Parse(raw)
	if err != nil || origin.Host == "" {
		return fmt.Errorf("APP_BASE_URL не разобран: %q", baseURL)
	}
	// Origin — со схемой, RP ID — только хост: по спецификации RP ID не содержит порта, и
	// библиотека сверяет rpIdHash именно с хостом.
	host := origin.Hostname()
	wa, err := webauthn.New(&webauthn.Config{
		RPID:          host,
		RPDisplayName: "SkyFraze",
		RPOrigins:     []string{origin.Scheme + "://" + origin.Host},
	})
	if err != nil {
		return fmt.Errorf("webauthn: %w", err)
	}
	s.webauthn = wa
	return nil
}

// webAuthnReady — ключи настроены?
func (s *Service) webAuthnReady() error {
	if s.webauthn == nil {
		return ErrWebAuthnDisabled
	}
	return nil
}

// WebAuthnEnabled — настроены ли ключи на этом стенде (для профиля и формы входа).
func (s *Service) WebAuthnEnabled() bool { return s.webauthn != nil }

// parseSecondFactorTicket разбирает пропуск «пароль проверен, нужен второй шаг».
//
// Формат тот же, что у пропуска TOTP (короткоживущий JWT типа "totp"): второй шаг один, и то,
// чем его пройти — кодом из приложения или ключом, — человек решает уже после пароля. Отдельный
// тип токена здесь означал бы два способа доказать одно и то же и две разные ошибки на выходе.
func (s *Service) parseSecondFactorTicket(ticket string) (uuid.UUID, error) {
	return s.parseTOTPChallenge(ticket)
}

// loadWebAuthnUser собирает пользователя с его ключами.
func (s *Service) loadWebAuthnUser(
	ctx context.Context, userID uuid.UUID,
) (*webAuthnUser, *store.User, error) {
	u, err := s.store.GetUserByID(ctx, userID)
	if err != nil {
		return nil, nil, err
	}
	rows, err := s.store.WebAuthnCredentials(ctx, userID)
	if err != nil {
		return nil, nil, err
	}
	cred := make([]webauthn.Credential, 0, len(rows))
	for _, row := range rows {
		cred = append(cred, toWebAuthnCredential(row))
	}
	name := u.DisplayName
	if strings.TrimSpace(name) == "" {
		name = u.Email
	}
	return &webAuthnUser{id: u.ID, name: name, creds: cred}, u, nil
}

// toWebAuthnCredential переводит строку базы в тип библиотеки.
func toWebAuthnCredential(row store.WebAuthnCredential) webauthn.Credential {
	transports := make([]protocol.AuthenticatorTransport, 0, 2)
	for _, t := range strings.Split(row.Transports, ",") {
		if t = strings.TrimSpace(t); t != "" {
			transports = append(transports, protocol.AuthenticatorTransport(t))
		}
	}
	// AAGUID в базе — hex (см. store.WebAuthnCredential): сырые байты содержат нули и
	// текстовой колонкой не сохраняются. Ошибка разбора здесь не страшна: поле
	// информационное, подпись проверяется публичным ключом.
	aaguid, _ := hex.DecodeString(strings.TrimSpace(row.AAGUID))
	return webauthn.Credential{
		ID:        row.CredentialID,
		PublicKey: row.PublicKey,
		Transport: transports,
		Authenticator: webauthn.Authenticator{
			AAGUID:    aaguid,
			SignCount: uint32(row.SignCount),
		},
	}
}

// WebAuthnKey — ключ в том виде, в каком его видит человек (приватной части здесь нет).
type WebAuthnKey struct {
	ID         uuid.UUID  `json:"id"`
	Name       string     `json:"name"`
	CreatedAt  time.Time  `json:"created_at"`
	LastUsedAt *time.Time `json:"last_used_at,omitempty"`
	Transports string     `json:"transports"`
}

// WebAuthnKeys — список ключей человека (только своё; вызывается из личного профиля).
func (s *Service) WebAuthnKeys(ctx context.Context, userID uuid.UUID) ([]WebAuthnKey, error) {
	if err := s.webAuthnReady(); err != nil {
		return nil, err
	}
	rows, err := s.store.WebAuthnCredentials(ctx, userID)
	if err != nil {
		return nil, err
	}
	out := make([]WebAuthnKey, 0, len(rows))
	for _, row := range rows {
		out = append(out, WebAuthnKey{
			ID: row.ID, Name: row.Name, CreatedAt: row.CreatedAt,
			LastUsedAt: row.LastUsedAt, Transports: row.Transports,
		})
	}
	return out, nil
}

// WebAuthnRegistrationStart — первый шаг привязки ключа.
//
// Требует полноценно вошедшего человека: иначе украденный пароль привязывал бы к аккаунту
// свой ключ, и второй фактор превращался бы в дверь, которую открыл сам вор.
func (s *Service) WebAuthnRegistrationStart(
	ctx context.Context, userID uuid.UUID,
) (*protocol.CredentialCreation, string, error) {
	if err := s.webAuthnReady(); err != nil {
		return nil, "", err
	}
	user, _, err := s.loadWebAuthnUser(ctx, userID)
	if err != nil {
		return nil, "", err
	}
	// Не даём привязать один и тот же ключ дважды: браузер это и сам подскажет списком
	// excludeCredentials, но полагаться на подсказку нельзя.
	exclude := make([]protocol.CredentialDescriptor, 0, len(user.creds))
	for _, c := range user.creds {
		exclude = append(exclude, protocol.CredentialDescriptor{
			Type: protocol.PublicKeyCredentialType, CredentialID: c.ID,
		})
	}
	creation, session, err := s.webauthn.BeginRegistration(user,
		webauthn.WithExclusions(exclude),
		// Ключ как второй фактор: просим проверку пользователя (PIN, отпечаток), иначе
		// «нажал кнопку» не доказывает, что это тот человек.
		webauthn.WithAuthenticatorSelection(protocol.AuthenticatorSelection{
			UserVerification: protocol.VerificationPreferred,
			ResidentKey:      protocol.ResidentKeyRequirementDiscouraged,
		}),
	)
	if err != nil {
		return nil, "", err
	}
	challengeID, err := s.saveChallenge(ctx, &userID, "register", session)
	if err != nil {
		return nil, "", err
	}
	return creation, challengeID.String(), nil
}

// WebAuthnRegistrationFinish — второй шаг: сервер проверяет ответ аутентификатора.
//
// Возвращает ключ и, если у человека ещё нет кодов восстановления, свежую их партию: коды
// общие для TOTP и ключей (docs/webauthn.md, решение 3), а человек, включивший только ключ,
// иначе остался бы без последнего пути в аккаунт при потере устройства.
func (s *Service) WebAuthnRegistrationFinish(
	ctx context.Context, userID uuid.UUID, challengeID uuid.UUID, name string,
	r *http.Request,
) (*WebAuthnKey, []string, error) {
	if err := s.webAuthnReady(); err != nil {
		return nil, nil, err
	}
	session, err := s.takeChallenge(ctx, challengeID, "register", &userID)
	if err != nil {
		return nil, nil, err
	}
	user, _, err := s.loadWebAuthnUser(ctx, userID)
	if err != nil {
		return nil, nil, err
	}
	credential, err := s.webauthn.FinishRegistration(user, *session, r)
	if err != nil {
		return nil, nil, err
	}
	label := strings.TrimSpace(name)
	if label == "" {
		label = "ключ доступа"
	}
	if len([]rune(label)) > 60 {
		label = string([]rune(label)[:60])
	}
	transports := make([]string, 0, len(credential.Transport))
	for _, t := range credential.Transport {
		transports = append(transports, string(t))
	}
	row, err := s.store.AddWebAuthnCredential(ctx, store.WebAuthnCredential{
		UserID:       userID,
		CredentialID: credential.ID,
		PublicKey:    credential.PublicKey,
		SignCount:    int64(credential.Authenticator.SignCount),
		Transports:   strings.Join(transports, ","),
		// hex, а не сырые байты: в AAGUID есть нули, и текстовой колонкой они не сохраняются.
		AAGUID: hex.EncodeToString(credential.Authenticator.AAGUID),
		Name:   label,
	})
	if err != nil {
		return nil, nil, err
	}
	recovery, err := s.ensureRecoveryCodes(ctx, userID)
	if err != nil {
		// Ключ уже сохранён: неудача с кодами не должна выглядеть как «привязка не удалась».
		s.log().Warn("auth: коды восстановления после привязки ключа не выданы", "err", err)
	}
	return &WebAuthnKey{
		ID: row.ID, Name: row.Name, CreatedAt: row.CreatedAt, Transports: row.Transports,
	}, recovery, nil
}

// ensureRecoveryCodes выдаёт коды восстановления, если их ещё нет.
//
// Уже существующие коды не заменяются: человек мог сохранить их от TOTP, и подмена сделала бы
// сохранённый листок бумаги бесполезным.
func (s *Service) ensureRecoveryCodes(ctx context.Context, userID uuid.UUID) ([]string, error) {
	left, err := s.store.UnusedRecoveryCodes(ctx, userID)
	if err != nil {
		return nil, err
	}
	if left > 0 {
		return nil, nil
	}
	codes, err := GenerateRecoveryCodes(recoveryCodesCount)
	if err != nil {
		return nil, err
	}
	hashes := make([]string, 0, len(codes))
	for _, plain := range codes {
		hashes = append(hashes, sha256Hex(normalizeRecoveryCode(plain)))
	}
	if err := s.store.ReplaceRecoveryCodes(ctx, userID, hashes); err != nil {
		return nil, err
	}
	return codes, nil
}

// WebAuthnLoginStart — первый шаг входа ключом: человек уже ввёл пароль и получил пропуск
// второго шага.
//
// Почему пропуск, а не email (docs/webauthn.md §3, решение 2): ключ — ВТОРОЙ фактор, а не
// замена пароля. Если бы вход начинался с одного email, ключ заменял бы и пароль, а это ровно
// тот сценарий «вход без пароля», который мы решили не делать первой версией: восстановление
// пароля по почте у нас отсутствует, и потерянный ключ запирал бы человека снаружи навсегда.
func (s *Service) WebAuthnLoginStart(
	ctx context.Context, ticket string,
) (*protocol.CredentialAssertion, string, error) {
	if err := s.webAuthnReady(); err != nil {
		return nil, "", err
	}
	userID, err := s.parseSecondFactorTicket(ticket)
	if err != nil {
		return nil, "", ErrInvalidCreds
	}
	waUser, _, err := s.loadWebAuthnUser(ctx, userID)
	if err != nil {
		return nil, "", ErrInvalidCreds
	}
	if len(waUser.creds) == 0 {
		// Ключей нет — значит их удалили между шагами. Тот же ответ, что и «пропуск не
		// подошёл»: человеку нужно вернуться к вводу пароля, а не читать наши причины.
		return nil, "", ErrInvalidCreds
	}
	assertion, session, err := s.webauthn.BeginLogin(waUser)
	if err != nil {
		return nil, "", err
	}
	challengeID, err := s.saveChallenge(ctx, &userID, "login", session)
	if err != nil {
		return nil, "", err
	}
	return assertion, challengeID.String(), nil
}

// WebAuthnLoginFinish — второй шаг входа ключом: подпись проверена, выдаём токены.
//
// Ключ заменяет КОД второго шага, а не пароль: он доказывает и владение устройством, и
// присутствие человека (PIN, отпечаток, Face ID), то есть предъявляет сразу оба фактора вместо
// «пароль + код». Поэтому человек с ключом не вводит код из приложения.
func (s *Service) WebAuthnLoginFinish(
	ctx context.Context, challengeID uuid.UUID, r *http.Request,
) (*store.User, *Tokens, error) {
	if err := s.webAuthnReady(); err != nil {
		return nil, nil, err
	}
	challenge, err := s.takeChallengeRaw(ctx, challengeID, "login")
	if err != nil {
		return nil, nil, err
	}
	if challenge.UserID == nil {
		return nil, nil, ErrInvalidCreds
	}
	user, _, err := s.loadWebAuthnUser(ctx, *challenge.UserID)
	if err != nil {
		return nil, nil, err
	}
	var session webauthn.SessionData
	if err := json.Unmarshal(challenge.Session, &session); err != nil {
		return nil, nil, err
	}
	credential, err := s.webauthn.FinishLogin(user, session, r)
	if err != nil {
		return nil, nil, ErrInvalidCreds
	}
	// Нашли, какую строку обновить: по идентификатору ключа.
	if row, ferr := s.store.WebAuthnCredentialByCredentialID(ctx, credential.ID); ferr == nil {
		if row.SignCount != 0 && int64(credential.Authenticator.SignCount) <= row.SignCount {
			// Не отказ: часть платформ всегда присылает ноль. Но заметить стоит — это
			// единственный признак клонирования ключа, который у нас есть.
			s.log().Warn("auth: счётчик подписей ключа не вырос",
				"user", *challenge.UserID, "credential", row.ID)
		}
		_ = s.store.UpdateWebAuthnCredentialUsage(ctx, row.ID, int64(credential.Authenticator.SignCount))
	}
	u, err := s.store.GetUserByID(ctx, *challenge.UserID)
	if err != nil {
		return nil, nil, err
	}
	tokens, err := s.issueTokens(ctx, u.ID, "")
	if err != nil {
		return nil, nil, err
	}
	return u, tokens, nil
}

// WebAuthnPasskeyCount — сколько ключей у человека. Нужен входу: если ключи есть, одного
// пароля недостаточно (ключ настроен как второй фактор), и второй шаг предлагает «код или ключ».
func (s *Service) WebAuthnPasskeyCount(ctx context.Context, userID uuid.UUID) int {
	if s.webauthn == nil {
		return 0
	}
	rows, err := s.store.WebAuthnCredentials(ctx, userID)
	if err != nil {
		return 0
	}
	return len(rows)
}

// DeleteWebAuthnKey удаляет ключ человека.
//
// Отказ, если ключ последний и TOTP включён? Нет: TOTP остаётся вторым фактором, а коды
// восстановления — последним путём. Запрещать удаление значило бы «ключ нельзя потерять», а
// потерять его можно физически.
func (s *Service) DeleteWebAuthnKey(ctx context.Context, userID, id uuid.UUID) error {
	if err := s.webAuthnReady(); err != nil {
		return err
	}
	return s.store.DeleteWebAuthnCredential(ctx, userID, id)
}

// saveChallenge сохраняет состояние церемонии и возвращает его идентификатор.
func (s *Service) saveChallenge(
	ctx context.Context, userID *uuid.UUID, kind string, session *webauthn.SessionData,
) (uuid.UUID, error) {
	raw, err := json.Marshal(session)
	if err != nil {
		return uuid.Nil, err
	}
	return s.store.SaveWebAuthnChallenge(ctx, store.WebAuthnChallenge{
		UserID: userID,
		Kind:   kind,
		// Challenge в SessionData — строка base64url; в базе храним её же байтами:
		// колонка bytea нужна для индекса и для того, чтобы значение нельзя было
		// случайно истолковать дважды.
		Challenge: []byte(session.Challenge),
		Session:   raw,
		ExpiresAt: time.Now().Add(webAuthnChallengeTTL),
	})
}

// takeChallenge читает и удаляет состояние церемонии, проверяя владельца и срок.
func (s *Service) takeChallenge(
	ctx context.Context, id uuid.UUID, kind string, userID *uuid.UUID,
) (*webauthn.SessionData, error) {
	row, err := s.takeChallengeRaw(ctx, id, kind)
	if err != nil {
		return nil, err
	}
	if userID != nil && (row.UserID == nil || *row.UserID != *userID) {
		return nil, ErrWebAuthnChallenge
	}
	var session webauthn.SessionData
	if err := json.Unmarshal(row.Session, &session); err != nil {
		return nil, ErrWebAuthnChallenge
	}
	return &session, nil
}

func (s *Service) takeChallengeRaw(
	ctx context.Context, id uuid.UUID, kind string,
) (*store.WebAuthnChallenge, error) {
	row, err := s.store.TakeWebAuthnChallenge(ctx, id, kind)
	if err != nil {
		return nil, ErrWebAuthnChallenge
	}
	if time.Now().After(row.ExpiresAt) {
		return nil, ErrWebAuthnChallenge
	}
	return row, nil
}
