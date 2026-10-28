package store

// store_entity_types.go — свои типы карточек (миграция 0034, docs/entity-types.md).
//
// Тип — строка таблицы проекта, а не константа в коде: по нему группируют списки, матрицу и
// отчёты, поэтому «Фракция» и «фракция» не должны становиться двумя разными группами. Отсюда
// два поля вместо одного: `key` — машинное имя (латиница, неизменяемое), `title` — то, что видит
// человек и что можно переименовать.

import (
	"context"
	"encoding/json"
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

// EntityCardTemplate — заготовка карточки у типа (0.85.0, миграция 0035).
//
// Зачем: тип отвечает «что это за класс» («Фракция»), а заготовка — «что написать в карточке
// этого класса»: типичное описание с подстановкой `{{name}}` и набор алиасов. Одна колонка
// вместо сущности «шаблон карточки»: шаблон без типа не имеет смысла.
type EntityCardTemplate struct {
	Description string   `json:"description,omitempty"`
	Aliases     []string `json:"aliases,omitempty"`
}

// Empty — заготовки нет: форма карточки остаётся пустой.
func (t EntityCardTemplate) Empty() bool {
	return t.Description == "" && len(t.Aliases) == 0
}

// Same — та же заготовка (для идемпотентного применения шаблона проекта).
func (t EntityCardTemplate) Same(other EntityCardTemplate) bool {
	if t.Description != other.Description || len(t.Aliases) != len(other.Aliases) {
		return false
	}
	for i := range t.Aliases {
		if t.Aliases[i] != other.Aliases[i] {
			return false
		}
	}
	return true
}

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
	// CardTemplate — что подставить в форму новой карточки этого типа (0.85.0).
	CardTemplate EntityCardTemplate `db:"card_template" json:"card_template"`
	CreatedAt    time.Time          `db:"created_at" json:"created_at"`
}

// ErrEntityTypeExists — такой ключ уже занят в проекте.
var ErrEntityTypeExists = errors.New("тип с таким ключом уже есть в проекте")

const entityTypeColumns = `project_id, key, title, color, icon, position, is_default, card_template, created_at`

// cardTemplateJSON — заготовка в виде jsonb-параметра.
//
// Маршалим сами и приводим параметр к jsonb: pgx умеет отдавать структуру как json, но
// `$6::jsonb` не оставляет места для догадок о типе параметра.
func cardTemplateJSON(t EntityCardTemplate) string {
	raw, err := json.Marshal(t)
	if err != nil {
		return "{}"
	}
	return string(raw)
}

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
		`INSERT INTO project_entity_types (project_id, key, title, color, icon, position, is_default, card_template)
		 VALUES ($1, $2, $3, $4, $5,
		         COALESCE((SELECT max(position) + 1 FROM project_entity_types WHERE project_id = $1), 3),
		         false, $6::jsonb)
		 RETURNING `+entityTypeColumns,
		t.ProjectID, t.Key, t.Title, t.Color, t.Icon, cardTemplateJSON(t.CardTemplate))
	if err != nil {
		if isUniqueViolation(err) {
			return nil, ErrEntityTypeExists
		}
		return nil, err
	}
	return row, nil
}

// UpdateEntityType меняет НАЗВАНИЕ, цвет, значок и заготовку карточки. Ключ не меняется никогда:
// на него ссылаются карточки, экспорт и помощник.
func (s *Store) UpdateEntityType(
	ctx context.Context, projectID uuid.UUID, key, title, color, icon string,
	cardTemplate EntityCardTemplate,
) (*EntityType, error) {
	return qOne[EntityType](ctx, s.Pool,
		`UPDATE project_entity_types
		    SET title = $3, color = $4, icon = $5, card_template = $6::jsonb
		  WHERE project_id = $1 AND key = $2
		  RETURNING `+entityTypeColumns,
		projectID, key, title, color, icon, cardTemplateJSON(cardTemplate))
}

// UpsertEntityType заводит тип с заданным ключом или обновляет название, цвет, значок и
// заготовку существующего (0.85.0).
//
// Нужен переносу шаблона: ключ приезжает ИЗ шаблона (в чужом проекте он уже такой), поэтому
// выводить его из названия нельзя — иначе «Фракция» из шаблона стала бы `frakciya-2`.
// Стартовые типы можно переименовать, но их `is_default` сохраняется: удалять их по-прежнему
// нельзя, и это правило не должно зависеть от того, приехал тип шаблоном или заведён руками.
func (s *Store) UpsertEntityType(ctx context.Context, t EntityType) (*EntityType, error) {
	row, err := qOne[EntityType](ctx, s.Pool,
		`INSERT INTO project_entity_types (project_id, key, title, color, icon, position, is_default, card_template)
		 VALUES ($1, $2, $3, $4, $5,
		         COALESCE((SELECT max(position) + 1 FROM project_entity_types WHERE project_id = $1), 3),
		         $6, $7::jsonb)
		 ON CONFLICT (project_id, key) DO UPDATE
		    SET title = EXCLUDED.title,
		        color = EXCLUDED.color,
		        icon = EXCLUDED.icon,
		        card_template = EXCLUDED.card_template
		 RETURNING `+entityTypeColumns,
		t.ProjectID, t.Key, t.Title, t.Color, t.Icon, t.IsDefault, cardTemplateJSON(t.CardTemplate))
	if err != nil {
		if isUniqueViolation(err) {
			return nil, ErrEntityTypeExists
		}
		return nil, err
	}
	return row, nil
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
