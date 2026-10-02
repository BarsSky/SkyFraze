package assistant

// handler.go — HTTP-слой помощника: беседы проекта и отправка сообщений.
//
// Ручки живут под `/api/projects/{id}/ai/...`, потому что разговор всегда идёт о
// конкретном проекте: и контекст, и изменения привязаны к нему. Права проверяет
// сервис (editor+ — помощник меняет проект), а обработчик только переводит ошибки
// в коды ответа, по которым интерфейс понимает, что показать: «нужен ключ», «нужно
// согласие», «нет прав».
//
// Формат ответа на сообщение устроен так, чтобы интерфейсу НЕ приходилось разбирать
// текст модели: `answer` — что сказать, `changes` — что изменилось (с идентификаторами
// для перехода к кадру), `calls` — что делал помощник. Модель может написать что угодно,
// но список изменений приходит от сервера, а не из её слов.

import (
	"encoding/json"
	"errors"
	"log/slog"
	"net/http"
	"strings"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"

	"github.com/skyfraze/backend/internal/ai"
	"github.com/skyfraze/backend/internal/auth"
	"github.com/skyfraze/backend/internal/store"
)

// Handler — HTTP-слой помощника.
type Handler struct {
	svc    *Service
	logger *slog.Logger
}

func NewHandler(svc *Service, logger *slog.Logger) *Handler {
	return &Handler{svc: svc, logger: logger}
}

// Routes монтирует под-ресурсы помощника внутри проекта.
func (h *Handler) Routes(r chi.Router) {
	r.Get("/ai/conversations", h.ListConversations)
	r.Post("/ai/conversations", h.CreateConversation)
	r.Get("/ai/conversations/{cid}", h.GetConversation)
	r.Post("/ai/conversations/{cid}/messages", h.SendMessage)
	// Тот же вопрос, но ответ приходит потоком: текст по кускам и события по ходу дела.
	r.Post("/ai/conversations/{cid}/stream", h.StreamMessage)
	// Роль и поведение агента: читает участник проекта, меняет только владелец.
	r.Get("/ai/settings", h.GetSettings)
	r.Put("/ai/settings", h.SaveSettings)
}

// GetSettings — GET .../ai/settings: имя агента, роль, указания и права спрашивающего.
func (h *Handler) GetSettings(w http.ResponseWriter, r *http.Request) {
	uid, pid, ok := h.scope(w, r)
	if !ok {
		return
	}
	settings, err := h.svc.ProjectSettings(r.Context(), uid, pid)
	if err != nil {
		h.fail(w, "get settings", err)
		return
	}
	writeJSON(w, http.StatusOK, settings)
}

// SaveSettings — PUT .../ai/settings: владелец задаёт роль и поведение агента.
func (h *Handler) SaveSettings(w http.ResponseWriter, r *http.Request) {
	uid, pid, ok := h.scope(w, r)
	if !ok {
		return
	}
	var body struct {
		Role         string `json:"role"`
		Instructions string `json:"instructions"`
		Enabled      *bool  `json:"enabled"`
	}
	if err := decodeJSON(w, r, &body); err != nil {
		return
	}
	// `enabled` необязателен: интерфейс сохраняет роль и указания, не трогая
	// выключатель, — иначе сохранение формы молча включало бы выключенного агента.
	enabled := true
	if body.Enabled != nil {
		enabled = *body.Enabled
	} else {
		current, err := h.svc.ProjectSettings(r.Context(), uid, pid)
		if err != nil {
			h.fail(w, "save settings", err)
			return
		}
		enabled = current.Enabled
	}
	settings, err := h.svc.SaveProjectSettings(r.Context(), uid, pid, body.Role, body.Instructions, enabled)
	if err != nil {
		h.fail(w, "save settings", err)
		return
	}
	writeJSON(w, http.StatusOK, settings)
}

// ListConversations — GET .../ai/conversations: беседы этого человека в проекте.
//
// Проект проверяем явно: без этого ручка отвечала 200 на чужой проект (беседы-то
// свои, но 200 на чужом проекте — это уже утечка факта «ручка работает везде» и
// приглашение перебирать идентификаторы).
func (h *Handler) ListConversations(w http.ResponseWriter, r *http.Request) {
	uid, pid, ok := h.scope(w, r)
	if !ok {
		return
	}
	if err := h.svc.RequireProject(r.Context(), uid, pid, false); err != nil {
		h.fail(w, "list conversations access", err)
		return
	}
	list, err := h.svc.store.ListAIConversations(r.Context(), pid, uid)
	if err != nil {
		h.fail(w, "list conversations", err)
		return
	}
	if list == nil {
		list = []store.AIConversation{}
	}
	writeJSON(w, http.StatusOK, map[string]any{"conversations": list})
}

// CreateConversation — POST .../ai/conversations: завести пустую беседу.
//
// Нужна не всегда: отправка сообщения сама создаёт беседу. Но интерфейсу удобнее
// показать список и «Новый разговор» сразу, не дожидаясь первого вопроса. Права —
// как у правки проекта: беседа привязана к проекту, и заводить её в чужом нельзя.
func (h *Handler) CreateConversation(w http.ResponseWriter, r *http.Request) {
	uid, pid, ok := h.scope(w, r)
	if !ok {
		return
	}
	if err := h.svc.RequireProject(r.Context(), uid, pid, true); err != nil {
		h.fail(w, "create conversation access", err)
		return
	}
	var body struct {
		Title string `json:"title"`
		Model string `json:"model"`
	}
	if err := decodeJSON(w, r, &body); err != nil {
		return
	}
	conversation, err := h.svc.store.CreateAIConversation(r.Context(), pid, uid, body.Title, body.Model)
	if err != nil {
		h.fail(w, "create conversation", err)
		return
	}
	writeJSON(w, http.StatusCreated, conversation)
}

// GetConversation — GET .../ai/conversations/{cid}: история беседы.
func (h *Handler) GetConversation(w http.ResponseWriter, r *http.Request) {
	uid, pid, ok := h.scope(w, r)
	if !ok {
		return
	}
	cid, ok := h.conversationID(w, r)
	if !ok {
		return
	}
	// GET не должен ничего создавать: «новая беседа» — это состояние интерфейса, а не
	// беседа на сервере (иначе каждый открытый разговор оставлял бы пустую запись).
	if cid == uuid.Nil {
		writeErr(w, http.StatusBadRequest, "не указана беседа")
		return
	}
	if err := h.svc.RequireProject(r.Context(), uid, pid, false); err != nil {
		h.fail(w, "get conversation access", err)
		return
	}
	conversation, err := h.svc.conversation(r.Context(), uid, pid, cid, "", "")
	if err != nil {
		h.fail(w, "get conversation", err)
		return
	}
	messages, err := h.svc.store.ListAIMessages(r.Context(), cid, h.svc.limits.MaxHistory*5)
	if err != nil {
		h.fail(w, "list messages", err)
		return
	}
	if messages == nil {
		messages = []store.AIMessage{}
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"conversation": conversation,
		"messages":     messages,
		"limits":       h.svc.limits,
	})
}

// SendMessage — POST .../ai/conversations/{cid}/messages: вопрос помощнику.
//
// Самый долгий запрос в приложении: пока модель думает и вызываются инструменты,
// проходит десяток секунд. Таймаут на стороне nginx это выдерживает (600 секунд),
// а интерфейс показывает «думает».
func (h *Handler) SendMessage(w http.ResponseWriter, r *http.Request) {
	uid, pid, ok := h.scope(w, r)
	if !ok {
		return
	}
	cid, ok := h.conversationID(w, r)
	if !ok {
		return
	}
	var body struct {
		Text  string `json:"text"`
		Model string `json:"model"`
	}
	if err := decodeJSON(w, r, &body); err != nil {
		return
	}
	turn, err := h.svc.Send(r.Context(), uid, pid, cid, body.Model, body.Text)
	if err != nil {
		h.fail(w, "send message", err)
		return
	}
	writeJSON(w, http.StatusOK, turn)
}

// StreamMessage — POST .../ai/conversations/{cid}/stream: тот же вопрос, но ответ
// приходит потоком событий (SSE): куски текста, выполненные вызовы, изменения, итог.
//
// Ошибку до первого события отдаём обычным ответом с кодом: интерфейс по коду решает,
// показать ли вопрос о согласии, просьбу добавить ключ или красную плашку. После начала
// потока так уже нельзя — код ответа отправлен, поэтому сбой уходит событием `error`.
func (h *Handler) StreamMessage(w http.ResponseWriter, r *http.Request) {
	uid, pid, ok := h.scope(w, r)
	if !ok {
		return
	}
	cid, ok := h.conversationID(w, r)
	if !ok {
		return
	}
	var body struct {
		Text  string `json:"text"`
		Model string `json:"model"`
	}
	if err := decodeJSON(w, r, &body); err != nil {
		return
	}

	stream := newSSEStream(w)
	defer stream.close()
	go stream.ping(r.Context(), ssePingEvery)

	turn, err := h.svc.SendStream(r.Context(), uid, pid, cid, body.Model, body.Text, stream.send)
	if err != nil {
		if !stream.startedNow() {
			h.fail(w, "stream message", err)
			return
		}
		_ = stream.send(Event{Type: EventError, Error: err.Error()})
		return
	}
	_ = stream.send(Event{Type: EventDone, Turn: turn})
}

// scope достаёт пользователя и проект из запроса.
func (h *Handler) scope(w http.ResponseWriter, r *http.Request) (uuid.UUID, uuid.UUID, bool) {
	uid, err := auth.UserIDFromCtx(r.Context())
	if err != nil {
		writeErr(w, http.StatusUnauthorized, "unauthorized")
		return uuid.Nil, uuid.Nil, false
	}
	pid, err := uuid.Parse(chi.URLParam(r, "id"))
	if err != nil {
		writeErr(w, http.StatusBadRequest, "invalid project id")
		return uuid.Nil, uuid.Nil, false
	}
	return uid, pid, true
}

// conversationID читает {cid}; пустая строка — «новая беседа» (сервер её заведёт).
func (h *Handler) conversationID(w http.ResponseWriter, r *http.Request) (uuid.UUID, bool) {
	raw := strings.TrimSpace(chi.URLParam(r, "cid"))
	if raw == "" || raw == "new" {
		return uuid.Nil, true
	}
	id, err := uuid.Parse(raw)
	if err != nil {
		writeErr(w, http.StatusBadRequest, "invalid conversation id")
		return uuid.Nil, false
	}
	return id, true
}

// fail переводит ошибки сервиса в коды и тексты.
func (h *Handler) fail(w http.ResponseWriter, op string, err error) {
	switch {
	case errors.Is(err, ErrDisabled):
		writeErr(w, http.StatusServiceUnavailable, err.Error())
	case errors.Is(err, ErrConsent):
		// Согласие — не «ошибка»: интерфейс по этому ответу показывает вопрос
		// «текст проекта уйдёт провайдеру модели — продолжить?».
		writeJSON(w, http.StatusConflict, map[string]any{
			"error":            err.Error(),
			"consent_required": true,
		})
	case errors.Is(err, ErrProjectDisabled):
		writeErr(w, http.StatusConflict, err.Error())
	case errors.Is(err, ErrTokenBudget):
		// 429, а не 400: это не ошибка запроса, а исчерпанный предел. Интерфейс по
		// этому коду говорит «завтра снова» и показывает расход.
		writeJSON(w, http.StatusTooManyRequests, map[string]any{
			"error":        err.Error(),
			"token_budget": true,
			"token_limit":  h.svc.models.TokensPerDay(),
		})
	case errors.Is(err, ErrForbidden):
		writeErr(w, http.StatusForbidden, err.Error())
	case errors.Is(err, ErrModelRequired):
		writeErr(w, http.StatusBadRequest, err.Error())
	case errors.Is(err, ai.ErrNoKey):
		writeErr(w, http.StatusPreconditionRequired,
			"для этой модели нужен ключ провайдера — добавьте свой в настройках помощника")
	case errors.Is(err, ai.ErrUnauthorized):
		writeErr(w, http.StatusBadRequest, err.Error())
	case errors.Is(err, ai.ErrUnavailable):
		writeErr(w, http.StatusBadGateway, err.Error())
	case errors.Is(err, store.ErrNotFound):
		writeErr(w, http.StatusNotFound, "беседа не найдена")
	default:
		h.logger.Warn("assistant request failed", "op", op, "err", err)
		writeErr(w, http.StatusBadRequest, err.Error())
	}
}

// decodeJSON читает небольшое тело запроса и отвечает 400 на мусор.
func decodeJSON(w http.ResponseWriter, r *http.Request, out any) error {
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 64<<10)).Decode(out); err != nil {
		writeErr(w, http.StatusBadRequest, "не разобрал запрос")
		return err
	}
	return nil
}

func writeJSON(w http.ResponseWriter, status int, body any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(body)
}

func writeErr(w http.ResponseWriter, status int, msg string) {
	writeJSON(w, status, map[string]string{"error": msg})
}
