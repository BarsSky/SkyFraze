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
	// ParentID — замечание, на которое это ответ (миграция 0023). nil у корневых.
	// Ветка ровно одного уровня: ответ на ответ сервер не принимает (см. events.AddComment).
	ParentID *uuid.UUID `db:"parent_id" json:"parent_id,omitempty"`
	// Deleted — комментарий удалён автором. Строка остаётся, тело вычищено: иначе вместе с
	// замечанием исчезли бы и чужие ответы на него.
	Deleted bool `db:"deleted" json:"deleted"`
	// Reactions — реакции на замечание (миграция 0025). Не колонка таблицы: заполняется
	// отдельным запросом на весь список (см. CommentReactionStats), чтобы не плодить N+1.
	Reactions CommentReactions `db:"-" json:"reactions"`
	// Anchor — замечание к фрагменту текста (миграция 0026). nil — замечание к кадру целиком.
	// Заполняется тоже отдельным запросом (см. CommentAnchors).
	Anchor *CommentAnchor `db:"-" json:"anchor,omitempty"`
}

const eventCommentColumns = `c.id, c.project_id, c.event_id, c.user_id,
	COALESCE(NULLIF(u.display_name, ''), u.email) AS author_name, c.body, c.created_at,
	c.parent_id, (c.deleted_at IS NOT NULL) AS deleted`

// CreateEventComment сохраняет комментарий и возвращает его с именем автора.
func (s *Store) CreateEventComment(
	ctx context.Context, projectID, eventID, userID uuid.UUID, body string, parentID *uuid.UUID,
) (*EventComment, error) {
	return qOne[EventComment](ctx, s.Pool,
		`WITH ins AS (
		   INSERT INTO event_comments (project_id, event_id, user_id, body, parent_id)
		   VALUES ($1, $2, $3, $4, $5)
		   RETURNING *
		 )
		 SELECT `+eventCommentColumns+`
		   FROM ins c JOIN users u ON u.id = c.user_id`,
		projectID, eventID, userID, body, parentID)
}

// ListEventComments — обсуждение одного кадра в порядке написания.
//
// limit ограничивает выборку: под кадром может оказаться длинная переписка, а панель
// показывает последние сообщения, а не всю историю с начала проекта.
//
// Удалённые строки входят в выборку (`Deleted = true`, тело пустое): дерево обсуждения
// собирается ими — без них ответы на удалённое замечание повисли бы в воздухе.
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
// комментарий можно написать в пустоту — его никто не заметит. Удалённые не считаются:
// счётчик зовёт к живому разговору, а не к «(удалён)».
func (s *Store) EventCommentCounts(
	ctx context.Context, projectID uuid.UUID,
) (map[uuid.UUID]int, error) {
	rows, err := s.Pool.Query(ctx,
		`SELECT event_id, count(*) FROM event_comments
		  WHERE project_id=$1 AND deleted_at IS NULL
		  GROUP BY event_id`,
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

// EventCommentByID читает комментарий проекта (для проверки автора перед удалением и
// проверки родителя при ответе).
func (s *Store) EventCommentByID(
	ctx context.Context, projectID, id uuid.UUID,
) (*EventComment, error) {
	return qOne[EventComment](ctx, s.Pool,
		`SELECT `+eventCommentColumns+`
		   FROM event_comments c JOIN users u ON u.id = c.user_id
		  WHERE c.id=$1 AND c.project_id=$2`, id, projectID)
}

// DeleteEventComment помечает комментарий удалённым.
//
// Мягкое удаление, а не `DELETE` (миграция 0023): с ветками жёсткое удаление уносило бы
// либо чужие ответы (каскад), либо смысл разговора (висящая ветка). Тело вычищается сразу:
// «удалено» должно значить «слов больше нет», а не «спрятано от глаз».
//
// Условие «чей» — в запросе, а не в проверке перед ним: иначе между проверкой и удалением
// остаётся щель, а тут речь о чужом тексте.
func (s *Store) DeleteEventComment(
	ctx context.Context, projectID, id, userID uuid.UUID,
) error {
	tag, err := s.Pool.Exec(ctx,
		`UPDATE event_comments SET deleted_at = now(), body = ''
		  WHERE id=$1 AND project_id=$2 AND user_id=$3 AND deleted_at IS NULL`,
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
