package entities

// links_handler.go — ручки связей между карточками мира (миграция 0032).
//
// Пути (внутри /api/projects/{id}):
//
//	GET    /entities/links                    — все связи проекта (viewer+)
//	POST   /entities/{entityID}/links         — связать карточку с другой (editor+)
//	DELETE /entities/links/{linkID}           — убрать связь (editor+)
//
// Список отдаётся целиком, а не «связи одной карточки»: интерфейсу нужны обе стороны сразу
// («на этой карточке: Аня — живёт на»), а связей в проекте десятки, не тысячи.

import (
	"errors"
	"net/http"
	"strings"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"

	"github.com/skyfraze/backend/internal/store"
)

// linkRoutes — регистрация ручек связей (вызывается из Mount).
func (h *Handler) linkRoutes(r chi.Router) {
	r.Get("/entities/links", h.ListLinks)
	r.Post("/entities/{entityID}/links", h.CreateLink)
	r.Delete("/entities/links/{linkID}", h.DeleteLink)
}

// ListLinks — GET /entities/links.
func (h *Handler) ListLinks(w http.ResponseWriter, r *http.Request) {
	userID, projectID, ok := h.target(w, r)
	if !ok {
		return
	}
	list, err := h.svc.Links(r.Context(), userID, projectID)
	if err != nil {
		h.fail(w, err, "entities links list")
		return
	}
	if list == nil {
		list = []store.EntityLink{}
	}
	writeJSON(w, http.StatusOK, map[string]any{"links": list})
}

// CreateLink — POST /entities/{entityID}/links {"to","label"}.
func (h *Handler) CreateLink(w http.ResponseWriter, r *http.Request) {
	userID, projectID, ok := h.target(w, r)
	if !ok {
		return
	}
	from, ok := h.entityID(w, r)
	if !ok {
		return
	}
	var body struct {
		To    string `json:"to"`
		Label string `json:"label"`
	}
	if err := decode(r, &body); err != nil {
		writeErr(w, http.StatusBadRequest, "invalid json")
		return
	}
	to, err := uuid.Parse(strings.TrimSpace(body.To))
	if err != nil {
		writeErr(w, http.StatusBadRequest, "нужен идентификатор карточки назначения")
		return
	}
	link, err := h.svc.AddLink(r.Context(), userID, projectID, from, to, body.Label)
	if err != nil {
		// Занятая связь — 409: это конфликт, а не неверные данные.
		if errors.Is(err, store.ErrEntityLinkExists) {
			writeErr(w, http.StatusConflict, "такая связь уже есть")
			return
		}
		h.fail(w, err, "entities link create")
		return
	}
	writeJSON(w, http.StatusCreated, map[string]any{"link": link})
}

// DeleteLink — DELETE /entities/links/{linkID}.
func (h *Handler) DeleteLink(w http.ResponseWriter, r *http.Request) {
	userID, projectID, ok := h.target(w, r)
	if !ok {
		return
	}
	id, err := uuid.Parse(chi.URLParam(r, "linkID"))
	if err != nil {
		writeErr(w, http.StatusBadRequest, "invalid link id")
		return
	}
	if err := h.svc.DeleteLink(r.Context(), userID, projectID, id); err != nil {
		h.fail(w, err, "entities link delete")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true})
}
