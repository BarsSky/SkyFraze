package store

// store_chat.go — сообщения общего чата проекта (0.95.0).
//
// Чат — не замечания к кадру: он один на проект, в нём пишут все участники, и в нём отвечает
// Нестор. Замечания (0018) остаются тем, чем были: обсуждением конкретного фрагмента текста.

import (
	"context"
	"errors"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

// ChatKind — кто написал сообщение.
const (
	ChatKindUser = "user"
	ChatKindBot  = "bot"
)

// ChatMessage — сообщение общего чата.
type ChatMessage struct {
	ID         uuid.UUID  `db:"id" json:"id"`
	ProjectID  uuid.UUID  `db:"project_id" json:"project_id"`
	AuthorID   *uuid.UUID `db:"author_id" json:"author_id,omitempty"`
	AuthorName string     `db:"author_name" json:"author_name"`
	Kind       string     `db:"kind" json:"kind"`
	Body       string     `db:"body" json:"body"`
	// EventID — кадр, о котором речь (ссылка на элемент текста). Может пропасть: кадр удалили.
	EventID *uuid.UUID `db:"event_id" json:"event_id,omitempty"`
	// Quote — точная фраза из кадра, которую обсуждают. Пусто — ссылка на кадр целиком.
	Quote string `db:"quote" json:"quote,omitempty"`
	// ReplyTo — сообщение, на которое это ответ (0.96.0). Может пропасть вместе с исходным.
	ReplyTo *uuid.UUID `db:"reply_to" json:"reply_to,omitempty"`
	// EditedAt — когда правили после отправки. Пусто — не правили.
	EditedAt  *time.Time `db:"edited_at" json:"edited_at,omitempty"`
	CreatedAt time.Time  `db:"created_at" json:"created_at"`
}

const chatColumns = `id, project_id, author_id, author_name, kind, body, event_id, quote, reply_to, edited_at, created_at`

// AppendChatMessage добавляет сообщение и возвращает его с назначенными id и временем.
func (s *Store) AppendChatMessage(ctx context.Context, m *ChatMessage) error {
	return s.Pool.QueryRow(ctx,
		`INSERT INTO project_chat_messages
		   (project_id, author_id, author_name, kind, body, event_id, quote, reply_to)
		 VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
		 RETURNING id, created_at`,
		m.ProjectID, m.AuthorID, m.AuthorName, m.Kind, m.Body, m.EventID, m.Quote, m.ReplyTo,
	).Scan(&m.ID, &m.CreatedAt)
}

// ChatMessageByID — одно сообщение проекта (nil, если его нет).
func (s *Store) ChatMessageByID(ctx context.Context, projectID, id uuid.UUID) (*ChatMessage, error) {
	row, err := qOne[ChatMessage](ctx, s.Pool,
		`SELECT `+chatColumns+` FROM project_chat_messages
		  WHERE project_id = $1 AND id = $2`, projectID, id)
	if errors.Is(err, ErrNotFound) || errors.Is(err, pgx.ErrNoRows) {
		return nil, nil
	}
	return row, err
}

// UpdateChatMessageBody меняет текст сообщения и ставит отметку «изменено».
//
// Автора не трогаем: правка не меняет авторство — иначе «это писал не я» стало бы возможно.
func (s *Store) UpdateChatMessageBody(
	ctx context.Context, projectID, id uuid.UUID, body string,
) (*ChatMessage, error) {
	row, err := qOne[ChatMessage](ctx, s.Pool,
		`UPDATE project_chat_messages
		    SET body = $3, edited_at = now()
		  WHERE project_id = $1 AND id = $2
		  RETURNING `+chatColumns, projectID, id, body)
	if errors.Is(err, ErrNotFound) || errors.Is(err, pgx.ErrNoRows) {
		return nil, nil
	}
	return row, err
}

// ListChatMessages — последние сообщения проекта в хронологическом порядке.
//
// «Последние N по возрастанию» — то, что нужно окну чата: свежие внизу, а не «первые N с начала».
// Так история проекта не превращается в бесконечную ленту при каждом открытии.
func (s *Store) ListChatMessages(ctx context.Context, projectID uuid.UUID, limit int) ([]ChatMessage, error) {
	if limit <= 0 {
		limit = 100
	}
	return qAll[ChatMessage](ctx, s.Pool,
		`SELECT `+chatColumns+` FROM (
		     SELECT `+chatColumns+` FROM project_chat_messages
		      WHERE project_id = $1
		      ORDER BY created_at DESC, id DESC
		      LIMIT $2
		   ) recent
		 ORDER BY created_at, id`, projectID, limit)
}

// ChatMessagesAfter — что нового после известного сообщения. Пусто, если after нулевой: тогда
// это «всё, что есть» в пределах лимита.
func (s *Store) ChatMessagesAfter(
	ctx context.Context, projectID uuid.UUID, after uuid.UUID, limit int,
) ([]ChatMessage, error) {
	if limit <= 0 {
		limit = 100
	}
	if after == uuid.Nil {
		return s.ListChatMessages(ctx, projectID, limit)
	}
	return qAll[ChatMessage](ctx, s.Pool,
		`SELECT `+chatColumns+` FROM project_chat_messages
		  WHERE project_id = $1
		    AND (created_at, id) > (SELECT created_at, id FROM project_chat_messages WHERE id = $2)
		  ORDER BY created_at, id
		  LIMIT $3`, projectID, after, limit)
}

// ChatMessagesBefore — что было ДО известного сообщения (0.99.2): «показать прежние».
//
// Зачем. Окно чата открывается последними 100 сообщениями (ListChatMessages), и до 0.99.2 более
// раннее начало разговора было недостижимо вовсе: в проекте, живущем год, первый день обсуждения
// просто исчезал из интерфейса. Листаем назад страницами по limit, от старых к новым.
//
// Сравнение по паре (created_at, id), как и у After: у двух сообщений может совпасть время до
// микросекунды, и тогда порядок задаёт id — иначе страница «зависала» бы на одном сообщении.
func (s *Store) ChatMessagesBefore(
	ctx context.Context, projectID uuid.UUID, before uuid.UUID, limit int,
) ([]ChatMessage, error) {
	if limit <= 0 {
		limit = 100
	}
	if before == uuid.Nil {
		return s.ListChatMessages(ctx, projectID, limit)
	}
	return qAll[ChatMessage](ctx, s.Pool,
		`SELECT `+chatColumns+` FROM (
		     SELECT `+chatColumns+` FROM project_chat_messages
		      WHERE project_id = $1
		        AND (created_at, id) < (SELECT created_at, id FROM project_chat_messages WHERE id = $2)
		      ORDER BY created_at DESC, id DESC
		      LIMIT $3
		   ) older
		 ORDER BY created_at, id`, projectID, before, limit)
}
