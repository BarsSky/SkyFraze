package store

// store_entity_types.go — свои типы карточек (миграция 0034, docs/entity-types.md).
//
// Тип — строка таблицы проекта, а не константа в коде: по нему группируют списки, матрицу и
// отчёты, поэтому «Фракция» и «фракция» не должны становиться двумя разными группами. Отсюда
// два поля вместо одного: `key` — машинное имя (латиница, неизменяемое), `title` — то, что видит
// человек и что можно переименовать.

import (
	"context"
	"errors"
	"strings"
	"time"

	"github.com/google/uuid"
)

// Стартовые типы. Константами: на них рассчитывают карточки, экспорт и помощник.
const (
	EntityTypeCharacter = "character"
	EntityTypePlace     = "place"
	EntityTypeTheme     = "theme"
)

// DefaultEntityTypes — три типа, которые есть в каждом проекте.
var DefaultEntityTypes = []struct {
	Key   string
	Title string
	Pos   int
}{
	{EntityTypeCharacter, "Персонаж", 0},
	{EntityTypePlace, "Место", 1},
	{EntityTypeTheme, "Тема", 2},
}

// EntityType — тип карточки в проекте.
type EntityType struct {
	ProjectID uuid.UUID `db:"project_id" json:"-"`
	Key       string    `db:"key" json:"key"`
	Title     string    `db:"title" json:"title"`
	Color     string    `db:"color" json:"color"`
	Icon      string    `db:"icon" json:"icon"`
	Position  int       `db:"position" json:"position"`
	IsDefault bool      `db:"is_default" json:"is_default"`
	CreatedAt time.Time `db:"created_at" json:"created_at"`
}

// ErrEntityTypeExists — такой ключ уже занят в проекте.
var ErrEntityTypeExists = errors.New("тип с таким ключом уже есть в проекте")

const entityTypeColumns = `project_id, key, title, color, icon, position, is_default, created_at`

// EnsureEntityTypes заводит стартовые типы, если их нет.
//
// Нужно в двух местах: при создании проекта (сразу есть из чего выбрать) и при чтении списка
// (проект мог быть создан до миграции). Идемпотентно и НЕ перетирает переименование: человек
// вправе назвать «character» как угодно.
func (s *Store) EnsureEntityTypes(ctx context.Context, projectID uuid.UUID) error {
	for _, def := range DefaultEntityTypes {
		if _, err := s.Pool.Exec(ctx,
			`INSERT INTO project_entity_types (project_id, key, title, position, is_default)
			 VALUES ($1, $2, $3, $4, true)
			 ON CONFLICT (project_id, key) DO NOTHING`,
			projectID, def.Key, def.Title, def.Pos); err != nil {
			return err
		}
	}
	return nil
}

// ListEntityTypes — типы проекта в порядке показа: стартовые первыми, дальше по названию.
func (s *Store) ListEntityTypes(ctx context.Context, projectID uuid.UUID) ([]EntityType, error) {
	return qAll[EntityType](ctx, s.Pool,
		`SELECT `+entityTypeColumns+` FROM project_entity_types
		  WHERE project_id = $1
		  ORDER BY is_default DESC, position, lower(title)`, projectID)
}

// EntityTypeByKey — один тип проекта (нужен для проверки «вид существует»).
func (s *Store) EntityTypeByKey(ctx context.Context, projectID uuid.UUID, key string) (*EntityType, error) {
	return qOne[EntityType](ctx, s.Pool,
		`SELECT `+entityTypeColumns+` FROM project_entity_types
		  WHERE project_id = $1 AND key = $2`, projectID, strings.TrimSpace(key))
}

// CreateEntityType добавляет свой тип.
//
// Позиция — в конец списка: новый тип не должен прыгать выше стартовых, к которым привыкли.
func (s *Store) CreateEntityType(ctx context.Context, t EntityType) (*EntityType, error) {
	row, err := qOne[EntityType](ctx, s.Pool,
		`INSERT INTO project_entity_types (project_id, key, title, color, icon, position, is_default)
		 VALUES ($1, $2, $3, $4, $5,
		         COALESCE((SELECT max(position) + 1 FROM project_entity_types WHERE project_id = $1), 3),
		         false)
		 RETURNING `+entityTypeColumns,
		t.ProjectID, t.Key, t.Title, t.Color, t.Icon)
	if err != nil {
		if isUniqueViolation(err) {
			return nil, ErrEntityTypeExists
		}
		return nil, err
	}
	return row, nil
}

// UpdateEntityType меняет НАЗВАНИЕ, цвет и значок. Ключ не меняется никогда: на него ссылаются
// карточки, экспорт и помощник.
func (s *Store) UpdateEntityType(
	ctx context.Context, projectID uuid.UUID, key, title, color, icon string,
) (*EntityType, error) {
	return qOne[EntityType](ctx, s.Pool,
		`UPDATE project_entity_types
		    SET title = $3, color = $4, icon = $5
		  WHERE project_id = $1 AND key = $2
		  RETURNING `+entityTypeColumns,
		projectID, key, title, color, icon)
}

// DeleteEntityType удаляет свой тип. Стартовые и занятые карточками отсекает сервис, а БД
// страхует внешним ключом с ON DELETE RESTRICT.
func (s *Store) DeleteEntityType(ctx context.Context, projectID uuid.UUID, key string) error {
	tag, err := s.Pool.Exec(ctx,
		`DELETE FROM project_entity_types WHERE project_id = $1 AND key = $2`, projectID, key)
	if err != nil {
		if isForeignKeyViolation(err) {
			return ErrEntityTypeInUse
		}
		return err
	}
	if tag.RowsAffected() == 0 {
		return ErrNotFound
	}
	return nil
}

// CountEntitiesOfKind — сколько карточек носят этот тип: по числу решается, можно ли удалять.
func (s *Store) CountEntitiesOfKind(ctx context.Context, projectID uuid.UUID, key string) (int, error) {
	var count int
	if err := s.Pool.QueryRow(ctx,
		`SELECT count(*) FROM project_entities WHERE project_id = $1 AND kind = $2`,
		projectID, key).Scan(&count); err != nil {
		return 0, err
	}
	return count, nil
}

// ErrEntityTypeInUse — у типа есть карточки: удалять нельзя, сначала переведите их.
var ErrEntityTypeInUse = errors.New("в этом типе есть карточки")
