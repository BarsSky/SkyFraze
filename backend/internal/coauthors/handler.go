package coauthors

import (
	"encoding/json"
	"errors"
	"log/slog"
	"net/http"

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

type inviteReq struct {
	// Кого зовём: id из поиска по нику (@username).
	UserID  string   `json:"user_id"`
	Message string   `json:"message"`
	Crafts  []string `json:"crafts"`
}

type updateReq struct {
	Crafts       *[]string `json:"crafts"`
	SharesClosed *bool     `json:"shares_closed"`
}

// Routes монтируется в /api/coauthors (все методы требуют входа).
func (h *Handler) Routes(authSvc *auth.Service) http.Handler {
	r := chi.NewRouter()
	r.Use(authSvc.WithUser)
	r.Get("/", h.List)
	r.Post("/", h.Invite)
	r.Patch("/{linkID}", h.Update)
	r.Delete("/{linkID}", h.Remove)
	r.Post("/{linkID}/accept", h.Accept)
	r.Post("/{linkID}/decline", h.Decline)
	return r
}

// SearchRoutes — поиск людей: /api/users/search.
func (h *Handler) SearchRoutes(authSvc *auth.Service) http.Handler {
	r := chi.NewRouter()
	r.Use(authSvc.WithUser)
	r.Get("/search", h.Search)
	return r
}

func (h *Handler) List(w http.ResponseWriter, r *http.Request) {
	uid, err := auth.UserIDFromCtx(r.Context())
	if err != nil {
		writeErr(w, http.StatusUnauthorized, "unauthorized")
		return
	}
	list, err := h.svc.List(r.Context(), uid)
	if err != nil {
		h.logger.Error("list coauthors", "err", err)
		writeErr(w, http.StatusInternalServerError, "list failed")
		return
	}
	writeJSON(w, http.StatusOK, list)
}

func (h *Handler) Search(w http.ResponseWriter, r *http.Request) {
	uid, err := auth.UserIDFromCtx(r.Context())
	if err != nil {
		writeErr(w, http.StatusUnauthorized, "unauthorized")
		return
	}
	found, err := h.svc.Search(r.Context(), uid, r.URL.Query().Get("q"))
	if err != nil {
		h.logger.Error("search users", "err", err)
		writeErr(w, http.StatusInternalServerError, "search failed")
		return
	}
	writeJSON(w, http.StatusOK, found)
}

func (h *Handler) Invite(w http.ResponseWriter, r *http.Request) {
	uid, err := auth.UserIDFromCtx(r.Context())
	if err != nil {
		writeErr(w, http.StatusUnauthorized, "unauthorized")
		return
	}
	var req inviteReq
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeErr(w, http.StatusBadRequest, "invalid json")
		return
	}
	target, err := uuid.Parse(req.UserID)
	if err != nil {
		writeErr(w, http.StatusBadRequest, "invalid user_id")
		return
	}
	link, err := h.svc.Invite(r.Context(), uid, target, req.Message, req.Crafts)
	if err != nil {
		switch {
		case errors.Is(err, ErrSelf):
			writeErr(w, http.StatusBadRequest, "cannot invite yourself")
		case errors.Is(err, ErrAlreadyCoauthors):
			writeErr(w, http.StatusConflict, "already coauthors")
		case errors.Is(err, ErrInvalidCrafts):
			writeErr(w, http.StatusBadRequest, "invalid crafts")
		default:
			h.logger.Error("invite coauthor", "err", err)
			writeErr(w, http.StatusInternalServerError, "invite failed")
		}
		return
	}
	writeJSON(w, http.StatusCreated, link)
}

func (h *Handler) Update(w http.ResponseWriter, r *http.Request) {
	uid, err := auth.UserIDFromCtx(r.Context())
	if err != nil {
		writeErr(w, http.StatusUnauthorized, "unauthorized")
		return
	}
	linkID, err := uuid.Parse(chi.URLParam(r, "linkID"))
	if err != nil {
		writeErr(w, http.StatusBadRequest, "invalid link id")
		return
	}
	var req updateReq
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeErr(w, http.StatusBadRequest, "invalid json")
		return
	}
	link, err := h.svc.Update(r.Context(), uid, linkID, req.Crafts, req.SharesClosed)
	if err != nil {
		switch {
		case errors.Is(err, ErrNotFound):
			writeErr(w, http.StatusNotFound, "not found")
		case errors.Is(err, ErrInvalidCrafts):
			writeErr(w, http.StatusBadRequest, "invalid crafts")
		default:
			h.logger.Error("update coauthor", "err", err)
			writeErr(w, http.StatusInternalServerError, "update failed")
		}
		return
	}
	writeJSON(w, http.StatusOK, link)
}

func (h *Handler) Remove(w http.ResponseWriter, r *http.Request) {
	h.decide(w, r, nil)
}

func (h *Handler) Accept(w http.ResponseWriter, r *http.Request) {
	yes := true
	h.decide(w, r, &yes)
}

func (h *Handler) Decline(w http.ResponseWriter, r *http.Request) {
	no := false
	h.decide(w, r, &no)
}

func (h *Handler) decide(w http.ResponseWriter, r *http.Request, accept *bool) {
	uid, err := auth.UserIDFromCtx(r.Context())
	if err != nil {
		writeErr(w, http.StatusUnauthorized, "unauthorized")
		return
	}
	linkID, err := uuid.Parse(chi.URLParam(r, "linkID"))
	if err != nil {
		writeErr(w, http.StatusBadRequest, "invalid link id")
		return
	}

	if accept == nil {
		if err := h.svc.Remove(r.Context(), uid, linkID); err != nil {
			if errors.Is(err, ErrNotFound) {
				writeErr(w, http.StatusNotFound, "not found")
				return
			}
			h.logger.Error("remove coauthor", "err", err)
			writeErr(w, http.StatusInternalServerError, "remove failed")
			return
		}
		w.WriteHeader(http.StatusNoContent)
		return
	}

	link, err := h.svc.Decide(r.Context(), uid, linkID, *accept)
	if err != nil {
		if errors.Is(err, ErrNotFound) {
			writeErr(w, http.StatusNotFound, "not found")
			return
		}
		h.logger.Error("decide coauthor", "err", err)
		writeErr(w, http.StatusInternalServerError, "decide failed")
		return
	}
	writeJSON(w, http.StatusOK, link)
}

func writeJSON(w http.ResponseWriter, status int, body any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(body)
}

func writeErr(w http.ResponseWriter, status int, msg string) {
	writeJSON(w, status, map[string]string{"error": msg})
}
