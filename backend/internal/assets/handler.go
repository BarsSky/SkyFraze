package assets

import (
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"net/http"
	"strconv"

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

// Upload — multipart formdata, field "file".
func (h *Handler) Upload(_ *auth.Service) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
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
		if r.ContentLength > maxAssetSize+1024 {
			writeErr(w, http.StatusRequestEntityTooLarge, "file too large")
			return
		}
		if err := r.ParseMultipartForm(maxAssetSize); err != nil {
			writeErr(w, http.StatusBadRequest, "parse multipart failed")
			return
		}
		file, header, err := r.FormFile("file")
		if err != nil {
			writeErr(w, http.StatusBadRequest, "file field missing")
			return
		}
		defer file.Close()

		a, err := h.svc.Upload(r.Context(), uid, pid, UploadOpts{
			Filename:    header.Filename,
			ContentType: header.Header.Get("Content-Type"),
			Size:        header.Size,
			Reader:      file,
		})
		if err != nil {
			switch {
			case errors.Is(err, ErrTooLarge):
				writeErr(w, http.StatusRequestEntityTooLarge, "file too large")
			case errors.Is(err, ErrBadMime):
				writeErr(w, http.StatusUnsupportedMediaType, "unsupported mime")
			case QuotaExceeded(err):
				// Текст ошибки показывают человеку в панели редактора: в нём
				// занятое место, предел и вес файла.
				writeErr(w, http.StatusRequestEntityTooLarge, err.Error())
			default:
				h.logger.Error("upload", "err", err)
				writeErr(w, http.StatusInternalServerError, "upload failed")
			}
			return
		}
		writeJSON(w, http.StatusCreated, a)
	}
}

// Usage — GET /api/projects/{id}/assets/usage: занятое место и предел квоты.
//
// Отдельная ручка, а не поле в списке файлов: список — массив, и добавлять в него
// служебный объект значило бы ломать всех, кто его читает. Интерфейс показывает
// «занято 8.4 МБ из 10 МБ», чтобы отказ по квоте не был неожиданностью.
func (h *Handler) Usage(_ *auth.Service) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
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
		used, limit, err := h.svc.Usage(r.Context(), uid, pid)
		if err != nil {
			writeErr(w, http.StatusForbidden, "forbidden")
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{
			"used": used, "limit": limit, "used_text": HumanBytes(used), "limit_text": HumanBytes(limit),
		})
	}
}

// Delete — убирает вложение проекта: строку и (если ссылок не осталось) файл.
//
// Отдельная ручка появилась вместе с квотой: без неё проект, упёршийся в предел,
// не мог бы освободить место — открепить файл в редакторе можно, а удалить было
// нечем.
func (h *Handler) Delete(_ *auth.Service) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		uid, err := auth.UserIDFromCtx(r.Context())
		if err != nil {
			writeErr(w, http.StatusUnauthorized, "unauthorized")
			return
		}
		aid, err := uuid.Parse(chi.URLParam(r, "assetID"))
		if err != nil {
			writeErr(w, http.StatusBadRequest, "invalid asset id")
			return
		}
		err = h.svc.Delete(r.Context(), uid, aid)
		var inUse *InUseError
		switch {
		case err == nil:
			w.WriteHeader(http.StatusNoContent)
		case errors.As(err, &inUse):
			// 409, а не 403: права есть, мешает ссылка из документа.
			writeErr(w, http.StatusConflict, inUse.Error())
		case errors.Is(err, store.ErrNotFound):
			writeErr(w, http.StatusNotFound, "not found")
		default:
			writeErr(w, http.StatusForbidden, "forbidden")
		}
	}
}

func (h *Handler) List(_ *auth.Service) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
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
		as, err := h.svc.List(r.Context(), uid, pid)
		if err != nil {
			writeErr(w, http.StatusForbidden, "forbidden")
			return
		}
		writeJSON(w, http.StatusOK, as)
	}
}

// Download — стримит контент ассета.
func (h *Handler) Download(_ *auth.Service) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		uid, err := auth.UserIDFromCtx(r.Context())
		if err != nil {
			writeErr(w, http.StatusUnauthorized, "unauthorized")
			return
		}
		aid, err := uuid.Parse(chi.URLParam(r, "id"))
		if err != nil {
			writeErr(w, http.StatusBadRequest, "invalid id")
			return
		}
		rc, a, err := h.svc.Open(r.Context(), uid, aid)
		if err != nil {
			writeErr(w, http.StatusNotFound, "not found")
			return
		}
		defer rc.Close()
		w.Header().Set("Content-Type", a.Mime)
		w.Header().Set("Content-Length", strconv.FormatInt(a.Size, 10))
		w.Header().Set("Content-Disposition", `inline; filename="`+a.Filename+`"`)
		_, _ = io.Copy(w, rc)
	}
}

// DownloadPublic — публичная отдача файла (без авторизации).
//
// Нужна публичной ленте: анонимный посетитель не может тянуть /api/assets/{id}
// (там нужен Bearer + членство), поэтому обложки и картинки истории отдаются
// здесь — но только для опубликованных проектов (проверка внутри OpenPublic).
func (h *Handler) DownloadPublic(_ *auth.Service) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		aid, err := uuid.Parse(chi.URLParam(r, "id"))
		if err != nil {
			writeErr(w, http.StatusBadRequest, "invalid id")
			return
		}
		rc, a, err := h.svc.OpenPublic(r.Context(), aid)
		if err != nil {
			// Неопубликованный проект и несуществующий файл неразличимы: 404.
			writeErr(w, http.StatusNotFound, "not found")
			return
		}
		defer rc.Close()
		w.Header().Set("Content-Type", a.Mime)
		w.Header().Set("Content-Length", strconv.FormatInt(a.Size, 10))
		w.Header().Set("Content-Disposition", `inline; filename="`+a.Filename+`"`)
		// Публичные картинки можно кэшировать: контент адресуется неизменяемым id.
		w.Header().Set("Cache-Control", "public, max-age=3600")
		_, _ = io.Copy(w, rc)
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
