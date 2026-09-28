package store

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
)

// ========================== Ники ==========================
//
// Ник (@username) — то, по чему человека находят в поиске. Он есть у каждого:
// при регистрации подбирается из локальной части email, дальше человек может
// сменить его в профиле.

const (
	usernameMinLen = 3
	usernameMaxLen = 32
)

// usernameConstraint — имя уникального индекса по lower(username): по нему
// отличаем «ник занят» от «email уже зарегистрирован».
const usernameConstraint = "idx_users_username_lower"

// NormalizeUsername приводит ник к каноническому виду: нижний регистр, только
// буквы/цифры/точка/дефис/подчёркивание. Остальное отбрасывается, поэтому
// «@Аня-Дизайнер» и «аня-дизайнер» — один и тот же ник.
func NormalizeUsername(raw string) string {
	raw = strings.TrimSpace(strings.TrimPrefix(raw, "@"))
	var b strings.Builder
	for _, r := range strings.ToLower(raw) {
		switch {
		case r >= 'a' && r <= 'z', r >= '0' && r <= '9', r == '.', r == '-', r == '_':
			b.WriteRune(r)
		}
	}
	out := strings.Trim(b.String(), ".-_")
	if len(out) > usernameMaxLen {
		out = out[:usernameMaxLen]
	}
	return out
}

// ValidUsername — ник, который можно сохранить: только латиница/цифры/точка/дефис/
// подчёркивание, длина в пределах. Регистр допускается — он приводится к нижнему.
func ValidUsername(raw string) bool {
	trimmed := strings.TrimSpace(strings.TrimPrefix(strings.TrimSpace(raw), "@"))
	if len(trimmed) < usernameMinLen || len(trimmed) > usernameMaxLen {
		return false
	}
	return NormalizeUsername(trimmed) == strings.ToLower(trimmed)
}

// suggestUsername — ник-кандидат из email: локальная часть, а при совпадении —
// с цифровым суффиксом (anna, anna-2, anna-3 …).
func suggestUsername(email string, attempt int) string {
	base := NormalizeUsername(strings.SplitN(email, "@", 2)[0])
	if len(base) < usernameMinLen {
		base = "user"
	}
	if len(base) > usernameMaxLen-6 {
		base = base[:usernameMaxLen-6]
	}
	if attempt == 0 {
		return base
	}
	return fmt.Sprintf("%s-%d", base, attempt+1)
}

func isUsernameConflict(err error) bool {
	var pgErr *pgconn.PgError
	if !errors.As(err, &pgErr) || pgErr.Code != "23505" {
		return false
	}
	return pgErr.ConstraintName == usernameConstraint
}

// UpdateUsername меняет ник. ErrAlreadyExists — если такой ник уже занят.
func (s *Store) UpdateUsername(ctx context.Context, userID uuid.UUID, username string) (*User, error) {
	u, err := qOne[User](ctx, s.Pool,
		`UPDATE users SET username=$2, updated_at=now() WHERE id=$1 RETURNING `+userColumns,
		userID, username)
	if err != nil {
		if isUsernameConflict(err) {
			return nil, ErrAlreadyExists
		}
		return nil, err
	}
	return u, nil
}

// UserSearchResult — строка поиска людей: кто это и в каких вы с ним отношениях.
type UserSearchResult struct {
	ID          uuid.UUID `db:"id" json:"id"`
	Username    string    `db:"username" json:"username"`
	DisplayName string    `db:"display_name" json:"display_name"`
	// Relation: coauthor | request-incoming | request-outgoing | "" (никак не связаны)
	Relation string `db:"relation" json:"relation"`
	// Crafts заполняются только для принятой связи: что человек делает в общем деле.
	Crafts []string `db:"crafts" json:"crafts"`
}

// SearchUsers ищет людей по нику (с начала строки) и по имени (в любом месте).
// Сам себя и пустые запросы не возвращает.
func (s *Store) SearchUsers(ctx context.Context, viewerID uuid.UUID, query string, limit int) ([]UserSearchResult, error) {
	pattern := escapeLike(strings.TrimSpace(query))
	if len(pattern) < 2 {
		return []UserSearchResult{}, nil
	}
	if limit <= 0 || limit > 50 {
		limit = 20
	}
	return qAll[UserSearchResult](ctx, s.Pool,
		`SELECT u.id, u.username, u.display_name,
		        CASE
		          WHEN l.status = 'accepted' THEN 'coauthor'
		          WHEN l.status = 'pending' AND l.addressee_id = $1 THEN 'request-incoming'
		          WHEN l.status = 'pending' THEN 'request-outgoing'
		          ELSE ''
		        END AS relation,
		        CASE WHEN l.status = 'accepted' THEN l.crafts ELSE '{}'::text[] END AS crafts
		   FROM users u
		   LEFT JOIN coauthor_links l
		          ON (l.requester_id = $1 AND l.addressee_id = u.id)
		          OR (l.addressee_id = $1 AND l.requester_id = u.id)
		  WHERE u.id <> $1
		    AND (u.username ILIKE $2 || '%' OR u.display_name ILIKE '%' || $2 || '%')
		  ORDER BY (u.username ILIKE $2 || '%') DESC, u.username
		  LIMIT $3`,
		viewerID, pattern, limit)
}

// escapeLike обезвреживает % и _ в пользовательском запросе: иначе «%» находил бы
// всех подряд, а «_» — любого с одним символом.
func escapeLike(s string) string {
	r := strings.NewReplacer(`\`, `\\`, `%`, `\%`, `_`, `\_`)
	return r.Replace(s)
}

// ========================== Соавторы ==========================

// Статусы связи соавторов.
const (
	CoauthorPending  = "pending"
	CoauthorAccepted = "accepted"
	CoauthorDeclined = "declined"
)

// CoauthorLink — связь двух людей в общем деле. Crafts и разрешения на чтение
// закрытых проектов — свойства пары, а не отдельного человека.
type CoauthorLink struct {
	ID                    uuid.UUID  `db:"id" json:"id"`
	RequesterID           uuid.UUID  `db:"requester_id" json:"requester_id"`
	AddresseeID           uuid.UUID  `db:"addressee_id" json:"addressee_id"`
	Status                string     `db:"status" json:"status"`
	Message               string     `db:"message" json:"message"`
	Crafts                []string   `db:"crafts" json:"crafts"`
	RequesterSharesClosed bool       `db:"requester_shares_closed" json:"requester_shares_closed"`
	AddresseeSharesClosed bool       `db:"addressee_shares_closed" json:"addressee_shares_closed"`
	CreatedAt             time.Time  `db:"created_at" json:"created_at"`
	DecidedAt             *time.Time `db:"decided_at" json:"decided_at,omitempty"`
	// Вторая сторона связи — чтобы интерфейсу не делать второй запрос.
	OtherID          uuid.UUID `db:"other_id" json:"other_id"`
	OtherUsername    string    `db:"other_username" json:"other_username"`
	OtherDisplayName string    `db:"other_display_name" json:"other_display_name"`
}

// linkColumns — общий список колонок связи вместе с данными второй стороны.
// $1 — тот, чей это взгляд: «other» считается от него.
const linkColumns = `l.id, l.requester_id, l.addressee_id, l.status, l.message, l.crafts,
	l.requester_shares_closed, l.addressee_shares_closed, l.created_at, l.decided_at,
	o.id AS other_id, o.username AS other_username, o.display_name AS other_display_name`

const linkJoin = ` FROM coauthor_links l
	JOIN users o ON o.id = CASE WHEN l.requester_id = $1 THEN l.addressee_id ELSE l.requester_id END`

// GetCoauthorLink возвращает связь между двумя людьми в любом направлении.
func (s *Store) GetCoauthorLink(ctx context.Context, a, b uuid.UUID) (*CoauthorLink, error) {
	return qOne[CoauthorLink](ctx, s.Pool,
		`SELECT l.id, l.requester_id, l.addressee_id, l.status, l.message, l.crafts,
		        l.requester_shares_closed, l.addressee_shares_closed, l.created_at, l.decided_at,
		        o.id AS other_id, o.username AS other_username, o.display_name AS other_display_name`+
			linkJoin+`
		  WHERE (l.requester_id = $1 AND l.addressee_id = $2)
		     OR (l.requester_id = $2 AND l.addressee_id = $1)`,
		a, b)
}

// UpsertCoauthorRequest создаёт заявку или переписывает прежнюю (отказ/повторная
// заявка). Принятую связь не трогает — иначе повторная заявка сбрасывала бы статус.
func (s *Store) UpsertCoauthorRequest(ctx context.Context, requesterID, addresseeID uuid.UUID, message string, crafts []string) (*CoauthorLink, error) {
	_, err := s.Pool.Exec(ctx,
		`INSERT INTO coauthor_links (requester_id, addressee_id, status, message, crafts)
		 VALUES ($1,$2,'pending',$3,$4)
		 ON CONFLICT (LEAST(requester_id, addressee_id), GREATEST(requester_id, addressee_id))
		 DO UPDATE SET requester_id = EXCLUDED.requester_id,
		               addressee_id = EXCLUDED.addressee_id,
		               status = 'pending',
		               message = EXCLUDED.message,
		               crafts = EXCLUDED.crafts,
		               decided_at = NULL
		 WHERE coauthor_links.status <> 'accepted'`,
		requesterID, addresseeID, message, crafts)
	if err != nil {
		return nil, err
	}
	return s.GetCoauthorLink(ctx, requesterID, addresseeID)
}

// DecideCoauthor — согласие или отказ по заявке. Решает только приглашённый.
func (s *Store) DecideCoauthor(ctx context.Context, linkID, addresseeID uuid.UUID, accept bool) (*CoauthorLink, error) {
	status := CoauthorDeclined
	if accept {
		status = CoauthorAccepted
	}
	tag, err := s.Pool.Exec(ctx,
		`UPDATE coauthor_links
		    SET status=$3, decided_at=now()
		  WHERE id=$1 AND addressee_id=$2 AND status='pending'`,
		linkID, addresseeID, status)
	if err != nil {
		return nil, err
	}
	if tag.RowsAffected() == 0 {
		return nil, ErrNotFound
	}
	l, err := s.GetCoauthorLinkByID(ctx, linkID, addresseeID)
	if err != nil {
		return nil, err
	}
	return l, nil
}

// GetCoauthorLinkByID — связь глазами конкретного участника.
func (s *Store) GetCoauthorLinkByID(ctx context.Context, linkID, viewerID uuid.UUID) (*CoauthorLink, error) {
	return qOne[CoauthorLink](ctx, s.Pool,
		`SELECT `+linkColumns+linkJoin+`
		  WHERE l.id = $2 AND (l.requester_id = $1 OR l.addressee_id = $1)`,
		viewerID, linkID)
}

// RemoveCoauthor разрывает связь (доступно любой из сторон).
func (s *Store) RemoveCoauthor(ctx context.Context, linkID, userID uuid.UUID) error {
	tag, err := s.Pool.Exec(ctx,
		`DELETE FROM coauthor_links
		  WHERE id=$1 AND (requester_id=$2 OR addressee_id=$2)`,
		linkID, userID)
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		return ErrNotFound
	}
	return nil
}

// UpdateCoauthor меняет специализации и/или разрешение смотреть закрытые проекты.
// Каждый участник управляет ТОЛЬКО своим разрешением: приглашающий —
// requester_shares_closed, приглашённый — addressee_shares_closed.
func (s *Store) UpdateCoauthor(ctx context.Context, linkID, userID uuid.UUID, crafts []string, sharesClosed *bool) (*CoauthorLink, error) {
	tag, err := s.Pool.Exec(ctx,
		`UPDATE coauthor_links
		    SET crafts = CASE WHEN $3::text[] IS NULL THEN crafts ELSE $3::text[] END,
		        requester_shares_closed = CASE
		          WHEN $4::boolean IS NULL THEN requester_shares_closed
		          WHEN requester_id = $2 THEN $4
		          ELSE requester_shares_closed END,
		        addressee_shares_closed = CASE
		          WHEN $4::boolean IS NULL THEN addressee_shares_closed
		          WHEN addressee_id = $2 THEN $4
		          ELSE addressee_shares_closed END
		  WHERE id=$1 AND (requester_id=$2 OR addressee_id=$2)`,
		linkID, userID, crafts, sharesClosed)
	if err != nil {
		return nil, err
	}
	if tag.RowsAffected() == 0 {
		return nil, ErrNotFound
	}
	return s.GetCoauthorLinkByID(ctx, linkID, userID)
}

// ListCoauthors — принятые связи человека (с обеих сторон).
func (s *Store) ListCoauthors(ctx context.Context, userID uuid.UUID) ([]CoauthorLink, error) {
	return qAll[CoauthorLink](ctx, s.Pool,
		`SELECT `+linkColumns+linkJoin+`
		  WHERE l.status='accepted' AND (l.requester_id=$1 OR l.addressee_id=$1)
		  ORDER BY lower(o.display_name), o.username`,
		userID)
}

// ListCoauthorRequests — заявки: side = 'incoming' (ждут моего решения) или
// 'outgoing' (отправлены мной).
func (s *Store) ListCoauthorRequests(ctx context.Context, userID uuid.UUID, side string) ([]CoauthorLink, error) {
	condition := "l.addressee_id=$1"
	if side == "outgoing" {
		condition = "l.requester_id=$1"
	}
	return qAll[CoauthorLink](ctx, s.Pool,
		`SELECT `+linkColumns+linkJoin+`
		  WHERE l.status='pending' AND `+condition+`
		  ORDER BY l.created_at DESC`,
		userID)
}

// CoauthorCanRead — пускает ли владелец ownerID своего соавтора viewerID в
// закрытые проекты. Разрешение даёт именно владелец, и связь должна быть принята.
func (s *Store) CoauthorCanRead(ctx context.Context, ownerID, viewerID uuid.UUID) (bool, error) {
	var allowed bool
	err := s.Pool.QueryRow(ctx,
		`SELECT CASE
		          WHEN requester_id = $1 THEN requester_shares_closed
		          ELSE addressee_shares_closed
		        END
		   FROM coauthor_links
		  WHERE status='accepted'
		    AND ((requester_id=$1 AND addressee_id=$2) OR (requester_id=$2 AND addressee_id=$1))`,
		ownerID, viewerID).Scan(&allowed)
	if errors.Is(err, pgx.ErrNoRows) {
		return false, nil
	}
	if err != nil {
		return false, err
	}
	return allowed, nil
}

// ListProjectsSharedByCoauthors — закрытые проекты моих соавторов, которые они
// открыли мне на чтение. Проекты, где я и так участник, не дублируются.
func (s *Store) ListProjectsSharedByCoauthors(ctx context.Context, userID uuid.UUID) ([]Project, error) {
	return qAll[Project](ctx, s.Pool,
		`SELECT p.id, p.owner_id, p.title, p.description, p.created_at, p.updated_at,
		        p.is_public, p.public_slug, p.published_at, p.views_count
		   FROM projects p
		   JOIN coauthor_links l
		     ON l.status='accepted'
		    AND l.requester_id = p.owner_id
		    AND l.addressee_id = $1
		    AND l.requester_shares_closed
		  WHERE NOT EXISTS (SELECT 1 FROM team_memberships tm
		                     WHERE tm.project_id = p.id AND tm.user_id = $1)
		  UNION
		 SELECT p.id, p.owner_id, p.title, p.description, p.created_at, p.updated_at,
		        p.is_public, p.public_slug, p.published_at, p.views_count
		   FROM projects p
		   JOIN coauthor_links l
		     ON l.status='accepted'
		    AND l.addressee_id = p.owner_id
		    AND l.requester_id = $1
		    AND l.addressee_shares_closed
		  WHERE NOT EXISTS (SELECT 1 FROM team_memberships tm
		                     WHERE tm.project_id = p.id AND tm.user_id = $1)
		  ORDER BY created_at DESC`,
		userID)
}
