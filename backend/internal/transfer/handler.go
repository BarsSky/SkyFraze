package transfer

import (
	"bytes"
	"encoding/json"
	"errors"
	"log/slog"
	"net/http"
	"strconv"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"

	"github.com/skyfraze/backend/internal/auth"
)

type Handler struct {
	svc    *Service
	logger *slog.Logger
}

func NewHandler(svc *Service, logger *slog.Logger) *Handler {
	return &Handler{svc: svc, logger: logger}
}

// Export — GET /api/projects/{id}/export: отдаёт ZIP-архив проекта.
//
// Архив собирается в память: имя файла зависит от заголовка проекта, а после
// WriteHeader менять заголовки уже нельзя — иначе падение посреди выгрузки
// отдавало бы пользователю битый файл с кодом 200.
func (h *Handler) Export(w http.ResponseWriter, r *http.Request) {
	uid, err := auth.UserIDFromCtx(r.Context())
	if err != nil {
		writeErr(w, http.StatusUnauthorized, "unauthorized")
		return
	}
	pid, err := uuid.Parse(chi.URLParam(r, "id"))
	if err != nil {
		writeErr(w, http.StatusBadRequest, "invalid project id")
		return
	}

	var buf bytes.Buffer
	info, err := h.svc.Export(r.Context(), uid, pid, &buf)
	if err != nil {
		switch {
		case errors.Is(err, ErrForbidden):
			writeErr(w, http.StatusForbidden, "forbidden")
		case errors.Is(err, ErrNotFound):
			writeErr(w, http.StatusNotFound, "not found")
		default:
			h.logger.Error("export", "err", err, "project", pid)
			writeErr(w, http.StatusInternalServerError, "export failed")
		}
		return
	}

	w.Header().Set("Content-Type", "application/zip")
	w.Header().Set("Content-Disposition", "attachment; filename=\""+info.Filename+"\"")
	w.Header().Set("Content-Length", strconv.Itoa(buf.Len()))
	w.Header().Set("X-Skyfraze-Export-Events", strconv.Itoa(info.Events))
	w.Header().Set("X-Skyfraze-Export-Assets", strconv.Itoa(info.Assets))
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write(buf.Bytes())
}

// Import — POST /api/projects/import: создаёт проект из полученного архива.
// Владельцем становится импортирующий пользователь.
func (h *Handler) Import(w http.ResponseWriter, r *http.Request) {
	uid, err := auth.UserIDFromCtx(r.Context())
	if err != nil {
		writeErr(w, http.StatusUnauthorized, "unauthorized")
		return
	}
	if r.ContentLength > MaxBundleSize {
		writeErr(w, http.StatusRequestEntityTooLarge, "bundle too large")
		return
	}
	if err := r.ParseMultipartForm(MaxBundleSize); err != nil {
		writeErr(w, http.StatusBadRequest, "ожидается multipart/form-data с полем file")
		return
	}
	file, header, err := r.FormFile("file")
	if err != nil {
		writeErr(w, http.StatusBadRequest, "поле file отсутствует")
		return
	}
	defer file.Close()

	bundle, err := ParseBundle(file, header.Size)
	if err != nil {
		h.bundleError(w, err)
		return
	}
	res, err := h.svc.Import(r.Context(), uid, bundle)
	if err != nil {
		h.bundleError(w, err)
		return
	}
	h.logger.Info("project imported",
		"user", uid, "project", res.Project.ID, "events", res.Events, "assets", res.Assets)
	writeJSON(w, http.StatusCreated, map[string]any{
		"project": res.Project,
		"events":  res.Events,
		"assets":  res.Assets,
		"state":   res.HasState,
	})
}

// bundleError переводит ошибки разбора/импорта в понятные статусы и тексты.
func (h *Handler) bundleError(w http.ResponseWriter, err error) {
	switch {
	case errors.Is(err, ErrAlreadyImported):
		writeErr(w, http.StatusConflict,
			"этот архив уже импортирован в эту базу: удалите ранее импортированный проект или загрузите архив на другом стенде")
	case errors.Is(err, ErrTooLarge):
		writeErr(w, http.StatusRequestEntityTooLarge, err.Error())
	case errors.Is(err, ErrUnsupportedFormat), errors.Is(err, ErrBadBundle):
		writeErr(w, http.StatusBadRequest, err.Error())
	default:
		h.logger.Error("import", "err", err)
		writeErr(w, http.StatusInternalServerError, "import failed")
	}
}

func writeJSON(w http.ResponseWriter, status int, body any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(body)
}

func writeErr(w http.ResponseWriter, status int, msg string) {
	writeJSON(w, status, map[string]string{"error": msg})
}
