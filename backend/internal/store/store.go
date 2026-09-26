// Package store — единая точка доступа к Postgres.
// Содержит типизированные запросы для всех сущностей MVP.
// Использует pgx-native scanning для type-safety без codegen.
package store

import (
	"context"
	"errors"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

// Store — обёртка над пулом, владеет всем CRUD по доменным таблицам.
type Store struct {
	Pool *pgxpool.Pool
}

func New(pool *pgxpool.Pool) *Store {
	return &Store{Pool: pool}
}

// ErrNotFound — запись не найдена.
var ErrNotFound = errors.New("not found")

// scanOne — обёртка: делает query.QueryRow, сканирует в dst, возвращает ErrNotFound если нет строк.
func scanOne[T any](rows pgx.Row, dst *T) error {
	if err := rows.Scan(dst); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return ErrNotFound
		}
		return err
	}
	return nil
}

// scanAll — CollectRows + StructScan, удобно для списков.
func scanAll[T any](rows pgx.Rows, dst *[]T) error {
	collected, err := pgx.CollectRows(rows, pgx.RowToStructByName[T])
	if err != nil {
		return err
	}
	*dst = collected
	return nil
}

// ========================== Users ==========================

// User — запись users.
type User struct {
	ID           uuid.UUID `json:"id"`
	Email        string    `json:"email"`
	PasswordHash string    `json:"-"` // never leak
	DisplayName  string    `json:"display_name"`
	CreatedAt    time.Time `json:"created_at"`
	UpdatedAt    time.Time `json:"updated_at"`
}

func (s *Store) CreateUser(ctx context.Context, email, hash, name string) (*User, error) {
	var u User
	err := scanOne(s.Pool.QueryRow(ctx,
		`INSERT INTO users (email, password_hash, display_name) VALUES ($1,$2,$3) RETURNING id, email, password_hash, display_name, created_at, updated_at`,
		email, hash, name), &u)
	if err != nil {
		return nil, err
	}
	return &u, nil
}

func (s *Store) GetUserByEmail(ctx context.Context, email string) (*User, error) {
	var u User
	err := scanOne(s.Pool.QueryRow(ctx,
		`SELECT id, email, password_hash, display_name, created_at, updated_at FROM users WHERE email=$1`,
		email), &u)
	if err != nil {
		return nil, err
	}
	return &u, nil
}

func (s *Store) GetUserByID(ctx context.Context, id uuid.UUID) (*User, error) {
	var u User
	err := scanOne(s.Pool.QueryRow(ctx,
		`SELECT id, email, password_hash, display_name, created_at, updated_at FROM users WHERE id=$1`,
		id), &u)
	if err != nil {
		return nil, err
	}
	return &u, nil
}

// ========================== Projects ==========================

type Project struct {
	ID          uuid.UUID `json:"id"`
	OwnerID     uuid.UUID `json:"owner_id"`
	Title       string    `json:"title"`
	Description string    `json:"description"`
	CreatedAt   time.Time `json:"created_at"`
	UpdatedAt   time.Time `json:"updated_at"`
}

func (s *Store) CreateProject(ctx context.Context, ownerID uuid.UUID, title, desc string) (*Project, error) {
	var p Project
	err := scanOne(s.Pool.QueryRow(ctx,
		`INSERT INTO projects (owner_id, title, description) VALUES ($1,$2,$3) RETURNING id, owner_id, title, description, created_at, updated_at`,
		ownerID, title, desc), &p)
	if err != nil {
		return nil, err
	}
	return &p, nil
}

func (s *Store) GetProject(ctx context.Context, id uuid.UUID) (*Project, error) {
	var p Project
	err := scanOne(s.Pool.QueryRow(ctx,
		`SELECT id, owner_id, title, description, created_at, updated_at FROM projects WHERE id=$1`, id), &p)
	if err != nil {
		return nil, err
	}
	return &p, nil
}

func (s *Store) ListProjectsForUser(ctx context.Context, userID uuid.UUID) ([]Project, error) {
	rows, err := s.Pool.Query(ctx,
		`SELECT id, owner_id, title, description, created_at, updated_at
		   FROM projects p
		  WHERE p.owner_id = $1
		     OR EXISTS (SELECT 1 FROM team_memberships tm
		                 WHERE tm.project_id = p.id AND tm.user_id = $1)
		  ORDER BY p.created_at DESC`, userID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var ps []Project
	if err := scanAll(rows, &ps); err != nil {
		return nil, err
	}
	return ps, nil
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

type TeamMember struct {
	ProjectID uuid.UUID `json:"project_id"`
	UserID    uuid.UUID `json:"user_id"`
	Role      Role      `json:"role"`
	AddedAt   time.Time `json:"added_at"`
	// Joined fields for listing
	Email       string `json:"email,omitempty"`
	DisplayName string `json:"display_name,omitempty"`
}

// AddMembership — добавить участника (idempotent: ON CONFLICT обновляет роль).
func (s *Store) AddMembership(ctx context.Context, projectID, userID uuid.UUID, role Role) error {
	_, err := s.Pool.Exec(ctx,
		`INSERT INTO team_memberships (project_id, user_id, role) VALUES ($1,$2,$3)
		 ON CONFLICT (project_id, user_id) DO UPDATE SET role = EXCLUDED.role`,
		projectID, userID, role)
	return err
}

func (s *Store) GetMembership(ctx context.Context, projectID, userID uuid.UUID) (*TeamMember, error) {
	var m TeamMember
	err := scanOne(s.Pool.QueryRow(ctx,
		`SELECT project_id, user_id, role, added_at FROM team_memberships WHERE project_id=$1 AND user_id=$2`,
		projectID, userID), &m)
	if err != nil {
		return nil, err
	}
	return &m, nil
}

func (s *Store) ListMembers(ctx context.Context, projectID uuid.UUID) ([]TeamMember, error) {
	rows, err := s.Pool.Query(ctx,
		`SELECT tm.project_id, tm.user_id, tm.role, tm.added_at,
		        u.email, u.display_name
		   FROM team_memberships tm
		   JOIN users u ON u.id = tm.user_id
		  WHERE tm.project_id = $1
		  ORDER BY tm.added_at`, projectID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var ms []TeamMember
	if err := scanAll(rows, &ms); err != nil {
		return nil, err
	}
	return ms, nil
}

func (s *Store) RemoveMembership(ctx context.Context, projectID, userID uuid.UUID) error {
	_, err := s.Pool.Exec(ctx,
		`DELETE FROM team_memberships WHERE project_id=$1 AND user_id=$2`, projectID, userID)
	return err
}

// ========================== Invitations ==========================

type Invitation struct {
	ID         uuid.UUID  `json:"id"`
	ProjectID  uuid.UUID  `json:"project_id"`
	Email      string     `json:"email"`
	Role       Role       `json:"role"`
	Token      string     `json:"token"`
	InvitedBy  uuid.UUID  `json:"invited_by"`
	ExpiresAt  time.Time  `json:"expires_at"`
	AcceptedAt *time.Time `json:"accepted_at,omitempty"`
	CreatedAt  time.Time  `json:"created_at"`
}

func (s *Store) CreateInvitation(ctx context.Context, inv *Invitation) error {
	return s.Pool.QueryRow(ctx,
		`INSERT INTO invitations (project_id, email, role, token, invited_by, expires_at)
		 VALUES ($1,$2,$3,$4,$5,$6) RETURNING id, created_at`,
		inv.ProjectID, inv.Email, inv.Role, inv.Token, inv.InvitedBy, inv.ExpiresAt,
	).Scan(&inv.ID, &inv.CreatedAt)
}

func (s *Store) GetInvitationByToken(ctx context.Context, token string) (*Invitation, error) {
	var inv Invitation
	err := scanOne(s.Pool.QueryRow(ctx,
		`SELECT id, project_id, email, role, token, invited_by, expires_at, accepted_at, created_at
		   FROM invitations WHERE token=$1`, token), &inv)
	if err != nil {
		return nil, err
	}
	return &inv, nil
}

func (s *Store) MarkInvitationAccepted(ctx context.Context, id uuid.UUID) error {
	_, err := s.Pool.Exec(ctx,
		`UPDATE invitations SET accepted_at=now() WHERE id=$1`, id)
	return err
}

func (s *Store) ListPendingInvitations(ctx context.Context, projectID uuid.UUID) ([]Invitation, error) {
	rows, err := s.Pool.Query(ctx,
		`SELECT id, project_id, email, role, token, invited_by, expires_at, accepted_at, created_at
		   FROM invitations WHERE project_id=$1 AND accepted_at IS NULL
		  ORDER BY created_at DESC`, projectID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var invs []Invitation
	if err := scanAll(rows, &invs); err != nil {
		return nil, err
	}
	return invs, nil
}

// ========================== Events / Timeline ==========================

type Event struct {
	ID        uuid.UUID  `json:"id"`
	ProjectID uuid.UUID  `json:"project_id"`
	Position  int        `json:"position"`
	Title     string     `json:"title"`
	Body      string     `json:"body"`
	EventDate *time.Time `json:"event_date,omitempty"`
	YjsState  []byte     `json:"-"`
	CreatedBy *uuid.UUID `json:"created_by,omitempty"`
	CreatedAt time.Time  `json:"created_at"`
	UpdatedAt time.Time  `json:"updated_at"`
}

// GetYjsState — получить последний снапшот Yjs-документа проекта (последний event с непустым yjs_state).
func (s *Store) GetYjsState(ctx context.Context, projectID uuid.UUID) ([]byte, error) {
	var state []byte
	err := s.Pool.QueryRow(ctx,
		`SELECT yjs_state FROM events
		  WHERE project_id=$1 AND yjs_state IS NOT NULL
		  ORDER BY updated_at DESC LIMIT 1`, projectID).Scan(&state)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, nil // пустой Yjs
		}
		return nil, err
	}
	return state, nil
}

// SaveYjsState — сохраняет снапшот в первую запись событий проекта.
// (Per MVP — снепшот хранится как yjs_state одной (или каждой) записи events.)
func (s *Store) SaveYjsState(ctx context.Context, projectID uuid.UUID, state []byte) error {
	// Upsert: убедимся, что существует хотя бы одна запись events для проекта;
	// если нет — создаём "anchor" event под владельцем проекта.
	var ownerID uuid.UUID
	if err := s.Pool.QueryRow(ctx,
		`SELECT owner_id FROM projects WHERE id=$1`, projectID).Scan(&ownerID); err != nil {
		return err
	}
	_, err := s.Pool.Exec(ctx,
		`INSERT INTO events (project_id, position, title, body, yjs_state, created_by)
		 VALUES ($1, 0, '', '', $2, $3)
		 ON CONFLICT DO NOTHING`, projectID, state, ownerID)
	if err != nil {
		return err
	}
	_, err = s.Pool.Exec(ctx,
		`UPDATE events SET yjs_state=$2, updated_at=now()
		   WHERE id = (SELECT id FROM events WHERE project_id=$1
		                AND yjs_state IS NOT NULL
		                ORDER BY updated_at DESC LIMIT 1)`,
		projectID, state)
	return err
}

func (s *Store) ListEvents(ctx context.Context, projectID uuid.UUID) ([]Event, error) {
	rows, err := s.Pool.Query(ctx,
		`SELECT id, project_id, position, title, body, event_date, yjs_state, created_by, created_at, updated_at
		   FROM events WHERE project_id=$1 ORDER BY position, created_at`, projectID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var evs []Event
	if err := scanAll(rows, &evs); err != nil {
		return nil, err
	}
	return evs, nil
}

// ========================== Assets ==========================

type Asset struct {
	ID        uuid.UUID `json:"id"`
	ProjectID uuid.UUID `json:"project_id"`
	OwnerID   uuid.UUID `json:"owner_id"`
	Filename  string    `json:"filename"`
	Mime      string    `json:"mime"`
	Size      int64     `json:"size"`
	S3Key     string    `json:"s3_key"`
	Kind      string    `json:"kind"`
	Width     *int      `json:"width,omitempty"`
	Height    *int      `json:"height,omitempty"`
	CreatedAt time.Time `json:"created_at"`
}

func (s *Store) CreateAsset(ctx context.Context, a *Asset) error {
	return s.Pool.QueryRow(ctx,
		`INSERT INTO assets (project_id, owner_id, filename, mime, size, s3_key, kind, width, height)
		 VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id, created_at`,
		a.ProjectID, a.OwnerID, a.Filename, a.Mime, a.Size, a.S3Key, a.Kind, a.Width, a.Height,
	).Scan(&a.ID, &a.CreatedAt)
}

func (s *Store) GetAsset(ctx context.Context, id uuid.UUID) (*Asset, error) {
	var a Asset
	err := scanOne(s.Pool.QueryRow(ctx,
		`SELECT id, project_id, owner_id, filename, mime, size, s3_key, kind, width, height, created_at
		   FROM assets WHERE id=$1`, id), &a)
	if err != nil {
		return nil, err
	}
	return &a, nil
}

func (s *Store) ListAssets(ctx context.Context, projectID uuid.UUID) ([]Asset, error) {
	rows, err := s.Pool.Query(ctx,
		`SELECT id, project_id, owner_id, filename, mime, size, s3_key, kind, width, height, created_at
		   FROM assets WHERE project_id=$1 ORDER BY created_at DESC`, projectID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var as []Asset
	if err := scanAll(rows, &as); err != nil {
		return nil, err
	}
	return as, nil
}

// ========================== Sessions (refresh tokens) ==========================

type Session struct {
	ID               uuid.UUID `json:"id"`
	UserID           uuid.UUID `json:"user_id"`
	RefreshTokenHash string    `json:"-"`
	UserAgent        string    `json:"user_agent"`
	IP               string    `json:"ip"`
	ExpiresAt        time.Time `json:"expires_at"`
	RevokedAt        *time.Time `json:"revoked_at,omitempty"`
	CreatedAt        time.Time `json:"created_at"`
}

func (s *Store) CreateSession(ctx context.Context, sess *Session) error {
	return s.Pool.QueryRow(ctx,
		`INSERT INTO sessions (user_id, refresh_token_hash, user_agent, ip, expires_at)
		 VALUES ($1,$2,$3,$4,$5) RETURNING id, created_at`,
		sess.UserID, sess.RefreshTokenHash, sess.UserAgent, sess.IP, sess.ExpiresAt,
	).Scan(&sess.ID, &sess.CreatedAt)
}

func (s *Store) GetSessionByRefreshHash(ctx context.Context, hash string) (*Session, error) {
	var sess Session
	err := scanOne(s.Pool.QueryRow(ctx,
		`SELECT id, user_id, refresh_token_hash, user_agent, ip, expires_at, revoked_at, created_at
		   FROM sessions WHERE refresh_token_hash=$1`, hash), &sess)
	if err != nil {
		return nil, err
	}
	return &sess, nil
}

func (s *Store) RevokeSession(ctx context.Context, id uuid.UUID) error {
	_, err := s.Pool.Exec(ctx,
		`UPDATE sessions SET revoked_at=now() WHERE id=$1 AND revoked_at IS NULL`, id)
	return err
}
