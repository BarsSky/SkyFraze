package chat

// handler.go — ручки общего чата проекта (0.95.0).
//
// Пути внутри /api/projects/{id}:
//
//	GET  /chat/messages?after=<id>&limit=<n> — сообщения (viewer+), после — только новые
//	POST /chat/messages                       — написать (viewer+); ask_bot зовёт Нестора
//
// «after» нужно опросу: окно чата спрашивает «что нового после последнего сообщения», а не
// перечитывает историю целиком каждые несколько секунд.

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
	"github.com/skyfraze/backend/internal/projects"
	"github.com/skyfraze/backend/internal/store"
)

// Handler — ручки чата.
type Handler struct {
	svc    *Service
	logger *slog.Logger
}

func NewHandler(svc *Service, logger *slog.Logger) *Handler {
	return &Handler{svc: svc, logger: logger}
}

// Mount вешает ручки на под-роутер проекта.
func (h *Handler) Mount(r chi.Router) {
	r.Get("/chat/messages", h.List)
	r.Post("/chat/messages", h.Post)
}

// List — GET /chat/messages.
func (h *Handler) List(w http.ResponseWriter, r *http.Request) {
	userID, projectID, ok := h.target(w, r)
	if !ok {
		return
	}
	var after *uuid.UUID
	if raw := strings.TrimSpace(r.URL.Query().Get("after")); raw != "" {
		id, err := uuid.Parse(raw)
		if err != nil {
			writeErr(w, http.StatusBadRequest, "invalid after id")
			return
		}
		after = &id
	}
	limit, _ := strconv.Atoi(r.URL.Query().Get("limit"))
	messages, err := h.svc.Messages(r.Context(), userID, projectID, after, limit)
	if err != nil {
		h.fail(w, err, "chat list")
		return
	}
	if messages == nil {
		messages = []Message{}
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"messages": messages,
		"bot": map[string]any{
			"name":      h.svc.BotName(),
			"available": h.svc.BotAvailable(),
		},
	})
}

// postInput — тело сообщения.
type postInput struct {
	Body    string  `json:"body"`
	EventID *string `json:"event_id"`
	Quote   string  `json:"quote"`
	AskBot  bool    `json:"ask_bot"`
}

// Post — POST /chat/messages.
func (h *Handler) Post(w http.ResponseWriter, r *http.Request) {
	userID, projectID, ok := h.target(w, r)
	if !ok {
		return
	}
	var body postInput
	if err := decode(r, &body); err != nil {
		writeErr(w, http.StatusBadRequest, "invalid json")
		return
	}
	in := Input{Body: body.Body, Quote: body.Quote, AskBot: body.AskBot}
	if body.EventID != nil && strings.TrimSpace(*body.EventID) != "" {
		id, err := uuid.Parse(strings.TrimSpace(*body.EventID))
		if err != nil {
			writeErr(w, http.StatusBadRequest, "invalid event id")
			return
		}
		in.EventID = &id
	}
	answer, err := h.svc.Post(r.Context(), userID, projectID, in)
	if err != nil {
		h.fail(w, err, "chat post")
		return
	}
	writeJSON(w, http.StatusCreated, answer)
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

// fail переводит ошибки сервиса в коды и слова.
func (h *Handler) fail(w http.ResponseWriter, err error, where string) {
	switch {
	case errors.Is(err, ErrInvalidMessage):
		writeErr(w, http.StatusBadRequest, err.Error())
	case errors.Is(err, ErrEventNotFound), errors.Is(err, ErrQuoteNotFound):
		writeErr(w, http.StatusBadRequest, err.Error())
	case errors.Is(err, projects.ErrForbidden):
		writeErr(w, http.StatusForbidden, "forbidden")
	case errors.Is(err, store.ErrNotFound), errors.Is(err, projects.ErrNotFound):
		writeErr(w, http.StatusNotFound, "not found")
	default:
		h.logger.Error(where, "err", err)
		writeErr(w, http.StatusInternalServerError, "failed")
	}
}

func decode(r *http.Request, out any) error {
	// 64 КиБ: сообщение чата — текст, а не файл.
	return json.NewDecoder(io.LimitReader(r.Body, 64<<10)).Decode(out)
}

func writeJSON(w http.ResponseWriter, status int, body any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(body)
}

func writeErr(w http.ResponseWriter, status int, message string) {
	writeJSON(w, status, map[string]string{"error": strings.TrimSpace(message)})
}
