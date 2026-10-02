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
	"encoding/json"
	"errors"
	"strings"
	"time"

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

// ========================== Беседы с моделью ==========================

// AIConversation — беседа пользователя с моделью внутри проекта.
//
// Беседа личная: выборки всегда идут с `user_id`, и чужую беседу нельзя не только
// изменить, но и увидеть. Даже владелец проекта не читает переписку соавтора: это
// личные заметки о работе, а не содержимое проекта.
type AIConversation struct {
	ID        uuid.UUID `db:"id" json:"id"`
	ProjectID uuid.UUID `db:"project_id" json:"project_id"`
	UserID    uuid.UUID `db:"user_id" json:"user_id"`
	Title     string    `db:"title" json:"title"`
	Model     string    `db:"model" json:"model"`
	CreatedAt time.Time `db:"created_at" json:"created_at"`
	UpdatedAt time.Time `db:"updated_at" json:"updated_at"`
}

// AIMessage — одно сообщение беседы.
//
// ToolCalls/ToolResults — как есть, JSON-ом: набор инструментов будет меняться, и
// отдельные колонки под каждый значили бы миграцию на каждый новый инструмент. Наружу
// они уходят теми же JSON-массивами: интерфейсу нужно показать «что модель попросила»
// и «что получилось», и он это делает из истории, а не из отдельного запроса.
type AIMessage struct {
	ID             uuid.UUID       `db:"id" json:"id"`
	ConversationID uuid.UUID       `db:"conversation_id" json:"conversation_id"`
	Role           string          `db:"role" json:"role"`
	Content        string          `db:"content" json:"content"`
	ToolCalls      json.RawMessage `db:"tool_calls" json:"tool_calls"`
	ToolResults    json.RawMessage `db:"tool_results" json:"tool_results"`
	Model          string          `db:"model" json:"model"`
	TokensIn       int             `db:"tokens_in" json:"tokens_in"`
	TokensOut      int             `db:"tokens_out" json:"tokens_out"`
	CreatedAt      time.Time       `db:"created_at" json:"created_at"`
}

const aiMessageColumns = `id, conversation_id, role, content, tool_calls, tool_results,
	model, tokens_in, tokens_out, created_at`

// CreateAIConversation заводит беседу. Пустой заголовок — нормально: его поставит
// первый вопрос человека (обрезанный), чтобы список бесед не был списком «Новая беседа».
func (s *Store) CreateAIConversation(
	ctx context.Context, projectID, userID uuid.UUID, title, model string,
) (*AIConversation, error) {
	return qOne[AIConversation](ctx, s.Pool,
		`INSERT INTO ai_conversations (project_id, user_id, title, model)
		 VALUES ($1, $2, $3, $4)
		 RETURNING id, project_id, user_id, title, model, created_at, updated_at`,
		projectID, userID, strings.TrimSpace(title), strings.TrimSpace(model))
}

// ListAIConversations — беседы этого пользователя в этом проекте (свежие сверху).
func (s *Store) ListAIConversations(
	ctx context.Context, projectID, userID uuid.UUID,
) ([]AIConversation, error) {
	return qAll[AIConversation](ctx, s.Pool,
		`SELECT id, project_id, user_id, title, model, created_at, updated_at
		   FROM ai_conversations
		  WHERE project_id=$1 AND user_id=$2
		  ORDER BY updated_at DESC`, projectID, userID)
}

// AIConversationByID — беседа пользователя. Чужая беседа неотличима от несуществующей
// (ErrNotFound): так по ответу нельзя узнать, что она есть.
func (s *Store) AIConversationByID(
	ctx context.Context, id, userID uuid.UUID,
) (*AIConversation, error) {
	return qOne[AIConversation](ctx, s.Pool,
		`SELECT id, project_id, user_id, title, model, created_at, updated_at
		   FROM ai_conversations WHERE id=$1 AND user_id=$2`, id, userID)
}

// TouchAIConversation отмечает беседу свежей и запоминает модель последнего ответа:
// список бесед сортируется по updated_at, а интерфейсу нужно подставить модель, на
// которой человек остановился.
func (s *Store) TouchAIConversation(ctx context.Context, id uuid.UUID, model string) error {
	_, err := s.Pool.Exec(ctx,
		`UPDATE ai_conversations SET updated_at=now(), model=$2 WHERE id=$1`,
		id, strings.TrimSpace(model))
	return err
}

// RenameAIConversation ставит заголовок беседы (первый вопрос человека, обрезанный).
func (s *Store) RenameAIConversation(ctx context.Context, id uuid.UUID, title string) error {
	_, err := s.Pool.Exec(ctx,
		`UPDATE ai_conversations SET title=$2, updated_at=now()
		  WHERE id=$1 AND title=''`, id, strings.TrimSpace(title))
	return err
}

// AppendAIMessage дописывает сообщение в беседу. JSON-поля передаются строкой с
// явным приведением: пустой `[]` не должен превращаться в NULL, иначе чтение истории
// вернуло бы «поля нет» вместо «вызовов не было».
func (s *Store) AppendAIMessage(ctx context.Context, m AIMessage) (*AIMessage, error) {
	toolCalls := rawJSONOrEmpty(m.ToolCalls)
	toolResults := rawJSONOrEmpty(m.ToolResults)
	return qOne[AIMessage](ctx, s.Pool,
		`INSERT INTO ai_messages
		   (conversation_id, role, content, tool_calls, tool_results, model, tokens_in, tokens_out)
		 VALUES ($1, $2, $3, $4::jsonb, $5::jsonb, $6, $7, $8)
		 RETURNING `+aiMessageColumns,
		m.ConversationID, m.Role, m.Content, string(toolCalls), string(toolResults),
		m.Model, m.TokensIn, m.TokensOut)
}

// ListAIMessages — история беседы по порядку. limit ограничивает выборку с конца:
// длинная переписка не должна тянуться целиком на каждый запрос, но последние
// сообщения нужны все.
func (s *Store) ListAIMessages(ctx context.Context, conversationID uuid.UUID, limit int) ([]AIMessage, error) {
	if limit <= 0 {
		limit = 200
	}
	rows, err := qAll[AIMessage](ctx, s.Pool,
		`SELECT `+aiMessageColumns+` FROM (
		     SELECT `+aiMessageColumns+` FROM ai_messages
		      WHERE conversation_id=$1
		      ORDER BY created_at DESC, id DESC
		      LIMIT $2
		 ) AS tail
		 ORDER BY created_at, id`, conversationID, limit)
	if err != nil {
		return nil, err
	}
	return rows, nil
}

// rawJSONOrEmpty — исходный JSON или пустой массив.
func rawJSONOrEmpty(raw json.RawMessage) json.RawMessage {
	if len(raw) == 0 || !json.Valid(raw) {
		return json.RawMessage("[]")
	}
	return raw
}

// ========================== Согласие на отправку ==========================

// SetAIConsent запоминает явное согласие пользователя отправлять текст проекта
// выбранному провайдеру.
func (s *Store) SetAIConsent(ctx context.Context, userID uuid.UUID, provider string) error {
	_, err := s.Pool.Exec(ctx,
		`INSERT INTO ai_consents (user_id, provider) VALUES ($1, $2)
		 ON CONFLICT (user_id, provider) DO UPDATE SET agreed_at=now()`,
		userID, provider)
	return err
}

// DeleteAIConsent отзывает согласие: следующий запрос к этому провайдеру снова
// спросит разрешения.
func (s *Store) DeleteAIConsent(ctx context.Context, userID uuid.UUID, provider string) error {
	_, err := s.Pool.Exec(ctx,
		`DELETE FROM ai_consents WHERE user_id=$1 AND provider=$2`, userID, provider)
	return err
}

// AIConsents — провайдеры, на отправку которым пользователь согласился.
func (s *Store) AIConsents(ctx context.Context, userID uuid.UUID) ([]string, error) {
	rows, err := s.Pool.Query(ctx,
		`SELECT provider FROM ai_consents WHERE user_id=$1 ORDER BY provider`, userID)
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
