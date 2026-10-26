package store

// store_comment_mentions.go — упоминания людей в обсуждении (миграция 0024).
//
// Упоминание — это связь «в этом комментарии позвали вот этого человека», а не украшение
// текста. Хранится только для участников проекта: человек вне проекта комментарий всё равно
// не увидит, и уведомлять его значило бы звать в закрытую дверь (и выдавать существование
// проекта).

import (
	"context"

	"github.com/google/uuid"
)

// MentionCandidate — участник проекта, которого можно упомянуть: ник и имя для подсказки.
type MentionCandidate struct {
	UserID      uuid.UUID `db:"id" json:"user_id"`
	Username    string    `db:"username" json:"username"`
	DisplayName string    `db:"display_name" json:"display_name"`
}

// ProjectMentionCandidates — кого в этом проекте можно упомянуть.
//
// Владелец плюс участники команды. Без ника человек в списке не появляется: упоминание — это
// `@ник`, и предлагать того, кого нельзя набрать, бессмысленно.
func (s *Store) ProjectMentionCandidates(
	ctx context.Context, projectID uuid.UUID,
) ([]MentionCandidate, error) {
	return qAll[MentionCandidate](ctx, s.Pool,
		`SELECT DISTINCT u.id, u.username,
		        COALESCE(NULLIF(u.display_name, ''), u.username) AS display_name
		   FROM users u
		  WHERE u.username <> ''
		    AND (u.id = (SELECT p.owner_id FROM projects p WHERE p.id = $1)
		         OR EXISTS (SELECT 1 FROM team_memberships tm
		                     WHERE tm.project_id = $1 AND tm.user_id = u.id))
		  ORDER BY display_name`, projectID)
}

// AddCommentMentions сохраняет упоминания комментария.
//
// `ON CONFLICT DO NOTHING`: один человек — одна строка, сколько бы раз он ни был упомянут, и
// повторная запись (если её когда-нибудь вызовут дважды) не ошибка.
func (s *Store) AddCommentMentions(
	ctx context.Context, commentID uuid.UUID, userIDs []uuid.UUID,
) error {
	if len(userIDs) == 0 {
		return nil
	}
	_, err := s.Pool.Exec(ctx,
		`INSERT INTO comment_mentions (comment_id, user_id)
		 SELECT $1, unnest($2::uuid[])
		 ON CONFLICT (comment_id, user_id) DO NOTHING`,
		commentID, userIDs)
	return err
}

// CommentMentionedUsers — кого упомянули в конкретном комментарии (для проверок и тестов).
func (s *Store) CommentMentionedUsers(ctx context.Context, commentID uuid.UUID) ([]uuid.UUID, error) {
	rows, err := s.Pool.Query(ctx,
		`SELECT user_id FROM comment_mentions WHERE comment_id = $1 ORDER BY user_id`, commentID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []uuid.UUID
	for rows.Next() {
		var id uuid.UUID
		if err := rows.Scan(&id); err != nil {
			return nil, err
		}
		out = append(out, id)
	}
	return out, rows.Err()
}
