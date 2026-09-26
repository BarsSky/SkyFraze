package teams

import (
	"encoding/json"
	"errors"
	"log/slog"
	"net/http"

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

type inviteReq struct {
	Email string `json:"email"`
	Role  string `json:"role"`
}

func (h *Handler) Invite(authSvc *auth.Service) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
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
		var req inviteReq
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			writeErr(w, http.StatusBadRequest, "invalid json")
			return
		}
		inv, err := h.svc.Invite(r.Context(), uid, pid, req.Email, store.Role(req.Role))
		if err != nil {
			switch {
			case errors.Is(err, ErrForbidden):
				writeErr(w, http.StatusForbidden, "forbidden")
			case errors.Is(err, ErrSelfInviteOnly):
				writeErr(w, http.StatusBadRequest, "cannot invite owner")
			default:
				h.logger.Error("invite", "err", err)
				writeErr(w, http.StatusInternalServerError, "invite failed")
			}
			return
		}
		writeJSON(w, http.StatusCreated, inv)
	}
}

func (h *Handler) Accept() http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		uid, err := auth.UserIDFromCtx(r.Context())
		if err != nil {
			writeErr(w, http.StatusUnauthorized, "unauthorized")
			return
		}
		tok := chi.URLParam(r, "token")
		m, err := h.svc.Accept(r.Context(), uid, tok)
		if err != nil {
			switch {
			case errors.Is(err, ErrForbidden):
				writeErr(w, http.StatusForbidden, "forbidden")
			case errors.Is(err, ErrInvitationUsed):
				writeErr(w, http.StatusGone, "invitation already used")
			case errors.Is(err, ErrInvitationGone):
				writeErr(w, http.StatusGone, "invitation expired or not found")
			default:
				h.logger.Error("accept", "err", err)
				writeErr(w, http.StatusInternalServerError, "accept failed")
			}
			return
		}
		writeJSON(w, http.StatusOK, m)
	}
}

func (h *Handler) Members(_ *auth.Service) http.HandlerFunc {
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
		ms, err := h.svc.ListMembers(r.Context(), uid, pid)
		if err != nil {
			writeErr(w, http.StatusForbidden, "forbidden")
			return
		}
		writeJSON(w, http.StatusOK, ms)
	}
}

func (h *Handler) ListInvitations(_ *auth.Service) http.HandlerFunc {
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
		invs, err := h.svc.ListInvitations(r.Context(), uid, pid)
		if err != nil {
			writeErr(w, http.StatusForbidden, "forbidden")
			return
		}
		writeJSON(w, http.StatusOK, invs)
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
