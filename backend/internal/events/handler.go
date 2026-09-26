package events

import (
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"net/http"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"

	"github.com/skyfraze/backend/internal/auth"
	"github.com/skyfraze/backend/internal/projects"
)

type Handler struct {
	svc    *Service
	logger *slog.Logger
}

func NewHandler(svc *Service, logger *slog.Logger) *Handler {
	return &Handler{svc: svc, logger: logger}
}

func (h *Handler) GetState(_ *auth.Service) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		uid, err := auth.UserIDFromCtx(r.Context())
		if err != nil {
			writeErr(w, http.StatusUnauthorized, "unauthorized")
			return
		}
		pid, err := uuid.Parse(chi.URLParam(r, "id"))
		if err != nil {
			writeErr(w, http.StatusBadRequest, "invalid id")
			return
		}
		state, err := h.svc.GetYjsState(r.Context(), uid, pid)
		if err != nil {
			if errors.Is(err, projects.ErrForbidden) {
				writeErr(w, http.StatusForbidden, "forbidden")
				return
			}
			h.logger.Error("get state", "err", err)
			writeErr(w, http.StatusInternalServerError, "failed")
			return
		}
		if state == nil {
			state = []byte{}
		}
		w.Header().Set("Content-Type", "application/octet-stream")
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write(state)
	}
}

func (h *Handler) PutState(_ *auth.Service) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		uid, err := auth.UserIDFromCtx(r.Context())
		if err != nil {
			writeErr(w, http.StatusUnauthorized, "unauthorized")
			return
		}
		pid, err := uuid.Parse(chi.URLParam(r, "id"))
		if err != nil {
			writeErr(w, http.StatusBadRequest, "invalid id")
			return
		}
		body, err := io.ReadAll(io.LimitReader(r.Body, 16*1024*1024))
		if err != nil {
			writeErr(w, http.StatusBadRequest, "read failed")
			return
		}
		if err := h.svc.SaveYjsState(r.Context(), uid, pid, body); err != nil {
			if errors.Is(err, projects.ErrForbidden) {
				writeErr(w, http.StatusForbidden, "forbidden")
				return
			}
			h.logger.Error("put state", "err", err)
			writeErr(w, http.StatusInternalServerError, "failed")
			return
		}
		w.WriteHeader(http.StatusNoContent)
	}
}

func (h *Handler) List(_ *auth.Service) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		uid, err := auth.UserIDFromCtx(r.Context())
		if err != nil {
			writeErr(w, http.StatusUnauthorized, "unauthorized")
			return
		}
		pid, err := uuid.Parse(chi.URLParam(r, "id"))
		if err != nil {
			writeErr(w, http.StatusBadRequest, "invalid id")
			return
		}
		evs, err := h.svc.List(r.Context(), uid, pid)
		if err != nil {
			writeErr(w, http.StatusForbidden, "forbidden")
			return
		}
		writeJSON(w, http.StatusOK, evs)
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
