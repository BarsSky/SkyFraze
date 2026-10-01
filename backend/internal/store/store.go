// Package store — единая точка доступа к Postgres.
// Типизированные pgx-queries. Поля имеют db-теги для точного маппинга на snake_case колонки.
package store

import (
	"context"
	"errors"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"
)

type Store struct {
	Pool *pgxpool.Pool
}

func New(pool *pgxpool.Pool) *Store {
	return &Store{Pool: pool}
}

var (
	ErrNotFound = errors.New("not found")
	// ErrAlreadyExists — значение занято (ник, связь соавторов).
	ErrAlreadyExists = errors.New("already exists")
)

// querier — общий интерфейс пула и транзакции: одни и те же выборки должны
// работать и вне, и внутри транзакции (иначе логика дублируется).
type querier interface {
	Query(ctx context.Context, sql string, args ...any) (pgx.Rows, error)
}

func qOne[T any](ctx context.Context, q querier, sql string, args ...any) (*T, error) {
	rows, err := q.Query(ctx, sql, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	collected, err := pgx.CollectRows(rows, pgx.RowToStructByNameLax[T])
	if err != nil {
		return nil, err
	}
	if len(collected) == 0 {
		return nil, ErrNotFound
	}
	return &collected[0], nil
}

func qAll[T any](ctx context.Context, q querier, sql string, args ...any) ([]T, error) {
	rows, err := q.Query(ctx, sql, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	return pgx.CollectRows(rows, pgx.RowToStructByNameLax[T])
}

// ========================== Users ==========================

type User struct {
	ID           uuid.UUID `db:"id" json:"id"`
	Email        string    `db:"email" json:"email"`
	PasswordHash string    `db:"password_hash" json:"-"`
	DisplayName  string    `db:"display_name" json:"display_name"`
	// Username — ник для поиска людей (@nick). Подбирается при регистрации из
	// email, меняется в профиле; уникален без учёта регистра.
	Username string `db:"username" json:"username"`
	// Bio — краткое «о себе» для каталога людей. Предел (600 рун) проверяет
	// auth.Service: в store живёт только хранение.
	Bio string `db:"bio" json:"bio"`
	// Crafts — специализации человека на самом себе (витрина до знакомства), в
	// отличие от crafts связи соавторов, где это договорённость про общее дело.
	Crafts []string `db:"crafts" json:"crafts"`
	// Discoverable — галочка «показывать меня»: выключенная убирает человека и
	// из каталога, и из поиска соавторов.
	Discoverable bool `db:"discoverable" json:"discoverable"`
	// IsAdmin — администратор развёртывания: управляет режимом регистрации
	// и рассматривает заявки. Назначается env ADMIN_EMAILS (или первый пользователь).
	IsAdmin   bool      `db:"is_admin" json:"is_admin"`
	CreatedAt time.Time `db:"created_at" json:"created_at"`
	UpdatedAt time.Time `db:"updated_at" json:"updated_at"`
}

const userColumns = `id, email, password_hash, display_name, username, bio, crafts,
	discoverable, is_admin, created_at, updated_at`

func (s *Store) CreateUser(ctx context.Context, email, hash, name string) (*User, error) {
	return s.CreateUserWithHash(ctx, email, hash, name, false)
}

// CreateUserWithHash создаёт пользователя с готовым хэшем пароля (одобрение заявки)
// и сразу помечает администратором, если так решило развёртывание.
//
// Ник подбирается из email; если он занят — добавляется цифровой суффикс, поэтому
// INSERT повторяется. Так у каждого пользователя сразу есть ник для поиска, и
// регистрацию не приходится прерывать вопросом «придумайте ник».
func (s *Store) CreateUserWithHash(ctx context.Context, email, hash, name string, isAdmin bool) (*User, error) {
	for attempt := 0; attempt < 20; attempt++ {
		u, err := qOne[User](ctx, s.Pool,
			`INSERT INTO users (email, password_hash, display_name, username, is_admin)
			 VALUES ($1,$2,$3,$4,$5) RETURNING `+userColumns,
			email, hash, name, suggestUsername(email, attempt), isAdmin)
		if err == nil {
			return u, nil
		}
		if !isUsernameConflict(err) {
			return nil, err
		}
	}
	return nil, ErrAlreadyExists
}

func (s *Store) GetUserByEmail(ctx context.Context, email string) (*User, error) {
	return qOne[User](ctx, s.Pool,
		`SELECT `+userColumns+` FROM users WHERE email=$1`,
		email)
}

func (s *Store) GetUserByID(ctx context.Context, id uuid.UUID) (*User, error) {
	return qOne[User](ctx, s.Pool,
		`SELECT `+userColumns+` FROM users WHERE id=$1`,
		id)
}

// SetUserAdmin включает/выключает администратора. Возвращает ErrNotFound,
// если пользователя нет.
func (s *Store) SetUserAdmin(ctx context.Context, email string, isAdmin bool) error {
	tag, err := s.Pool.Exec(ctx,
		`UPDATE users SET is_admin=$2, updated_at=now() WHERE email=$1`, email, isAdmin)
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		return ErrNotFound
	}
	return nil
}

// CountAdmins — сколько администраторов есть сейчас (нужно, чтобы не остаться
// без единственного способа управлять развёртыванием).
func (s *Store) CountAdmins(ctx context.Context) (int, error) {
	var n int
	err := s.Pool.QueryRow(ctx, `SELECT COUNT(*) FROM users WHERE is_admin`).Scan(&n)
	return n, err
}

// ListUsers — для админки: кто вообще есть на инсталляции.
func (s *Store) ListUsers(ctx context.Context) ([]User, error) {
	return qAll[User](ctx, s.Pool,
		`SELECT `+userColumns+` FROM users ORDER BY created_at`)
}

// ProfileUpdate — правки профиля. nil-поле означает «не прислали»: интерфейс
// отправляет только изменённое, и сохранение имени не должно стирать «о себе»,
// специализации или галочку «показывать меня».
type ProfileUpdate struct {
	DisplayName  string
	Username     string
	Bio          *string
	Crafts       *[]string
	Discoverable *bool
}

// UpdateProfile меняет профиль одной операцией: интерфейс отправляет поля
// вместе, а ник должен остаться уникальным.
//
// COALESCE вместо ветвлений в Go: одна и та же строка обновляет и «только имя»,
// и весь профиль, поэтому нет риска, что какое-то сочетание полей забудет
// дописать updated_at или снесёт чужое поле.
func (s *Store) UpdateProfile(ctx context.Context, userID uuid.UUID, upd ProfileUpdate) (*User, error) {
	u, err := qOne[User](ctx, s.Pool,
		`UPDATE users SET display_name=$2, username=$3,
		        bio          = COALESCE($4, bio),
		        crafts       = COALESCE($5::text[], crafts),
		        discoverable = COALESCE($6, discoverable),
		        updated_at=now()
		  WHERE id=$1 RETURNING `+userColumns,
		userID, upd.DisplayName, upd.Username, upd.Bio, upd.Crafts, upd.Discoverable)
	if err != nil {
		if isUsernameConflict(err) {
			return nil, ErrAlreadyExists
		}
		return nil, err
	}
	return u, nil
}

// ========================== Projects ==========================

type Project struct {
	ID          uuid.UUID `db:"id" json:"id"`
	OwnerID     uuid.UUID `db:"owner_id" json:"owner_id"`
	Title       string    `db:"title" json:"title"`
	Description string    `db:"description" json:"description"`
	CreatedAt   time.Time `db:"created_at" json:"created_at"`
	UpdatedAt   time.Time `db:"updated_at" json:"updated_at"`
	// Публичная лента: проект виден всем ТОЛЬКО при IsPublic = true.
	IsPublic    bool       `db:"is_public" json:"is_public"`
	PublicSlug  *string    `db:"public_slug" json:"public_slug,omitempty"`
	PublishedAt *time.Time `db:"published_at" json:"published_at,omitempty"`
	ViewsCount  int        `db:"views_count" json:"views_count"`
}

const projectColumns = `id, owner_id, title, description, created_at, updated_at,
	is_public, public_slug, published_at, views_count`

func (s *Store) CreateProject(ctx context.Context, ownerID uuid.UUID, title, desc string) (*Project, error) {
	return qOne[Project](ctx, s.Pool,
		`INSERT INTO projects (owner_id, title, description)
		 VALUES ($1,$2,$3) RETURNING `+projectColumns,
		ownerID, title, desc)
}

func (s *Store) GetProject(ctx context.Context, id uuid.UUID) (*Project, error) {
	return qOne[Project](ctx, s.Pool,
		`SELECT `+projectColumns+` FROM projects WHERE id=$1`, id)
}

func (s *Store) ListProjectsForUser(ctx context.Context, userID uuid.UUID) ([]Project, error) {
	return qAll[Project](ctx, s.Pool,
		`SELECT p.id, p.owner_id, p.title, p.description, p.created_at, p.updated_at,
		        p.is_public, p.public_slug, p.published_at, p.views_count
		   FROM projects p
		  WHERE p.owner_id = $1
		     OR EXISTS (SELECT 1 FROM team_memberships tm
		                 WHERE tm.project_id = p.id AND tm.user_id = $1)
		  ORDER BY p.created_at DESC`, userID)
}

func (s *Store) UpdateProject(ctx context.Context, id uuid.UUID, title, desc string) error {
	_, err := s.Pool.Exec(ctx,
		`UPDATE projects SET title=$2, description=$3 WHERE id=$1`, id, title, desc)
	return err
}

func (s *Store) DeleteProject(ctx context.Context, id uuid.UUID) error {
	_, err := s.Pool.Exec(ctx, `DELETE FROM projects WHERE id=$1`, id)
	return err
}

// ========================== Team Memberships ==========================

type Role string

const (
	RoleOwner  Role = "owner"
	RoleEditor Role = "editor"
	RoleViewer Role = "viewer"
)

// TeamMember — для ListMembers (с JOIN users). Для простого membership используется MembershipLite.
type TeamMember struct {
	ProjectID   uuid.UUID `db:"project_id" json:"project_id"`
	UserID      uuid.UUID `db:"user_id" json:"user_id"`
	Role        Role      `db:"role" json:"role"`
	AddedAt     time.Time `db:"added_at" json:"added_at"`
	Email       string    `db:"email" json:"email,omitempty"`
	DisplayName string    `db:"display_name" json:"display_name,omitempty"`
	Username    string    `db:"username" json:"username,omitempty"`
}

// MembershipLite — то, что возвращает GetMembership (без JOIN).
type MembershipLite struct {
	ProjectID uuid.UUID `db:"project_id" json:"project_id"`
	UserID    uuid.UUID `db:"user_id" json:"user_id"`
	Role      Role      `db:"role" json:"role"`
	AddedAt   time.Time `db:"added_at" json:"added_at"`
	// Coauthor — доступ выдан соавторством, а не участием в команде: роль viewer
	// и никаких правок. Выставляется только в памяти (в team_memberships такого нет).
	Coauthor bool `db:"-" json:"coauthor,omitempty"`
}

func (s *Store) AddMembership(ctx context.Context, projectID, userID uuid.UUID, role Role) error {
	_, err := s.Pool.Exec(ctx,
		`INSERT INTO team_memberships (project_id, user_id, role) VALUES ($1,$2,$3)
		 ON CONFLICT (project_id, user_id) DO UPDATE SET role = EXCLUDED.role`,
		projectID, userID, role)
	return err
}

func (s *Store) GetMembership(ctx context.Context, projectID, userID uuid.UUID) (*MembershipLite, error) {
	return qOne[MembershipLite](ctx, s.Pool,
		`SELECT project_id, user_id, role, added_at
		   FROM team_memberships WHERE project_id=$1 AND user_id=$2`,
		projectID, userID)
}

func (s *Store) ListMembers(ctx context.Context, projectID uuid.UUID) ([]TeamMember, error) {
	return qAll[TeamMember](ctx, s.Pool,
		`SELECT tm.project_id, tm.user_id, tm.role, tm.added_at,
		        u.email, u.display_name, u.username
		   FROM team_memberships tm
		   JOIN users u ON u.id = tm.user_id
		  WHERE tm.project_id = $1
		  ORDER BY tm.added_at`, projectID)
}

func (s *Store) RemoveMembership(ctx context.Context, projectID, userID uuid.UUID) error {
	_, err := s.Pool.Exec(ctx,
		`DELETE FROM team_memberships WHERE project_id=$1 AND user_id=$2`, projectID, userID)
	return err
}

// ========================== Invitations ==========================

type Invitation struct {
	ID         uuid.UUID  `db:"id" json:"id"`
	ProjectID  uuid.UUID  `db:"project_id" json:"project_id"`
	Email      string     `db:"email" json:"email"`
	Role       Role       `db:"role" json:"role"`
	Token      string     `db:"token" json:"token"`
	InvitedBy  uuid.UUID  `db:"invited_by" json:"invited_by"`
	ExpiresAt  time.Time  `db:"expires_at" json:"expires_at"`
	AcceptedAt *time.Time `db:"accepted_at" json:"accepted_at,omitempty"`
	CreatedAt  time.Time  `db:"created_at" json:"created_at"`
}

func (s *Store) CreateInvitation(ctx context.Context, inv *Invitation) error {
	return s.Pool.QueryRow(ctx,
		`INSERT INTO invitations (project_id, email, role, token, invited_by, expires_at)
		 VALUES ($1,$2,$3,$4,$5,$6) RETURNING id, created_at`,
		inv.ProjectID, inv.Email, inv.Role, inv.Token, inv.InvitedBy, inv.ExpiresAt,
	).Scan(&inv.ID, &inv.CreatedAt)
}

func (s *Store) GetInvitationByToken(ctx context.Context, token string) (*Invitation, error) {
	return qOne[Invitation](ctx, s.Pool,
		`SELECT id, project_id, email, role, token, invited_by, expires_at, accepted_at, created_at
		   FROM invitations WHERE token=$1`, token)
}

func (s *Store) MarkInvitationAccepted(ctx context.Context, id uuid.UUID) error {
	_, err := s.Pool.Exec(ctx,
		`UPDATE invitations SET accepted_at=now() WHERE id=$1`, id)
	return err
}

func (s *Store) ListPendingInvitations(ctx context.Context, projectID uuid.UUID) ([]Invitation, error) {
	return qAll[Invitation](ctx, s.Pool,
		`SELECT id, project_id, email, role, token, invited_by, expires_at, accepted_at, created_at
		   FROM invitations WHERE project_id=$1 AND accepted_at IS NULL
		  ORDER BY created_at DESC`, projectID)
}

// ========================== Events / Timeline ==========================
//
// events — по строке на событие: parent_id/depth/position задают дерево,
// title/body/event_date — содержимое. Иерархию валидирует events.Service
// (циклы, глубина, чужой проект), каскад удаления потомков обеспечивает
// самоссылочный FK events_parent_id_fkey.
//
// CRDT-снапшот проекта хранится отдельно (project_event_state) и версионируется
// через revision: запись возможна только от известной базовой ревизии, иначе
// ErrRevisionConflict (оптимистичная блокировка вместо «последний писатель
// затирает всех»).

type Event struct {
	ID        uuid.UUID  `db:"id" json:"id"`
	ProjectID uuid.UUID  `db:"project_id" json:"project_id"`
	ParentID  *uuid.UUID `db:"parent_id" json:"parent_id"`
	Position  int        `db:"position" json:"position"`
	Depth     int16      `db:"depth" json:"depth"`
	Title     string     `db:"title" json:"title"`
	Body      string     `db:"body" json:"body"`
	EventDate *time.Time `db:"event_date" json:"event_date,omitempty"`
	// EventDateSet — дата пришла в payload'е (пусть и пустая): только тогда
	// проекция дерева вправе её менять. Клиент, который даты не видел (старый
	// снапшот, импорт без CRDT), поля не присылает, и дата в базе остаётся.
	EventDateSet bool       `db:"-" json:"-"`
	CreatedBy    *uuid.UUID `db:"created_by" json:"created_by,omitempty"`
	UpdatedBy    *uuid.UUID `db:"updated_by" json:"updated_by,omitempty"`
	CreatedAt    time.Time  `db:"created_at" json:"created_at"`
	UpdatedAt    time.Time  `db:"updated_at" json:"updated_at"`
}

const eventColumns = `id, project_id, parent_id, position, depth, title, body,
	event_date, created_by, updated_by, created_at, updated_at`

// ErrRevisionConflict — базовая ревизия снапшота устарела (кто-то записал раньше).
var ErrRevisionConflict = errors.New("revision conflict")

func (s *Store) ListEvents(ctx context.Context, projectID uuid.UUID) ([]Event, error) {
	return qAll[Event](ctx, s.Pool,
		`SELECT `+eventColumns+` FROM events WHERE project_id=$1
		  ORDER BY depth, position, created_at`, projectID)
}

func (s *Store) GetEvent(ctx context.Context, projectID, id uuid.UUID) (*Event, error) {
	return qOne[Event](ctx, s.Pool,
		`SELECT `+eventColumns+` FROM events WHERE project_id=$1 AND id=$2`, projectID, id)
}

// CreateEvent вставляет событие с заданными id/parent/depth/position.
func (s *Store) CreateEvent(ctx context.Context, e *Event) error {
	return s.Pool.QueryRow(ctx,
		`INSERT INTO events (id, project_id, parent_id, position, depth, title, body, event_date, created_by, updated_by)
		 VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$9)
		 RETURNING created_at, updated_at`,
		e.ID, e.ProjectID, e.ParentID, e.Position, e.Depth, e.Title, e.Body, e.EventDate, e.CreatedBy,
	).Scan(&e.CreatedAt, &e.UpdatedAt)
}

// UpdateEventContent обновляет только содержимое (структуру меняет MoveEventRow).
func (s *Store) UpdateEventContent(
	ctx context.Context, projectID, id uuid.UUID, title, body string, eventDate *time.Time, by uuid.UUID,
) error {
	tag, err := s.Pool.Exec(ctx,
		`UPDATE events SET title=$3, body=$4, event_date=$5, updated_by=$6
		  WHERE project_id=$1 AND id=$2`,
		projectID, id, title, body, eventDate, by)
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		return ErrNotFound
	}
	return nil
}

// MoveEventRow переносит событие к другому родителю с новой позицией/глубиной.
func (s *Store) MoveEventRow(
	ctx context.Context, projectID, id uuid.UUID, parentID *uuid.UUID, position int, depth int16, by uuid.UUID,
) error {
	tag, err := s.Pool.Exec(ctx,
		`UPDATE events SET parent_id=$3, position=$4, depth=$5, updated_by=$6
		  WHERE project_id=$1 AND id=$2`,
		projectID, id, parentID, position, depth, by)
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		return ErrNotFound
	}
	return nil
}

// DeleteEvent удаляет событие; потомки уходят каскадом (FK ON DELETE CASCADE).
func (s *Store) DeleteEvent(ctx context.Context, projectID, id uuid.UUID) (int64, error) {
	tag, err := s.Pool.Exec(ctx,
		`DELETE FROM events WHERE project_id=$1 AND id=$2`, projectID, id)
	if err != nil {
		return 0, err
	}
	return tag.RowsAffected(), nil
}

// SetEventPositions переиндексовывает позиции внутри одной группы соседей (0..n-1).
func (s *Store) SetEventPositions(ctx context.Context, projectID uuid.UUID, ids []uuid.UUID) error {
	if len(ids) == 0 {
		return nil
	}
	tx, err := s.Pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	for i, id := range ids {
		if _, err := tx.Exec(ctx,
			`UPDATE events SET position=$3 WHERE project_id=$1 AND id=$2`,
			projectID, id, i); err != nil {
			return err
		}
	}
	return tx.Commit(ctx)
}

// EventMove — параметры атомарного переноса события (одна транзакция):
// смена родителя/позиции/глубины, сдвиг глубин поддерева и переиндексация
// позиций в старой и новой группах соседей.
type EventMove struct {
	ProjectID   uuid.UUID
	ID          uuid.UUID
	ParentID    *uuid.UUID
	Position    int
	Depth       int16
	By          uuid.UUID
	Subtree     map[uuid.UUID]int16 // id → новая глубина (включая сам узел)
	OldSiblings []uuid.UUID         // новый порядок в старой группе (nil, если группа та же)
	NewSiblings []uuid.UUID         // новый порядок в новой группе
}

func (s *Store) ApplyEventMove(ctx context.Context, m EventMove) error {
	tx, err := s.Pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()

	tag, err := tx.Exec(ctx,
		`UPDATE events SET parent_id=$3, position=$4, depth=$5, updated_by=$6
		  WHERE project_id=$1 AND id=$2`,
		m.ProjectID, m.ID, m.ParentID, m.Position, m.Depth, m.By)
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		return ErrNotFound
	}

	for id, depth := range m.Subtree {
		if id == m.ID {
			continue
		}
		if _, err := tx.Exec(ctx,
			`UPDATE events SET depth=$3 WHERE project_id=$1 AND id=$2`,
			m.ProjectID, id, depth); err != nil {
			return err
		}
	}

	for i, id := range m.OldSiblings {
		if _, err := tx.Exec(ctx,
			`UPDATE events SET position=$3 WHERE project_id=$1 AND id=$2`,
			m.ProjectID, id, i); err != nil {
			return err
		}
	}
	for i, id := range m.NewSiblings {
		if _, err := tx.Exec(ctx,
			`UPDATE events SET position=$3 WHERE project_id=$1 AND id=$2`,
			m.ProjectID, id, i); err != nil {
			return err
		}
	}

	return tx.Commit(ctx)
}

// ReplaceEventTree — идемпотентная синхронизация проекции дерева целиком.
//
// Порядок шагов важен:
//  1. отцепляем сохраняемые узлы от родителей, которых нет в payload
//     (иначе каскад на шаге 2 унёс бы живые под-события удаляемой главы);
//  2. удаляем строки проекта, отсутствующие в payload (вместе с потомками);
//  3. upsert'им payload (узлы уже отсортированы по глубине: родители раньше детей).
func (s *Store) ReplaceEventTree(ctx context.Context, projectID uuid.UUID, by uuid.UUID, nodes []Event) error {
	return s.replaceEventTree(ctx, projectID, by, nodes, nil)
}

// ReplaceEventTreeChecked — то же, но с проверкой базовой ревизии снапшота.
//
// Проекция строится из локального CRDT клиента: если он не видел чужих правок
// (ревизия снапшота уже уехала вперёд), его payload снесёт строки, которых у него
// нет. Поэтому клиент присылает ревизию, которую считает актуальной, а мы
// сверяем её под тем же advisory-lock'ом, что и запись, и отдаём
// ErrRevisionConflict при расхождении.
func (s *Store) ReplaceEventTreeChecked(
	ctx context.Context, projectID uuid.UUID, by uuid.UUID, nodes []Event, base int64,
) error {
	return s.replaceEventTree(ctx, projectID, by, nodes, &base)
}

func (s *Store) replaceEventTree(
	ctx context.Context, projectID uuid.UUID, by uuid.UUID, nodes []Event, base *int64,
) error {
	tx, err := s.Pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()

	// Проекция — на весь проект, поэтому сохранения одного проекта должны идти
	// по очереди. Без этого два параллельных PUT (редактор и автосохранение)
	// брали блокировки строк в разном порядке и Postgres снимал одну транзакцию
	// как жертву deadlock'а (40P01) — клиент получал 500 и «правки не сохранились».
	// Блокировка транзакционная: снимается сама при COMMIT/ROLLBACK.
	if _, err := tx.Exec(ctx, `SELECT pg_advisory_xact_lock(hashtext($1::text)::bigint)`, projectID.String()); err != nil {
		return err
	}

	// Проверка ревизии — в той же транзакции, что и запись: иначе между проверкой
	// и заменой успел бы пройти чужой снапшот, и мы всё равно затерли бы его дерево.
	if base != nil {
		revision := int64(0)
		err := tx.QueryRow(ctx,
			`SELECT revision FROM project_event_state WHERE project_id=$1`, projectID).Scan(&revision)
		switch {
		case errors.Is(err, pgx.ErrNoRows):
			revision = 0 // снапшота ещё нет: базовой считается нулевая ревизия
		case err != nil:
			return err
		}
		if revision != *base {
			return ErrRevisionConflict
		}
	}

	keep := make(map[uuid.UUID]bool, len(nodes))
	for _, n := range nodes {
		keep[n.ID] = true
	}

	// Существующие строки читаем в той же транзакции (иначе видим состояние
	// вне её и расходимся с собственными правками).
	rows, err := tx.Query(ctx, `SELECT `+eventColumns+` FROM events WHERE project_id=$1 FOR UPDATE`, projectID)
	if err != nil {
		return err
	}
	existing, err := pgx.CollectRows(rows, pgx.RowToStructByNameLax[Event])
	if err != nil {
		return err
	}

	for _, e := range existing {
		if keep[e.ID] {
			if e.ParentID != nil && !keep[*e.ParentID] {
				if _, err := tx.Exec(ctx,
					`UPDATE events SET parent_id=NULL, depth=0, updated_by=$3 WHERE project_id=$1 AND id=$2`,
					projectID, e.ID, by); err != nil {
					return err
				}
			}
			continue
		}
		if _, err := tx.Exec(ctx,
			`DELETE FROM events WHERE project_id=$1 AND id=$2`, projectID, e.ID); err != nil {
			return err
		}
	}

	for _, n := range nodes {
		var id uuid.UUID
		err := tx.QueryRow(ctx,
			`INSERT INTO events (id, project_id, parent_id, position, depth, title, body, event_date, created_by, updated_by)
			 VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$9)
			 ON CONFLICT (id) DO UPDATE
			    SET parent_id=EXCLUDED.parent_id,
			        position=EXCLUDED.position,
			        depth=EXCLUDED.depth,
			        title=EXCLUDED.title,
			        body=EXCLUDED.body,
			        -- Дату меняем, только если она пришла в payload'е ($10):
			        -- иначе проекция клиента, который её не видел, стёрла бы дату.
			        event_date=CASE WHEN $10 THEN EXCLUDED.event_date ELSE events.event_date END,
			        updated_by=EXCLUDED.updated_by,
			        updated_at=now()
			  WHERE events.project_id = EXCLUDED.project_id
			  RETURNING id`,
			n.ID, projectID, n.ParentID, n.Position, n.Depth, n.Title, n.Body, n.EventDate, by,
			n.EventDateSet).Scan(&id)
		if err != nil {
			if errors.Is(err, pgx.ErrNoRows) {
				// id принадлежит другому проекту — не даём «перетащить» чужое событие
				return ErrNotFound
			}
			return err
		}
	}

	return tx.Commit(ctx)
}

// InsertEventTree вставляет дерево событий НОВОГО проекта одной транзакцией.
//
// Отличие от ReplaceEventTree: тот синхронизирует проекцию (удаляет строки,
// которых нет в payload, снимает блокировку проекта), а здесь проект только что
// создан — удалять нечего, зато нужен event_date. Синхронизация проекта дату не
// переносит: клиент присылает только id/parent/title/body. Импорту папки с md
// дата нужна (front-matter `date`), поэтому вставка отдельная.
//
// Узлы должны идти в порядке «родители раньше детей» — за это отвечает
// events.NormalizeTree, иначе FK parent_id не даст вставить ребёнка.
func (s *Store) InsertEventTree(ctx context.Context, projectID, by uuid.UUID, nodes []Event) error {
	if len(nodes) == 0 {
		return nil
	}
	tx, err := s.Pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()

	for _, n := range nodes {
		if _, err := tx.Exec(ctx,
			`INSERT INTO events (id, project_id, parent_id, position, depth, title, body, event_date, created_by, updated_by)
			 VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$9)`,
			n.ID, projectID, n.ParentID, n.Position, n.Depth, n.Title, n.Body, n.EventDate, by); err != nil {
			return err
		}
	}
	return tx.Commit(ctx)
}

// ProjectEventState — CRDT-снапшот проекта с ревизией.
type ProjectEventState struct {
	ProjectID uuid.UUID  `db:"project_id" json:"project_id"`
	YjsState  []byte     `db:"yjs_state" json:"-"`
	Revision  int64      `db:"revision" json:"revision"`
	UpdatedBy *uuid.UUID `db:"updated_by" json:"updated_by,omitempty"`
	UpdatedAt time.Time  `db:"updated_at" json:"updated_at"`
}

// GetProjectEventState возвращает снапшот или (nil, nil), если его ещё нет.
func (s *Store) GetProjectEventState(ctx context.Context, projectID uuid.UUID) (*ProjectEventState, error) {
	st, err := qOne[ProjectEventState](ctx, s.Pool,
		`SELECT project_id, yjs_state, revision, updated_by, updated_at
		   FROM project_event_state WHERE project_id=$1`, projectID)
	if err != nil {
		if errors.Is(err, ErrNotFound) {
			return nil, nil
		}
		return nil, err
	}
	return st, nil
}

// SaveProjectEventState записывает снапшот с проверкой базовой ревизии.
//
// baseRevision — ревизия, которую клиент видел последней (0 = снапшота ещё нет).
// Если фактическая ревизия другая — ErrRevisionConflict: клиент должен
// перечитать состояние и повторить (CRDT-merge не теряет правки).
func (s *Store) SaveProjectEventState(
	ctx context.Context, projectID, by uuid.UUID, state []byte, baseRevision int64,
) (int64, error) {
	var revision int64
	err := s.Pool.QueryRow(ctx,
		`INSERT INTO project_event_state (project_id, yjs_state, revision, updated_by, updated_at)
		 VALUES ($1, $2, 1, $3, now())
		 ON CONFLICT (project_id) DO UPDATE
		    SET yjs_state=EXCLUDED.yjs_state,
		        revision=project_event_state.revision + 1,
		        updated_by=EXCLUDED.updated_by,
		        updated_at=now()
		  WHERE project_event_state.revision = $4
		 RETURNING revision`,
		projectID, state, by, baseRevision).Scan(&revision)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return 0, ErrRevisionConflict
		}
		// Проект могли удалить, пока вкладка открыта: FK-нарушение — это 404,
		// а не 500: клиент просто перестаёт писать снапшот.
		var pgErr *pgconn.PgError
		if errors.As(err, &pgErr) && pgErr.Code == "23503" {
			return 0, ErrNotFound
		}
		return 0, err
	}
	return revision, nil
}

// SaveProjectEventStateServer — запись снапшота сервером, без проверки базовой ревизии.
//
// С Фазы 3 снапшот пишет один писатель — сервер: он держит документ комнаты,
// применяет к нему апдейты клиентов и сохраняет слитое состояние. Оптимистичная
// блокировка нужна там, где пишут конкурирующие клиенты; у сервера конкурентов
// нет, а проверка базы только мешала бы: пока он сохранял, чужая вкладка успевала
// записать своё, и сервер получал бы конфликт сам с собой.
//
// Клиентский путь (`SaveProjectEventState`) остаётся для тех, у кого нет realtime:
// за прокси без Upgrade и в мобильной сети сокет не поднимается, и правки нужно
// сохранить по REST — там ревизия по-прежнему обязательна.
func (s *Store) SaveProjectEventStateServer(
	ctx context.Context, projectID, by uuid.UUID, state []byte,
) (int64, error) {
	var revision int64
	err := s.Pool.QueryRow(ctx,
		`INSERT INTO project_event_state (project_id, yjs_state, revision, updated_by, updated_at)
		 VALUES ($1, $2, 1, $3, now())
		 ON CONFLICT (project_id) DO UPDATE
		    SET yjs_state=EXCLUDED.yjs_state,
		        revision=project_event_state.revision + 1,
		        updated_by=EXCLUDED.updated_by,
		        updated_at=now()
		 RETURNING revision`,
		projectID, state, by).Scan(&revision)
	if err != nil {
		// Проект могли удалить, пока комната жила: это не ошибка сервера.
		var pgErr *pgconn.PgError
		if errors.As(err, &pgErr) && pgErr.Code == "23503" {
			return 0, ErrNotFound
		}
		return 0, err
	}
	return revision, nil
}

// ========================== Хранилище: размеры и сверка ==========================

// TableSize — размер таблицы (heap + TOAST + индексы).
type TableSize struct {
	Name  string `db:"name" json:"name"`
	Bytes int64  `db:"bytes" json:"bytes"`
}

// StorageStats — где именно лежит место. Первый шаг плана по хранению
// (docs/storage-compression.md): без этих чисел оптимизировать нечего.
type StorageStats struct {
	DatabaseBytes int64       `json:"database_bytes"`
	Tables        []TableSize `json:"tables"`
	Projects      int64       `json:"projects"`
	// Снапшот CRDT: у проекта он один, но растёт с историей правок.
	SnapshotCount int64 `json:"snapshot_count"`
	SnapshotBytes int64 `json:"snapshot_bytes"`
	// Текст в реляционной проекции: это КОПИЯ того, что уже лежит в снапшоте.
	EventRows      int64 `json:"event_rows"`
	EventTextBytes int64 `json:"event_text_bytes"`
	// Вложения: строки и их суммарный размер (файлы на диске считает уборщик).
	AssetRows  int64 `json:"asset_rows"`
	AssetBytes int64 `json:"asset_bytes"`
}

// StorageStats собирает размеры базы и основных таблиц.
func (s *Store) StorageStats(ctx context.Context) (*StorageStats, error) {
	out := &StorageStats{}
	if err := s.Pool.QueryRow(ctx,
		`SELECT pg_database_size(current_database())`).Scan(&out.DatabaseBytes); err != nil {
		return nil, err
	}
	if err := s.Pool.QueryRow(ctx, `SELECT count(*) FROM projects`).Scan(&out.Projects); err != nil {
		return nil, err
	}
	if err := s.Pool.QueryRow(ctx,
		`SELECT count(*), coalesce(sum(octet_length(yjs_state)), 0) FROM project_event_state`).
		Scan(&out.SnapshotCount, &out.SnapshotBytes); err != nil {
		return nil, err
	}
	if err := s.Pool.QueryRow(ctx,
		`SELECT count(*), coalesce(sum(length(title) + length(body)), 0) FROM events`).
		Scan(&out.EventRows, &out.EventTextBytes); err != nil {
		return nil, err
	}
	if err := s.Pool.QueryRow(ctx,
		`SELECT count(*), coalesce(sum(size), 0) FROM assets`).
		Scan(&out.AssetRows, &out.AssetBytes); err != nil {
		return nil, err
	}

	rows, err := s.Pool.Query(ctx,
		`SELECT relname AS name, pg_total_relation_size(c.oid) AS bytes
		   FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
		  WHERE n.nspname = 'public' AND c.relkind = 'r'
		  ORDER BY pg_total_relation_size(c.oid) DESC`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	for rows.Next() {
		var table TableSize
		if err := rows.Scan(&table.Name, &table.Bytes); err != nil {
			return nil, err
		}
		out.Tables = append(out.Tables, table)
	}
	return out, rows.Err()
}

// AssetKeys — ключи всех вложений (ключ → проект). Нужен уборке хранилища: с этим
// списком сверяется каталог, чтобы найти файлы, на которые никто не ссылается.
func (s *Store) AssetKeys(ctx context.Context) (map[string]uuid.UUID, error) {
	rows, err := s.Pool.Query(ctx, `SELECT s3_key, project_id FROM assets`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := map[string]uuid.UUID{}
	for rows.Next() {
		var key string
		var projectID uuid.UUID
		if err := rows.Scan(&key, &projectID); err != nil {
			return nil, err
		}
		out[key] = projectID
	}
	return out, rows.Err()
}

// ========================== Assets ==========================

type Asset struct {
	ID        uuid.UUID `db:"id" json:"id"`
	ProjectID uuid.UUID `db:"project_id" json:"project_id"`
	OwnerID   uuid.UUID `db:"owner_id" json:"owner_id"`
	Filename  string    `db:"filename" json:"filename"`
	Mime      string    `db:"mime" json:"mime"`
	Size      int64     `db:"size" json:"size"`
	S3Key     string    `db:"s3_key" json:"s3_key"`
	Kind      string    `db:"kind" json:"kind"`
	Width     *int      `db:"width" json:"width,omitempty"`
	Height    *int      `db:"height" json:"height,omitempty"`
	// ContentHash — SHA-256 содержимого файла: по нему один и тот же файл не
	// хранится дважды (миграция 0007). Пусто у вложений, загруженных до миграции,
	// и у файлов из архива переноса: их содержимое задним числом не пересчитывается.
	ContentHash *string   `db:"content_hash" json:"content_hash,omitempty"`
	CreatedAt   time.Time `db:"created_at" json:"created_at"`
}

// assetColumns — колонки вложений в одном месте: их читают несколько выборок.
const assetColumns = `id, project_id, owner_id, filename, mime, size, s3_key, kind,
	width, height, content_hash, created_at`

func (s *Store) CreateAsset(ctx context.Context, a *Asset) error {
	return s.Pool.QueryRow(ctx,
		`INSERT INTO assets (project_id, owner_id, filename, mime, size, s3_key, kind, width, height, content_hash)
		 VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id, created_at`,
		a.ProjectID, a.OwnerID, a.Filename, a.Mime, a.Size, a.S3Key, a.Kind, a.Width, a.Height, a.ContentHash,
	).Scan(&a.ID, &a.CreatedAt)
}

// InsertAsset вставляет ассет с ЗАДАННЫМ id — нужно при импорте проекта: CRDT-снапшот
// ссылается на конкретные id вложений, и подменить их на новые без разбора Yjs нельзя.
func (s *Store) InsertAsset(ctx context.Context, a *Asset) error {
	return s.Pool.QueryRow(ctx,
		`INSERT INTO assets (id, project_id, owner_id, filename, mime, size, s3_key, kind, width, height, content_hash)
		 VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING created_at`,
		a.ID, a.ProjectID, a.OwnerID, a.Filename, a.Mime, a.Size, a.S3Key, a.Kind, a.Width, a.Height, a.ContentHash,
	).Scan(&a.CreatedAt)
}

// ExistingEventIDs возвращает те из переданных id, что уже есть в базе. Используется
// импортом: повторная загрузка того же архива должна давать понятную ошибку, а не
// «перезаписать» чужой проект.
func (s *Store) ExistingEventIDs(ctx context.Context, ids []uuid.UUID) ([]uuid.UUID, error) {
	if len(ids) == 0 {
		return nil, nil
	}
	rows, err := s.Pool.Query(ctx, `SELECT id FROM events WHERE id = ANY($1)`, ids)
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

// ExistingAssetIDs — то же для вложений.
func (s *Store) ExistingAssetIDs(ctx context.Context, ids []uuid.UUID) ([]uuid.UUID, error) {
	if len(ids) == 0 {
		return nil, nil
	}
	rows, err := s.Pool.Query(ctx, `SELECT id FROM assets WHERE id = ANY($1)`, ids)
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

func (s *Store) GetAsset(ctx context.Context, id uuid.UUID) (*Asset, error) {
	return qOne[Asset](ctx, s.Pool,
		`SELECT `+assetColumns+` FROM assets WHERE id=$1`, id)
}

func (s *Store) ListAssets(ctx context.Context, projectID uuid.UUID) ([]Asset, error) {
	return qAll[Asset](ctx, s.Pool,
		`SELECT `+assetColumns+` FROM assets WHERE project_id=$1 ORDER BY created_at DESC`, projectID)
}

// FindAssetByHash ищет любое вложение с таким же содержимым: если файл уже есть в
// хранилище, второй раз его писать не нужно — новая строка начнёт ссылаться на
// существующий ключ (дедупликация, миграция 0007).
//
// Ищем самое раннее: ключ первого такого вложения уже лежит в хранилище и пережил
// уборки, а у более поздних копий ключ может быть удалён как дубль.
func (s *Store) FindAssetByHash(ctx context.Context, hash string) (*Asset, error) {
	if hash == "" {
		return nil, nil
	}
	asset, err := qOne[Asset](ctx, s.Pool,
		`SELECT `+assetColumns+` FROM assets WHERE content_hash=$1 ORDER BY created_at LIMIT 1`, hash)
	if err != nil {
		if errors.Is(err, ErrNotFound) {
			return nil, nil
		}
		return nil, err
	}
	return asset, nil
}

// CountAssetsByKey — сколько строк вложений ссылается на файл с таким ключом.
// Ноль означает «файл больше никому не нужен», и только тогда его можно удалять:
// после дедупликации одним файлом пользуются несколько проектов.
func (s *Store) CountAssetsByKey(ctx context.Context, key string) (int, error) {
	var count int
	err := s.Pool.QueryRow(ctx, `SELECT count(*) FROM assets WHERE s3_key=$1`, key).Scan(&count)
	return count, err
}

// DeleteAsset убирает строку вложения. Файл удаляет вызывающий: хранилище и база
// живут раздельно, и «удалить ещё и файл» — отдельное решение (см. assets.Service
// и maintenance.Sweeper).
func (s *Store) DeleteAsset(ctx context.Context, id uuid.UUID) error {
	_, err := s.Pool.Exec(ctx, `DELETE FROM assets WHERE id=$1`, id)
	return err
}

// ========================== Sessions (refresh tokens) ==========================

type Session struct {
	ID               uuid.UUID  `db:"id" json:"id"`
	UserID           uuid.UUID  `db:"user_id" json:"user_id"`
	RefreshTokenHash string     `db:"refresh_token_hash" json:"-"`
	UserAgent        string     `db:"user_agent" json:"user_agent"`
	IP               string     `db:"ip" json:"ip"`
	ExpiresAt        time.Time  `db:"expires_at" json:"expires_at"`
	RevokedAt        *time.Time `db:"revoked_at" json:"revoked_at,omitempty"`
	CreatedAt        time.Time  `db:"created_at" json:"created_at"`
}

func (s *Store) CreateSession(ctx context.Context, sess *Session) error {
	return s.Pool.QueryRow(ctx,
		`INSERT INTO sessions (user_id, refresh_token_hash, user_agent, ip, expires_at)
		 VALUES ($1,$2,$3,$4,$5) RETURNING id, created_at`,
		sess.UserID, sess.RefreshTokenHash, sess.UserAgent, sess.IP, sess.ExpiresAt,
	).Scan(&sess.ID, &sess.CreatedAt)
}

func (s *Store) GetSessionByRefreshHash(ctx context.Context, hash string) (*Session, error) {
	return qOne[Session](ctx, s.Pool,
		`SELECT id, user_id, refresh_token_hash, user_agent, ip, expires_at, revoked_at, created_at
		   FROM sessions WHERE refresh_token_hash=$1`, hash)
}

func (s *Store) RevokeSession(ctx context.Context, id uuid.UUID) error {
	_, err := s.Pool.Exec(ctx,
		`UPDATE sessions SET revoked_at=now() WHERE id=$1 AND revoked_at IS NULL`, id)
	return err
}
