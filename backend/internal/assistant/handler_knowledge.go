package assistant

// handler_knowledge.go — HTTP-ручки знаний проекта и срока хранения бесед (0.149.0).
//
// Отдельный файл, а не дополнение к handler.go: там беседы и правки, здесь — то, что
// остаётся после бесед. Смешивать их в одном файле значило бы держать рядом две разные
// модели прав: беседа личная (только своя), знание проектное (все участники).

import (
	"errors"
	"net/http"
	"strings"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"

	"github.com/skyfraze/backend/internal/store"
)

// knowledgeBody — тело создания и правки знания.
type knowledgeBody struct {
	Title   string   `json:"title"`
	Summary string   `json:"summary"`
	Body    string   `json:"body"`
	Tags    []string `json:"tags"`
}

// ListKnowledge — GET .../ai/knowledge?q=: знания проекта (без тел).
func (h *Handler) ListKnowledge(w http.ResponseWriter, r *http.Request) {
	uid, pid, ok := h.scope(w, r)
	if !ok {
		return
	}
	list, err := h.svc.KnowledgeList(r.Context(), uid, pid, r.URL.Query().Get("q"))
	if err != nil {
		h.fail(w, "list knowledge", err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"knowledge": list})
}

// GetKnowledge — GET .../ai/knowledge/{kid}: знание целиком, с телом.
func (h *Handler) GetKnowledge(w http.ResponseWriter, r *http.Request) {
	uid, pid, ok := h.scope(w, r)
	if !ok {
		return
	}
	kid, ok := h.knowledgeID(w, r)
	if !ok {
		return
	}
	item, err := h.svc.KnowledgeGet(r.Context(), uid, pid, kid)
	if err != nil {
		h.fail(w, "get knowledge", err)
		return
	}
	writeJSON(w, http.StatusOK, item)
}

// ListKnowledgeTags — GET .../ai/knowledge/tags: метки проекта для автодополнения (0.153.0).
func (h *Handler) ListKnowledgeTags(w http.ResponseWriter, r *http.Request) {
	uid, pid, ok := h.scope(w, r)
	if !ok {
		return
	}
	list, err := h.svc.KnowledgeTags(r.Context(), uid, pid)
	if err != nil {
		h.fail(w, "list knowledge tags", err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"tags": list})
}

// CreateKnowledge — POST .../ai/knowledge: человек написал знание руками.
func (h *Handler) CreateKnowledge(w http.ResponseWriter, r *http.Request) {
	uid, pid, ok := h.scope(w, r)
	if !ok {
		return
	}
	var body knowledgeBody
	if err := decodeJSON(w, r, &body); err != nil {
		return
	}
	item, err := h.svc.KnowledgeCreate(r.Context(), uid, pid, KnowledgeInput{
		Title: body.Title, Summary: body.Summary, Body: body.Body, Tags: body.Tags,
	})
	if err != nil {
		writeErr(w, http.StatusBadRequest, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, item)
}

// UpdateKnowledge — PUT .../ai/knowledge/{kid}.
func (h *Handler) UpdateKnowledge(w http.ResponseWriter, r *http.Request) {
	uid, pid, ok := h.scope(w, r)
	if !ok {
		return
	}
	kid, ok := h.knowledgeID(w, r)
	if !ok {
		return
	}
	var body knowledgeBody
	if err := decodeJSON(w, r, &body); err != nil {
		return
	}
	item, err := h.svc.KnowledgeUpdate(r.Context(), uid, pid, kid, KnowledgeInput{
		Title: body.Title, Summary: body.Summary, Body: body.Body, Tags: body.Tags,
	})
	if err != nil {
		if errors.Is(err, store.ErrNotFound) {
			writeErr(w, http.StatusNotFound, "знание не найдено")
			return
		}
		writeErr(w, http.StatusBadRequest, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, item)
}

// DeleteKnowledge — DELETE .../ai/knowledge/{kid}.
func (h *Handler) DeleteKnowledge(w http.ResponseWriter, r *http.Request) {
	uid, pid, ok := h.scope(w, r)
	if !ok {
		return
	}
	kid, ok := h.knowledgeID(w, r)
	if !ok {
		return
	}
	if err := h.svc.KnowledgeDelete(r.Context(), uid, pid, kid); err != nil {
		if errors.Is(err, store.ErrNotFound) {
			writeErr(w, http.StatusNotFound, "знание не найдено")
			return
		}
		h.fail(w, "delete knowledge", err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// KeepConversation — POST .../ai/conversations/{cid}/keep: «не удалять эту беседу».
func (h *Handler) KeepConversation(w http.ResponseWriter, r *http.Request) {
	uid, pid, ok := h.scope(w, r)
	if !ok {
		return
	}
	cid, ok := h.conversationID(w, r)
	if !ok {
		return
	}
	var body struct {
		Kept *bool `json:"kept"`
	}
	if err := decodeJSON(w, r, &body); err != nil {
		return
	}
	// По умолчанию — «оставить»: кнопка в интерфейсе называется «не удалять», и если тело
	// пришло без поля, честнее сохранить беседу, чем удалить её по опечатке.
	kept := true
	if body.Kept != nil {
		kept = *body.Kept
	}
	if err := h.svc.KeepConversation(r.Context(), uid, pid, cid, kept); err != nil {
		h.fail(w, "keep conversation", err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// SetRetention — PUT .../ai/retention: срок хранения бесед проекта в днях (0 — не удалять).
func (h *Handler) SetRetention(w http.ResponseWriter, r *http.Request) {
	uid, pid, ok := h.scope(w, r)
	if !ok {
		return
	}
	var body struct {
		Days int `json:"days"`
	}
	if err := decodeJSON(w, r, &body); err != nil {
		return
	}
	settings, err := h.svc.SetRetention(r.Context(), uid, pid, body.Days)
	if err != nil {
		if errors.Is(err, ErrForbidden) {
			writeErr(w, http.StatusForbidden, "срок хранения бесед меняет владелец проекта")
			return
		}
		h.fail(w, "set retention", err)
		return
	}
	writeJSON(w, http.StatusOK, settings)
}

// knowledgeID читает {kid}.
func (h *Handler) knowledgeID(w http.ResponseWriter, r *http.Request) (uuid.UUID, bool) {
	raw := strings.TrimSpace(chi.URLParam(r, "kid"))
	id, err := uuid.Parse(raw)
	if err != nil {
		writeErr(w, http.StatusBadRequest, "invalid knowledge id")
		return uuid.Nil, false
	}
	return id, true
}
