package store

// store_ai.go — доступ к таблицам ИИ-помощника.
//
// Ключи провайдеров лежат здесь шифртекстом: база не знает, что внутри, и «достать
// ключ» можно только ключом шифрования из окружения (см. internal/ai/keys.go).
// Наружу (в API) ключ не отдаётся никогда — только факт «подключено/нет», поэтому
// метода «прочитать ключ» для обработчика не существует: только для сервиса,
// который собирает запрос к провайдеру.

import (
	"context"
	"errors"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

// UpsertAIKey сохраняет шифртекст ключа пользователя для провайдера.
func (s *Store) UpsertAIKey(ctx context.Context, userID uuid.UUID, provider string, ciphertext []byte) error {
	_, err := s.Pool.Exec(ctx,
		`INSERT INTO ai_user_keys (user_id, provider, key_ciphertext)
		 VALUES ($1, $2, $3)
		 ON CONFLICT (user_id, provider)
		 DO UPDATE SET key_ciphertext = EXCLUDED.key_ciphertext, updated_at = now()`,
		userID, provider, ciphertext)
	return err
}

// DeleteAIKey убирает ключ пользователя: провайдер снова работает только по ключу стенда.
func (s *Store) DeleteAIKey(ctx context.Context, userID uuid.UUID, provider string) error {
	_, err := s.Pool.Exec(ctx,
		`DELETE FROM ai_user_keys WHERE user_id=$1 AND provider=$2`, userID, provider)
	return err
}

// AIKeyCiphertext — шифртекст ключа пользователя (ErrNotFound, если ключа нет).
func (s *Store) AIKeyCiphertext(ctx context.Context, userID uuid.UUID, provider string) ([]byte, error) {
	var data []byte
	err := s.Pool.QueryRow(ctx,
		`SELECT key_ciphertext FROM ai_user_keys WHERE user_id=$1 AND provider=$2`,
		userID, provider).Scan(&data)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, ErrNotFound
	}
	return data, err
}

// AIKeyProviders — у каких провайдеров у пользователя есть свой ключ (без самих ключей).
func (s *Store) AIKeyProviders(ctx context.Context, userID uuid.UUID) ([]string, error) {
	rows, err := s.Pool.Query(ctx,
		`SELECT provider FROM ai_user_keys WHERE user_id=$1 ORDER BY provider`, userID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []string
	for rows.Next() {
		var provider string
		if err := rows.Scan(&provider); err != nil {
			return nil, err
		}
		out = append(out, provider)
	}
	return out, rows.Err()
}
