package people

import (
	"encoding/json"
	"errors"
	"log/slog"
	"net/http"
	"strconv"
	"strings"
	"unicode/utf8"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"

	"github.com/skyfraze/backend/internal/auth"
)

type Handler struct {
	svc    *Service
	logger *slog.Logger
}

func NewHandler(svc *Service, logger *slog.Logger) *Handler {
	return &Handler{svc: svc, logger: logger}
}

// Routes — дерево /api/users: каталог, публичный профиль и поиск людей.
//
// Обработчик поиска передаёт вызывающий (coauthors.Search): пакету каталога
// незачем знать про соавторов, а chi получает статический и параметрический
// сегменты СОСЕДЯМИ одного роутера — только так порядок «статический раньше
// параметрического» проверяем тестом, а не надеждой.
//
// Все три ветки требуют входа: каталог — это круг людей инсталляции, а не
// публичная страница.
func (h *Handler) Routes(authSvc *auth.Service, search http.HandlerFunc) http.Handler {
	r := chi.NewRouter()
	r.Use(authSvc.WithUser)
	r.Get("/search", search)
	r.Get("/", h.Catalog)
	r.Get("/{id}", h.Profile)
	return r
}

// Catalog — GET /api/users?q=&craft=&limit=&offset=.
func (h *Handler) Catalog(w http.ResponseWriter, r *http.Request) {
	uid, err := auth.UserIDFromCtx(r.Context())
	if err != nil {
		writeErr(w, http.StatusUnauthorized, "unauthorized")
		return
	}

	q := r.URL.Query()
	limit, err := intParam(q.Get("limit"))
	if err != nil {
		writeErr(w, http.StatusBadRequest, "invalid limit")
		return
	}
	offset, err := intParam(q.Get("offset"))
	if err != nil {
		writeErr(w, http.StatusBadRequest, "invalid offset")
		return
	}
	craft := q.Get("craft")
	if utf8.RuneCountInString(strings.TrimSpace(craft)) > maxCraftRunes {
		writeErr(w, http.StatusBadRequest, "invalid craft")
		return
	}

	page, err := h.svc.Catalog(r.Context(), uid, Filter{
		Q: q.Get("q"), Craft: craft, Limit: limit, Offset: offset,
	})
	if err != nil {
		if errors.Is(err, ErrBadArgument) {
			writeErr(w, http.StatusBadRequest, "invalid parameters")
			return
		}
		h.logger.Error("people catalog", "err", err)
		writeErr(w, http.StatusInternalServerError, "catalog failed")
		return
	}
	writeJSON(w, http.StatusOK, page)
}

// Profile — GET /api/users/{id}: публичный профиль человека.
func (h *Handler) Profile(w http.ResponseWriter, r *http.Request) {
	uid, err := auth.UserIDFromCtx(r.Context())
	if err != nil {
		writeErr(w, http.StatusUnauthorized, "unauthorized")
		return
	}
	target, err := uuid.Parse(chi.URLParam(r, "id"))
	if err != nil {
		writeErr(w, http.StatusBadRequest, "invalid user id")
		return
	}
	profile, err := h.svc.Profile(r.Context(), uid, target)
	if err != nil {
		if errors.Is(err, ErrNotFound) {
			writeErr(w, http.StatusNotFound, "user not found")
			return
		}
		h.logger.Error("people profile", "err", err)
		writeErr(w, http.StatusInternalServerError, "profile failed")
		return
	}
	writeJSON(w, http.StatusOK, profile)
}

// intParam разбирает необязательный числовой параметр: пусто — 0 (значение по
// умолчанию выберет сервис), мусор — ошибка, а не молчаливый ноль: иначе
// «limit=abc» показывал бы первую страницу, и клиент не понял бы, что не так.
func intParam(raw string) (int, error) {
	if strings.TrimSpace(raw) == "" {
		return 0, nil
	}
	return strconv.Atoi(raw)
}

func writeJSON(w http.ResponseWriter, status int, body any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(body)
}

func writeErr(w http.ResponseWriter, status int, msg string) {
	writeJSON(w, status, map[string]string{"error": msg})
}
