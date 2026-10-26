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

	"github.com/skyfraze/backend/internal/auth"
	"github.com/skyfraze/backend/internal/store"
)

// MountComments вешает ручки обсуждения на уже смонтированный /api/projects/{id}.
func (h *Handler) MountComments(r chi.Router) {
	// Чтение — viewer+ (обсуждение не секретнее текста), запись и удаление своего —
	// editor+ (проверяет сервис).
	r.Get("/comments", h.ListComments)
	r.Get("/comments/counts", h.CommentCounts)
	r.Get("/comments/unseen", h.UnseenComments)
	r.Post("/comments", h.CreateComment)
	r.Post("/comments/seen", h.MarkCommentsSeen)
	r.Delete("/comments/{cid}", h.DeleteComment)
	// Реакции: PUT/DELETE, а не переключатель. Повтор того же запроса безопасен, и это важно:
	// двойное нажатие на телефоне не должно превращаться в «поставил и снял».
	r.Put("/comments/{cid}/reactions/{kind}", h.SetCommentReaction(true))
	r.Delete("/comments/{cid}/reactions/{kind}", h.SetCommentReaction(false))
}

// UnseenComments — GET /comments/unseen: сколько новых замечаний у каждого кадра.
func (h *Handler) UnseenComments(w http.ResponseWriter, r *http.Request) {
	uid, pid, ok := h.identity(w, r)
	if !ok {
		return
	}
	list, err := h.svc.UnseenComments(r.Context(), uid, pid)
	if err != nil {
		h.fail(w, err, "unseen comments")
		return
	}
	if list == nil {
		list = []store.CommentUnread{}
	}
	writeJSON(w, http.StatusOK, map[string]any{"unseen": list})
}

// MarkCommentsSeen — POST /comments/seen {"event_id":"..."}: обсуждение кадра прочитано.
func (h *Handler) MarkCommentsSeen(w http.ResponseWriter, r *http.Request) {
	uid, pid, ok := h.identity(w, r)
	if !ok {
		return
	}
	var body struct {
		EventID string `json:"event_id"`
	}
	if err := json.NewDecoder(io.LimitReader(r.Body, 4<<10)).Decode(&body); err != nil && err != io.EOF {
		writeErr(w, http.StatusBadRequest, "invalid json")
		return
	}
	eventID, err := uuid.Parse(strings.TrimSpace(body.EventID))
	if err != nil {
		writeErr(w, http.StatusBadRequest, "нужен event_id кадра")
		return
	}
	if err := h.svc.MarkCommentsSeen(r.Context(), uid, pid, eventID); err != nil {
		h.fail(w, err, "mark comments seen")
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// CommentsUnreadAnywhere — GET /api/comments/unseen (без проекта): в каких моих проектах
// есть непрочитанные замечания.
//
// Отдельно от /projects/{id}/…, потому что вопрос задаётся ДО выбора проекта: список
// проектов должен показать «сюда стоит заглянуть». Права проверять не нужно — запрос
// возвращает только проекты, где человек участник, и только счётчики.
func (h *Handler) CommentsUnreadAnywhere(_ *auth.Service) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		uid, err := auth.UserIDFromCtx(r.Context())
		if err != nil {
			writeErr(w, http.StatusUnauthorized, "unauthorized")
			return
		}
		list, err := h.svc.UnseenCommentsByProject(r.Context(), uid)
		if err != nil {
			h.fail(w, err, "unseen comments anywhere")
			return
		}
		if list == nil {
			list = []store.ProjectCommentUnread{}
		}
		writeJSON(w, http.StatusOK, map[string]any{"projects": list})
	}
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

// CreateComment — POST /comments {"event_id":"...","body":"...","parent_id":"..."}
//
// parent_id необязателен: без него это замечание, с ним — ответ на замечание (одна ветка,
// см. events.AddComment).
func (h *Handler) CreateComment(w http.ResponseWriter, r *http.Request) {
	uid, pid, ok := h.identity(w, r)
	if !ok {
		return
	}
	var body struct {
		EventID  string `json:"event_id"`
		Body     string `json:"body"`
		ParentID string `json:"parent_id"`
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
	var parentID *uuid.UUID
	if raw := strings.TrimSpace(body.ParentID); raw != "" {
		parsed, perr := uuid.Parse(raw)
		if perr != nil {
			writeErr(w, http.StatusBadRequest, "parent_id должен быть идентификатором замечания")
			return
		}
		parentID = &parsed
	}
	comment, err := h.svc.AddComment(r.Context(), uid, pid, eventID, body.Body, parentID)
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
