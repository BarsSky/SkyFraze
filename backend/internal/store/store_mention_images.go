package store

// store_mention_images.go — картинка у упоминания карточки в кадре (0.93.0).
//
// Фича из docs/entity-links.md §3.4.1: в карточке упоминания привязывается вложение проекта,
// которое показывает «как это выглядит». Здесь только связь «пара (карточка, кадр) → вложение»:
// сам файл живёт в assets (квота, пережатие, дедупликация, архив переноса — всё уже там).

import (
	"context"
	"errors"

	"github.com/google/uuid"

	"github.com/jackc/pgx/v5"
)

// MentionImage — привязанная картинка упоминания.
type MentionImage struct {
	ProjectID uuid.UUID `db:"project_id" json:"project_id"`
	EntityID  uuid.UUID `db:"entity_id" json:"entity_id"`
	EventID   uuid.UUID `db:"event_id" json:"event_id"`
	AssetID   uuid.UUID `db:"asset_id" json:"asset_id"`
}

const mentionImageColumns = `project_id, entity_id, event_id, asset_id`

// ListMentionImages — все привязки проекта одной выборкой.
//
// Панель «Связи» открывается на вкладке и показывает карточки всех персонажей сразу: отдельный
// запрос на пару означал бы N обращений к базе ради одного экрана.
func (s *Store) ListMentionImages(ctx context.Context, projectID uuid.UUID) ([]MentionImage, error) {
	return qAll[MentionImage](ctx, s.Pool,
		`SELECT `+mentionImageColumns+` FROM mention_images
		  WHERE project_id = $1
		  ORDER BY created_at`, projectID)
}

// MentionImage — привязка конкретной пары (nil, если картинки нет).
func (s *Store) MentionImage(
	ctx context.Context, projectID, entityID, eventID uuid.UUID,
) (*MentionImage, error) {
	row, err := qOne[MentionImage](ctx, s.Pool,
		`SELECT `+mentionImageColumns+` FROM mention_images
		  WHERE project_id = $1 AND entity_id = $2 AND event_id = $3`,
		projectID, entityID, eventID)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil
	}
	return row, err
}

// SetMentionImage привязывает картинку к паре, заменяя прежнюю.
//
// Замена, а не отказ: «поставь другую» — обычное действие, и человек не должен сначала отвязывать.
func (s *Store) SetMentionImage(
	ctx context.Context, projectID, entityID, eventID, assetID, userID uuid.UUID,
) (*MentionImage, error) {
	return qOne[MentionImage](ctx, s.Pool,
		`INSERT INTO mention_images (project_id, entity_id, event_id, asset_id, created_by)
		 VALUES ($1, $2, $3, $4, $5)
		 ON CONFLICT (entity_id, event_id)
		 DO UPDATE SET asset_id = EXCLUDED.asset_id, created_by = EXCLUDED.created_by,
		               created_at = now()
		 RETURNING `+mentionImageColumns,
		projectID, entityID, eventID, assetID, userID)
}

// DeleteMentionImage убирает привязку. false — привязки не было (это не ошибка: повторное
// «отвязать» из двух вкладок должно просто сработать).
func (s *Store) DeleteMentionImage(
	ctx context.Context, projectID, entityID, eventID uuid.UUID,
) (bool, error) {
	tag, err := s.Pool.Exec(ctx,
		`DELETE FROM mention_images WHERE project_id = $1 AND entity_id = $2 AND event_id = $3`,
		projectID, entityID, eventID)
	if err != nil {
		return false, err
	}
	return tag.RowsAffected() > 0, nil
}
