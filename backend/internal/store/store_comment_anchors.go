package store

// store_comment_anchors.go — якоря замечаний к фрагменту текста (миграция 0026).
//
// Якорь — это не «номер символа», а `Y.RelativePosition`: позиция, привязанная к конкретным
// символам CRDT, поэтому вставка абзаца выше не сдвигает замечание на другой текст
// (docs/fragment-comments.md §4). Храним закодированные байты как есть — разбирать их умеет
// и клиент (Yjs), и сервер (ygo).

import (
	"context"

	"github.com/google/uuid"
)

// CommentAnchor — привязка замечания к фрагменту текста кадра.
type CommentAnchor struct {
	// Field — поле кадра: пока только `body`.
	Field string `json:"field"`
	// Start/End — Y.RelativePosition в закодированном виде. В JSON уходят base64-строками
	// (encoding/json кодирует []byte именно так): клиент резолвит их в живом документе.
	Start []byte `json:"start"`
	End   []byte `json:"end"`
	// Quote — выделенный текст на момент написания. Нужен человеку, когда якорь больше не
	// резолвится: без цитаты замечание к исчезнувшему фрагменту не прочитать.
	Quote string `json:"quote"`
}

// SetCommentAnchor прикрепляет к комментарию якорь. Повторная запись заменяет прежнюю:
// у комментария один якорь.
func (s *Store) SetCommentAnchor(
	ctx context.Context, commentID uuid.UUID, anchor CommentAnchor,
) error {
	_, err := s.Pool.Exec(ctx,
		`INSERT INTO comment_anchors (comment_id, field, start_relpos, end_relpos, quote)
		 VALUES ($1, $2, $3, $4, $5)
		 ON CONFLICT (comment_id) DO UPDATE
		    SET field = EXCLUDED.field,
		        start_relpos = EXCLUDED.start_relpos,
		        end_relpos = EXCLUDED.end_relpos,
		        quote = EXCLUDED.quote`,
		commentID, anchor.Field, anchor.Start, anchor.End, anchor.Quote)
	return err
}

// CommentAnchors — якоря по набору комментариев одним запросом.
//
// Один запрос, а не по запросу на комментарий: обсуждение кадра грузится на каждый выбор
// строки дерева, и N+1 здесь был бы заметен сразу (то же решение, что у реакций и счётчиков).
func (s *Store) CommentAnchors(
	ctx context.Context, commentIDs []uuid.UUID,
) (map[uuid.UUID]CommentAnchor, error) {
	out := make(map[uuid.UUID]CommentAnchor, len(commentIDs))
	if len(commentIDs) == 0 {
		return out, nil
	}
	rows, err := s.Pool.Query(ctx,
		`SELECT comment_id, field, start_relpos, end_relpos, quote
		   FROM comment_anchors
		  WHERE comment_id = ANY($1::uuid[])`, commentIDs)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	for rows.Next() {
		var (
			id     uuid.UUID
			anchor CommentAnchor
		)
		if err := rows.Scan(&id, &anchor.Field, &anchor.Start, &anchor.End, &anchor.Quote); err != nil {
			return nil, err
		}
		out[id] = anchor
	}
	return out, rows.Err()
}
