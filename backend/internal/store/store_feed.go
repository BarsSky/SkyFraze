// Публичная лента: чтение опубликованных историй, просмотры и оценки.
//
// Отдельный файл, потому что это отдельный контур доступа: всё, что здесь есть,
// не проверяет членство в проекте — источник истины только `projects.is_public`.
// Любая выборка отсюда обязана содержать условие `is_public`.
package store

import (
	"context"
	"errors"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

// FeedSort — порядок ленты. Значение проверяется сервисом, а не подставляется
// в SQL из запроса: фрагменты ORDER BY ниже — фиксированный whitelist.
type FeedSort string

const (
	FeedSortNew    FeedSort = "new"
	FeedSortRating FeedSort = "rating"
	FeedSortViews  FeedSort = "views"
)

// FeedItem — строка ленты: проект + автор + агрегаты оценок + обложка.
//
// RatingAvg = 0 при RatingCount = 0 (нет оценок), поэтому UI обязан смотреть на
// RatingCount, а не на «нулевое среднее».
type FeedItem struct {
	ID           uuid.UUID  `db:"id" json:"id"`
	Title        string     `db:"title" json:"title"`
	Description  string     `db:"description" json:"description"`
	PublicSlug   string     `db:"public_slug" json:"slug"`
	PublishedAt  *time.Time `db:"published_at" json:"published_at,omitempty"`
	ViewsCount   int        `db:"views_count" json:"views"`
	AuthorName   string     `db:"author_name" json:"author"`
	RatingAvg    float64    `db:"rating_avg" json:"rating_avg"`
	RatingCount  int        `db:"rating_count" json:"rating_count"`
	CoverAssetID *uuid.UUID `db:"cover_asset_id" json:"cover_asset_id,omitempty"`
}

const feedColumns = `p.id, p.title, p.description, p.public_slug, p.published_at,
	p.views_count, u.display_name AS author_name,
	COALESCE(r.avg_stars, 0)::float8 AS rating_avg,
	COALESCE(r.cnt, 0)::int AS rating_count,
	cov.id AS cover_asset_id`

// feedJoins — агрегаты оценок и обложка (первая картинка проекта).
const feedJoins = `
	JOIN users u ON u.id = p.owner_id
	LEFT JOIN LATERAL (
	    SELECT AVG(stars) AS avg_stars, COUNT(*) AS cnt
	      FROM project_ratings pr WHERE pr.project_id = p.id
	) r ON true
	LEFT JOIN LATERAL (
	    SELECT a.id FROM assets a
	     WHERE a.project_id = p.id AND a.mime LIKE 'image/%'
	     ORDER BY a.created_at LIMIT 1
	) cov ON true`

// ListPublicFeed — постраничная лента опубликованных историй.
func (s *Store) ListPublicFeed(ctx context.Context, sort FeedSort, limit, offset int) ([]FeedItem, error) {
	order := `p.published_at DESC NULLS LAST, p.created_at DESC`
	switch sort {
	case FeedSortRating:
		order = `rating_avg DESC, rating_count DESC, p.published_at DESC NULLS LAST`
	case FeedSortViews:
		order = `p.views_count DESC, p.published_at DESC NULLS LAST`
	}
	return qAll[FeedItem](ctx, s.Pool,
		`SELECT `+feedColumns+`
		   FROM projects p`+feedJoins+`
		  WHERE p.is_public AND p.public_slug IS NOT NULL
		  ORDER BY `+order+`
		  LIMIT $1 OFFSET $2`, limit, offset)
}

// GetFeedItemBySlug — одна карточка ленты (публичная история) по ссылке.
func (s *Store) GetFeedItemBySlug(ctx context.Context, slug string) (*FeedItem, error) {
	return qOne[FeedItem](ctx, s.Pool,
		`SELECT `+feedColumns+`
		   FROM projects p`+feedJoins+`
		  WHERE p.is_public AND p.public_slug = $1`, slug)
}

// GetPublicProjectBySlug — проект, доступный публично. Неопубликованный slug
// даёт ErrNotFound (а не «forbidden»), чтобы нельзя было перебором отличить
// существующий закрытый проект от несуществующего.
func (s *Store) GetPublicProjectBySlug(ctx context.Context, slug string) (*Project, error) {
	return qOne[Project](ctx, s.Pool,
		`SELECT `+projectColumns+` FROM projects WHERE is_public AND public_slug=$1`, slug)
}

// SetPublication включает/выключает публикацию. Slug передаётся только при первой
// публикации: дальше он сохраняется, чтобы ссылка не менялась.
func (s *Store) SetPublication(ctx context.Context, projectID uuid.UUID, public bool, slug *string) error {
	tag, err := s.Pool.Exec(ctx,
		`UPDATE projects
		    SET is_public    = $2,
		        public_slug  = COALESCE($3, public_slug),
		        published_at = CASE WHEN $2 THEN now() ELSE published_at END,
		        updated_at   = now()
		  WHERE id = $1`, projectID, public, slug)
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		return ErrNotFound
	}
	return nil
}

// CountPublicProjects — сколько историй опубликовано (для отчётов/ленты).
func (s *Store) CountPublicProjects(ctx context.Context) (int, error) {
	var n int
	err := s.Pool.QueryRow(ctx, `SELECT COUNT(*) FROM projects WHERE is_public`).Scan(&n)
	return n, err
}

// ---------- просмотры ----------

// RecordView фиксирует просмотр: одна запись на посетителя в сутки.
//
// counted=false означает, что посетитель уже смотрел историю сегодня — счётчик
// не растёт, но актуальное значение всё равно возвращается, чтобы UI показывал
// правду. Инкремент и вставка идут одной транзакцией: иначе при гонке двух
// вкладок счётчик мог бы уехать от числа строк.
func (s *Store) RecordView(ctx context.Context, projectID uuid.UUID, visitorKey string) (bool, int, error) {
	tx, err := s.Pool.Begin(ctx)
	if err != nil {
		return false, 0, err
	}
	defer func() { _ = tx.Rollback(ctx) }()

	tag, err := tx.Exec(ctx,
		`INSERT INTO project_views (project_id, visitor_key) VALUES ($1,$2)
		 ON CONFLICT (project_id, visitor_key, viewed_on) DO NOTHING`, projectID, visitorKey)
	if err != nil {
		return false, 0, err
	}
	counted := tag.RowsAffected() > 0

	var total int
	if counted {
		if err := tx.QueryRow(ctx,
			`UPDATE projects SET views_count = views_count + 1 WHERE id=$1
			 RETURNING views_count`, projectID).Scan(&total); err != nil {
			return false, 0, err
		}
	} else if err := tx.QueryRow(ctx,
		`SELECT views_count FROM projects WHERE id=$1`, projectID).Scan(&total); err != nil {
		return false, 0, err
	}

	if err := tx.Commit(ctx); err != nil {
		return false, 0, err
	}
	return counted, total, nil
}

// ---------- оценки ----------

// RatingSummary — среднее и количество оценок проекта.
type RatingSummary struct {
	Avg   float64 `db:"avg_stars" json:"rating_avg"`
	Count int     `db:"cnt" json:"rating_count"`
}

func (s *Store) GetRatingSummary(ctx context.Context, projectID uuid.UUID) (*RatingSummary, error) {
	return qOne[RatingSummary](ctx, s.Pool,
		`SELECT COALESCE(AVG(stars),0)::float8 AS avg_stars, COUNT(*)::int AS cnt
		   FROM project_ratings WHERE project_id=$1`, projectID)
}

// GetUserRating — оценка текущего пользователя. found=false, если он не голосовал.
func (s *Store) GetUserRating(ctx context.Context, projectID, userID uuid.UUID) (int, bool, error) {
	var stars int
	err := s.Pool.QueryRow(ctx,
		`SELECT stars FROM project_ratings WHERE project_id=$1 AND user_id=$2`,
		projectID, userID).Scan(&stars)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return 0, false, nil
		}
		return 0, false, err
	}
	return stars, true, nil
}

// UpsertRating — одна оценка на пользователя: повторный голос заменяет прежний.
func (s *Store) UpsertRating(ctx context.Context, projectID, userID uuid.UUID, stars int) error {
	_, err := s.Pool.Exec(ctx,
		`INSERT INTO project_ratings (project_id, user_id, stars)
		 VALUES ($1,$2,$3)
		 ON CONFLICT (project_id, user_id)
		 DO UPDATE SET stars = EXCLUDED.stars, updated_at = now()`,
		projectID, userID, stars)
	return err
}

func (s *Store) DeleteRating(ctx context.Context, projectID, userID uuid.UUID) error {
	_, err := s.Pool.Exec(ctx,
		`DELETE FROM project_ratings WHERE project_id=$1 AND user_id=$2`, projectID, userID)
	return err
}
