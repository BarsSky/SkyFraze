package store

// store_comment_views.go — непрочитанные замечания (миграция 0019).
//
// Считаем «сколько замечаний появилось после того, как я в последний раз открывал
// обсуждение этого кадра». Отметка ставится по кадру (comment_views), а не по проекту:
// «прочитал замечания к этой главе» не значит «прочитал во всём проекте».

import (
	"context"
	"time"

	"github.com/google/uuid"
)

// CommentUnread — непрочитанное по одному кадру.
type CommentUnread struct {
	// EventID — кадр, у которого есть новые замечания.
	EventID uuid.UUID `db:"event_id" json:"event_id"`
	// Unread — сколько замечаний появилось после последнего просмотра.
	Unread int `db:"unread" json:"unread"`
	// LastAt — когда написали последнее из них (для «свежих сверху»).
	LastAt time.Time `db:"last_at" json:"last_at"`
}

// ProjectCommentUnread — непрочитанные замечания проекта целиком: для списка проектов,
// где человек видит «сюда стоит заглянуть», не открывая каждый проект.
type ProjectCommentUnread struct {
	ProjectID uuid.UUID `db:"project_id" json:"project_id"`
	Title     string    `db:"title" json:"title"`
	Unread    int       `db:"unread" json:"unread"`
	// Mentions — сколько из этих непрочитанных замечаний адресованы мне (`@ник`,
	// миграция 0024). «В проекте что-то новое» и «в проекте позвали меня» — разные новости:
	// первое можно отложить, второе обычно нельзя.
	Mentions int       `db:"mentions" json:"mentions"`
	LastAt   time.Time `db:"last_at" json:"last_at"`
}

// EventCommentsUnread — непрочитанное по кадрам одного проекта.
//
// Свои комментарии не считаются: «я написал» — точно прочитано, и возвращать человеку его
// же замечание как новое было бы шумом.
func (s *Store) EventCommentsUnread(
	ctx context.Context, projectID, userID uuid.UUID,
) ([]CommentUnread, error) {
	return qAll[CommentUnread](ctx, s.Pool,
		`SELECT c.event_id,
		        count(*) AS unread,
		        max(c.created_at) AS last_at
		   FROM event_comments c
		   LEFT JOIN comment_views v
		          ON v.user_id = $2 AND v.event_id = c.event_id
		  WHERE c.project_id = $1
		    AND c.user_id <> $2
		    AND c.deleted_at IS NULL
		    AND c.created_at > COALESCE(v.seen_at, to_timestamp(0))
		  GROUP BY c.event_id
		  ORDER BY last_at DESC`, projectID, userID)
}

// ProjectsCommentsUnread — в каких моих проектах есть непрочитанные замечания.
//
// Учитываются только проекты, где человек участник (владелец или член команды): чужие
// обсуждения ему не показываются, а «сколько там нового» — это уже утечка. Проекты в
// корзине тоже исключены (`p.deleted_at IS NULL`, миграция 0022): иначе счётчик звал бы в
// проект, который открывается 403 и из списка уже пропал. Правило одно и то же везде, где
// считаются замечания «для меня».
func (s *Store) ProjectsCommentsUnread(
	ctx context.Context, userID uuid.UUID,
) ([]ProjectCommentUnread, error) {
	return qAll[ProjectCommentUnread](ctx, s.Pool,
		`SELECT c.project_id, p.title, count(*) AS unread,
		        count(m.comment_id) AS mentions, max(c.created_at) AS last_at
		   FROM event_comments c
		   JOIN projects p ON p.id = c.project_id
		   LEFT JOIN comment_views v
		          ON v.user_id = $1 AND v.event_id = c.event_id
		   LEFT JOIN comment_mentions m
		          ON m.comment_id = c.id AND m.user_id = $1
		  WHERE c.user_id <> $1
		    AND c.deleted_at IS NULL
		    AND c.created_at > COALESCE(v.seen_at, to_timestamp(0))
		    AND p.deleted_at IS NULL
		    AND (p.owner_id = $1
		         OR EXISTS (SELECT 1 FROM team_memberships tm
		                     WHERE tm.project_id = p.id AND tm.user_id = $1))
		  GROUP BY c.project_id, p.title
		  ORDER BY last_at DESC`, userID)
}

// MarkCommentsSeen отмечает обсуждение кадра прочитанным.
//
// upsert, а не insert: повторное открытие кадра — обычное дело, и второй строки быть не
// должно. Время перезаписывается всегда: «прочитано сейчас» — это факт о сейчас, а не о
// первом визите.
func (s *Store) MarkCommentsSeen(
	ctx context.Context, projectID, eventID, userID uuid.UUID,
) error {
	_, err := s.Pool.Exec(ctx,
		`INSERT INTO comment_views (user_id, event_id, seen_at)
		 SELECT $3, $2, now()
		  WHERE EXISTS (SELECT 1 FROM event_comments
		                 WHERE project_id = $1 AND event_id = $2)
		 ON CONFLICT (user_id, event_id) DO UPDATE SET seen_at = now()`,
		projectID, eventID, userID)
	return err
}

// PurgeOrphanCommentViews удаляет отметки к кадрам, которых больше нет (уборщик).
func (s *Store) PurgeOrphanCommentViews(ctx context.Context) (int64, error) {
	tag, err := s.Pool.Exec(ctx,
		`DELETE FROM comment_views v
		  WHERE NOT EXISTS (SELECT 1 FROM events e WHERE e.id = v.event_id)`)
	if err != nil {
		return 0, err
	}
	return tag.RowsAffected(), nil
}
