package projects

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

type createReq struct {
	Title       string `json:"title"`
	Description string `json:"description"`
}

type updateReq struct {
	Title       string `json:"title"`
	Description string `json:"description"`
}

// projectDetail — проект вместе с ролью вызывающего. Доступ по соавторству — это
// роль viewer плюс пометка Coauthor: интерфейс по ней пишет «только чтение» и не
// показывает редакторы.
type projectDetail struct {
	*store.Project
	Role     string `json:"role"`
	Coauthor bool   `json:"coauthor_access"`
}

// Routes — коллекция проектов. CRUD одиночного проекта (/api/projects/{id})
// регистрируется в cmd/server/main.go внутри param-поддерева chi: там же живут
// под-ресурсы (members/invitations/events/assets). Регистрировать Get/Update/Delete
// и здесь нельзя — этот роутер смонтирован через Mount(), и param-ветка
// /api/projects/{id} его перекрывает (иначе получаются недостижимые дубликаты,
// из-за которых GET /api/projects/{id} раньше отдавал 404).
func (h *Handler) Routes(authSvc *auth.Service) http.Handler {
	r := chi.NewRouter()
	r.Use(authSvc.WithUser)
	r.Get("/", h.List)
	r.Post("/", h.Create)
	return r
}

// projectListItem — проект вместе с тем, КАК пользователь получил к нему доступ:
// как владелец, как участник команды или как соавтор, которому владелец открыл
// закрытый проект на чтение. Интерфейс показывает последние отдельным блоком.
type projectListItem struct {
	*store.Project
	Access string `json:"access"`
}

func (h *Handler) List(w http.ResponseWriter, r *http.Request) {
	uid, err := auth.UserIDFromCtx(r.Context())
	if err != nil {
		writeErr(w, http.StatusUnauthorized, "unauthorized")
		return
	}
	ps, err := h.svc.List(r.Context(), uid)
	if err != nil {
		h.logger.Error("list projects", "err", err)
		writeErr(w, http.StatusInternalServerError, "list failed")
		return
	}
	shared, err := h.svc.ListSharedByCoauthors(r.Context(), uid)
	if err != nil {
		h.logger.Error("list shared projects", "err", err)
		writeErr(w, http.StatusInternalServerError, "list failed")
		return
	}

	items := make([]projectListItem, 0, len(ps)+len(shared))
	for i := range ps {
		access := "member"
		if ps[i].OwnerID == uid {
			access = "owner"
		}
		items = append(items, projectListItem{Project: &ps[i], Access: access})
	}
	for i := range shared {
		items = append(items, projectListItem{Project: &shared[i], Access: "coauthor"})
	}
	writeJSON(w, http.StatusOK, items)
}

func (h *Handler) Create(w http.ResponseWriter, r *http.Request) {
	uid, err := auth.UserIDFromCtx(r.Context())
	if err != nil {
		writeErr(w, http.StatusUnauthorized, "unauthorized")
		return
	}
	var req createReq
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeErr(w, http.StatusBadRequest, "invalid json")
		return
	}
	if req.Title == "" {
		writeErr(w, http.StatusBadRequest, "title required")
		return
	}
	p, err := h.svc.Create(r.Context(), uid, req.Title, req.Description)
	if err != nil {
		h.logger.Error("create project", "err", err)
		writeErr(w, http.StatusInternalServerError, "create failed")
		return
	}
	writeJSON(w, http.StatusCreated, p)
}

func (h *Handler) Get(w http.ResponseWriter, r *http.Request) {
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
	p, err := h.svc.Get(r.Context(), uid, pid)
	if err != nil {
		switch {
		case errors.Is(err, ErrNotFound):
			writeErr(w, http.StatusNotFound, "not found")
		case errors.Is(err, ErrForbidden):
			writeErr(w, http.StatusForbidden, "forbidden")
		default:
			h.logger.Error("get project", "err", err)
			writeErr(w, http.StatusInternalServerError, "get failed")
		}
		return
	}
	// Отдаём вместе с проектом роль вызывающего: страница проекта по ней решает,
	// показывать ли редакторы (соавтору и наблюдателю — нет).
	access, aerr := h.svc.AccessOf(r.Context(), uid, pid)
	if aerr != nil {
		h.logger.Error("project access", "err", aerr)
		writeErr(w, http.StatusInternalServerError, "get failed")
		return
	}
	writeJSON(w, http.StatusOK, projectDetail{
		Project:  p,
		Role:     string(access.Role),
		Coauthor: access.Coauthor,
	})
}

func (h *Handler) Update(w http.ResponseWriter, r *http.Request) {
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
	var req updateReq
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeErr(w, http.StatusBadRequest, "invalid json")
		return
	}
	if err := h.svc.Update(r.Context(), uid, pid, req.Title, req.Description); err != nil {
		switch {
		case errors.Is(err, ErrForbidden):
			writeErr(w, http.StatusForbidden, "forbidden")
		case errors.Is(err, ErrNotFound):
			writeErr(w, http.StatusNotFound, "not found")
		default:
			h.logger.Error("update project", "err", err)
			writeErr(w, http.StatusInternalServerError, "update failed")
		}
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"status": "updated"})
}

func (h *Handler) Delete(w http.ResponseWriter, r *http.Request) {
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
	if err := h.svc.Delete(r.Context(), uid, pid); err != nil {
		switch {
		case errors.Is(err, ErrForbidden):
			writeErr(w, http.StatusForbidden, "forbidden")
		case errors.Is(err, ErrNotFound):
			writeErr(w, http.StatusNotFound, "not found")
		default:
			h.logger.Error("delete project", "err", err)
			writeErr(w, http.StatusInternalServerError, "delete failed")
		}
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func writeJSON(w http.ResponseWriter, status int, body any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(body)
}

func writeErr(w http.ResponseWriter, status int, msg string) {
	writeJSON(w, status, map[string]string{"error": msg})
}
