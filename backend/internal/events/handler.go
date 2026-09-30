package events

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"net/http"
	"strconv"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"

	"github.com/skyfraze/backend/internal/auth"
	"github.com/skyfraze/backend/internal/projects"
	"github.com/skyfraze/backend/internal/store"
)

// baseRevisionHeader — ревизия снапшота, которую клиент видел последней.
// Позволяет не затирать чужие правки: при расхождении — 409.
const baseRevisionHeader = "X-Skyfraze-Base-Revision"

// revisionHeader — текущая ревизия снапшота в ответе.
const revisionHeader = "X-Skyfraze-Revision"

const (
	maxTreeNodes = 5000
	maxTreeBody  = 8 << 20 // 8 MiB
)

type Handler struct {
	svc    *Service
	logger *slog.Logger
}

func NewHandler(svc *Service, logger *slog.Logger) *Handler {
	return &Handler{svc: svc, logger: logger}
}

// ---------- CRDT-снапшот ----------

func (h *Handler) GetState(_ *auth.Service) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		uid, pid, ok := h.identity(w, r)
		if !ok {
			return
		}
		state, revision, err := h.svc.GetYjsState(r.Context(), uid, pid)
		if err != nil {
			h.fail(w, err, "get state")
			return
		}
		if state == nil {
			state = []byte{}
		}
		w.Header().Set(revisionHeader, strconv.FormatInt(revision, 10))
		w.Header().Set("Content-Type", "application/octet-stream")
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write(state)
	}
}

func (h *Handler) PutState(_ *auth.Service) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		uid, pid, ok := h.identity(w, r)
		if !ok {
			return
		}
		raw := r.Header.Get(baseRevisionHeader)
		if raw == "" {
			// Без базовой ревизии запись была бы «последний писатель затирает всех».
			writeErr(w, http.StatusPreconditionRequired,
				"missing "+baseRevisionHeader+" header")
			return
		}
		base, err := strconv.ParseInt(raw, 10, 64)
		if err != nil || base < 0 {
			writeErr(w, http.StatusBadRequest, "invalid "+baseRevisionHeader)
			return
		}
		body, err := io.ReadAll(io.LimitReader(r.Body, 16<<20))
		if err != nil {
			writeErr(w, http.StatusBadRequest, "read failed")
			return
		}
		revision, err := h.svc.SaveYjsState(r.Context(), uid, pid, body, base)
		if err != nil {
			if errors.Is(err, store.ErrRevisionConflict) {
				// Отдаём актуальную ревизию, чтобы клиент перечитал состояние
				// и повторил запись (CRDT-merge сохранит его правки).
				w.Header().Set(revisionHeader, h.currentRevision(r, uid, pid))
				writeErr(w, http.StatusConflict, "snapshot revision conflict")
				return
			}
			h.fail(w, err, "put state")
			return
		}
		w.Header().Set(revisionHeader, strconv.FormatInt(revision, 10))
		w.WriteHeader(http.StatusNoContent)
	}
}

func (h *Handler) currentRevision(r *http.Request, uid, pid uuid.UUID) string {
	_, rev, err := h.svc.GetYjsState(r.Context(), uid, pid)
	if err != nil {
		return "0"
	}
	return strconv.FormatInt(rev, 10)
}

// ---------- Дерево событий ----------

// List — дерево событий проекта.
func (h *Handler) List(_ *auth.Service) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		uid, pid, ok := h.identity(w, r)
		if !ok {
			return
		}
		tree, err := h.svc.ListTree(r.Context(), uid, pid)
		if err != nil {
			h.fail(w, err, "list events")
			return
		}
		writeJSON(w, http.StatusOK, tree)
	}
}

// Create — POST /events: новое событие (или под-событие с parent_id).
func (h *Handler) Create(_ *auth.Service) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		uid, pid, ok := h.identity(w, r)
		if !ok {
			return
		}
		var in CreateInput
		if err := json.NewDecoder(io.LimitReader(r.Body, 1<<20)).Decode(&in); err != nil {
			writeErr(w, http.StatusBadRequest, "invalid json")
			return
		}
		ev, err := h.svc.CreateEvent(r.Context(), uid, pid, in)
		if err != nil {
			h.fail(w, err, "create event")
			return
		}
		writeJSON(w, http.StatusCreated, ev)
	}
}

// Update — PATCH /events/{eventID}: содержимое события.
func (h *Handler) Update(_ *auth.Service) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		uid, pid, ok := h.identity(w, r)
		if !ok {
			return
		}
		eventID, ok := h.eventID(w, r)
		if !ok {
			return
		}
		var in ContentInput
		if err := json.NewDecoder(io.LimitReader(r.Body, 1<<20)).Decode(&in); err != nil {
			writeErr(w, http.StatusBadRequest, "invalid json")
			return
		}
		ev, err := h.svc.UpdateEvent(r.Context(), uid, pid, eventID, in)
		if err != nil {
			h.fail(w, err, "update event")
			return
		}
		writeJSON(w, http.StatusOK, ev)
	}
}

// Move — PUT /events/{eventID}/parent: перенос к другому родителю/позиции.
func (h *Handler) Move(_ *auth.Service) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		uid, pid, ok := h.identity(w, r)
		if !ok {
			return
		}
		eventID, ok := h.eventID(w, r)
		if !ok {
			return
		}
		var in MoveInput
		if err := json.NewDecoder(io.LimitReader(r.Body, 1<<20)).Decode(&in); err != nil {
			writeErr(w, http.StatusBadRequest, "invalid json")
			return
		}
		ev, err := h.svc.MoveEvent(r.Context(), uid, pid, eventID, in)
		if err != nil {
			h.fail(w, err, "move event")
			return
		}
		writeJSON(w, http.StatusOK, ev)
	}
}

// Delete — DELETE /events/{eventID}: удаление вместе с потомками.
func (h *Handler) Delete(_ *auth.Service) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		uid, pid, ok := h.identity(w, r)
		if !ok {
			return
		}
		eventID, ok := h.eventID(w, r)
		if !ok {
			return
		}
		removed, err := h.svc.DeleteEvent(r.Context(), uid, pid, eventID)
		if err != nil {
			h.fail(w, err, "delete event")
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{"removed": removed})
	}
}

// SyncTree — PUT /events/tree: идемпотентная синхронизация проекции дерева.
func (h *Handler) SyncTree(_ *auth.Service) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		uid, pid, ok := h.identity(w, r)
		if !ok {
			return
		}
		// Проекция строится из локального CRDT, поэтому без базовой ревизии
		// запись означала бы «клиент, не видевший чужих правок, удаляет чужие
		// события». Требуем её так же, как в PUT /state.
		raw := r.Header.Get(baseRevisionHeader)
		if raw == "" {
			writeErr(w, http.StatusPreconditionRequired,
				"missing "+baseRevisionHeader+" header")
			return
		}
		base, err := strconv.ParseInt(raw, 10, 64)
		if err != nil || base < 0 {
			writeErr(w, http.StatusBadRequest, "invalid "+baseRevisionHeader)
			return
		}
		var nodes []NodeInput
		if err := json.NewDecoder(io.LimitReader(r.Body, maxTreeBody)).Decode(&nodes); err != nil {
			writeErr(w, http.StatusBadRequest, "invalid json")
			return
		}
		if len(nodes) > maxTreeNodes {
			writeErr(w, http.StatusRequestEntityTooLarge, "too many events")
			return
		}
		tree, err := h.svc.SyncTree(r.Context(), uid, pid, nodes, base)
		if err != nil {
			if errors.Is(err, store.ErrRevisionConflict) {
				// Отдаём актуальную ревизию: клиент перечитает снапшот,
				// смержит его в свой CRDT и повторит проекцию.
				w.Header().Set(revisionHeader, h.currentRevision(r, uid, pid))
				writeErr(w, http.StatusConflict, "snapshot revision conflict")
				return
			}
			h.fail(w, err, "sync tree")
			return
		}
		writeJSON(w, http.StatusOK, tree)
	}
}

// ---------- helpers ----------

func (h *Handler) identity(w http.ResponseWriter, r *http.Request) (uuid.UUID, uuid.UUID, bool) {
	uid, err := auth.UserIDFromCtx(r.Context())
	if err != nil {
		writeErr(w, http.StatusUnauthorized, "unauthorized")
		return uuid.Nil, uuid.Nil, false
	}
	pid, err := uuid.Parse(chi.URLParam(r, "id"))
	if err != nil {
		writeErr(w, http.StatusBadRequest, "invalid id")
		return uuid.Nil, uuid.Nil, false
	}
	return uid, pid, true
}

func (h *Handler) eventID(w http.ResponseWriter, r *http.Request) (uuid.UUID, bool) {
	id, err := uuid.Parse(chi.URLParam(r, "eventID"))
	if err != nil {
		writeErr(w, http.StatusBadRequest, "invalid event id")
		return uuid.Nil, false
	}
	return id, true
}

// fail — единая трансляция ошибок сервиса в HTTP-статусы.
func (h *Handler) fail(w http.ResponseWriter, err error, op string) {
	switch {
	case errors.Is(err, context.Canceled), errors.Is(err, context.DeadlineExceeded):
		// Клиент закрыл соединение (уход со страницы, отменённый запрос):
		// отвечать некому, и это не ошибка сервера — не засоряем лог и не отдаём 500.
		h.logger.Info(op, "canceled", true)
		return
	case errors.Is(err, projects.ErrForbidden):
		writeErr(w, http.StatusForbidden, "forbidden")
	case errors.Is(err, ErrForbidden):
		writeErr(w, http.StatusForbidden, "forbidden")
	case errors.Is(err, store.ErrRevisionConflict):
		writeErr(w, http.StatusConflict, "snapshot revision conflict")
	case errors.Is(err, ErrValidation):
		writeErr(w, http.StatusBadRequest, err.Error())
	case errors.Is(err, store.ErrNotFound), errors.Is(err, projects.ErrNotFound):
		writeErr(w, http.StatusNotFound, "not found")
	default:
		h.logger.Error(op, "err", err)
		writeErr(w, http.StatusInternalServerError, "failed")
	}
}

func writeJSON(w http.ResponseWriter, status int, body any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(body)
}

func writeErr(w http.ResponseWriter, status int, msg string) {
	writeJSON(w, status, map[string]string{"error": msg})
}
