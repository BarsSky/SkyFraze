package store

// store_chat_unread.go — «где меня ждут в чате» и отметки «прочитано» (0.97.0).
//
// Отметка — по проекту, а не по сообщению: чат один на проект, и «прочитал чат» — это «прочитал
// всё, что было до сейчас». Свои сообщения и ответы бота на свой вопрос не считаются: «я написал»
// прочитано по определению, а ответ на мой вопрос я и так увижу, потому что жду его.

import (
	"context"
	"time"

	"github.com/google/uuid"
)

// ProjectChatUnread — непрочитанное в чате одного проекта.
type ProjectChatUnread struct {
	ProjectID uuid.UUID `db:"project_id" json:"project_id"`
	Title     string    `db:"title" json:"title"`
	Unread    int       `db:"unread" json:"unread"`
	LastAt    time.Time `db:"last_at" json:"last_at"`
}

// ProjectsChatUnread — в каких моих проектах есть непрочитанные сообщения.
//
// Учитываются только проекты, где человек участник, и только не удалённые в корзину — то же
// правило, что у непрочитанных замечаний: счётчик не должен звать туда, где 403.
func (s *Store) ProjectsChatUnread(ctx context.Context, userID uuid.UUID) ([]ProjectChatUnread, error) {
	return qAll[ProjectChatUnread](ctx, s.Pool,
		`SELECT m.project_id, p.title, count(*) AS unread, max(m.created_at) AS last_at
		   FROM project_chat_messages m
		   JOIN projects p ON p.id = m.project_id
		   LEFT JOIN project_chat_reads r
		          ON r.project_id = m.project_id AND r.user_id = $1
		  WHERE m.author_id IS DISTINCT FROM $1
		    AND m.created_at > COALESCE(r.seen_at, to_timestamp(0))
		    AND p.deleted_at IS NULL
		    AND (p.owner_id = $1
		         OR EXISTS (SELECT 1 FROM team_memberships tm
		                     WHERE tm.project_id = p.id AND tm.user_id = $1))
		  GROUP BY m.project_id, p.title
		  ORDER BY last_at DESC`, userID)
}

// MarkChatSeen отмечает чат проекта прочитанным до сейчас.
func (s *Store) MarkChatSeen(ctx context.Context, projectID, userID uuid.UUID) error {
	_, err := s.Pool.Exec(ctx,
		`INSERT INTO project_chat_reads (project_id, user_id, seen_at)
		 VALUES ($1, $2, now())
		 ON CONFLICT (project_id, user_id) DO UPDATE SET seen_at = now()`, projectID, userID)
	return err
}

// EnqueueChatNotifications ставит письма всем участникам проекта, кроме автора сообщения.
//
// Очередь, а не отправка здесь: письмо — сеть и чужой сервер, и держать из-за него ответ
// участнику нельзя (то же решение, что у замечаний, 0020).
func (s *Store) EnqueueChatNotifications(
	ctx context.Context, projectID, messageID, authorID uuid.UUID,
) (int64, error) {
	tag, err := s.Pool.Exec(ctx,
		`INSERT INTO chat_notifications (project_id, message_id, user_id)
		 SELECT $1, $2, u.id
		   FROM (
		     SELECT p.owner_id AS id FROM projects p WHERE p.id = $1 AND p.owner_id <> $3
		     UNION
		     SELECT tm.user_id FROM team_memberships tm
		      WHERE tm.project_id = $1 AND tm.user_id <> $3
		   ) u
		  JOIN users us ON us.id = u.id AND us.notify_comments`,
		projectID, messageID, authorID)
	if err != nil {
		return 0, err
	}
	return tag.RowsAffected(), nil
}

// PendingChatNotifications — что ещё не отправлено (для фонового обхода).
//
// Группируется по человеку при сборке письма: пять сообщений подряд не должны стать пятью письмами.
func (s *Store) PendingChatNotifications(
	ctx context.Context, limit, maxAttempts int,
) ([]ChatNotification, error) {
	return qAll[ChatNotification](ctx, s.Pool,
		`SELECT n.id, n.project_id, n.message_id, n.user_id, n.created_at, n.attempts,
		        u.email AS email, p.title AS project_title,
		        m.author_name, m.body
		   FROM chat_notifications n
		   JOIN users u ON u.id = n.user_id
		   JOIN projects p ON p.id = n.project_id
		   JOIN project_chat_messages m ON m.id = n.message_id
		  WHERE n.sent_at IS NULL AND n.attempts < $1
		  ORDER BY n.created_at
		  LIMIT $2`, maxAttempts, limit)
}

// ChatNotification — строка очереди писем о сообщениях чата (с полями для письма).
type ChatNotification struct {
	ID           uuid.UUID `db:"id"`
	ProjectID    uuid.UUID `db:"project_id"`
	MessageID    uuid.UUID `db:"message_id"`
	UserID       uuid.UUID `db:"user_id"`
	CreatedAt    time.Time `db:"created_at"`
	Attempts     int       `db:"attempts"`
	Email        string    `db:"email"`
	ProjectTitle string    `db:"project_title"`
	AuthorName   string    `db:"author_name"`
	Body         string    `db:"body"`
}

// MarkChatNotificationsSent отмечает письма отправленными.
func (s *Store) MarkChatNotificationsSent(ctx context.Context, ids []uuid.UUID) error {
	if len(ids) == 0 {
		return nil
	}
	_, err := s.Pool.Exec(ctx,
		`UPDATE chat_notifications SET sent_at = now() WHERE id = ANY($1)`, ids)
	return err
}

// FailChatNotification записывает неудачную попытку отправки.
func (s *Store) FailChatNotification(ctx context.Context, id uuid.UUID, reason string) error {
	_, err := s.Pool.Exec(ctx,
		`UPDATE chat_notifications
		    SET attempts = attempts + 1, last_error = $2
		  WHERE id = $1`, id, reason)
	return err
}
