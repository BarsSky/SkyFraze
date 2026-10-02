package ai

// handler.go — ручки ИИ-помощника.
//
// Что здесь есть и чего нет. Есть настройка подключения: какие провайдеры доступны,
// какие у них модели и свои ключи. Инструменты (создание глав) и чат работают через
// тот же сервис и появятся следующими фазами — ручки для них добавляются здесь же,
// чтобы весь контур был в одном месте.
//
// Права: ручки требуют входа (ключи и модели — про конкретного человека), а изменение
// проекта доступно editor+ — это проверяет сервис проектов, а не этот обработчик.

import (
	"encoding/json"
	"errors"
	"log/slog"
	"net/http"
	"strings"

	"github.com/go-chi/chi/v5"

	"github.com/skyfraze/backend/internal/auth"
	"github.com/skyfraze/backend/internal/store"
)

// Handler — HTTP-слой ИИ-помощника.
type Handler struct {
	svc    *Service
	logger *slog.Logger
}

func NewHandler(svc *Service, logger *slog.Logger) *Handler {
	return &Handler{svc: svc, logger: logger}
}

// Routes монтирует /api/ai. Права проверяет auth-мидлварь (WithUser) снаружи.
func (h *Handler) Routes(r chi.Router) {
	r.Get("/config", h.Config)
	r.Get("/models", h.Models)
	r.Post("/keys", h.SetKey)
	r.Delete("/keys/{provider}", h.DeleteKey)
	r.Post("/consent", h.SetConsent)
	r.Delete("/consent/{provider}", h.DeleteConsent)
}

type providerDTO struct {
	ProviderInfo
}

// Config — GET /api/ai/config: что включено и какие провайдеры доступны.
//
// Один запрос на страницу: интерфейс решает по нему, показывать ли панель и нужно ли
// просить ключ. Модели здесь не перечисляются — их список запрашивается отдельно,
// когда человек открывает выбор модели (иначе каждое открытие страницы дёргало бы
// пять чужих API).
func (h *Handler) Config(w http.ResponseWriter, r *http.Request) {
	uid, err := auth.UserIDFromCtx(r.Context())
	if err != nil {
		writeErr(w, http.StatusUnauthorized, "unauthorized")
		return
	}
	providers, err := h.svc.Providers(r.Context(), uid)
	if err != nil {
		h.logger.Error("ai providers", "err", err)
		writeErr(w, http.StatusInternalServerError, "не удалось получить провайдеров")
		return
	}
	// Согласия отдаём вместе с провайдерами: интерфейсу нужно и то, и другое сразу —
	// иначе он показал бы «можно спрашивать», не зная, спрашивали ли уже.
	consents, err := h.svc.Consents(r.Context(), uid)
	if err != nil {
		h.logger.Error("ai consents", "err", err)
		writeErr(w, http.StatusInternalServerError, "не удалось получить согласия")
		return
	}
	// Расход за сутки и предел отдаём вместе с настройкой: человек должен видеть,
	// сколько уже израсходовано, ДО того как упрётся в предел. Ошибка счёта не
	// ломает настройку — показываем ноль и работаем дальше.
	spent, err := h.svc.SpentTokens(r.Context(), uid)
	if err != nil {
		h.logger.Warn("ai: не удалось посчитать расход токенов", "err", err)
		spent = 0
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"enabled":        h.svc.Enabled(),
		"keys_ready":     h.svc.KeysReady(),
		"default_model":  h.svc.DefaultModel(),
		"max_tool_calls": h.svc.MaxToolCalls(),
		"tokens_today":   spent,
		"token_limit":    h.svc.TokensPerDay(),
		"providers":      providers,
		"consents":       nonNil(consents),
	})
}

// SetConsent — POST /api/ai/consent {provider}: человек разрешил отправлять текст
// проекта этому провайдеру. Отдельная ручка, а не галочка «при первом сообщении»
// на сервере: согласие должно быть явным действием человека, а не побочным эффектом
// запроса на создание главы.
func (h *Handler) SetConsent(w http.ResponseWriter, r *http.Request) {
	uid, err := auth.UserIDFromCtx(r.Context())
	if err != nil {
		writeErr(w, http.StatusUnauthorized, "unauthorized")
		return
	}
	var body struct {
		Provider string `json:"provider"`
	}
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 4<<10)).Decode(&body); err != nil {
		writeErr(w, http.StatusBadRequest, "не разобрал запрос")
		return
	}
	if err := h.svc.SetConsent(r.Context(), uid, body.Provider); err != nil {
		h.writeAIError(w, "ai set consent", err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"provider": strings.ToLower(strings.TrimSpace(body.Provider)),
		"agreed":   true,
	})
}

// DeleteConsent — DELETE /api/ai/consent/{provider}: согласие отозвано.
func (h *Handler) DeleteConsent(w http.ResponseWriter, r *http.Request) {
	uid, err := auth.UserIDFromCtx(r.Context())
	if err != nil {
		writeErr(w, http.StatusUnauthorized, "unauthorized")
		return
	}
	if err := h.svc.DeleteConsent(r.Context(), uid, chi.URLParam(r, "provider")); err != nil {
		h.writeAIError(w, "ai delete consent", err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// Models — GET /api/ai/models?provider=groq: модели одного провайдера.
func (h *Handler) Models(w http.ResponseWriter, r *http.Request) {
	uid, err := auth.UserIDFromCtx(r.Context())
	if err != nil {
		writeErr(w, http.StatusUnauthorized, "unauthorized")
		return
	}
	provider := strings.TrimSpace(r.URL.Query().Get("provider"))
	if provider == "" {
		writeErr(w, http.StatusBadRequest, "не указан провайдер")
		return
	}
	models, err := h.svc.Models(r.Context(), uid, provider)
	if err != nil {
		h.writeAIError(w, "ai models", err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"models": models})
}

// SetKey — POST /api/ai/keys {provider, key}: сохранить свой ключ.
//
// Ключ проверяется запросом к провайдеру и шифруется; в ответе его нет (только
// «сохранён» и провайдер).
func (h *Handler) SetKey(w http.ResponseWriter, r *http.Request) {
	uid, err := auth.UserIDFromCtx(r.Context())
	if err != nil {
		writeErr(w, http.StatusUnauthorized, "unauthorized")
		return
	}
	var body struct {
		Provider string `json:"provider"`
		Key      string `json:"key"`
	}
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 8<<10)).Decode(&body); err != nil {
		writeErr(w, http.StatusBadRequest, "не разобрал запрос")
		return
	}
	if err := h.svc.SetKey(r.Context(), uid, body.Provider, body.Key); err != nil {
		h.writeAIError(w, "ai set key", err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"provider": strings.ToLower(strings.TrimSpace(body.Provider)), "saved": true})
}

// DeleteKey — DELETE /api/ai/keys/{provider}: убрать свой ключ.
func (h *Handler) DeleteKey(w http.ResponseWriter, r *http.Request) {
	uid, err := auth.UserIDFromCtx(r.Context())
	if err != nil {
		writeErr(w, http.StatusUnauthorized, "unauthorized")
		return
	}
	if err := h.svc.DeleteKey(r.Context(), uid, chi.URLParam(r, "provider")); err != nil {
		h.writeAIError(w, "ai delete key", err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// writeAIError переводит ошибки сервиса в коды: «нет ключа» и «ключ отвергнут» — это
// просьба к человеку, а не сбой сервера.
func (h *Handler) writeAIError(w http.ResponseWriter, op string, err error) {
	switch {
	case errors.Is(err, ErrNoKey):
		writeErr(w, http.StatusPreconditionRequired, "для этого провайдера нужен ключ")
	case errors.Is(err, ErrUnauthorized):
		writeErr(w, http.StatusBadRequest, err.Error())
	case errors.Is(err, ErrUnavailable):
		writeErr(w, http.StatusBadGateway, err.Error())
	case errors.Is(err, ErrNoCipher):
		writeErr(w, http.StatusConflict, "на стенде не настроено хранение ключей (AI_SECRET_KEY)")
	case errors.Is(err, store.ErrNotFound):
		writeErr(w, http.StatusNotFound, "не найдено")
	default:
		// Сообщения «неизвестный провайдер», «пустой ключ», «ИИ выключен» — про
		// запрос, поэтому 400, и текст показываем как есть.
		h.logger.Warn("ai request failed", "op", op, "err", err)
		writeErr(w, http.StatusBadRequest, err.Error())
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

// nonNil — пустой список в JSON должен быть [], а не null: интерфейс перебирает его
// и не должен проверять на null.
func nonNil(list []string) []string {
	if list == nil {
		return []string{}
	}
	return list
}
