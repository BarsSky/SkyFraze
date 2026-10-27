package store

// store_entity.go — карточки сущностей проекта: персонажи, места, темы (миграция 0030).
//
// Карточка — это идентичность слова: имя, алиасы (падежи, краткие формы) и описание.
// Связь «сущность появляется в кадре» появится в фазе 2 (упоминания с якорями); здесь —
// только сами карточки. Уникальность имени в проекте держит БД, а не код: два человека,
// создающие «Анну» одновременно, должны получить отказ, а не двух «Анн».

import (
	"context"
	"errors"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgconn"
)

// EntityKind — вид сущности.
type EntityKind string

const (
	// EntityCharacter — персонаж: «Анна», «Сторож».
	EntityCharacter EntityKind = "character"
	// EntityPlace — место: «Дом на холме», «Вокзал».
	EntityPlace EntityKind = "place"
	// EntityTheme — тема/мотив/предмет: «Письмо», «Долг».
	EntityTheme EntityKind = "theme"
)

// ParseEntityKind разбирает СТАРТОВЫЙ вид сущности (character/place/theme).
//
// С 0.81.0 виды карточек — строки таблицы `project_entity_types`, и этой функцией проверять
// карточку нельзя: она знает только три стартовых ключа. Оставлена для мест, где речь именно о
// стартовых типах (значения по умолчанию, обратная совместимость).
func ParseEntityKind(raw string) (EntityKind, bool) {
	switch EntityKind(raw) {
	case EntityCharacter:
		return EntityCharacter, true
	case EntityPlace:
		return EntityPlace, true
	case EntityTheme:
		return EntityTheme, true
	default:
		return "", false
	}
}

// ValidEntityKindKey проверяет ФОРМУ ключа типа карточки (0.81.0).
//
// Существование типа проверяется по проекту отдельно; здесь — только то, что ключ вообще может
// быть ключом: строчная латиница, цифры, дефис, подчёркивание, до 32 знаков. Миграция 0034 держит
// то же правило CHECK-ом, поэтому ключ, прошедший эту проверку, не упрётся в базу.
func ValidEntityKindKey(raw string) bool {
	if raw == "" || len(raw) > 32 {
		return false
	}
	for i, r := range raw {
		lower := r >= 'a' && r <= 'z'
		digit := r >= '0' && r <= '9'
		extra := i > 0 && (r == '-' || r == '_')
		if !lower && !digit && !extra {
			return false
		}
	}
	return true
}

// ProjectEntity — карточка сущности.
type ProjectEntity struct {
	ID          uuid.UUID  `db:"id" json:"id"`
	ProjectID   uuid.UUID  `db:"project_id" json:"-"`
	Kind        string     `db:"kind" json:"kind"`
	Name        string     `db:"name" json:"name"`
	Aliases     []string   `db:"aliases" json:"aliases"`
	Description string     `db:"description" json:"description"`
	Color       string     `db:"color" json:"color"`
	CreatedBy   *uuid.UUID `db:"created_by" json:"-"`
	CreatedAt   time.Time  `db:"created_at" json:"created_at"`
	UpdatedAt   time.Time  `db:"updated_at" json:"updated_at"`
}

const entityColumns = `id, project_id, kind, name, aliases, description, color,
	created_by, created_at, updated_at`

// ErrEntityExists — имя занято в этом проекте (без учёта регистра).
var ErrEntityExists = errors.New("сущность с таким именем уже есть в проекте")

// EntityUpdate — что менять в карточке. nil — не трогать (тот же контракт, что у профиля
// человека: сохранение одного поля не должно стирать остальные).
type EntityUpdate struct {
	Kind        *string
	Name        *string
	Description *string
	Color       *string
	Aliases     *[]string
}

// CreateEntity создаёт карточку.
func (s *Store) CreateEntity(ctx context.Context, e ProjectEntity) (*ProjectEntity, error) {
	row, err := qOne[ProjectEntity](ctx, s.Pool,
		`INSERT INTO project_entities (project_id, kind, name, aliases, description, color, created_by)
		 VALUES ($1, $2, $3, $4, $5, $6, $7)
		 RETURNING `+entityColumns,
		e.ProjectID, e.Kind, e.Name, e.Aliases, e.Description, e.Color, e.CreatedBy)
	if err != nil {
		if isUniqueViolation(err) {
			return nil, ErrEntityExists
		}
		return nil, err
	}
	return row, nil
}

// ListEntities читает карточки проекта (по виду, затем по имени).
func (s *Store) ListEntities(ctx context.Context, projectID uuid.UUID) ([]ProjectEntity, error) {
	return qAll[ProjectEntity](ctx, s.Pool,
		`SELECT `+entityColumns+`
		   FROM project_entities
		  WHERE project_id = $1
		  ORDER BY kind, lower(name)`, projectID)
}

// EntityByID находит карточку в проекте.
func (s *Store) EntityByID(ctx context.Context, projectID, id uuid.UUID) (*ProjectEntity, error) {
	return qOne[ProjectEntity](ctx, s.Pool,
		`SELECT `+entityColumns+`
		   FROM project_entities
		  WHERE project_id = $1 AND id = $2`, projectID, id)
}

// EntityByName ищет карточку по имени (без учёта регистра) — для помощника, который знает
// имя персонажа, но не его идентификатор.
func (s *Store) EntityByName(
	ctx context.Context, projectID uuid.UUID, name string,
) (*ProjectEntity, error) {
	return qOne[ProjectEntity](ctx, s.Pool,
		`SELECT `+entityColumns+`
		   FROM project_entities
		  WHERE project_id = $1 AND lower(name) = lower($2)`, projectID, name)
}

// UpdateEntity меняет поля карточки.
func (s *Store) UpdateEntity(
	ctx context.Context, projectID, id uuid.UUID, upd EntityUpdate,
) (*ProjectEntity, error) {
	row, err := qOne[ProjectEntity](ctx, s.Pool,
		`UPDATE project_entities
		    SET kind        = COALESCE($3, kind),
		        name        = COALESCE($4, name),
		        description = COALESCE($5, description),
		        color       = COALESCE($6, color),
		        aliases     = COALESCE($7, aliases),
		        updated_at  = now()
		  WHERE project_id = $1 AND id = $2
		  RETURNING `+entityColumns,
		projectID, id, upd.Kind, upd.Name, upd.Description, upd.Color, upd.Aliases)
	if err != nil {
		if isUniqueViolation(err) {
			return nil, ErrEntityExists
		}
		return nil, err
	}
	return row, nil
}

// DeleteEntity удаляет карточку.
//
// Условие «свой проект» — в запросе: карточка чужого проекта не должна удаляться даже при
// верно угаданном идентификаторе.
func (s *Store) DeleteEntity(ctx context.Context, projectID, id uuid.UUID) error {
	tag, err := s.Pool.Exec(ctx,
		`DELETE FROM project_entities WHERE project_id = $1 AND id = $2`, projectID, id)
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		return ErrNotFound
	}
	return nil
}

// isUniqueViolation — нарушение уникального индекса (SQLSTATE 23505).
func isUniqueViolation(err error) bool {
	var pgErr *pgconn.PgError
	return errors.As(err, &pgErr) && pgErr.Code == "23505"
}

// isForeignKeyViolation — нарушение внешнего ключа (SQLSTATE 23503).
//
// Нужно удалению типа карточки: вид карточки ссылается на тип, и БД отказывает, если у типа
// ещё есть карточки. Это не сбой, а правило — им сервис отвечает человеку списком карточек.
func isForeignKeyViolation(err error) bool {
	var pgErr *pgconn.PgError
	return errors.As(err, &pgErr) && pgErr.Code == "23503"
}
