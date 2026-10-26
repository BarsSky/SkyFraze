package store

// store_comment_reactions.go — реакции на замечания (миграция 0025).
//
// Реакция — это не комментарий: она не занимает места в ветке и не создаёт уведомлений.
// Два вида, оба про работу: «согласен» (замечание принято) и «сделано» (правка внесена).
// Набор фиксирован схемой, а не «любой эмодзи»: замечание — не пост в соцсети, и голосование
// за него превращало бы критику в рейтинг.

import (
	"context"

	"github.com/google/uuid"
)

// ReactionKind — вид реакции.
type ReactionKind string

const (
	// ReactionAgree — «согласен»: замечание принято к работе.
	ReactionAgree ReactionKind = "agree"
	// ReactionDone — «сделано»: правка внесена.
	ReactionDone ReactionKind = "done"
)

// ParseReactionKind разбирает вид реакции из строки запроса.
func ParseReactionKind(raw string) (ReactionKind, bool) {
	switch ReactionKind(raw) {
	case ReactionAgree:
		return ReactionAgree, true
	case ReactionDone:
		return ReactionDone, true
	default:
		return "", false
	}
}

// CommentReactions — сколько реакций у замечания и какие из них мои.
//
// `Mine` нужен интерфейсу, чтобы нажатая кнопка была нажатой: считать это в браузере по
// списку людей — лишний круг данных, а «моё ли это» — один флаг.
type CommentReactions struct {
	Agree int      `json:"agree"`
	Done  int      `json:"done"`
	Mine  []string `json:"mine"`
}

// AddCommentReaction ставит реакцию. Повтор не ошибка и новых строк не создаёт.
func (s *Store) AddCommentReaction(
	ctx context.Context, commentID, userID uuid.UUID, kind ReactionKind,
) error {
	_, err := s.Pool.Exec(ctx,
		`INSERT INTO comment_reactions (comment_id, user_id, kind)
		 VALUES ($1, $2, $3)
		 ON CONFLICT (comment_id, user_id, kind) DO NOTHING`,
		commentID, userID, string(kind))
	return err
}

// RemoveCommentReaction снимает реакцию. Отсутствующая реакция — не ошибка: снятие
// идемпотентно, чтобы двойное нажатие не выглядело поломкой.
func (s *Store) RemoveCommentReaction(
	ctx context.Context, commentID, userID uuid.UUID, kind ReactionKind,
) error {
	_, err := s.Pool.Exec(ctx,
		`DELETE FROM comment_reactions
		  WHERE comment_id = $1 AND user_id = $2 AND kind = $3`,
		commentID, userID, string(kind))
	return err
}

// CommentReactionStats — реакции по набору комментариев одним запросом.
//
// Один запрос, а не «по запросу на комментарий»: в обсуждении кадра их бывает два десятка, и
// N+1 здесь заметен сразу — панель под кадром грузится на каждый выбор строки дерева.
func (s *Store) CommentReactionStats(
	ctx context.Context, commentIDs []uuid.UUID, userID uuid.UUID,
) (map[uuid.UUID]CommentReactions, error) {
	out := make(map[uuid.UUID]CommentReactions, len(commentIDs))
	if len(commentIDs) == 0 {
		return out, nil
	}
	rows, err := s.Pool.Query(ctx,
		`SELECT comment_id,
		        count(*) FILTER (WHERE kind = 'agree') AS agree,
		        count(*) FILTER (WHERE kind = 'done')  AS done,
		        bool_or(user_id = $2 AND kind = 'agree') AS mine_agree,
		        bool_or(user_id = $2 AND kind = 'done')  AS mine_done
		   FROM comment_reactions
		  WHERE comment_id = ANY($1::uuid[])
		  GROUP BY comment_id`,
		commentIDs, userID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	for rows.Next() {
		var (
			id          uuid.UUID
			agree, done int
			mineAgree   bool
			mineDone    bool
		)
		if err := rows.Scan(&id, &agree, &done, &mineAgree, &mineDone); err != nil {
			return nil, err
		}
		stats := CommentReactions{Agree: agree, Done: done, Mine: []string{}}
		if mineAgree {
			stats.Mine = append(stats.Mine, string(ReactionAgree))
		}
		if mineDone {
			stats.Mine = append(stats.Mine, string(ReactionDone))
		}
		out[id] = stats
	}
	return out, rows.Err()
}
