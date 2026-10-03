package store

// store_ai_endpoints.go — свои серверы моделей у пользователя (миграция 0014).
//
// Зачем в базе, а не в окружении. Адрес сервера моделей — личное дело человека: у одного
// llama.cpp на домашней машине, у другого vLLM на работе. Окружение стенда знает только
// про серверы админа, поэтому свои адреса живут у пользователя.
//
// Ключ сервера лежит шифртекстом: тот же принцип, что у ключей провайдеров — открытым
// текстом ключи не хранятся вовсе.

import (
	"context"
	"time"

	"github.com/google/uuid"
)

// AIEndpoint — свой сервер моделей человека.
type AIEndpoint struct {
	ID     uuid.UUID `db:"id" json:"id"`
	UserID uuid.UUID `db:"user_id" json:"user_id"`
	Title  string    `db:"title" json:"title"`
	// BaseURL — адрес OpenAI-совместимого API, как его видит СЕРВЕР стенда.
	BaseURL string `db:"base_url" json:"base_url"`
	// Local — считает ли этот сервер на машине человека или в своей сети. От этого
	// зависит, нужно ли согласие на отправку текста проекта: решает человек, потому что
	// llama.cpp в соседней комнате и чужой шлюз в интернете выглядят для кода одинаково.
	Local bool `db:"local" json:"local"`
	// KeyCiphertext — ключ сервера (может быть пустым: свой сервер обычно без ключа).
	KeyCiphertext []byte    `db:"key_ciphertext" json:"-"`
	CreatedAt     time.Time `db:"created_at" json:"created_at"`
	UpdatedAt     time.Time `db:"updated_at" json:"updated_at"`
}

const aiEndpointColumns = `id, user_id, title, base_url, local, key_ciphertext, created_at, updated_at`

// ListAIEndpoints — свои серверы человека (в порядке добавления).
func (s *Store) ListAIEndpoints(ctx context.Context, userID uuid.UUID) ([]AIEndpoint, error) {
	return qAll[AIEndpoint](ctx, s.Pool,
		`SELECT `+aiEndpointColumns+` FROM ai_user_endpoints
		  WHERE user_id=$1 ORDER BY created_at`, userID)
}

// AIEndpointByID — сервер человека. Чужой неотличим от несуществующего: иначе по ответу
// можно было бы узнать, что у кого-то есть такой сервер.
func (s *Store) AIEndpointByID(ctx context.Context, id, userID uuid.UUID) (*AIEndpoint, error) {
	return qOne[AIEndpoint](ctx, s.Pool,
		`SELECT `+aiEndpointColumns+` FROM ai_user_endpoints WHERE id=$1 AND user_id=$2`, id, userID)
}

// UpsertAIEndpoint добавляет сервер. Обновления «на месте» нет намеренно: смена адреса у
// уже используемого сервера — это другой сервер, и человек должен добавить его отдельно,
// а не потерять прежний вместе с историей бесед.
func (s *Store) UpsertAIEndpoint(ctx context.Context, e AIEndpoint) (*AIEndpoint, error) {
	return qOne[AIEndpoint](ctx, s.Pool,
		`INSERT INTO ai_user_endpoints (id, user_id, title, base_url, local, key_ciphertext)
		 VALUES ($1, $2, $3, $4, $5, $6)
		 RETURNING `+aiEndpointColumns,
		e.ID, e.UserID, e.Title, e.BaseURL, e.Local, e.KeyCiphertext)
}

// DeleteAIEndpoint удаляет свой сервер. Возвращает ErrNotFound, если его нет или он чужой.
func (s *Store) DeleteAIEndpoint(ctx context.Context, id, userID uuid.UUID) error {
	tag, err := s.Pool.Exec(ctx,
		`DELETE FROM ai_user_endpoints WHERE id=$1 AND user_id=$2`, id, userID)
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		return ErrNotFound
	}
	return nil
}

// CountAIEndpoints — сколько своих серверов у человека (для предела).
func (s *Store) CountAIEndpoints(ctx context.Context, userID uuid.UUID) (int, error) {
	var n int
	err := s.Pool.QueryRow(ctx,
		`SELECT count(*) FROM ai_user_endpoints WHERE user_id=$1`, userID).Scan(&n)
	return n, err
}
