// Package store — единая точка доступа к Postgres.
// Типизированные pgx-queries. Поля имеют db-теги для точного маппинга на snake_case колонки.
package store

import (
	"context"
	"errors"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

type Store struct {
	Pool *pgxpool.Pool
}

func New(pool *pgxpool.Pool) *Store {
	return &Store{Pool: pool}
}

var ErrNotFound = errors.New("not found")

func qOne[T any](ctx context.Context, pool *pgxpool.Pool, sql string, args ...any) (*T, error) {
	rows, err := pool.Query(ctx, sql, args...)
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

func qAll[T any](ctx context.Context, pool *pgxpool.Pool, sql string, args ...any) ([]T, error) {
	rows, err := pool.Query(ctx, sql, args...)
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
	CreatedAt    time.Time `db:"created_at" json:"created_at"`
	UpdatedAt    time.Time `db:"updated_at" json:"updated_at"`
}

func (s *Store) CreateUser(ctx context.Context, email, hash, name string) (*User, error) {
	return qOne[User](ctx, s.Pool,
		`INSERT INTO users (email, password_hash, display_name)
		 VALUES ($1,$2,$3) RETURNING id, email, password_hash, display_name, created_at, updated_at`,
		email, hash, name)
}

func (s *Store) GetUserByEmail(ctx context.Context, email string) (*User, error) {
	return qOne[User](ctx, s.Pool,
		`SELECT id, email, password_hash, display_name, created_at, updated_at FROM users WHERE email=$1`,
		email)
}

func (s *Store) GetUserByID(ctx context.Context, id uuid.UUID) (*User, error) {
	return qOne[User](ctx, s.Pool,
		`SELECT id, email, password_hash, display_name, created_at, updated_at FROM users WHERE id=$1`,
		id)
}

// ========================== Projects ==========================

type Project struct {
	ID          uuid.UUID `db:"id" json:"id"`
	OwnerID     uuid.UUID `db:"owner_id" json:"owner_id"`
	Title       string    `db:"title" json:"title"`
	Description string    `db:"description" json:"description"`
	CreatedAt   time.Time `db:"created_at" json:"created_at"`
	UpdatedAt   time.Time `db:"updated_at" json:"updated_at"`
}

func (s *Store) CreateProject(ctx context.Context, ownerID uuid.UUID, title, desc string) (*Project, error) {
	return qOne[Project](ctx, s.Pool,
		`INSERT INTO projects (owner_id, title, description)
		 VALUES ($1,$2,$3) RETURNING id, owner_id, title, description, created_at, updated_at`,
		ownerID, title, desc)
}

func (s *Store) GetProject(ctx context.Context, id uuid.UUID) (*Project, error) {
	return qOne[Project](ctx, s.Pool,
		`SELECT id, owner_id, title, description, created_at, updated_at FROM projects WHERE id=$1`, id)
}

func (s *Store) ListProjectsForUser(ctx context.Context, userID uuid.UUID) ([]Project, error) {
	return qAll[Project](ctx, s.Pool,
		`SELECT p.id, p.owner_id, p.title, p.description, p.created_at, p.updated_at
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
}

// MembershipLite — то, что возвращает GetMembership (без JOIN).
type MembershipLite struct {
	ProjectID uuid.UUID `db:"project_id" json:"project_id"`
	UserID    uuid.UUID `db:"user_id" json:"user_id"`
	Role      Role      `db:"role" json:"role"`
	AddedAt   time.Time `db:"added_at" json:"added_at"`
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
		        u.email, u.display_name
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

type Event struct {
	ID        uuid.UUID  `db:"id" json:"id"`
	ProjectID uuid.UUID  `db:"project_id" json:"project_id"`
	Position  int        `db:"position" json:"position"`
	Title     string     `db:"title" json:"title"`
	Body      string     `db:"body" json:"body"`
	EventDate *time.Time `db:"event_date" json:"event_date,omitempty"`
	YjsState  []byte     `db:"yjs_state" json:"-"`
	CreatedBy *uuid.UUID `db:"created_by" json:"created_by,omitempty"`
	CreatedAt time.Time  `db:"created_at" json:"created_at"`
	UpdatedAt time.Time  `db:"updated_at" json:"updated_at"`
}

func (s *Store) GetYjsState(ctx context.Context, projectID uuid.UUID) ([]byte, error) {
	var state []byte
	err := s.Pool.QueryRow(ctx,
		`SELECT yjs_state FROM events
		  WHERE project_id=$1 AND yjs_state IS NOT NULL
		  ORDER BY updated_at DESC LIMIT 1`, projectID).Scan(&state)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, nil
		}
		return nil, err
	}
	return state, nil
}

func (s *Store) SaveYjsState(ctx context.Context, projectID uuid.UUID, state []byte) error {
	var ownerID uuid.UUID
	if err := s.Pool.QueryRow(ctx,
		`SELECT owner_id FROM projects WHERE id=$1`, projectID).Scan(&ownerID); err != nil {
		return err
	}
	var exists bool
	if err := s.Pool.QueryRow(ctx,
		`SELECT EXISTS(SELECT 1 FROM events WHERE project_id=$1)`, projectID).Scan(&exists); err != nil {
		return err
	}
	if !exists {
		_, err := s.Pool.Exec(ctx,
			`INSERT INTO events (project_id, position, title, body, yjs_state, created_by)
			 VALUES ($1, 0, '', '', $2, $3)`,
			projectID, state, ownerID)
		return err
	}
	_, err := s.Pool.Exec(ctx,
		`UPDATE events SET yjs_state=$2, updated_at=now()
		   WHERE id = (SELECT id FROM events WHERE project_id=$1
		                AND yjs_state IS NOT NULL
		                ORDER BY updated_at DESC LIMIT 1)`,
		projectID, state)
	return err
}

func (s *Store) ListEvents(ctx context.Context, projectID uuid.UUID) ([]Event, error) {
	return qAll[Event](ctx, s.Pool,
		`SELECT id, project_id, position, title, body, event_date, yjs_state, created_by, created_at, updated_at
		   FROM events WHERE project_id=$1 ORDER BY position, created_at`, projectID)
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
	CreatedAt time.Time `db:"created_at" json:"created_at"`
}

func (s *Store) CreateAsset(ctx context.Context, a *Asset) error {
	return s.Pool.QueryRow(ctx,
		`INSERT INTO assets (project_id, owner_id, filename, mime, size, s3_key, kind, width, height)
		 VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id, created_at`,
		a.ProjectID, a.OwnerID, a.Filename, a.Mime, a.Size, a.S3Key, a.Kind, a.Width, a.Height,
	).Scan(&a.ID, &a.CreatedAt)
}

func (s *Store) GetAsset(ctx context.Context, id uuid.UUID) (*Asset, error) {
	return qOne[Asset](ctx, s.Pool,
		`SELECT id, project_id, owner_id, filename, mime, size, s3_key, kind, width, height, created_at
		   FROM assets WHERE id=$1`, id)
}

func (s *Store) ListAssets(ctx context.Context, projectID uuid.UUID) ([]Asset, error) {
	return qAll[Asset](ctx, s.Pool,
		`SELECT id, project_id, owner_id, filename, mime, size, s3_key, kind, width, height, created_at
		   FROM assets WHERE project_id=$1 ORDER BY created_at DESC`, projectID)
}

// ========================== Sessions (refresh tokens) ==========================

type Session struct {
	ID            uuid.UUID  `db:"id" json:"id"`
	UserID        uuid.UUID  `db:"user_id" json:"user_id"`
	RefreshTokenHash string  `db:"refresh_token_hash" json:"-"`
	UserAgent     string     `db:"user_agent" json:"user_agent"`
	IP            string     `db:"ip" json:"ip"`
	ExpiresAt     time.Time  `db:"expires_at" json:"expires_at"`
	RevokedAt     *time.Time `db:"revoked_at" json:"revoked_at,omitempty"`
	CreatedAt     time.Time  `db:"created_at" json:"created_at"`
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
