package auth

import (
	"encoding/json"
	"errors"
	"log/slog"
	"net/http"
	"strings"

	"github.com/skyfraze/backend/internal/store"
)

// Handler — HTTP-роуты /api/auth/*.
type Handler struct {
	svc    *Service
	store  *store.Store
	logger *slog.Logger
}

func NewHandler(svc *Service, store *store.Store, logger *slog.Logger) *Handler {
	return &Handler{svc: svc, store: store, logger: logger}
}

type registerReq struct {
	Email       string `json:"email"`
	Password    string `json:"password"`
	DisplayName string `json:"display_name"`
}

type loginReq struct {
	Email    string `json:"email"`
	Password string `json:"password"`
}

type refreshReq struct {
	Refresh string `json:"refresh"`
}

type tokensResp struct {
	Access       string `json:"access"`
	Refresh      string `json:"refresh"`
	AccessExp    int64  `json:"access_exp_unix"`
	RefreshExp   int64  `json:"refresh_exp_unix"`
}

type userPublic struct {
	ID          string `json:"id"`
	Email       string `json:"email"`
	DisplayName string `json:"display_name"`
}

func (h *Handler) Register(w http.ResponseWriter, r *http.Request) {
	var req registerReq
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeErr(w, http.StatusBadRequest, "invalid json")
		return
	}
	if req.Email == "" || req.Password == "" || req.DisplayName == "" {
		writeErr(w, http.StatusBadRequest, "email, password, display_name required")
		return
	}
	u, tok, err := h.svc.Register(r.Context(), req.Email, req.Password, req.DisplayName)
	if err != nil {
		if errors.Is(err, ErrEmailTaken) {
			writeErr(w, http.StatusConflict, "email already registered")
			return
		}
		h.logger.Error("register", "err", err)
		writeErr(w, http.StatusInternalServerError, "register failed")
		return
	}
	writeJSON(w, http.StatusCreated, map[string]any{
		"user":   userPublic{ID: u.ID.String(), Email: u.Email, DisplayName: u.DisplayName},
		"tokens": toResp(tok),
	})
}

func (h *Handler) Login(w http.ResponseWriter, r *http.Request) {
	var req loginReq
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeErr(w, http.StatusBadRequest, "invalid json")
		return
	}
	u, tok, err := h.svc.Login(r.Context(), req.Email, req.Password)
	if err != nil {
		if errors.Is(err, ErrInvalidCreds) {
			writeErr(w, http.StatusUnauthorized, "invalid credentials")
			return
		}
		h.logger.Error("login", "err", err)
		writeErr(w, http.StatusInternalServerError, "login failed")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"user":   userPublic{ID: u.ID.String(), Email: u.Email, DisplayName: u.DisplayName},
		"tokens": toResp(tok),
	})
}

func (h *Handler) Refresh(w http.ResponseWriter, r *http.Request) {
	var req refreshReq
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeErr(w, http.StatusBadRequest, "invalid json")
		return
	}
	if req.Refresh == "" {
		writeErr(w, http.StatusBadRequest, "refresh required")
		return
	}
	tok, err := h.svc.Refresh(r.Context(), req.Refresh)
	if err != nil {
		writeErr(w, http.StatusUnauthorized, "refresh failed")
		return
	}
	writeJSON(w, http.StatusOK, toResp(tok))
}

func (h *Handler) Me(w http.ResponseWriter, r *http.Request) {
	uid, err := UserIDFromCtx(r.Context())
	if err != nil {
		writeErr(w, http.StatusUnauthorized, "unauthorized")
		return
	}
	u, err := h.store.GetUserByID(r.Context(), uid)
	if err != nil {
		writeErr(w, http.StatusNotFound, "user not found")
		return
	}
	writeJSON(w, http.StatusOK, userPublic{ID: u.ID.String(), Email: u.Email, DisplayName: u.DisplayName})
}

// helpers

func toResp(t *Tokens) tokensResp {
	return tokensResp{
		Access:     t.Access,
		Refresh:    t.Refresh,
		AccessExp:  t.AccessExp.Unix(),
		RefreshExp: t.RefreshExp.Unix(),
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

// emailSanitize — переносим в helper, если пригодится в других местах.
func emailSanitize(e string) string {
	return strings.TrimSpace(strings.ToLower(e))
}
