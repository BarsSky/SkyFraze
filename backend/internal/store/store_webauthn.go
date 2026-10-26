package store

// store_webauthn.go — ключи доступа и состояние церемоний (миграция 0028).
//
// Приватного ключа здесь нет и быть не может: аутентификатор хранит его у себя, а сервер
// проверяет подпись публичным. Поэтому утечка базы не даёт войти под человеком — в отличие от
// пароля и секрета TOTP.

import (
	"context"
	"encoding/json"
	"errors"
	"time"

	"github.com/google/uuid"
)

// WebAuthnCredential — сохранённый ключ доступа.
type WebAuthnCredential struct {
	ID     uuid.UUID `db:"id" json:"id"`
	UserID uuid.UUID `db:"user_id" json:"user_id"`
	// CredentialID — идентификатор ключа от аутентификатора (для allow-list и поиска).
	CredentialID []byte `db:"credential_id" json:"-"`
	// PublicKey — COSE-ключ для проверки подписи.
	PublicKey  []byte `db:"public_key" json:"-"`
	SignCount  int64  `db:"sign_count" json:"sign_count"`
	Transports string `db:"transports" json:"transports"`
	// AAGUID — идентификатор модели аутентификатора в hex. В базе текст, а не байты: сырой
	// AAGUID содержит нулевые байты, и PostgreSQL отвергает такую строку («invalid byte
	// sequence for encoding UTF8»). Для проверки подписи это поле не нужно — оно только
	// помогает человеку узнать свой ключ в списке.
	AAGUID string `db:"aaguid" json:"aaguid"`
	// Name — имя, которое дал человек: без него список ключей это список байтов.
	Name       string     `db:"name" json:"name"`
	CreatedAt  time.Time  `db:"created_at" json:"created_at"`
	LastUsedAt *time.Time `db:"last_used_at" json:"last_used_at,omitempty"`
}

const webAuthnCredentialColumns = `id, user_id, credential_id, public_key, sign_count,
	transports, aaguid, name, created_at, last_used_at`

// AddWebAuthnCredential сохраняет ключ доступа.
//
// Конфликт по `credential_id` — ошибка, а не «обновим»: один ключ принадлежит одному человеку,
// и «перезаписать владельца» означало бы отдать чужой ключ другому аккаунту.
func (s *Store) AddWebAuthnCredential(
	ctx context.Context, c WebAuthnCredential,
) (*WebAuthnCredential, error) {
	return qOne[WebAuthnCredential](ctx, s.Pool,
		`INSERT INTO user_webauthn_credentials
		    (user_id, credential_id, public_key, sign_count, transports, aaguid, name)
		 VALUES ($1, $2, $3, $4, $5, $6, $7)
		 RETURNING `+webAuthnCredentialColumns,
		c.UserID, c.CredentialID, c.PublicKey, c.SignCount, c.Transports, c.AAGUID, c.Name)
}

// WebAuthnCredentials читает ключи человека (свежие сверху).
func (s *Store) WebAuthnCredentials(
	ctx context.Context, userID uuid.UUID,
) ([]WebAuthnCredential, error) {
	return qAll[WebAuthnCredential](ctx, s.Pool,
		`SELECT `+webAuthnCredentialColumns+`
		   FROM user_webauthn_credentials
		  WHERE user_id = $1
		  ORDER BY created_at DESC`, userID)
}

// WebAuthnCredentialByCredentialID находит ключ по идентификатору аутентификатора.
//
// Глобально, а не по пользователю: при входе человек ещё не назван — идентификатор ключа и есть
// то, по чему мы находим, кто это.
func (s *Store) WebAuthnCredentialByCredentialID(
	ctx context.Context, credentialID []byte,
) (*WebAuthnCredential, error) {
	return qOne[WebAuthnCredential](ctx, s.Pool,
		`SELECT `+webAuthnCredentialColumns+`
		   FROM user_webauthn_credentials
		  WHERE credential_id = $1`, credentialID)
}

// WebAuthnCredentialsForUser ограничивает вход ключами конкретного человека: сервер не должен
// принимать ключ, зарегистрированный на другого.
func (s *Store) WebAuthnCredentialsForUser(
	ctx context.Context, userID uuid.UUID,
) ([]WebAuthnCredential, error) {
	return s.WebAuthnCredentials(ctx, userID)
}

// UpdateWebAuthnCredentialUsage отмечает вход ключом: счётчик и время.
//
// Счётчик обновляется, но не блокирует вход при расхождении: часть платформенных
// аутентификаторов всегда отдаёт ноль, и «подозрительно» — это запись в журнал, а не отказ
// человеку (docs/webauthn.md §5).
func (s *Store) UpdateWebAuthnCredentialUsage(
	ctx context.Context, id uuid.UUID, signCount int64,
) error {
	_, err := s.Pool.Exec(ctx,
		`UPDATE user_webauthn_credentials
		    SET sign_count = $2, last_used_at = now()
		  WHERE id = $1`, id, signCount)
	return err
}

// DeleteWebAuthnCredential удаляет ключ человека.
//
// Условие «чей» — в запросе, а не в проверке перед ним: иначе между проверкой и удалением
// остаётся щель, а тут речь о доступе к аккаунту.
func (s *Store) DeleteWebAuthnCredential(ctx context.Context, userID, id uuid.UUID) error {
	tag, err := s.Pool.Exec(ctx,
		`DELETE FROM user_webauthn_credentials WHERE id = $1 AND user_id = $2`, id, userID)
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		return ErrNotFound
	}
	return nil
}

// WebAuthnChallenge — состояние одной церемонии (регистрация или вход).
type WebAuthnChallenge struct {
	ID        uuid.UUID  `db:"id"`
	UserID    *uuid.UUID `db:"user_id"`
	Kind      string     `db:"kind"`
	Challenge []byte     `db:"challenge"`
	// Session — состояние церемонии в виде, который понимает go-webauthn.
	Session   json.RawMessage `db:"session"`
	CreatedAt time.Time       `db:"created_at"`
	ExpiresAt time.Time       `db:"expires_at"`
}

// SaveWebAuthnChallenge сохраняет состояние церемонии.
func (s *Store) SaveWebAuthnChallenge(
	ctx context.Context, c WebAuthnChallenge,
) (uuid.UUID, error) {
	var id uuid.UUID
	err := s.Pool.QueryRow(ctx,
		`INSERT INTO webauthn_challenges (user_id, kind, challenge, session, expires_at)
		 VALUES ($1, $2, $3, $4, $5) RETURNING id`,
		c.UserID, c.Kind, c.Challenge, c.Session, c.ExpiresAt).Scan(&id)
	return id, err
}

// TakeWebAuthnChallenge читает и УДАЛЯЕТ состояние церемонии: challenge одноразовый.
//
// Удаление в том же запросе, а не отдельным шагом: иначе перехваченный ответ можно было бы
// предъявить второй раз, и «одноразовость» держалась бы на аккуратности вызывающего.
func (s *Store) TakeWebAuthnChallenge(
	ctx context.Context, id uuid.UUID, kind string,
) (*WebAuthnChallenge, error) {
	row := s.Pool.QueryRow(ctx,
		`DELETE FROM webauthn_challenges
		  WHERE id = $1 AND kind = $2
		  RETURNING id, user_id, kind, challenge, session, created_at, expires_at`, id, kind)
	var c WebAuthnChallenge
	if err := row.Scan(&c.ID, &c.UserID, &c.Kind, &c.Challenge, &c.Session, &c.CreatedAt, &c.ExpiresAt); err != nil {
		return nil, ErrNotFound
	}
	return &c, nil
}

// PurgeExpiredWebAuthnChallenges удаляет просроченные церемонии (зовётся уборщиком).
//
// Без этой уборки таблица растёт от каждой попытки входа ключом — включая неудачные.
func (s *Store) PurgeExpiredWebAuthnChallenges(ctx context.Context) (int64, error) {
	tag, err := s.Pool.Exec(ctx,
		`DELETE FROM webauthn_challenges WHERE expires_at < now()`)
	if err != nil {
		return 0, err
	}
	return tag.RowsAffected(), nil
}

// ErrWebAuthnCredentialExists — такой ключ уже зарегистрирован (кем-то).
var ErrWebAuthnCredentialExists = errors.New("ключ уже зарегистрирован")
