package docxtpl

// handler.go — ручки шаблонов оформления DOCX (0.91.0).
//
// Пути внутри /api/projects/{id}:
//
//	GET    /docx-templates                      — список шаблонов (редактор+)
//	POST   /docx-templates                      — загрузить шаблон (владелец), multipart: file, name
//	POST   /docx-templates/{templateID}/activate — сделать активным (владелец)
//	DELETE /docx-templates/{templateID}          — убрать шаблон (владелец)
//
// Скачивание (GET /export/docx) берёт активный шаблон само — отдельной ручки «скачать» нет.

import (
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"net/http"
	"strconv"
	"strings"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"

	"github.com/skyfraze/backend/internal/auth"
	"github.com/skyfraze/backend/internal/store"
)

// Handler — ручки шаблонов.
type Handler struct {
	svc    *Service
	logger *slog.Logger
}

func NewHandler(svc *Service, logger *slog.Logger) *Handler {
	return &Handler{svc: svc, logger: logger}
}

// Mount вешает ручки на под-роутер проекта.
func (h *Handler) Mount(r chi.Router) {
	r.Get("/docx-templates", h.List)
	// Статический сегмент рядом с {templateID}: chi отдаёт приоритет статике, поэтому
	// `/docx-templates/sample` не попадёт в обработчик идентификатора.
	r.Get("/docx-templates/sample", h.Sample)
	r.Post("/docx-templates", h.Upload)
	r.Post("/docx-templates/{templateID}/activate", h.Activate)
	r.Delete("/docx-templates/{templateID}", h.Delete)
}

// Sample — GET /docx-templates/sample: готовый пример шаблона (0.94.0).
//
// Отдаём файл, а не инструкцию: человек открывает пример в Word, меняет титул, шрифты и поля,
// оставляет абзац {{content}} и имена стилей — и загружает обратно. Это снимает главный вопрос
// «как вообще начать», из-за которого фича выглядела нерабочей.
func (h *Handler) Sample(w http.ResponseWriter, r *http.Request) {
	userID, projectID, ok := h.target(w, r)
	if !ok {
		return
	}
	data, err := h.svc.Sample(r.Context(), userID, projectID)
	if err != nil {
		h.fail(w, err, "docx template sample")
		return
	}
	w.Header().Set("Content-Type", docxMime)
	w.Header().Set("Content-Disposition", `attachment; filename="skyfraze-template-example.docx"`)
	w.Header().Set("Content-Length", strconv.Itoa(len(data)))
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write(data)
}

// List — GET /docx-templates.
func (h *Handler) List(w http.ResponseWriter, r *http.Request) {
	userID, projectID, ok := h.target(w, r)
	if !ok {
		return
	}
	list, err := h.svc.List(r.Context(), userID, projectID)
	if err != nil {
		h.fail(w, err, "docx templates list")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"templates": list})
}

// Upload — POST /docx-templates (multipart: file — .docx, name — имя шаблона).
func (h *Handler) Upload(w http.ResponseWriter, r *http.Request) {
	userID, projectID, ok := h.target(w, r)
	if !ok {
		return
	}
	// Потолок тела — MaxTemplateSize + запас на multipart-обвязку.
	if err := r.ParseMultipartForm(MaxTemplateSize + (1 << 20)); err != nil {
		writeErr(w, http.StatusBadRequest, "файл шаблона слишком большой или форма не разобрана")
		return
	}
	file, header, err := r.FormFile("file")
	if err != nil {
		writeErr(w, http.StatusBadRequest, "нужен файл .docx в поле file")
		return
	}
	defer file.Close()
	entry, err := h.svc.Upload(r.Context(), userID, projectID,
		r.FormValue("name"), header.Filename, header.Size, file)
	if err != nil {
		h.fail(w, err, "docx template upload")
		return
	}
	h.logger.Info("docx template uploaded",
		"project", projectID, "user", userID, "template", entry.ID, "bytes", entry.Size)
	writeJSON(w, http.StatusCreated, map[string]any{"template": entry})
}

// Activate — POST /docx-templates/{templateID}/activate.
func (h *Handler) Activate(w http.ResponseWriter, r *http.Request) {
	userID, projectID, ok := h.target(w, r)
	if !ok {
		return
	}
	id, ok := h.templateID(w, r)
	if !ok {
		return
	}
	list, err := h.svc.Activate(r.Context(), userID, projectID, id)
	if err != nil {
		h.fail(w, err, "docx template activate")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"templates": list})
}

// Delete — DELETE /docx-templates/{templateID}.
func (h *Handler) Delete(w http.ResponseWriter, r *http.Request) {
	userID, projectID, ok := h.target(w, r)
	if !ok {
		return
	}
	id, ok := h.templateID(w, r)
	if !ok {
		return
	}
	list, err := h.svc.Delete(r.Context(), userID, projectID, id)
	if err != nil {
		h.fail(w, err, "docx template delete")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"templates": list})
}

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

func (h *Handler) templateID(w http.ResponseWriter, r *http.Request) (uuid.UUID, bool) {
	id, err := uuid.Parse(chi.URLParam(r, "templateID"))
	if err != nil {
		writeErr(w, http.StatusBadRequest, "invalid template id")
		return uuid.Nil, false
	}
	return id, true
}

// fail переводит ошибки сервиса в коды и объясняет отказ словами сервера.
func (h *Handler) fail(w http.ResponseWriter, err error, where string) {
	switch {
	case errors.Is(err, ErrForbidden):
		writeErr(w, http.StatusForbidden, "шаблон меняет только владелец проекта")
	case errors.Is(err, ErrNotFound):
		writeErr(w, http.StatusNotFound, "шаблон не найден")
	case errors.Is(err, ErrNameTaken):
		writeErr(w, http.StatusConflict, err.Error())
	case errors.Is(err, ErrBadTemplate), errors.Is(err, ErrNoPlaceholder):
		writeErr(w, http.StatusBadRequest, err.Error())
	default:
		h.logger.Error(where, "err", err)
		writeErr(w, http.StatusInternalServerError, "не удалось")
	}
}

func writeJSON(w http.ResponseWriter, status int, payload any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(payload)
}

func writeErr(w http.ResponseWriter, status int, message string) {
	writeJSON(w, status, map[string]string{"error": strings.TrimSpace(message)})
}

// silence unused import when слежение за store форматом: типы store используются в сервисе.
var _ = store.ErrNotFound
var _ = io.Discard
