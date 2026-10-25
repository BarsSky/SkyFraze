package events

// comments_handler.go — HTTP-ручки обсуждения кадров.
//
// Пути под /api/projects/{id}/comments. Отдельный префикс, а не /events/{eid}/comments:
// дереву нужны счётчики по ВСЕМ кадрам сразу, а это один запрос к /comments/counts, а не
// N запросов по кадрам.

import (
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"strconv"
	"strings"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"

	"github.com/skyfraze/backend/internal/store"
)

// MountComments вешает ручки обсуждения на уже смонтированный /api/projects/{id}.
func (h *Handler) MountComments(r chi.Router) {
	// Чтение — viewer+ (обсуждение не секретнее текста), запись и удаление своего —
	// editor+ (проверяет сервис).
	r.Get("/comments", h.ListComments)
	r.Get("/comments/counts", h.CommentCounts)
	r.Post("/comments", h.CreateComment)
	r.Delete("/comments/{cid}", h.DeleteComment)
}

// ListComments — GET /comments?event_id=...&limit=...
func (h *Handler) ListComments(w http.ResponseWriter, r *http.Request) {
	uid, pid, ok := h.identity(w, r)
	if !ok {
		return
	}
	eventID, err := uuid.Parse(strings.TrimSpace(r.URL.Query().Get("event_id")))
	if err != nil {
		writeErr(w, http.StatusBadRequest, "нужен event_id кадра")
		return
	}
	limit := 200
	if raw := strings.TrimSpace(r.URL.Query().Get("limit")); raw != "" {
		if n, convErr := strconv.Atoi(raw); convErr == nil {
			limit = n
		}
	}
	list, err := h.svc.ListComments(r.Context(), uid, pid, eventID, limit)
	if err != nil {
		h.fail(w, err, "list comments")
		return
	}
	if list == nil {
		list = []store.EventComment{}
	}
	writeJSON(w, http.StatusOK, map[string]any{"comments": list})
}

// CommentCounts — GET /comments/counts: сколько комментариев у каждого кадра.
func (h *Handler) CommentCounts(w http.ResponseWriter, r *http.Request) {
	uid, pid, ok := h.identity(w, r)
	if !ok {
		return
	}
	counts, err := h.svc.CommentCounts(r.Context(), uid, pid)
	if err != nil {
		h.fail(w, err, "comment counts")
		return
	}
	// Ключи — строки: JSON не умеет uuid в ключе объекта, а фронтенд ищет по строке id.
	out := make(map[string]int, len(counts))
	for id, n := range counts {
		out[id.String()] = n
	}
	writeJSON(w, http.StatusOK, map[string]any{"counts": out})
}

// CreateComment — POST /comments {"event_id":"...","body":"..."}
func (h *Handler) CreateComment(w http.ResponseWriter, r *http.Request) {
	uid, pid, ok := h.identity(w, r)
	if !ok {
		return
	}
	var body struct {
		EventID string `json:"event_id"`
		Body    string `json:"body"`
	}
	// Предел чтения — с запасом на MaxCommentRunes: строка в 4000 знаков в UTF-8 это до
	// 16 КБ, а всё, что больше 64 КБ, — уже не комментарий.
	if err := json.NewDecoder(io.LimitReader(r.Body, 64<<10)).Decode(&body); err != nil {
		writeErr(w, http.StatusBadRequest, "invalid json")
		return
	}
	eventID, err := uuid.Parse(strings.TrimSpace(body.EventID))
	if err != nil {
		writeErr(w, http.StatusBadRequest, "нужен event_id кадра")
		return
	}
	comment, err := h.svc.AddComment(r.Context(), uid, pid, eventID, body.Body)
	if err != nil {
		if errors.Is(err, ErrValidation) {
			writeErr(w, http.StatusBadRequest, strings.TrimPrefix(err.Error(), ErrValidation.Error()+": "))
			return
		}
		h.fail(w, err, "create comment")
		return
	}
	writeJSON(w, http.StatusCreated, map[string]any{"comment": comment})
}

// DeleteComment — DELETE /comments/{cid}: удалить СВОЙ комментарий.
func (h *Handler) DeleteComment(w http.ResponseWriter, r *http.Request) {
	uid, pid, ok := h.identity(w, r)
	if !ok {
		return
	}
	commentID, err := uuid.Parse(chi.URLParam(r, "cid"))
	if err != nil {
		writeErr(w, http.StatusBadRequest, "bad comment id")
		return
	}
	if err := h.svc.DeleteComment(r.Context(), uid, pid, commentID); err != nil {
		h.fail(w, err, "delete comment")
		return
	}
	w.WriteHeader(http.StatusNoContent)
}
