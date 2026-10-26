package projects

import (
	"context"
	"encoding/json"
	"errors"
	"log/slog"
	"math"
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
	// quota — предел вложений проекта (0 — без предела): список проектов показывает
	// его вместе с весом. Значение приходит из assets.Service при сборке приложения,
	// чтобы предел имел один источник истины.
	quota int64
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
	// /trash здесь НЕТ намеренно, хотя по смыслу он «коллекция». Роутер монтируется через
	// Mount, а param-ветка /api/projects/{id} в cmd/server/main.go перехватывает статический
	// "trash" как идентификатор: chi выбирает {id} раньше wildcard от Mount, uuid.Parse
	// получает "trash" и отдаёт 400. Поэтому корзина регистрируется на корневом роутере
	// рядом с /api/projects/import — до монтирования (проверено e2e).
	return r
}

// Trash — GET /api/projects/trash: удалённые проекты владельца.
func (h *Handler) Trash(w http.ResponseWriter, r *http.Request) {
	uid, err := auth.UserIDFromCtx(r.Context())
	if err != nil {
		writeErr(w, http.StatusUnauthorized, "unauthorized")
		return
	}
	list, err := h.svc.Trash(r.Context(), uid)
	if err != nil {
		h.logger.Error("project trash", "err", err)
		writeErr(w, http.StatusInternalServerError, "failed")
		return
	}
	// Вес — тем же агрегатом, что у списка проектов: «сколько места освободится» видно до
	// необратимого действия, а не после. Ошибка веса не валит корзину: без числа проект
	// вернуть всё равно можно, а показать «пусто» из-за одного агрегата было бы хуже.
	weights, werr := h.svc.AssetBytesByProject(r.Context())
	if werr != nil {
		h.logger.Warn("project trash weights", "err", werr)
	}
	out := make([]map[string]any, 0, len(list))
	for _, p := range list {
		item := map[string]any{
			"id": p.ID.String(), "title": p.Title, "description": p.Description,
			"deleted_at": p.DeletedAt, "asset_bytes": weights[p.ID],
		}
		// Сколько дней осталось до окончательного удаления — это и есть обещание корзины,
		// и человек должен видеть срок, а не догадываться о нём.
		if p.DeletedAt != nil {
			left := TrashRetention - time.Since(*p.DeletedAt)
			// Округление вверх: удалил минуту назад — «можно вернуть ещё 30 дней», а не
			// 29. Остаток меньше суток всё равно означает «сегодня последний шанс», и
			// показывать 0 при живом проекте было бы ложью в другую сторону.
			days := int(math.Ceil(left.Hours() / 24))
			if days < 0 {
				days = 0
			}
			item["days_left"] = days
		}
		out = append(out, item)
	}
	writeJSON(w, http.StatusOK, map[string]any{"projects": out, "retention_days": int(TrashRetention.Hours() / 24)})
}

// RestoreTrash — POST /api/projects/{id}/restore: вернуть проект из корзины.
func (h *Handler) RestoreTrash(w http.ResponseWriter, r *http.Request) {
	h.trashAction(w, r, h.svc.Restore, "restore project")
}

// PurgeTrash — DELETE /api/projects/{id}/purge: удалить из корзины навсегда.
func (h *Handler) PurgeTrash(w http.ResponseWriter, r *http.Request) {
	h.trashAction(w, r, h.svc.Purge, "purge project")
}

// trashAction — общее для «вернуть» и «удалить навсегда»: права и ответы одинаковые.
func (h *Handler) trashAction(
	w http.ResponseWriter, r *http.Request,
	action func(context.Context, uuid.UUID, uuid.UUID) error, op string,
) {
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
	if err := action(r.Context(), uid, pid); err != nil {
		switch {
		case errors.Is(err, ErrNotFound):
			writeErr(w, http.StatusNotFound, "not found")
		case errors.Is(err, ErrForbidden):
			writeErr(w, http.StatusForbidden, "forbidden")
		default:
			h.logger.Error(op, "err", err)
			writeErr(w, http.StatusInternalServerError, "failed")
		}
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// projectListItem — проект вместе с тем, КАК пользователь получил к нему доступ:
// как владелец, как участник команды или как соавтор, которому владелец открыл
// закрытый проект на чтение. Интерфейс показывает последние отдельным блоком.
type projectListItem struct {
	*store.Project
	Access string `json:"access"`
	// AssetBytes — сколько занимают вложения проекта (после пережатия), QuotaBytes —
	// предел. Нужны списку проектов: «проект весит 8.4 МБ из 10» видно до открытия,
	// а не когда загрузка уже упёрлась в отказ.
	AssetBytes int64 `json:"asset_bytes"`
	QuotaBytes int64 `json:"quota_bytes"`
}

// listItem собирает строку списка: проект, доступ и его вес.
func (h *Handler) listItem(p *store.Project, access string, weights map[uuid.UUID]int64) projectListItem {
	return projectListItem{
		Project:    p,
		Access:     access,
		AssetBytes: weights[p.ID],
		QuotaBytes: h.quota,
	}
}

// UseQuota задаёт предел вложений проекта: список показывает «сколько занято из
// предела». Ноль означает «без предела» — тогда интерфейс показывает только вес.
func (h *Handler) UseQuota(limit int64) { h.quota = limit }

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

	// Вес вложений — одним запросом на все проекты: у каждой карточки списка он
	// показывается, и делать по запросу на проект было бы N+1.
	weights, err := h.svc.AssetBytesByProject(r.Context())
	if err != nil {
		h.logger.Error("list project weights", "err", err)
		writeErr(w, http.StatusInternalServerError, "list failed")
		return
	}

	items := make([]projectListItem, 0, len(ps)+len(shared))
	for i := range ps {
		access := "member"
		if ps[i].OwnerID == uid {
			access = "owner"
		}
		items = append(items, h.listItem(&ps[i], access, weights))
	}
	for i := range shared {
		items = append(items, h.listItem(&shared[i], "coauthor", weights))
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
