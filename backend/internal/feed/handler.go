package feed

import (
	"encoding/base64"
	"encoding/json"
	"errors"
	"log/slog"
	"net/http"
	"strconv"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"

	"github.com/skyfraze/backend/internal/auth"
	"github.com/skyfraze/backend/internal/store"
)

type Handler struct {
	svc    *Service
	logger *slog.Logger
}

func NewHandler(svc *Service, logger *slog.Logger) *Handler {
	return &Handler{svc: svc, logger: logger}
}

// visitorCookie — ключ посетителя для дедупликации просмотров.
const visitorCookie = "sf_vid"

// ---------- DTO ----------

type assetDTO struct {
	ID       uuid.UUID `json:"id"`
	Mime     string    `json:"mime"`
	Kind     string    `json:"kind"`
	Filename string    `json:"filename"`
	Width    *int      `json:"width,omitempty"`
	Height   *int      `json:"height,omitempty"`
}

type eventDTO struct {
	ID       uuid.UUID  `json:"id"`
	ParentID *uuid.UUID `json:"parent_id"`
	Position int        `json:"position"`
	Title    string     `json:"title"`
	Body     string     `json:"body"`
}

// storyDTO — публичная история. state — base64 CRDT-снапшота (или пусто),
// events — плоское дерево как запасной вариант.
type storyDTO struct {
	Story    store.FeedItem `json:"story"`
	Assets   []assetDTO     `json:"assets"`
	State    string         `json:"state,omitempty"`
	Events   []eventDTO     `json:"events"`
	MyRating *int           `json:"my_rating,omitempty"`
}

type feedDTO struct {
	Items []store.FeedItem `json:"items"`
	Sort  string           `json:"sort"`
}

type ratingDTO struct {
	RatingAvg   float64 `json:"rating_avg"`
	RatingCount int     `json:"rating_count"`
	MyRating    *int    `json:"my_rating"`
}

// ---------- маршруты ----------
//
// Дерево /api/public регистрируется в cmd/server/main.go (chi.Route): там же
// подключается публичная отдача файлов, поэтому единая точка входа нагляднее,
// чем Mount с соседним корневым роутом (см. комментарий в main.go).

// Feed — GET /api/feed?sort=new|rating|views&limit=&offset=
func (h *Handler) Feed(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()
	limit, _ := strconv.Atoi(q.Get("limit"))
	offset, _ := strconv.Atoi(q.Get("offset"))

	items, sort, err := h.svc.Feed(r.Context(), q.Get("sort"), limit, offset)
	if err != nil {
		if errors.Is(err, ErrBadArgument) {
			writeErr(w, http.StatusBadRequest, "unknown sort")
			return
		}
		h.logger.Error("feed", "err", err)
		writeErr(w, http.StatusInternalServerError, "feed failed")
		return
	}
	if items == nil {
		items = []store.FeedItem{}
	}
	writeJSON(w, http.StatusOK, feedDTO{Items: items, Sort: string(sort)})
}

// Story — GET /api/public/stories/{slug}. Считает просмотр (дедуп по посетителю).
func (h *Handler) Story(w http.ResponseWriter, r *http.Request) {
	slug := chi.URLParam(r, "slug")
	viewer, _ := auth.UserIDFromCtxOptional(r.Context())

	story, err := h.svc.StoryBySlug(r.Context(), slug, viewer)
	if err != nil {
		h.storyError(w, "story", err)
		return
	}

	// Просмотр фиксируем ДО ответа: иначе счётчик в этом же ответе отставал бы
	// на единицу и выглядел как «не считается».
	counted, total, verr := h.svc.RecordView(r.Context(), slug, visitorKey(w, r))
	if verr == nil {
		story.Item.ViewsCount = total
		h.logger.Debug("view recorded", "slug", slug, "counted", counted)
	} else if !errors.Is(verr, ErrNotFound) {
		// Просмотр — не повод не отдать историю: логируем и продолжаем.
		h.logger.Warn("record view", "err", verr, "slug", slug)
	}

	dto := storyDTO{
		Story:  story.Item,
		Assets: make([]assetDTO, 0, len(story.Assets)),
		Events: make([]eventDTO, 0, len(story.Events)),
	}
	for _, a := range story.Assets {
		dto.Assets = append(dto.Assets, assetDTO{
			ID: a.ID, Mime: a.Mime, Kind: a.Kind, Filename: a.Filename, Width: a.Width, Height: a.Height,
		})
	}
	for _, e := range story.Events {
		dto.Events = append(dto.Events, eventDTO{
			ID: e.ID, ParentID: e.ParentID, Position: e.Position, Title: e.Title, Body: e.Body,
		})
	}
	if len(story.State) > 0 {
		dto.State = base64.StdEncoding.EncodeToString(story.State)
	}
	if story.HasMy {
		stars := story.MyRate
		dto.MyRating = &stars
	}
	writeJSON(w, http.StatusOK, dto)
}

// Rate — POST /api/public/stories/{slug}/rating {"stars":1..5}
func (h *Handler) Rate(w http.ResponseWriter, r *http.Request) {
	uid, err := auth.UserIDFromCtx(r.Context())
	if err != nil {
		writeErr(w, http.StatusUnauthorized, "unauthorized")
		return
	}
	var req struct {
		Stars *int `json:"stars"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil || req.Stars == nil {
		writeErr(w, http.StatusBadRequest, "stars required")
		return
	}

	sum, stars, err := h.svc.Rate(r.Context(), chi.URLParam(r, "slug"), uid, *req.Stars)
	if err != nil {
		switch {
		case errors.Is(err, ErrBadRating):
			writeErr(w, http.StatusBadRequest, "stars must be 1..5")
		case errors.Is(err, ErrSelfRating):
			writeErr(w, http.StatusForbidden, "author cannot rate own story")
		default:
			h.storyError(w, "rate", err)
		}
		return
	}
	writeJSON(w, http.StatusOK, ratingDTO{RatingAvg: sum.Avg, RatingCount: sum.Count, MyRating: &stars})
}

// Unrate — DELETE /api/public/stories/{slug}/rating (снять свою оценку).
func (h *Handler) Unrate(w http.ResponseWriter, r *http.Request) {
	uid, err := auth.UserIDFromCtx(r.Context())
	if err != nil {
		writeErr(w, http.StatusUnauthorized, "unauthorized")
		return
	}
	sum, err := h.svc.Unrate(r.Context(), chi.URLParam(r, "slug"), uid)
	if err != nil {
		h.storyError(w, "unrate", err)
		return
	}
	writeJSON(w, http.StatusOK, ratingDTO{RatingAvg: sum.Avg, RatingCount: sum.Count, MyRating: nil})
}

// Publish — POST /api/projects/{id}/publication {"is_public":true|false}.
// Владелец проекта; единственная точка, включающая публичность.
func (h *Handler) Publish(w http.ResponseWriter, r *http.Request) {
	uid, err := auth.UserIDFromCtx(r.Context())
	if err != nil {
		writeErr(w, http.StatusUnauthorized, "unauthorized")
		return
	}
	pid, err := uuid.Parse(chi.URLParam(r, "id"))
	if err != nil {
		writeErr(w, http.StatusBadRequest, "invalid project id")
		return
	}
	var req struct {
		IsPublic *bool `json:"is_public"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil || req.IsPublic == nil {
		writeErr(w, http.StatusBadRequest, "is_public required")
		return
	}

	p, err := h.svc.SetPublication(r.Context(), uid, pid, *req.IsPublic)
	if err != nil {
		switch {
		case errors.Is(err, ErrForbidden):
			writeErr(w, http.StatusForbidden, "only owner can publish")
		case errors.Is(err, ErrNotFound):
			writeErr(w, http.StatusNotFound, "not found")
		default:
			h.logger.Error("publication", "err", err)
			writeErr(w, http.StatusInternalServerError, "publication failed")
		}
		return
	}
	writeJSON(w, http.StatusOK, p)
}

func (h *Handler) storyError(w http.ResponseWriter, op string, err error) {
	if errors.Is(err, ErrNotFound) {
		writeErr(w, http.StatusNotFound, "story not found")
		return
	}
	h.logger.Error(op, "err", err)
	writeErr(w, http.StatusInternalServerError, op+" failed")
}

// visitorKey — стабильный ключ браузера для дедупликации просмотров.
// Cookie ставится на год; HttpOnly, чтобы скрипты её не переиспользовали.
// Если cookie не пришла (приватный режим/запрет) — ключ одноразовый, и просмотр
// в этом случае считается заново: лучше завышенный счётчик, чем потерянные.
func visitorKey(w http.ResponseWriter, r *http.Request) string {
	if c, err := r.Cookie(visitorCookie); err == nil && len(c.Value) >= 8 {
		return c.Value
	}
	key := uuid.NewString()
	http.SetCookie(w, &http.Cookie{
		Name:     visitorCookie,
		Value:    key,
		Path:     "/",
		MaxAge:   int((365 * 24 * time.Hour).Seconds()),
		HttpOnly: true,
		SameSite: http.SameSiteLaxMode,
	})
	return key
}

func writeJSON(w http.ResponseWriter, status int, body any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(body)
}

func writeErr(w http.ResponseWriter, status int, msg string) {
	writeJSON(w, status, map[string]string{"error": msg})
}
