package entities

// mention_images_handler.go — ручки картинки у упоминания карточки (0.93.0).
//
// Пути (внутри /api/projects/{id}):
//
//	GET    /mention-images                          — все привязки проекта (viewer+)
//	PUT    /mention-images/{entityID}/{eventID}     — привязать/заменить (editor+), тело {asset_id}
//	DELETE /mention-images/{entityID}/{eventID}     — отвязать (editor+)
//
// Список отдельной ручкой, а не картинка в ответе `GET /entities`: карточки мира бывают нужны
// без картинок (поиск упоминаний, помощник, импорт), а привязки — только панели «Связи».

import (
	"net/http"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"
)

// mentionImageRoutes вешает ручки картинок упоминаний.
func (h *Handler) mentionImageRoutes(r chi.Router) {
	r.Get("/mention-images", h.ListMentionImages)
	r.Put("/mention-images/{entityID}/{eventID}", h.SetMentionImage)
	r.Delete("/mention-images/{entityID}/{eventID}", h.DeleteMentionImage)
}

// ListMentionImages — GET /mention-images.
func (h *Handler) ListMentionImages(w http.ResponseWriter, r *http.Request) {
	userID, projectID, ok := h.target(w, r)
	if !ok {
		return
	}
	list, err := h.svc.MentionImages(r.Context(), userID, projectID)
	if err != nil {
		h.fail(w, err, "mention images list")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"images": list})
}

// mentionImageInput — тело привязки.
type mentionImageInput struct {
	AssetID string `json:"asset_id"`
}

// SetMentionImage — PUT /mention-images/{entityID}/{eventID}.
func (h *Handler) SetMentionImage(w http.ResponseWriter, r *http.Request) {
	userID, projectID, ok := h.target(w, r)
	if !ok {
		return
	}
	entityID, eventID, ok := h.mentionImageTarget(w, r)
	if !ok {
		return
	}
	var body mentionImageInput
	if err := decode(r, &body); err != nil {
		writeErr(w, http.StatusBadRequest, "invalid json")
		return
	}
	assetID, err := uuid.Parse(body.AssetID)
	if err != nil {
		writeErr(w, http.StatusBadRequest, "invalid asset id")
		return
	}
	image, err := h.svc.SetMentionImage(r.Context(), userID, projectID, entityID, eventID, assetID)
	if err != nil {
		h.fail(w, err, "mention image set")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"image": image})
}

// DeleteMentionImage — DELETE /mention-images/{entityID}/{eventID}.
func (h *Handler) DeleteMentionImage(w http.ResponseWriter, r *http.Request) {
	userID, projectID, ok := h.target(w, r)
	if !ok {
		return
	}
	entityID, eventID, ok := h.mentionImageTarget(w, r)
	if !ok {
		return
	}
	removed, err := h.svc.ClearMentionImage(r.Context(), userID, projectID, entityID, eventID)
	if err != nil {
		h.fail(w, err, "mention image delete")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "removed": removed})
}

// mentionImageTarget разбирает пару «карточка × кадр» из пути.
func (h *Handler) mentionImageTarget(w http.ResponseWriter, r *http.Request) (uuid.UUID, uuid.UUID, bool) {
	entityID, err := uuid.Parse(chi.URLParam(r, "entityID"))
	if err != nil {
		writeErr(w, http.StatusBadRequest, "invalid entity id")
		return uuid.Nil, uuid.Nil, false
	}
	eventID, err := uuid.Parse(chi.URLParam(r, "eventID"))
	if err != nil {
		writeErr(w, http.StatusBadRequest, "invalid event id")
		return uuid.Nil, uuid.Nil, false
	}
	return entityID, eventID, true
}
