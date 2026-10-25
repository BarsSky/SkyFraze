package store

// store_comment_notifications.go — очередь писем о новых замечаниях (миграция 0020).
//
// Письмо не отправляется в момент комментария (см. шапку миграции): здесь только очередь.
// Пишет в неё сервис обсуждения, читает фоновый обход в internal/notify.

import (
	"context"
	"time"

	"github.com/google/uuid"
)

// CommentNotification — одно письмо: кому и о каком замечании.
type CommentNotification struct {
	ID        uuid.UUID `db:"id"`
	ProjectID uuid.UUID `db:"project_id"`
	EventID   uuid.UUID `db:"event_id"`
	CommentID uuid.UUID `db:"comment_id"`
	UserID    uuid.UUID `db:"user_id"`
	Attempts  int       `db:"attempts"`
	// Поля ниже — из соседних таблиц: письмо собирается одним запросом, без N+1.
	Email        string    `db:"email"`
	Recipient    string    `db:"recipient"`
	ProjectTitle string    `db:"project_title"`
	EventTitle   string    `db:"event_title"`
	AuthorName   string    `db:"author_name"`
	Body         string    `db:"body"`
	CreatedAt    time.Time `db:"created_at"`
}

// EnqueueCommentNotifications ставит письма в очередь.
//
// Кому: всем участникам проекта, кроме автора комментария, и только тем, кто включил
// галочку. Возвращает, скольким поставлено — это же число видно в журнале.
func (s *Store) EnqueueCommentNotifications(
	ctx context.Context, projectID, eventID, commentID, authorID uuid.UUID,
) (int, error) {
	tag, err := s.Pool.Exec(ctx,
		`INSERT INTO comment_notifications (project_id, event_id, comment_id, user_id)
		 SELECT $1, $2, $3, x.uid
		   FROM (
		         SELECT owner_id AS uid FROM projects WHERE id = $1
		         UNION
		         SELECT user_id FROM team_memberships WHERE project_id = $1
		        ) x
		   JOIN users u ON u.id = x.uid
		  WHERE u.notify_comments AND x.uid <> $4`,
		projectID, eventID, commentID, authorID)
	if err != nil {
		return 0, err
	}
	return int(tag.RowsAffected()), nil
}

// PendingCommentNotifications — что ждёт отправки, по одному человеку за раз.
//
// `attempts < $3` — предел попыток: письмо, которое сервер отвергает всегда, не должно
// занимать очередь вечно. Такие строки остаются в базе с last_error, чтобы было видно.
func (s *Store) PendingCommentNotifications(
	ctx context.Context, limit, maxAttempts int,
) ([]CommentNotification, error) {
	if limit <= 0 || limit > 500 {
		limit = 200
	}
	if maxAttempts <= 0 {
		maxAttempts = 5
	}
	return qAll[CommentNotification](ctx, s.Pool,
		`SELECT n.id, n.project_id, n.event_id, n.comment_id, n.user_id, n.attempts,
		        u.email,
		        COALESCE(NULLIF(u.display_name, ''), u.email) AS recipient,
		        p.title AS project_title,
		        COALESCE(e.title, '') AS event_title,
		        COALESCE(NULLIF(a.display_name, ''), a.email) AS author_name,
		        c.body,
		        n.created_at
		   FROM comment_notifications n
		   JOIN users u          ON u.id = n.user_id
		   JOIN projects p       ON p.id = n.project_id
		   JOIN event_comments c ON c.id = n.comment_id
		   JOIN users a          ON a.id = c.user_id
		   LEFT JOIN events e    ON e.id = n.event_id
		  WHERE n.sent_at IS NULL AND n.attempts < $2
		  ORDER BY n.created_at
		  LIMIT $1`, limit, maxAttempts)
}

// MarkCommentNotificationsSent отмечает письма отправленными.
func (s *Store) MarkCommentNotificationsSent(ctx context.Context, ids []uuid.UUID) error {
	if len(ids) == 0 {
		return nil
	}
	_, err := s.Pool.Exec(ctx,
		`UPDATE comment_notifications SET sent_at = now(), last_error = ''
		  WHERE id = ANY($1)`, ids)
	return err
}

// MarkCommentNotificationsFailed фиксирует неудачу: попытка, текст ошибки, и всё.
//
// `sent_at` не ставится: следующая попытка снова возьмёт строку (пока не упрётся в
// предел попыток). Так письмо не теряется из-за временной недоступности сервера.
func (s *Store) MarkCommentNotificationsFailed(ctx context.Context, ids []uuid.UUID, reason string) error {
	if len(ids) == 0 {
		return nil
	}
	_, err := s.Pool.Exec(ctx,
		`UPDATE comment_notifications
		    SET attempts = attempts + 1, last_error = $2
		  WHERE id = ANY($1)`, ids, reason)
	return err
}

// SetNotifyComments включает/выключает уведомления человеку.
//
// Отдельным запросом, а не через UpdateProfile: галочка меняется одним кликом и не должна
// тянуть за собой проверки имени и ника.
func (s *Store) SetNotifyComments(ctx context.Context, userID uuid.UUID, enabled bool) error {
	_, err := s.Pool.Exec(ctx,
		`UPDATE users SET notify_comments = $2, updated_at = now() WHERE id = $1`,
		userID, enabled)
	return err
}
