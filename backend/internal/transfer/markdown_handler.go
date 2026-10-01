package transfer

// markdown_handler.go — HTTP-обвязка выгрузки Markdown и импорта папки с md.
//
// Контракт (docs/import-export.md, п. 1–2):
//
//	GET  /api/projects/{id}/export.md            → story.md (text/markdown)
//	GET  /api/projects/{id}/export.md?assets=1   → zip (story.md, story/, assets/, манифест)
//	POST /api/projects/import/markdown/preview   → разобранное дерево, без записи
//	POST /api/projects/import/markdown           → новый проект
//	POST /api/projects/{id}/import/markdown      → кусок в существующий проект
//	                                               (parent_id / after_id / before_id
//	                                               задают место)
//
// Тело выгрузки собирается в память целиком: имя файла зависит от заголовка
// проекта, а после WriteHeader заголовки уже не поменять — иначе обрыв посреди
// выгрузки отдал бы пользователю битый файл с кодом 200. Так же устроен и архив
// переноса (см. Handler.Export).

import (
	"bytes"
	"errors"
	"fmt"
	"io"
	"mime"
	"mime/multipart"
	"net/http"
	"net/url"
	"strconv"
	"strings"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"

	"github.com/skyfraze/backend/internal/assets"
	"github.com/skyfraze/backend/internal/auth"
)

// Имена полей multipart-запроса импорта: `files` — файлы папки (повторяющееся
// поле), `archive` — zip, `title` — необязательное название нового проекта.
//
// Имя файла читается из СЫРОГО заголовка части (partFileName), а не из
// FileHeader.Filename: и Go, и multipart.Part.FileName() прогоняют имя через
// filepath.Base, и для `Глава 01/01-Пролог.md` вернули бы `01-Пролог.md` —
// вместе с каталогом потерялся бы уровень вложенности.
const (
	importFieldFiles   = "files"
	importFieldArchive = "archive"
	importFieldTitle   = "title"
	// Место вставки для импорта в существующий проект: под какое событие положить
	// кусок (`parent_id`), после какого встать (`after_id`) и перед каким
	// (`before_id`). Пустые значения — верхний уровень и конец списка.
	importFieldParent = "parent_id"
	importFieldAfter  = "after_id"
	importFieldBefore = "before_id"
)

// ExportMarkdown — GET /api/projects/{id}/export.md[?assets=1].
func (h *Handler) ExportMarkdown(w http.ResponseWriter, r *http.Request) {
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

	assets := r.URL.Query().Get("assets")
	withAssets := assets == "1" || strings.EqualFold(assets, "true")

	var buf bytes.Buffer
	var info *MarkdownInfo
	if withAssets {
		info, err = h.svc.ExportMarkdownZip(r.Context(), uid, pid, &buf)
	} else {
		info, err = h.svc.ExportMarkdown(r.Context(), uid, pid, &buf)
	}
	if err != nil {
		switch {
		case errors.Is(err, ErrForbidden):
			writeErr(w, http.StatusForbidden, "forbidden")
		case errors.Is(err, ErrNotFound):
			writeErr(w, http.StatusNotFound, "not found")
		default:
			h.logger.Error("export markdown", "err", err, "project", pid)
			writeErr(w, http.StatusInternalServerError, "export failed")
		}
		return
	}

	if withAssets {
		w.Header().Set("Content-Type", "application/zip")
	} else {
		w.Header().Set("Content-Type", "text/markdown; charset=utf-8")
	}
	w.Header().Set("Content-Disposition", "attachment; filename=\""+info.Filename+"\"")
	w.Header().Set("Content-Length", strconv.Itoa(buf.Len()))
	w.Header().Set("X-Skyfraze-Export-Events", strconv.Itoa(info.Events))
	w.Header().Set("X-Skyfraze-Export-Assets", strconv.Itoa(info.Assets))
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write(buf.Bytes())
}

// MarkdownPreview — POST /api/projects/import/markdown/preview: разбирает набор
// файлов и отдаёт дерево с предупреждениями, не создавая проект.
func (h *Handler) MarkdownPreview(w http.ResponseWriter, r *http.Request) {
	if _, err := auth.UserIDFromCtx(r.Context()); err != nil {
		writeErr(w, http.StatusUnauthorized, "unauthorized")
		return
	}
	parsed, err := parseMarkdownRequest(r)
	if err != nil {
		h.markdownError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, parsed.Preview())
}

// MarkdownImport — POST /api/projects/import/markdown: создаёт НОВЫЙ проект
// владельца по разобранной папке. Фатальная ошибка разбора означает 400 и проект
// не создаётся вообще.
func (h *Handler) MarkdownImport(w http.ResponseWriter, r *http.Request) {
	uid, err := auth.UserIDFromCtx(r.Context())
	if err != nil {
		writeErr(w, http.StatusUnauthorized, "unauthorized")
		return
	}
	parsed, err := parseMarkdownRequest(r)
	if err != nil {
		h.markdownError(w, err)
		return
	}
	p, err := h.svc.ImportMarkdown(r.Context(), uid, parsed, r.FormValue(importFieldTitle))
	if err != nil {
		h.markdownError(w, err)
		return
	}
	h.logger.Info("project imported from markdown",
		"user", uid, "project", p.ID, "events", len(parsed.Events),
		"files", parsed.Stats.Files, "warnings", len(parsed.Warnings))
	writeJSON(w, http.StatusCreated, importResponse{
		ProjectID: p.ID,
		Events:    len(parsed.Events),
		Warnings:  nonNil(parsed.Warnings),
	})
}

// MarkdownImportInto — POST /api/projects/{id}/import/markdown: вставляет
// разобранный кусок в СУЩЕСТВУЮЩИЙ проект.
//
// Место задаётся полями формы: `parent_id` (под какое событие), `after_id` (после
// какого) и `before_id` (перед каким). Все необязательны: без них кусок встаёт в
// конец верхнего уровня. «Перед» и «после» одновременно — противоречие: позиция
// была бы неоднозначной, поэтому это 400, а не молчаливый выбор одного из двух.
// Пишем в CRDT-документ проекта (живой комнаты, если она есть), а таблицу событий
// перестраиваем из него — иначе вставленное увидели бы только читатели базы, а
// редакторы нет.
func (h *Handler) MarkdownImportInto(w http.ResponseWriter, r *http.Request) {
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
	parsed, err := parseMarkdownRequest(r)
	if err != nil {
		h.markdownError(w, err)
		return
	}
	parentID, err := optionalUUID(r.FormValue(importFieldParent))
	if err != nil {
		writeErr(w, http.StatusBadRequest, "invalid "+importFieldParent)
		return
	}
	afterID, err := optionalUUID(r.FormValue(importFieldAfter))
	if err != nil {
		writeErr(w, http.StatusBadRequest, "invalid "+importFieldAfter)
		return
	}
	beforeID, err := optionalUUID(r.FormValue(importFieldBefore))
	if err != nil {
		writeErr(w, http.StatusBadRequest, "invalid "+importFieldBefore)
		return
	}
	if afterID != nil && beforeID != nil {
		writeErr(w, http.StatusBadRequest,
			importFieldAfter+" и "+importFieldBefore+" вместе не задают одного места")
		return
	}

	place := InsertPlace{ParentID: parentID, AfterID: afterID, BeforeID: beforeID}
	result, err := h.svc.ImportMarkdownInto(r.Context(), uid, pid, parsed, place)
	if err != nil {
		h.markdownError(w, err)
		return
	}
	h.logger.Info("markdown inserted into project",
		"user", uid, "project", pid, "events", result.Events, "parent", parentID, "after", afterID,
		"before", beforeID, "warning", result.Warning, "warnings", len(parsed.Warnings))
	// Предупреждение серверной стороны (снапшот или проекция не записались) идёт
	// рядом с замечаниями разбора: вставка сделана, и повторять её нельзя — но
	// человек должен знать, что серверная копия отстала.
	warnings := parsed.Warnings
	if result.Warning != "" {
		warnings = append(append([]string{}, warnings...), result.Warning)
	}
	writeJSON(w, http.StatusCreated, importResponse{
		ProjectID: pid,
		Events:    result.Events,
		Warnings:  nonNil(warnings),
	})
}

// optionalUUID читает необязательный идентификатор из формы.
func optionalUUID(raw string) (*uuid.UUID, error) {
	value := strings.TrimSpace(raw)
	if value == "" {
		return nil, nil
	}
	id, err := uuid.Parse(value)
	if err != nil {
		return nil, err
	}
	return &id, nil
}

// parseMarkdownRequest разбирает multipart импорта: либо один zip в поле
// `archive` (можно и в `files`), либо набор файлов в поле `files` (файлы из любых
// других полей тоже принимаем: отказать пользователю из-за имени поля хуже, чем
// принять папку, названную иначе).
func parseMarkdownRequest(r *http.Request) (*ParsedMarkdown, error) {
	if r.ContentLength > markdownMaxTotal {
		return nil, fmt.Errorf("%w: запрос больше %d МБ", ErrMarkdownTooLarge, markdownMaxTotal>>20)
	}
	// maxMemory — сколько держим в памяти; крупные части net/http сам выгружает
	// во временные файлы и удаляет их после обработки запроса.
	if err := r.ParseMultipartForm(32 << 20); err != nil {
		return nil, fmt.Errorf("%w: ожидается multipart/form-data с полем %s или %s",
			ErrMarkdownEmpty, importFieldFiles, importFieldArchive)
	}

	archive := onlyFile(r, importFieldArchive)
	if archive == nil {
		// Zip могли прислать и в общем поле файлов — распознаём по имени/типу.
		if files := r.MultipartForm.File[importFieldFiles]; len(files) == 1 && isZipHeader(files[0]) {
			archive = files[0]
		}
	}
	if archive != nil {
		f, err := archive.Open()
		if err != nil {
			return nil, fmt.Errorf("%w: %v", ErrMarkdownBadZip, err)
		}
		defer f.Close()
		return ParseMarkdownZip(f, archive.Size)
	}

	var files []*multipart.FileHeader
	for field, list := range r.MultipartForm.File {
		if field == importFieldArchive {
			continue
		}
		files = append(files, list...)
	}
	if len(files) == 0 {
		return nil, fmt.Errorf("%w: не получено ни файлов (%s), ни архива (%s)",
			ErrMarkdownEmpty, importFieldFiles, importFieldArchive)
	}
	if len(files) > markdownMaxFiles {
		return nil, fmt.Errorf("%w: больше %d файлов", ErrMarkdownTooLarge, markdownMaxFiles)
	}

	paths := make([]string, 0, len(files))
	readers := make([]io.Reader, 0, len(files))
	for _, fh := range files {
		path, err := partFileName(fh)
		if err != nil {
			return nil, err
		}
		f, err := fh.Open()
		if err != nil {
			return nil, fmt.Errorf("%w: файл %s не открылся: %v", ErrMarkdownUnsafePath, path, err)
		}
		// Части живут до конца запроса: net/http закрывает и удаляет их сам,
		// поэтому здесь достаточно отпустить дескрипторы после разбора.
		defer f.Close()
		paths = append(paths, path)
		readers = append(readers, f)
	}
	return ParseMarkdownReaders(paths, readers)
}

// onlyFile возвращает единственный файл поля; при нескольких файлах поле `archive`
// означает, что клиент прислал что-то не то — это ошибка, а не повод выбрать
// первый архив наугад.
func onlyFile(r *http.Request, field string) *multipart.FileHeader {
	list := r.MultipartForm.File[field]
	if len(list) != 1 {
		return nil
	}
	return list[0]
}

// isZipHeader распознаёт zip по имени или типу части: расширению верим только
// настолько, чтобы отличить архив от md-файла (содержимое всё равно проверяет
// zip.NewReader).
func isZipHeader(fh *multipart.FileHeader) bool {
	if strings.HasSuffix(strings.ToLower(fh.Filename), ".zip") {
		return true
	}
	return fh.Header.Get("Content-Type") == "application/zip"
}

// partFileName достаёт относительный путь файла из сырого заголовка части.
//
// Именно здесь сохраняется вложенность: `Глава 01/01-Пролог.md` приходит в
// параметре filename заголовка Content-Disposition, а FileHeader.Filename ту же
// строку уже обрезал бы до базового имени.
func partFileName(fh *multipart.FileHeader) (string, error) {
	if raw := fh.Header.Get("Content-Disposition"); raw != "" {
		if _, params, err := mime.ParseMediaType(raw); err == nil {
			if name := params["filename"]; name != "" {
				return name, nil
			}
			// RFC 5987: filename*=UTF-8''%D0%93… — браузеры так почти не делают,
			// но формат это допускает.
			if name := decodeExtValue(params["filename*"]); name != "" {
				return name, nil
			}
		}
	}
	// Заголовок не разобрался — остаётся базовое имя: принять файл без каталога
	// лучше, чем отказать во всём наборе.
	if fh.Filename == "" {
		return "", fmt.Errorf("%w: у части нет имени файла", ErrMarkdownUnsafePath)
	}
	return fh.Filename, nil
}

// decodeExtValue разбирает значение вида UTF-8”%D0%93… в строку.
func decodeExtValue(v string) string {
	if v == "" {
		return ""
	}
	if i := strings.Index(v, "''"); i >= 0 {
		v = v[i+2:]
	}
	out, err := url.PathUnescape(v)
	if err != nil {
		return ""
	}
	return out
}

// markdownError переводит ошибки разбора в понятные статусы и тексты: сообщение
// показывается пользователю, поэтому оно должно объяснять причину.
func (h *Handler) markdownError(w http.ResponseWriter, err error) {
	switch {
	case errors.Is(err, ErrForbidden):
		// Импорт «в место» — это правка чужого проекта: читателю и постороннему
		// отказываем так же, как отказывает выгрузка (403, без подсказок о том,
		// существует проект или нет).
		writeErr(w, http.StatusForbidden, "forbidden")
	case errors.Is(err, ErrNotFound):
		writeErr(w, http.StatusNotFound, "not found")
	case errors.Is(err, ErrMarkdownTooDeep):
		// Отказ до записи: место не тронуто, кусок можно вставить в другое место.
		writeErr(w, http.StatusBadRequest, err.Error())
	case errors.Is(err, ErrMarkdownBusy):
		// Документ комнаты ещё грузится. Просим повторить и говорим, когда:
		// повтор безопасен, потому что ничего не изменилось.
		w.Header().Set("Retry-After", "1")
		writeErr(w, http.StatusServiceUnavailable, err.Error())
	case errors.Is(err, ErrMarkdownTooLarge):
		writeErr(w, http.StatusRequestEntityTooLarge, err.Error())
	case assets.QuotaExceeded(err):
		// Квота проекта: отказ приходит из общей записи файлов, но объяснение
		// адресовано человеку, который переносит папку, поэтому добавляем, что
		// именно случилось с проектом (в новый проект он не создан вовсе).
		writeErr(w, http.StatusRequestEntityTooLarge, err.Error())
	case errors.Is(err, assets.ErrHEICUndecodable):
		// В папке лежит HEIC, а сервер его не разобрал: это ошибка набора, а не
		// сервера — говорим об этом текстом, а не «import failed».
		writeErr(w, http.StatusBadRequest, err.Error()+": сохраните картинку как JPEG и повторите импорт")
	case errors.Is(err, ErrMarkdownEmpty),
		errors.Is(err, ErrMarkdownBadZip),
		errors.Is(err, ErrMarkdownUnsafePath):
		writeErr(w, http.StatusBadRequest, err.Error())
	default:
		h.logger.Error("import markdown", "err", err)
		writeErr(w, http.StatusInternalServerError, "import failed")
	}
}
