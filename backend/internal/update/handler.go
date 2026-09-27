package update

import (
	"context"
	"encoding/json"
	"log/slog"
	"net/http"

	"github.com/google/uuid"

	"github.com/skyfraze/backend/internal/auth"
	"github.com/skyfraze/backend/internal/store"
)

// AdminGuard — проверка прав администратора. Интерфейс объявлен здесь, а
// реализует его admin.Service: так пакет обновления не зависит от админки
// (иначе получился бы цикл admin → update → admin).
type AdminGuard interface {
	RequireAdmin(ctx context.Context, userID uuid.UUID) (*store.User, error)
}

type Handler struct {
	svc    *Service
	guard  AdminGuard
	logger *slog.Logger
}

func NewHandler(svc *Service, guard AdminGuard, logger *slog.Logger) *Handler {
	return &Handler{svc: svc, guard: guard, logger: logger}
}

// Status — GET /api/admin/update: текущая версия, доступный релиз, состояние применения.
// `?force=1` — «Проверить сейчас» (минуя кэш GitHub).
func (h *Handler) Status(w http.ResponseWriter, r *http.Request) {
	if _, ok := h.requireAdmin(w, r); !ok {
		return
	}
	check := h.svc.Check(r.Context(), r.URL.Query().Get("force") == "1")
	st, _ := h.svc.Status()
	writeJSON(w, http.StatusOK, map[string]any{
		"check":  check,
		"status": st,
		"log":    h.svc.Log(8 << 10),
	})
}

// RequestUpdate — POST /api/admin/update: оставить заявку на обновление.
// Применяет её хост (systemd + deploy/skyfraze-update.sh), см. комментарий в service.go.
func (h *Handler) RequestUpdate(w http.ResponseWriter, r *http.Request) {
	admin, ok := h.requireAdmin(w, r)
	if !ok {
		return
	}
	var req struct {
		Target string `json:"target"`
	}
	_ = json.NewDecoder(r.Body).Decode(&req)

	target := req.Target
	if target == "" {
		check := h.svc.Check(r.Context(), false)
		if check.Latest == nil {
			writeErr(w, http.StatusBadRequest, "нет данных о релизе: сначала проверьте обновления")
			return
		}
		target = check.Latest.Tag
	}

	saved, err := h.svc.RequestUpdate(target, admin.Email)
	if err != nil {
		writeErr(w, http.StatusConflict, err.Error())
		return
	}
	h.logger.Info("update requested", "by", admin.Email, "target", target)
	writeJSON(w, http.StatusAccepted, saved)
}

func (h *Handler) requireAdmin(w http.ResponseWriter, r *http.Request) (*store.User, bool) {
	uid, err := auth.UserIDFromCtx(r.Context())
	if err != nil {
		writeErr(w, http.StatusUnauthorized, "unauthorized")
		return nil, false
	}
	admin, err := h.guard.RequireAdmin(r.Context(), uid)
	if err != nil {
		writeErr(w, http.StatusForbidden, "admin rights required")
		return nil, false
	}
	return admin, true
}

func writeJSON(w http.ResponseWriter, status int, body any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(body)
}

func writeErr(w http.ResponseWriter, status int, msg string) {
	writeJSON(w, status, map[string]string{"error": msg})
}
