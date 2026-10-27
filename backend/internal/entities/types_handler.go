package entities

// types_handler.go — ручки своих типов карточек (0.81.0, миграция 0034).
//
// Контракт сознательно «плоский»: `{key, title, icon, color}`, где `key` неизменяем. Клиенту не
// нужно знать, что тип живёт строкой таблицы проекта, — ему нужно выбрать вид карточки и один раз
// завести свой.

import (
	"net/http"
	"strings"

	"github.com/go-chi/chi/v5"

	"github.com/skyfraze/backend/internal/store"
)

// ListTypes — GET /entity-types: типы проекта в порядке показа.
func (h *Handler) ListTypes(w http.ResponseWriter, r *http.Request) {
	userID, projectID, ok := h.target(w, r)
	if !ok {
		return
	}
	list, err := h.svc.Types(r.Context(), userID, projectID)
	if err != nil {
		h.fail(w, err, "entity types list")
		return
	}
	if list == nil {
		list = []store.EntityType{}
	}
	writeJSON(w, http.StatusOK, map[string]any{"types": list})
}

type typeInput struct {
	Title string `json:"title"`
	Icon  string `json:"icon"`
	Color string `json:"color"`
}

// CreateType — POST /entity-types: завести свой тип.
func (h *Handler) CreateType(w http.ResponseWriter, r *http.Request) {
	userID, projectID, ok := h.target(w, r)
	if !ok {
		return
	}
	var body typeInput
	if err := decode(r, &body); err != nil {
		writeErr(w, http.StatusBadRequest, "invalid json")
		return
	}
	created, err := h.svc.CreateType(r.Context(), userID, projectID, body.Title, body.Icon, body.Color)
	if err != nil {
		h.fail(w, err, "entity type create")
		return
	}
	h.logger.Info("entity type created", "project", projectID, "key", created.Key, "user", userID)
	writeJSON(w, http.StatusCreated, map[string]any{"type": created})
}

// UpdateType — PATCH /entity-types/{key}: переименовать, сменить значок или цвет.
func (h *Handler) UpdateType(w http.ResponseWriter, r *http.Request) {
	userID, projectID, ok := h.target(w, r)
	if !ok {
		return
	}
	var body typeInput
	if err := decode(r, &body); err != nil {
		writeErr(w, http.StatusBadRequest, "invalid json")
		return
	}
	updated, err := h.svc.UpdateType(
		r.Context(), userID, projectID, strings.TrimSpace(chi.URLParam(r, "key")), body.Title, body.Icon, body.Color)
	if err != nil {
		h.fail(w, err, "entity type update")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"type": updated})
}

// DeleteType — DELETE /entity-types/{key}: убрать свой тип (стартовые и занятые — отказ).
func (h *Handler) DeleteType(w http.ResponseWriter, r *http.Request) {
	userID, projectID, ok := h.target(w, r)
	if !ok {
		return
	}
	key := strings.TrimSpace(chi.URLParam(r, "key"))
	if err := h.svc.DeleteType(r.Context(), userID, projectID, key); err != nil {
		h.fail(w, err, "entity type delete")
		return
	}
	h.logger.Info("entity type deleted", "project", projectID, "key", key, "user", userID)
	w.WriteHeader(http.StatusNoContent)
}
