package store

// store_entity_links.go — связи между карточками мира (миграция 0032).
//
// Связь направленная: «Аня живёт на Земле» — это from=Аня, to=Земля, label=«живёт на».
// Подпись принадлежит связи, а не карточке: из неё нельзя автоматически вывести обратную
// («место жительства Ани»), поэтому обратную сторону показывает интерфейс, а не сервер.

import (
	"context"
	"errors"
	"time"

	"github.com/google/uuid"
)

// EntityLink — связь двух карточек.
type EntityLink struct {
	ID         uuid.UUID  `db:"id" json:"id"`
	ProjectID  uuid.UUID  `db:"project_id" json:"-"`
	FromEntity uuid.UUID  `db:"from_entity" json:"from_entity"`
	ToEntity   uuid.UUID  `db:"to_entity" json:"to_entity"`
	Label      string     `db:"label" json:"label"`
	CreatedBy  *uuid.UUID `db:"created_by" json:"-"`
	CreatedAt  time.Time  `db:"created_at" json:"created_at"`
}

const entityLinkColumns = `id, project_id, from_entity, to_entity, label, created_by, created_at`

// ErrEntityLinkExists — такая связь уже есть (та же пара и та же подпись без учёта регистра).
var ErrEntityLinkExists = errors.New("такая связь уже есть")

// AddEntityLink создаёт связь.
//
// Оба конца проверяются в том же запросе: `INSERT … SELECT … WHERE EXISTS`. Отдельная
// проверка «карточки из этого проекта?» оставляла бы щель, через которую можно было бы
// связать карточку чужого проекта, зная только идентификатор.
func (s *Store) AddEntityLink(ctx context.Context, link EntityLink) (*EntityLink, error) {
	row, err := qOne[EntityLink](ctx, s.Pool,
		`INSERT INTO project_entity_links (project_id, from_entity, to_entity, label, created_by)
		 SELECT $1, $2, $3, $4, $5
		  WHERE EXISTS (SELECT 1 FROM project_entities WHERE id = $2 AND project_id = $1)
		    AND EXISTS (SELECT 1 FROM project_entities WHERE id = $3 AND project_id = $1)
		 RETURNING `+entityLinkColumns,
		link.ProjectID, link.FromEntity, link.ToEntity, link.Label, link.CreatedBy)
	if err != nil {
		if isUniqueViolation(err) {
			return nil, ErrEntityLinkExists
		}
		if errors.Is(err, ErrNotFound) {
			// Вставки не произошло: одна из карточек не из этого проекта (или её нет).
			return nil, ErrNotFound
		}
		return nil, err
	}
	return row, nil
}

// ListEntityLinks — все связи проекта.
//
// Целиком, а не по одной карточке: интерфейсу нужны и прямые, и обратные стороны сразу
// («на этой карточке: Аня — живёт на»), а связей в проекте десятки, не тысячи.
func (s *Store) ListEntityLinks(
	ctx context.Context, projectID uuid.UUID,
) ([]EntityLink, error) {
	return qAll[EntityLink](ctx, s.Pool,
		`SELECT `+entityLinkColumns+`
		   FROM project_entity_links
		  WHERE project_id = $1
		  ORDER BY created_at`, projectID)
}

// DeleteEntityLink удаляет связь ПРОЕКТА (чужой идентификатор ничего не удалит).
func (s *Store) DeleteEntityLink(ctx context.Context, projectID, id uuid.UUID) error {
	tag, err := s.Pool.Exec(ctx,
		`DELETE FROM project_entity_links WHERE project_id = $1 AND id = $2`, projectID, id)
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		return ErrNotFound
	}
	return nil
}

// CountEntityLinks — сколько связей у карточки в любую сторону (предел на карточку).
func (s *Store) CountEntityLinks(ctx context.Context, entityID uuid.UUID) (int, error) {
	var count int
	err := s.Pool.QueryRow(ctx,
		`SELECT count(*) FROM project_entity_links
		  WHERE from_entity = $1 OR to_entity = $1`, entityID).Scan(&count)
	return count, err
}
