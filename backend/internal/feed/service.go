// Package feed — публичная лента: чтение опубликованных историй, просмотры и оценки.
//
// Контур доступа намеренно бедный:
//   - чтение ленты и публичной истории доступно без авторизации;
//   - публикация и снятие с публикации — только владелец проекта;
//   - оценка — только вошедшему, по одной на историю, и не автору своей же истории;
//   - ни одна ручка этого пакета не даёт записи в содержимое истории.
package feed

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"
	"strings"
	"unicode"

	"github.com/google/uuid"

	"github.com/skyfraze/backend/internal/projects"
	"github.com/skyfraze/backend/internal/store"
)

var (
	ErrNotFound    = errors.New("story not found")
	ErrForbidden   = errors.New("forbidden")
	ErrBadRating   = errors.New("rating must be between 1 and 5")
	ErrSelfRating  = errors.New("author cannot rate own story")
	ErrBadArgument = errors.New("bad argument")
)

const (
	defaultLimit = 24
	maxLimit     = 60
	maxSlugBase  = 40
)

type Service struct {
	store *store.Store
	proj  *projects.Service
}

func New(s *store.Store, proj *projects.Service) *Service {
	return &Service{store: s, proj: proj}
}

// ---------- лента ----------

// Feed — страница ленты. sort валидируется здесь, чтобы в SQL уходил только
// известный вариант (whitelist, а не пользовательская строка).
func (s *Service) Feed(ctx context.Context, sortRaw string, limit, offset int) ([]store.FeedItem, store.FeedSort, error) {
	sort, err := parseSort(sortRaw)
	if err != nil {
		return nil, sort, err
	}
	if limit <= 0 {
		limit = defaultLimit
	}
	if limit > maxLimit {
		limit = maxLimit
	}
	if offset < 0 {
		offset = 0
	}
	items, err := s.store.ListPublicFeed(ctx, sort, limit, offset)
	if err != nil {
		return nil, sort, err
	}
	return items, sort, nil
}

func parseSort(raw string) (store.FeedSort, error) {
	switch strings.ToLower(strings.TrimSpace(raw)) {
	case "", "new":
		return store.FeedSortNew, nil
	case "rating":
		return store.FeedSortRating, nil
	case "views":
		return store.FeedSortViews, nil
	}
	return "", fmt.Errorf("%w: unknown sort", ErrBadArgument)
}

// ---------- публичная история ----------

// Story — то, что отдаётся публичной странице: карточка, вложения и содержимое.
//
// Содержимое отдаётся CRDT-снапшотом (State), если он есть: именно он —
// источник истины для кадров (тексты, вложения, фон). Если снапшота нет
// (проект ни разу не открывали в редакторе), отдаём плоское дерево из events.
// Наружу это превращает handler: он собирает DTO, чтобы не публиковать
// внутренние поля (s3_key, служебные uuid).
type Story struct {
	Item   store.FeedItem
	Assets []store.Asset
	State  []byte
	Events []store.Event
	MyRate int
	HasMy  bool
}

// StoryBySlug собирает публичную историю. viewerID может быть uuid.Nil (аноним).
func (s *Service) StoryBySlug(ctx context.Context, slug string, viewerID uuid.UUID) (*Story, error) {
	slug = strings.TrimSpace(slug)
	if slug == "" {
		return nil, ErrNotFound
	}
	item, err := s.store.GetFeedItemBySlug(ctx, slug)
	if err != nil {
		if errors.Is(err, store.ErrNotFound) {
			return nil, ErrNotFound
		}
		return nil, err
	}

	out := &Story{Item: *item}

	assets, err := s.store.ListAssets(ctx, item.ID)
	if err != nil {
		return nil, err
	}
	out.Assets = assets

	state, err := s.store.GetProjectEventState(ctx, item.ID)
	if err != nil {
		return nil, err
	}
	if state != nil && len(state.YjsState) > 0 {
		out.State = state.YjsState
	} else {
		events, err := s.store.ListEvents(ctx, item.ID)
		if err != nil {
			return nil, err
		}
		out.Events = events
	}

	if viewerID != uuid.Nil {
		stars, found, err := s.store.GetUserRating(ctx, item.ID, viewerID)
		if err != nil {
			return nil, err
		}
		out.MyRate, out.HasMy = stars, found
	}
	return out, nil
}

// RecordView — просмотр с дедупликацией по посетителю (одна запись в сутки).
func (s *Service) RecordView(ctx context.Context, slug, visitorKey string) (bool, int, error) {
	slug = strings.TrimSpace(slug)
	if slug == "" || visitorKey == "" {
		return false, 0, ErrNotFound
	}
	p, err := s.store.GetPublicProjectBySlug(ctx, slug)
	if err != nil {
		if errors.Is(err, store.ErrNotFound) {
			return false, 0, ErrNotFound
		}
		return false, 0, err
	}
	return s.store.RecordView(ctx, p.ID, visitorKey)
}

// ---------- оценки ----------

// Rate ставит или заменяет оценку. Оценка автора собственной истории отклоняется:
// иначе «рейтинг» перестаёт что-либо значить.
func (s *Service) Rate(ctx context.Context, slug string, userID uuid.UUID, stars int) (*store.RatingSummary, int, error) {
	if stars < 1 || stars > 5 {
		return nil, 0, ErrBadRating
	}
	p, err := s.store.GetPublicProjectBySlug(ctx, strings.TrimSpace(slug))
	if err != nil {
		if errors.Is(err, store.ErrNotFound) {
			return nil, 0, ErrNotFound
		}
		return nil, 0, err
	}
	if p.OwnerID == userID {
		return nil, 0, ErrSelfRating
	}
	if err := s.store.UpsertRating(ctx, p.ID, userID, stars); err != nil {
		return nil, 0, err
	}
	sum, err := s.store.GetRatingSummary(ctx, p.ID)
	if err != nil {
		return nil, 0, err
	}
	return sum, stars, nil
}

// Unrate удаляет оценку пользователя (повторный клик по той же звезде в UI).
func (s *Service) Unrate(ctx context.Context, slug string, userID uuid.UUID) (*store.RatingSummary, error) {
	p, err := s.store.GetPublicProjectBySlug(ctx, strings.TrimSpace(slug))
	if err != nil {
		if errors.Is(err, store.ErrNotFound) {
			return nil, ErrNotFound
		}
		return nil, err
	}
	if err := s.store.DeleteRating(ctx, p.ID, userID); err != nil {
		return nil, err
	}
	return s.store.GetRatingSummary(ctx, p.ID)
}

// ---------- публикация ----------

// SetPublication — единственная ручка, включающая публичность. Только владелец.
// Slug выдаётся один раз и дальше не меняется: внешние ссылки не должны ломаться
// ни при снятии с публикации, ни при повторной публикации.
func (s *Service) SetPublication(ctx context.Context, actorID, projectID uuid.UUID, public bool) (*store.Project, error) {
	role, err := s.proj.Role(ctx, actorID, projectID)
	if err != nil {
		if errors.Is(err, projects.ErrForbidden) {
			return nil, ErrForbidden
		}
		if errors.Is(err, projects.ErrNotFound) {
			return nil, ErrNotFound
		}
		return nil, err
	}
	if role != store.RoleOwner {
		return nil, ErrForbidden
	}

	p, err := s.store.GetProject(ctx, projectID)
	if err != nil {
		if errors.Is(err, store.ErrNotFound) {
			return nil, ErrNotFound
		}
		return nil, err
	}

	var slug *string
	if public && (p.PublicSlug == nil || *p.PublicSlug == "") {
		value, err := uniqueSlug(ctx, s.store, p.Title)
		if err != nil {
			return nil, err
		}
		slug = &value
	}

	if err := s.store.SetPublication(ctx, projectID, public, slug); err != nil {
		if errors.Is(err, store.ErrNotFound) {
			return nil, ErrNotFound
		}
		return nil, err
	}
	return s.store.GetProject(ctx, projectID)
}

// uniqueSlug — человекочитаемая ссылка + короткий случайный суффикс.
// Суффикс обязателен: одинаковые названия у разных авторов — норма, а ссылка
// должна быть уникальной без «-2, -3» и без гонок при параллельной публикации.
func uniqueSlug(ctx context.Context, s *store.Store, title string) (string, error) {
	base := slugify(title)
	for attempt := 0; attempt < 5; attempt++ {
		suffix, err := randomHex(4)
		if err != nil {
			return "", err
		}
		candidate := suffix
		if base != "" {
			candidate = base + "-" + suffix
		}
		if _, err := s.GetPublicProjectBySlug(ctx, candidate); err != nil {
			if errors.Is(err, store.ErrNotFound) {
				return candidate, nil
			}
			return "", err
		}
	}
	return "", errors.New("cannot allocate unique slug")
}

// slugify оставляет только латиницу/цифры: кириллический заголовок даёт пустую
// основу, и ссылка состоит из одного суффикса (транслит без библиотеки не стоит
// усложнения, а читаемость ссылки важна меньше её стабильности).
func slugify(title string) string {
	var b strings.Builder
	prevDash := false
	for _, r := range strings.ToLower(title) {
		switch {
		case r >= 'a' && r <= 'z', r >= '0' && r <= '9':
			b.WriteRune(r)
			prevDash = false
		case unicode.IsSpace(r) || r == '-' || r == '_' || r == '.' || r == ',' || r == ':':
			if !prevDash && b.Len() > 0 {
				b.WriteByte('-')
				prevDash = true
			}
		}
		if b.Len() >= maxSlugBase {
			break
		}
	}
	return strings.Trim(b.String(), "-")
}

func randomHex(n int) (string, error) {
	buf := make([]byte, n)
	if _, err := rand.Read(buf); err != nil {
		return "", err
	}
	return hex.EncodeToString(buf), nil
}
