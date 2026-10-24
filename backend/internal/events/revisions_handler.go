package events

// revisions_handler.go — HTTP-ручки истории версий.
//
// Пути: /api/projects/{id}/versions/{vid}. Название «versions», а не «revisions»: в API
// уже есть `revision` у снапшота (оптимистичная блокировка), и два разных «revision» в
// одном ответе читались бы как одно и то же.

import (
	"encoding/json"
	"io"
	"net/http"
	"strconv"
	"strings"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"

	"github.com/skyfraze/backend/internal/store"
)

// MountVersions вешает ручки версий на уже смонтированный /api/projects/{id}.
func (h *Handler) MountVersions(r chi.Router) {
	// Список и предпросмотр — viewer+: читать историю может любой участник. Создание,
	// восстановление и удаление — editor+ (проверяет сервис).
	r.Get("/versions", h.ListVersions)
	r.Post("/versions", h.CreateVersion)
	r.Get("/versions/{vid}", h.GetVersion)
	r.Post("/versions/{vid}/restore", h.RestoreVersion)
	r.Delete("/versions/{vid}", h.DeleteVersion)
}

// ListVersions — GET /versions?limit=50.
func (h *Handler) ListVersions(w http.ResponseWriter, r *http.Request) {
	uid, pid, ok := h.identity(w, r)
	if !ok {
		return
	}
	limit := 50
	if raw := strings.TrimSpace(r.URL.Query().Get("limit")); raw != "" {
		if n, err := strconv.Atoi(raw); err == nil {
			limit = n
		}
	}
	list, err := h.svc.ListRevisions(r.Context(), uid, pid, limit)
	if err != nil {
		h.fail(w, err, "list versions")
		return
	}
	if list == nil {
		list = []store.ProjectRevision{}
	}
	writeJSON(w, http.StatusOK, map[string]any{"versions": list})
}

// CreateVersion — POST /versions: ручная версия («Сохранить версию»).
func (h *Handler) CreateVersion(w http.ResponseWriter, r *http.Request) {
	uid, pid, ok := h.identity(w, r)
	if !ok {
		return
	}
	var body struct {
		Label string `json:"label"`
	}
	if err := json.NewDecoder(io.LimitReader(r.Body, 4<<10)).Decode(&body); err != nil && err != io.EOF {
		writeErr(w, http.StatusBadRequest, "invalid json")
		return
	}
	rev, err := h.svc.SaveRevision(r.Context(), uid, pid, strings.TrimSpace(body.Label))
	if err != nil {
		h.fail(w, err, "create version")
		return
	}
	writeJSON(w, http.StatusCreated, rev)
}

// GetVersion — GET /versions/{vid}: дерево версии без применения.
func (h *Handler) GetVersion(w http.ResponseWriter, r *http.Request) {
	uid, pid, ok := h.identity(w, r)
	if !ok {
		return
	}
	vid, ok := h.versionID(w, r)
	if !ok {
		return
	}
	preview, err := h.svc.RevisionPreview(r.Context(), uid, pid, vid)
	if err != nil {
		h.fail(w, err, "version preview")
		return
	}
	writeJSON(w, http.StatusOK, preview)
}

// RestoreVersion — POST /versions/{vid}/restore: привести проект к этой версии.
func (h *Handler) RestoreVersion(w http.ResponseWriter, r *http.Request) {
	uid, pid, ok := h.identity(w, r)
	if !ok {
		return
	}
	vid, ok := h.versionID(w, r)
	if !ok {
		return
	}
	outcome, err := h.svc.RestoreRevision(r.Context(), uid, uid, pid, vid)
	if err != nil {
		h.fail(w, err, "restore version")
		return
	}
	writeJSON(w, http.StatusOK, outcome)
}

// DeleteVersion — DELETE /versions/{vid}.
func (h *Handler) DeleteVersion(w http.ResponseWriter, r *http.Request) {
	uid, pid, ok := h.identity(w, r)
	if !ok {
		return
	}
	vid, ok := h.versionID(w, r)
	if !ok {
		return
	}
	if err := h.svc.DeleteRevision(r.Context(), uid, pid, vid); err != nil {
		h.fail(w, err, "delete version")
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// versionID читает {vid}.
func (h *Handler) versionID(w http.ResponseWriter, r *http.Request) (uuid.UUID, bool) {
	vid, err := uuid.Parse(strings.TrimSpace(chi.URLParam(r, "vid")))
	if err != nil {
		writeErr(w, http.StatusBadRequest, "invalid version id")
		return uuid.Nil, false
	}
	return vid, true
}
