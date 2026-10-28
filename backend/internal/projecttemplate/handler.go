package projecttemplate

// handler.go — ручки шаблона проекта (0.85.0).
//
// Пути (внутри /api/projects/{id}):
//
//	GET  /template — шаблон проекта файлом JSON (editor+: это настройки, а не содержимое)
//	POST /template — применить шаблон (только владелец), в ответе отчёт
//
// Тот же JSON отдаётся в архиве проекта файлом template.json — так «начни новый проект по
// образцу старого» делается из уже существующего экспорта, без отдельной сущности.

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
)

// Handler — ручки шаблона.
type Handler struct {
	svc    *Service
	logger *slog.Logger
}

func NewHandler(svc *Service, logger *slog.Logger) *Handler {
	return &Handler{svc: svc, logger: logger}
}

// Mount вешает ручки на под-роутер проекта.
func (h *Handler) Mount(r chi.Router) {
	r.Get("/template", h.Get)
	r.Post("/template", h.Apply)
}

// createFromInput — тело POST /api/projects/from-template.
type createFromInput struct {
	Title       string    `json:"title"`
	Description string    `json:"description"`
	Template    *Template `json:"template"`
}

// CreateFrom — POST /api/projects/from-template: новый проект «по образцу».
//
// Путь статический и лежит рядом с /api/projects/import: chi выбирает статический сегмент раньше
// параметрического, поэтому регистрировать его нужно до Mount (см. cmd/server/main.go).
func (h *Handler) CreateFrom(w http.ResponseWriter, r *http.Request) {
	userID, err := auth.UserIDFromCtx(r.Context())
	if err != nil {
		writeErr(w, http.StatusUnauthorized, "unauthorized")
		return
	}
	var body createFromInput
	if err := json.NewDecoder(io.LimitReader(r.Body, 8<<20)).Decode(&body); err != nil {
		writeErr(w, http.StatusBadRequest, "шаблон не разобран: "+err.Error())
		return
	}
	if body.Template == nil {
		writeErr(w, http.StatusBadRequest, "нужен шаблон: template")
		return
	}
	project, report, err := h.svc.CreateFrom(r.Context(), userID, body.Title, body.Description, body.Template)
	if err != nil {
		h.fail(w, err, "project from template")
		return
	}
	h.logger.Info("project created from template",
		"project", project.ID, "user", userID, "changed", report.Changed)
	writeJSON(w, http.StatusCreated, map[string]any{"project": project, "report": report})
}

// Get — GET /template[?cards=0]: шаблон проекта.
//
// `cards=0` — без карточек: архив переносит их своим путём, и дублировать их в template.json
// значило бы импортировать дважды.
func (h *Handler) Get(w http.ResponseWriter, r *http.Request) {
	userID, projectID, ok := h.target(w, r)
	if !ok {
		return
	}
	withCards := true
	if raw := r.URL.Query().Get("cards"); raw != "" {
		if parsed, err := strconv.ParseBool(raw); err == nil {
			withCards = parsed
		}
	}
	template, err := h.svc.Export(r.Context(), userID, projectID, withCards)
	if err != nil {
		h.fail(w, err, "template export")
		return
	}
	// Заголовок скачивания: тот же путь открывается и как файл, и как JSON для интерфейса —
	// браузеру имя нужно, а fetch его игнорирует.
	w.Header().Set("Content-Disposition", `attachment; filename="template.json"`)
	writeJSON(w, http.StatusOK, template)
}

// Apply — POST /template: применить шаблон (слияние без удаления). Владелец.
func (h *Handler) Apply(w http.ResponseWriter, r *http.Request) {
	userID, projectID, ok := h.target(w, r)
	if !ok {
		return
	}
	// Потолок тела: шаблон — это настройки и карточки, а не текст проекта. Мегабайт с запасом.
	const maxBody = 8 << 20
	var template Template
	// Лишние поля не отвергаем: шаблон версионирован, и «новое поле от новой сборки» должно
	// читаться старой, а не падать с 400 (та же логика, что у архива).
	decoder := json.NewDecoder(io.LimitReader(r.Body, maxBody))
	if err := decoder.Decode(&template); err != nil {
		writeErr(w, http.StatusBadRequest, "шаблон не разобран: "+err.Error())
		return
	}
	report, err := h.svc.Apply(r.Context(), userID, projectID, &template)
	if err != nil {
		h.fail(w, err, "template apply")
		return
	}
	h.logger.Info("project template applied",
		"project", projectID, "user", userID, "changed", report.Changed)
	writeJSON(w, http.StatusOK, map[string]any{"report": report})
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

// fail переводит ошибки сервиса в коды ответа. Чужая ошибка — 500 и в лог.
func (h *Handler) fail(w http.ResponseWriter, err error, where string) {
	switch {
	case errors.Is(err, ErrForbidden):
		writeErr(w, http.StatusForbidden, "шаблон меняет только владелец проекта")
	case errors.Is(err, ErrNotFound):
		writeErr(w, http.StatusNotFound, "проект не найден")
	case errors.Is(err, ErrBadTemplate):
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
	writeJSON(w, status, map[string]string{"error": message})
}
