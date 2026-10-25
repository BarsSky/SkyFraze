package store

// store_event_comments.go — комментарии к кадрам (миграция 0018).
//
// Обсуждение кадра — это разговор о тексте, а не сам текст: комментарии не попадают ни в
// CRDT-документ, ни в книгу, ни в Markdown-выгрузку. Поэтому они живут в обычной таблице,
// и весь путь записи — обычный SQL, без комнат и снапшотов.

import (
	"context"
	"time"

	"github.com/google/uuid"
)

// EventComment — один комментарий к кадру.
type EventComment struct {
	ID        uuid.UUID `db:"id" json:"id"`
	ProjectID uuid.UUID `db:"project_id" json:"project_id"`
	// EventID — идентификатор кадра в документе (поле `id` события).
	EventID uuid.UUID `db:"event_id" json:"event_id"`
	// UserID/AuthorName — кто написал. Имя подтягивается джойном: в интерфейсе нужен
	// человек, а не UUID, и второй запрос за именами был бы лишним.
	UserID     uuid.UUID `db:"user_id" json:"user_id"`
	AuthorName string    `db:"author_name" json:"author_name"`
	Body       string    `db:"body" json:"body"`
	CreatedAt  time.Time `db:"created_at" json:"created_at"`
}

const eventCommentColumns = `c.id, c.project_id, c.event_id, c.user_id,
	COALESCE(NULLIF(u.display_name, ''), u.email) AS author_name, c.body, c.created_at`

// CreateEventComment сохраняет комментарий и возвращает его с именем автора.
func (s *Store) CreateEventComment(
	ctx context.Context, projectID, eventID, userID uuid.UUID, body string,
) (*EventComment, error) {
	return qOne[EventComment](ctx, s.Pool,
		`WITH ins AS (
		   INSERT INTO event_comments (project_id, event_id, user_id, body)
		   VALUES ($1, $2, $3, $4)
		   RETURNING *
		 )
		 SELECT `+eventCommentColumns+`
		   FROM ins c JOIN users u ON u.id = c.user_id`,
		projectID, eventID, userID, body)
}

// ListEventComments — обсуждение одного кадра в порядке написания.
//
// limit ограничивает выборку: под кадром может оказаться длинная переписка, а панель
// показывает последние сообщения, а не всю историю с начала проекта.
func (s *Store) ListEventComments(
	ctx context.Context, projectID, eventID uuid.UUID, limit int,
) ([]EventComment, error) {
	if limit <= 0 || limit > 500 {
		limit = 200
	}
	return qAll[EventComment](ctx, s.Pool,
		`SELECT `+eventCommentColumns+`
		   FROM event_comments c JOIN users u ON u.id = c.user_id
		  WHERE c.project_id=$1 AND c.event_id=$2
		  ORDER BY c.created_at
		  LIMIT $3`, projectID, eventID, limit)
}

// EventCommentCounts — сколько комментариев у каждого кадра проекта.
//
// Нужно дереву: «где уже идёт обсуждение» видно по счётчику рядом со строкой, иначе
// комментарий можно написать в пустоту — его никто не заметит.
func (s *Store) EventCommentCounts(
	ctx context.Context, projectID uuid.UUID,
) (map[uuid.UUID]int, error) {
	rows, err := s.Pool.Query(ctx,
		`SELECT event_id, count(*) FROM event_comments WHERE project_id=$1 GROUP BY event_id`,
		projectID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := make(map[uuid.UUID]int)
	for rows.Next() {
		var id uuid.UUID
		var n int
		if err := rows.Scan(&id, &n); err != nil {
			return nil, err
		}
		out[id] = n
	}
	return out, rows.Err()
}

// EventCommentByID читает комментарий проекта (для проверки автора перед удалением).
func (s *Store) EventCommentByID(
	ctx context.Context, projectID, id uuid.UUID,
) (*EventComment, error) {
	return qOne[EventComment](ctx, s.Pool,
		`SELECT `+eventCommentColumns+`
		   FROM event_comments c JOIN users u ON u.id = c.user_id
		  WHERE c.id=$1 AND c.project_id=$2`, id, projectID)
}

// DeleteEventComment удаляет комментарий. Условие «чей» — в запросе, а не в проверке
// перед ним: иначе между проверкой и удалением остаётся щель, а тут речь о чужом тексте.
func (s *Store) DeleteEventComment(
	ctx context.Context, projectID, id, userID uuid.UUID,
) error {
	tag, err := s.Pool.Exec(ctx,
		`DELETE FROM event_comments WHERE id=$1 AND project_id=$2 AND user_id=$3`,
		id, projectID, userID)
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		return ErrNotFound
	}
	return nil
}

// PurgeOrphanEventComments удаляет комментарии к кадрам, которых больше нет.
//
// Вызывается уборщиком, а не по факту удаления кадра: кадр исчезает из CRDT-документа,
// и «исчез» — это не событие, а результат пересчёта проекции. Карантин в сутки — тот же,
// что у осиротевших файлов: свежая пропажа бывает серединой импорта, когда дерево
// перестраивается по частям.
func (s *Store) PurgeOrphanEventComments(ctx context.Context, olderThan time.Duration) (int64, error) {
	if olderThan < 0 {
		olderThan = 0
	}
	tag, err := s.Pool.Exec(ctx,
		`DELETE FROM event_comments c
		  WHERE c.created_at < now() - $1::interval
		    AND NOT EXISTS (SELECT 1 FROM events e WHERE e.id = c.event_id)`,
		olderThan.String())
	if err != nil {
		return 0, err
	}
	return tag.RowsAffected(), nil
}
