package admin

import (
	"encoding/json"
	"errors"
	"log/slog"
	"net/http"
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

// DTO: наружу не уходят password_hash и служебные uuid решающего.
type requestDTO struct {
	ID          uuid.UUID  `json:"id"`
	Email       string     `json:"email"`
	DisplayName string     `json:"display_name"`
	Message     string     `json:"message"`
	Status      string     `json:"status"`
	Note        string     `json:"note"`
	CreatedAt   time.Time  `json:"created_at"`
	DecidedAt   *time.Time `json:"decided_at,omitempty"`
}

type userDTO struct {
	ID          uuid.UUID `json:"id"`
	Email       string    `json:"email"`
	DisplayName string    `json:"display_name"`
	IsAdmin     bool      `json:"is_admin"`
	CreatedAt   time.Time `json:"created_at"`
}

func toRequestDTO(r store.RegistrationRequest) requestDTO {
	return requestDTO{
		ID: r.ID, Email: r.Email, DisplayName: r.DisplayName, Message: r.Message,
		Status: r.Status, Note: r.Note, CreatedAt: r.CreatedAt, DecidedAt: r.DecidedAt,
	}
}

// UpdateRoutes — ручки механизма обновления, которые монтируются в /api/admin.
// Интерфейс объявлен здесь, а реализация живёт в пакете update: админка не должна
// зависеть от него напрямую (иначе цикл admin → update → admin для проверки прав).
type UpdateRoutes interface {
	Status(w http.ResponseWriter, r *http.Request)
	RequestUpdate(w http.ResponseWriter, r *http.Request)
}

// StorageRoutes — ручки хранилища (отчёт о размерах и уборка), которые
// монтируются в /api/admin. Реализация живёт в пакете maintenance: админка не
// должна зависеть от уборщика, ей достаточно контракта.
type StorageRoutes interface {
	Storage(w http.ResponseWriter, r *http.Request)
	SweepStorage(w http.ResponseWriter, r *http.Request)
	// RecompressStorage — пережать уже загруженные картинки (сухой прогон без
	// `?apply=1`).
	RecompressStorage(w http.ResponseWriter, r *http.Request)
}

// Routes — /api/admin/*. Все ручки требуют токен; права проверяются в each().
func (h *Handler) Routes(authSvc *auth.Service, upd UpdateRoutes, storageRoutes StorageRoutes) http.Handler {
	r := chi.NewRouter()
	r.Use(authSvc.WithUser)

	r.Get("/settings", h.Settings)
	r.Patch("/settings", h.PatchSettings)
	r.Get("/users", h.Users)
	r.Get("/registrations", h.Registrations)
	r.Post("/registrations/{id}/approve", h.Approve)
	r.Post("/registrations/{id}/reject", h.Reject)

	if upd != nil {
		r.Get("/update", upd.Status)
		r.Post("/update", upd.RequestUpdate)
	}
	if storageRoutes != nil {
		// Права проверяем здесь, а не в maintenance: у админки уже есть и
		// middleware, и requireAdmin, второй раз это делать негде.
		r.Get("/storage", h.requireAdminFor(storageRoutes.Storage))
		r.Post("/storage/sweep", h.requireAdminFor(storageRoutes.SweepStorage))
		r.Post("/storage/recompress", h.requireAdminFor(storageRoutes.RecompressStorage))
	}
	return r
}

// requireAdminFor — обёртка «только администратор» вокруг чужой ручки.
func (h *Handler) requireAdminFor(next http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if _, ok := h.requireAdmin(w, r); !ok {
			return
		}
		next(w, r)
	}
}

func (h *Handler) Settings(w http.ResponseWriter, r *http.Request) {
	if _, ok := h.requireAdmin(w, r); !ok {
		return
	}
	s, err := h.svc.Settings(r.Context())
	if err != nil {
		h.fail(w, "settings", err)
		return
	}
	writeJSON(w, http.StatusOK, s)
}

func (h *Handler) PatchSettings(w http.ResponseWriter, r *http.Request) {
	admin, ok := h.requireAdmin(w, r)
	if !ok {
		return
	}
	var req struct {
		RegistrationMode *string `json:"registration_mode"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil || req.RegistrationMode == nil {
		writeErr(w, http.StatusBadRequest, "registration_mode required")
		return
	}
	s, err := h.svc.SetRegistrationMode(r.Context(), admin.ID, *req.RegistrationMode)
	if err != nil {
		if errors.Is(err, ErrBadMode) {
			writeErr(w, http.StatusBadRequest, "registration_mode must be request or open")
			return
		}
		h.fail(w, "set mode", err)
		return
	}
	h.logger.Info("registration mode changed", "by", admin.Email, "mode", s.RegistrationMode)
	writeJSON(w, http.StatusOK, s)
}

func (h *Handler) Users(w http.ResponseWriter, r *http.Request) {
	if _, ok := h.requireAdmin(w, r); !ok {
		return
	}
	users, err := h.svc.store.ListUsers(r.Context())
	if err != nil {
		h.fail(w, "list users", err)
		return
	}
	out := make([]userDTO, 0, len(users))
	for _, u := range users {
		out = append(out, userDTO{
			ID: u.ID, Email: u.Email, DisplayName: u.DisplayName,
			IsAdmin: u.IsAdmin, CreatedAt: u.CreatedAt,
		})
	}
	writeJSON(w, http.StatusOK, map[string]any{"users": out})
}

func (h *Handler) Registrations(w http.ResponseWriter, r *http.Request) {
	if _, ok := h.requireAdmin(w, r); !ok {
		return
	}
	items, err := h.svc.Requests(r.Context(), r.URL.Query().Get("status"))
	if err != nil {
		if errors.Is(err, ErrBadDecision) {
			writeErr(w, http.StatusBadRequest, "unknown status")
			return
		}
		h.fail(w, "list registrations", err)
		return
	}
	out := make([]requestDTO, 0, len(items))
	for _, it := range items {
		out = append(out, toRequestDTO(it))
	}
	writeJSON(w, http.StatusOK, map[string]any{"requests": out})
}

func (h *Handler) Approve(w http.ResponseWriter, r *http.Request) {
	admin, ok := h.requireAdmin(w, r)
	if !ok {
		return
	}
	id, err := uuid.Parse(chi.URLParam(r, "id"))
	if err != nil {
		writeErr(w, http.StatusBadRequest, "invalid id")
		return
	}
	u, err := h.svc.Approve(r.Context(), admin.ID, id)
	if err != nil {
		switch {
		case errors.Is(err, ErrNotFound):
			writeErr(w, http.StatusNotFound, "request not found or already decided")
		case errors.Is(err, ErrEmailTaken):
			writeErr(w, http.StatusConflict, "email already registered")
		default:
			h.fail(w, "approve", err)
		}
		return
	}
	h.logger.Info("registration approved", "by", admin.Email, "user", u.Email)
	writeJSON(w, http.StatusOK, map[string]any{"status": "approved", "user": u.Email})
}

func (h *Handler) Reject(w http.ResponseWriter, r *http.Request) {
	admin, ok := h.requireAdmin(w, r)
	if !ok {
		return
	}
	id, err := uuid.Parse(chi.URLParam(r, "id"))
	if err != nil {
		writeErr(w, http.StatusBadRequest, "invalid id")
		return
	}
	var req struct {
		Note string `json:"note"`
	}
	_ = json.NewDecoder(r.Body).Decode(&req)

	if err := h.svc.Reject(r.Context(), admin.ID, id, req.Note); err != nil {
		if errors.Is(err, ErrNotFound) {
			writeErr(w, http.StatusNotFound, "request not found or already decided")
			return
		}
		h.fail(w, "reject", err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"status": "rejected"})
}

// requireAdmin — общий вход для всех ручек: без прав отвечаем 403, а не 404,
// потому что существование админки не секрет, а её содержимое — да.
func (h *Handler) requireAdmin(w http.ResponseWriter, r *http.Request) (*store.User, bool) {
	uid, err := auth.UserIDFromCtx(r.Context())
	if err != nil {
		writeErr(w, http.StatusUnauthorized, "unauthorized")
		return nil, false
	}
	admin, err := h.svc.RequireAdmin(r.Context(), uid)
	if err != nil {
		writeErr(w, http.StatusForbidden, "admin rights required")
		return nil, false
	}
	return admin, true
}

func (h *Handler) fail(w http.ResponseWriter, op string, err error) {
	h.logger.Error(op, "err", err)
	writeErr(w, http.StatusInternalServerError, "admin operation failed")
}

func writeJSON(w http.ResponseWriter, status int, body any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(body)
}

func writeErr(w http.ResponseWriter, status int, msg string) {
	writeJSON(w, status, map[string]string{"error": msg})
}
