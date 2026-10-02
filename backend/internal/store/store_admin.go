// Администрирование развёртывания: настройки приложения и заявки на регистрацию.
//
// Отдельный файл: это не «ещё один CRUD», а контур, который существует ровно
// затем, чтобы владелец инсталляции решал, кого пускать внутрь.
package store

import (
	"context"
	"errors"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

// Ключи app_settings.
const (
	// SettingRegistrationMode — 'request' (по заявке, по умолчанию) | 'open'.
	SettingRegistrationMode = "registration_mode"
)

// Режимы регистрации.
const (
	RegistrationModeRequest = "request"
	RegistrationModeOpen    = "open"
)

var ErrSettingNotFound = errors.New("setting not found")
var ErrPendingRequestExists = errors.New("pending registration request already exists")

func (s *Store) GetSetting(ctx context.Context, key string) (string, error) {
	var value string
	err := s.Pool.QueryRow(ctx, `SELECT value FROM app_settings WHERE key=$1`, key).Scan(&value)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return "", ErrSettingNotFound
		}
		return "", err
	}
	return value, nil
}

// SetSetting пишет настройку и запоминает, кто её изменил (для истории).
func (s *Store) SetSetting(ctx context.Context, key, value string, by uuid.UUID) error {
	var byArg any
	if by != uuid.Nil {
		byArg = by
	}
	_, err := s.Pool.Exec(ctx,
		`INSERT INTO app_settings (key, value, updated_at, updated_by)
		 VALUES ($1,$2,now(),$3)
		 ON CONFLICT (key) DO UPDATE
		    SET value=EXCLUDED.value, updated_at=now(), updated_by=EXCLUDED.updated_by`,
		key, value, byArg)
	return err
}

// SeedSettingIfUnchanged применяет значение из окружения, но только пока настройку
// не менял администратор (`updated_by IS NULL`). Так развёртывание задаёт стартовый
// режим, а решение админа в интерфейсе его больше не перебивает.
func (s *Store) SeedSettingIfUnchanged(ctx context.Context, key, value string) (bool, error) {
	tag, err := s.Pool.Exec(ctx,
		`INSERT INTO app_settings (key, value) VALUES ($1,$2)
		 ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value, updated_at=now()
		  WHERE app_settings.updated_by IS NULL AND app_settings.value <> EXCLUDED.value`,
		key, value)
	if err != nil {
		return false, err
	}
	return tag.RowsAffected() > 0, nil
}

// CountUsers — сколько ЛЮДЕЙ уже есть. Нужно, чтобы отличить пустую инсталляцию
// (первому пользователю надо дать зарегистрироваться, иначе управлять развёртыванием
// будет некому) от работающей.
//
// Системные аккаунты (ИИ-агент, миграция 0010) в счёт не идут: иначе на чистом стенде
// установка сразу выглядела бы занятой, окно первого администратора не открывалось бы, и
// зарегистрироваться было бы некому. Нашлось в CI — на свежей базе e2e-сценарии
// пропускались, потому что форма показывала «Заявка на доступ».
func (s *Store) CountUsers(ctx context.Context) (int, error) {
	var n int
	err := s.Pool.QueryRow(ctx, `SELECT COUNT(*) FROM users WHERE NOT is_system`).Scan(&n)
	return n, err
}

// ---------- заявки на регистрацию ----------

type RegistrationRequest struct {
	ID           uuid.UUID  `db:"id" json:"id"`
	Email        string     `db:"email" json:"email"`
	DisplayName  string     `db:"display_name" json:"display_name"`
	PasswordHash string     `db:"password_hash" json:"-"`
	Message      string     `db:"message" json:"message"`
	Status       string     `db:"status" json:"status"`
	Note         string     `db:"note" json:"note"`
	CreatedAt    time.Time  `db:"created_at" json:"created_at"`
	DecidedAt    *time.Time `db:"decided_at" json:"decided_at,omitempty"`
	DecidedBy    *uuid.UUID `db:"decided_by" json:"decided_by,omitempty"`
}

const registrationColumns = `id, email, display_name, password_hash, message, status, note,
	created_at, decided_at, decided_by`

// CreateRegistrationRequest создаёт заявку. Повторная заявка с тем же email,
// пока предыдущая не рассмотрена, отклоняется (ErrPendingRequestExists) —
// уникальный частичный индекс защищает и от гонки.
func (s *Store) CreateRegistrationRequest(ctx context.Context, email, name, hash, message string) (*RegistrationRequest, error) {
	req, err := qOne[RegistrationRequest](ctx, s.Pool,
		`INSERT INTO registration_requests (email, display_name, password_hash, message)
		 VALUES ($1,$2,$3,$4) RETURNING `+registrationColumns,
		email, name, hash, message)
	if err != nil {
		var pgErr interface{ SQLState() string }
		if errors.As(err, &pgErr) && pgErr.SQLState() == "23505" {
			return nil, ErrPendingRequestExists
		}
		return nil, err
	}
	return req, nil
}

// GetPendingRegistrationRequest ищет нерассмотренную заявку по email — нужна,
// чтобы объяснить человеку на входе, что его заявка ещё рассматривается.
func (s *Store) GetPendingRegistrationRequest(ctx context.Context, email string) (*RegistrationRequest, error) {
	return qOne[RegistrationRequest](ctx, s.Pool,
		`SELECT `+registrationColumns+` FROM registration_requests
		  WHERE lower(email)=lower($1) AND status='pending'`, email)
}

// GetLatestRegistrationRequest — последняя заявка по email независимо от статуса
// (чтобы отклонивший мог увидеть «заявка отклонена»).
func (s *Store) GetLatestRegistrationRequest(ctx context.Context, email string) (*RegistrationRequest, error) {
	return qOne[RegistrationRequest](ctx, s.Pool,
		`SELECT `+registrationColumns+` FROM registration_requests
		  WHERE lower(email)=lower($1) ORDER BY created_at DESC LIMIT 1`, email)
}

// GetRegistrationRequestByID — одна заявка (для одобрения/отклонения).
func (s *Store) GetRegistrationRequestByID(ctx context.Context, id uuid.UUID) (*RegistrationRequest, error) {
	return qOne[RegistrationRequest](ctx, s.Pool,
		`SELECT `+registrationColumns+` FROM registration_requests WHERE id=$1`, id)
}

// ListRegistrationRequests — заявки для админки. status="" — все.
func (s *Store) ListRegistrationRequests(ctx context.Context, status string) ([]RegistrationRequest, error) {
	if status == "" {
		return qAll[RegistrationRequest](ctx, s.Pool,
			`SELECT `+registrationColumns+` FROM registration_requests
			  ORDER BY (status='pending') DESC, created_at DESC`)
	}
	return qAll[RegistrationRequest](ctx, s.Pool,
		`SELECT `+registrationColumns+` FROM registration_requests
		  WHERE status=$1 ORDER BY created_at DESC`, status)
}

// DecideRegistrationRequest фиксирует решение администратора. Уже рассмотренная
// заявка не может быть рассмотрена повторно (ErrNotFound), иначе двойное
// одобрение создало бы пользователя дважды.
func (s *Store) DecideRegistrationRequest(ctx context.Context, id uuid.UUID, status, note string, by uuid.UUID) error {
	tag, err := s.Pool.Exec(ctx,
		`UPDATE registration_requests
		    SET status=$2, note=$3, decided_at=now(), decided_by=$4
		  WHERE id=$1 AND status='pending'`, id, status, note, by)
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		return ErrNotFound
	}
	return nil
}

// ApproveRegistrationRequest атомарно создаёт пользователя из заявки и помечает
// её одобренной: либо и то, и другое, либо ничего.
func (s *Store) ApproveRegistrationRequest(ctx context.Context, id uuid.UUID, by uuid.UUID, isAdmin bool) (*User, error) {
	tx, err := s.Pool.Begin(ctx)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()

	var req RegistrationRequest
	rows, err := tx.Query(ctx, `SELECT `+registrationColumns+` FROM registration_requests
		WHERE id=$1 AND status='pending' FOR UPDATE`, id)
	if err != nil {
		return nil, err
	}
	collected, err := pgx.CollectRows(rows, pgx.RowToStructByNameLax[RegistrationRequest])
	if err != nil {
		return nil, err
	}
	if len(collected) == 0 {
		return nil, ErrNotFound
	}
	req = collected[0]

	// Ник подбираем так же, как при обычной регистрации: у одобренного заявкой
	// пользователя он должен быть сразу, иначе его не найти поиском.
	var user *User
	for attempt := 0; attempt < 20; attempt++ {
		user, err = qOne[User](ctx, tx,
			`INSERT INTO users (email, password_hash, display_name, username, is_admin)
			 VALUES ($1,$2,$3,$4,$5) RETURNING `+userColumns,
			req.Email, req.PasswordHash, req.DisplayName, suggestUsername(req.Email, attempt), isAdmin)
		if err == nil {
			break
		}
		if !isUsernameConflict(err) {
			return nil, err
		}
	}
	if err != nil {
		return nil, err
	}

	if _, err := tx.Exec(ctx,
		`UPDATE registration_requests SET status='approved', decided_at=now(), decided_by=$2
		  WHERE id=$1`, id, by); err != nil {
		return nil, err
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	return user, nil
}
