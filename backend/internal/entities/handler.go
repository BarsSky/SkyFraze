package entities

// handler.go — HTTP-ручки карточек сущностей проекта (docs/entity-links.md).
//
// Пути (внутри /api/projects/{id}):
//
//	GET    /entities            — карточки проекта (viewer+)
//	POST   /entities            — создать (editor+)
//	PATCH  /entities/{entityID} — изменить (editor+)
//	DELETE /entities/{entityID} — удалить (editor+)
//
// Отдельный пакет, а не добавка к events: сущности — не текст проекта, они не попадают ни в
// CRDT-документ, ни в книгу. Тот же выбор, что у замечаний (0018), и по той же причине.

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
	"github.com/skyfraze/backend/internal/store"
)

// Handler — ручки сущностей.
type Handler struct {
	svc    *Service
	logger *slog.Logger
}

func NewHandler(svc *Service, logger *slog.Logger) *Handler {
	return &Handler{svc: svc, logger: logger}
}

// Mount вешает ручки на под-роутер проекта.
func (h *Handler) Mount(r chi.Router) {
	r.Get("/entities", h.List)
	r.Post("/entities", h.Create)
	r.Patch("/entities/{entityID}", h.Update)
	r.Delete("/entities/{entityID}", h.Delete)
	// Связи между карточками мира (миграция 0032).
	h.linkRoutes(r)
	// Свои типы карточек (0.81.0, миграция 0034).
	r.Get("/entity-types", h.ListTypes)
	r.Post("/entity-types", h.CreateType)
	r.Patch("/entity-types/{key}", h.UpdateType)
	r.Delete("/entity-types/{key}", h.DeleteType)
	// Картинка у упоминания карточки в кадре (0.93.0, миграция 0037).
	h.mentionImageRoutes(r)
}

// entityInput — тело запроса; указатели у необязательных полей, чтобы «не прислали» не
// означало «стереть» (тот же контракт, что у профиля человека).
type entityInput struct {
	Kind        string    `json:"kind"`
	Name        string    `json:"name"`
	Aliases     *[]string `json:"aliases"`
	Description *string   `json:"description"`
	Color       *string   `json:"color"`
}

func (in entityInput) toInput() Input {
	return Input{
		Kind: in.Kind, Name: in.Name,
		Aliases: in.Aliases, Description: in.Description, Color: in.Color,
	}
}

// List — GET /entities.
func (h *Handler) List(w http.ResponseWriter, r *http.Request) {
	userID, projectID, ok := h.target(w, r)
	if !ok {
		return
	}
	list, err := h.svc.ListEntities(r.Context(), userID, projectID)
	if err != nil {
		h.fail(w, err, "entities list")
		return
	}
	if list == nil {
		list = []store.ProjectEntity{}
	}
	writeJSON(w, http.StatusOK, map[string]any{"entities": list})
}

// Create — POST /entities.
func (h *Handler) Create(w http.ResponseWriter, r *http.Request) {
	userID, projectID, ok := h.target(w, r)
	if !ok {
		return
	}
	var body entityInput
	if err := decode(r, &body); err != nil {
		writeErr(w, http.StatusBadRequest, "invalid json")
		return
	}
	entity, err := h.svc.Create(r.Context(), userID, projectID, body.toInput())
	if err != nil {
		h.fail(w, err, "entities create")
		return
	}
	writeJSON(w, http.StatusCreated, map[string]any{"entity": entity})
}

// Update — PATCH /entities/{entityID}.
func (h *Handler) Update(w http.ResponseWriter, r *http.Request) {
	userID, projectID, ok := h.target(w, r)
	if !ok {
		return
	}
	entityID, ok := h.entityID(w, r)
	if !ok {
		return
	}
	var body entityInput
	if err := decode(r, &body); err != nil {
		writeErr(w, http.StatusBadRequest, "invalid json")
		return
	}
	entity, err := h.svc.Update(r.Context(), userID, projectID, entityID, body.toInput())
	if err != nil {
		h.fail(w, err, "entities update")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"entity": entity})
}

// Delete — DELETE /entities/{entityID}.
func (h *Handler) Delete(w http.ResponseWriter, r *http.Request) {
	userID, projectID, ok := h.target(w, r)
	if !ok {
		return
	}
	entityID, ok := h.entityID(w, r)
	if !ok {
		return
	}
	if err := h.svc.Delete(r.Context(), userID, projectID, entityID); err != nil {
		h.fail(w, err, "entities delete")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true})
}

// target достаёт человека и проект из запроса.
func (h *Handler) target(w http.ResponseWriter, r *http.Request) (uuid.UUID, uuid.UUID, bool) {
	userID, err := auth.UserIDFromCtx(r.Context())
	if err != nil {
		writeErr(w, http.StatusUnauthorized, "unauthorized")
		return uuid.Nil, uuid.Nil, false
	}
	projectID, err := uuid.Parse(chi.URLParam(r, "id"))
	if err != nil {
		writeErr(w, http.StatusBadRequest, "invalid id")
		return uuid.Nil, uuid.Nil, false
	}
	return userID, projectID, true
}

func (h *Handler) entityID(w http.ResponseWriter, r *http.Request) (uuid.UUID, bool) {
	id, err := uuid.Parse(chi.URLParam(r, "entityID"))
	if err != nil {
		writeErr(w, http.StatusBadRequest, "invalid entity id")
		return uuid.Nil, false
	}
	return id, true
}

// fail переводит ошибки сервиса в коды ответов.
func (h *Handler) fail(w http.ResponseWriter, err error, op string) {
	var hasCards ErrTypeHasCards
	switch {
	case errors.Is(err, ErrInvalidEntity):
		writeErr(w, http.StatusBadRequest, err.Error())
	case errors.Is(err, ErrEntityExists):
		writeErr(w, http.StatusConflict, "сущность с таким именем уже есть в проекте")
	case errors.Is(err, ErrTypeNotFound):
		writeErr(w, http.StatusNotFound, "тип карточки не найден")
	case errors.Is(err, ErrMentionImageTarget):
		// 404, а не 400: пара «карточка × кадр» или файл либо есть в проекте, либо нет.
		writeErr(w, http.StatusNotFound, err.Error())
	case errors.Is(err, ErrNotImage):
		writeErr(w, http.StatusBadRequest, err.Error())
	case errors.Is(err, ErrTypeDefault):
		writeErr(w, http.StatusConflict, err.Error())
	case errors.As(err, &hasCards):
		// 409, а не 400: запрос правильный, конфликт в данных — и в тексте есть, что делать.
		writeErr(w, http.StatusConflict, hasCards.Error())
	case errors.Is(err, store.ErrNotFound), errors.Is(err, projects.ErrNotFound):
		writeErr(w, http.StatusNotFound, "not found")
	case errors.Is(err, projects.ErrForbidden):
		writeErr(w, http.StatusForbidden, "forbidden")
	default:
		h.logger.Error(op, "err", err)
		writeErr(w, http.StatusInternalServerError, "failed")
	}
}

func decode(r *http.Request, out any) error {
	// 64 КиБ: карточка — это имя, алиасы и абзац описания, а не файл.
	if err := json.NewDecoder(io.LimitReader(r.Body, 64<<10)).Decode(out); err != nil {
		return err
	}
	return nil
}

func writeJSON(w http.ResponseWriter, status int, body any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(body)
}

func writeErr(w http.ResponseWriter, status int, msg string) {
	writeJSON(w, status, map[string]string{"error": msg})
}
