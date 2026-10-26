package auth

// webauthn_handler.go — HTTP-ручки ключей доступа (docs/webauthn.md, миграция 0028).
//
// Пути:
//   POST   /api/auth/keys/register/begin      — начать привязку (нужен вход по паролю)
//   POST   /api/auth/keys/register/finish     — закончить привязку
//   GET    /api/auth/keys                     — список ключей
//   DELETE /api/auth/keys/{id}                — удалить ключ
//   POST   /api/auth/login/webauthn/begin     — начать вход ключом (публичная)
//   POST   /api/auth/login/webauthn/finish    — закончить вход ключом (публичная)
//
// Идентификатор церемонии и имя ключа едут в строке запроса (`?challenge=..&name=..`), а тело
// запроса остаётся аутентификатору: и registration, и assertion разбирает сама библиотека из
// тела. Если положить свои поля в то же тело, придётся разбирать и переупаковывать его
// вручную — на ошибке в этом месте подпись проверялась бы над не тем, что пришло.

import (
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"strings"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"

	"github.com/skyfraze/backend/internal/ratelimit"
	"github.com/skyfraze/backend/internal/store"
)

// MountWebAuthnKeys — ручки ключей внутри группы с WithUser (личный профиль).
func (h *Handler) MountWebAuthnKeys(r interface {
	Post(string, http.HandlerFunc)
	Get(string, http.HandlerFunc)
	Delete(string, http.HandlerFunc)
}) {
	r.Get("/keys", h.WebAuthnKeys)
	r.Post("/keys/register/begin", h.WebAuthnRegisterBegin)
	r.Post("/keys/register/finish", h.WebAuthnRegisterFinish)
	r.Delete("/keys/{id}", h.WebAuthnDeleteKey)
}

// WebAuthnKeys — GET /keys: ключи человека.
func (h *Handler) WebAuthnKeys(w http.ResponseWriter, r *http.Request) {
	uid, err := UserIDFromCtx(r.Context())
	if err != nil {
		writeErr(w, http.StatusUnauthorized, "unauthorized")
		return
	}
	keys, err := h.svc.WebAuthnKeys(r.Context(), uid)
	if err != nil {
		if errors.Is(err, ErrWebAuthnDisabled) {
			writeErr(w, http.StatusNotImplemented, "ключи доступа не настроены на этом стенде")
			return
		}
		h.logger.Error("webauthn keys", "err", err)
		writeErr(w, http.StatusInternalServerError, "failed")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"keys": keys})
}

// WebAuthnRegisterBegin — POST /keys/register/begin: параметры привязки.
//
// Возвращаются в формате `PublicKeyCredentialCreationOptions`, который браузерный
// `navigator.credentials.create()` принимает как есть (поле `publicKey`).
func (h *Handler) WebAuthnRegisterBegin(w http.ResponseWriter, r *http.Request) {
	uid, err := UserIDFromCtx(r.Context())
	if err != nil {
		writeErr(w, http.StatusUnauthorized, "unauthorized")
		return
	}
	creation, challengeID, err := h.svc.WebAuthnRegistrationStart(r.Context(), uid)
	if err != nil {
		if errors.Is(err, ErrWebAuthnDisabled) {
			writeErr(w, http.StatusNotImplemented, "ключи доступа не настроены на этом стенде")
			return
		}
		h.logger.Error("webauthn register begin", "err", err)
		writeErr(w, http.StatusInternalServerError, "failed")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"challenge": challengeID,
		"publicKey": creation.Response,
	})
}

// WebAuthnRegisterFinish — POST /keys/register/finish?challenge=<id>&name=<label>.
//
// Тело — ответ `navigator.credentials.create()` (JSON-сериализованный PublicKeyCredential).
func (h *Handler) WebAuthnRegisterFinish(w http.ResponseWriter, r *http.Request) {
	uid, err := UserIDFromCtx(r.Context())
	if err != nil {
		writeErr(w, http.StatusUnauthorized, "unauthorized")
		return
	}
	challengeID, err := parseChallengeParam(w, r)
	if err != nil {
		return
	}
	// Имя ключа приходит уже раскодированным: Values() разбирает percent-кодирование,
	// поэтому «Ключ на телефоне» доедет как есть. Повторно декодировать нельзя — имя с
	// символом «%» превратилось бы в мусор.
	name := strings.TrimSpace(r.URL.Query().Get("name"))
	if !h.allowWebAuthnAttempt(w, r, uid) {
		return
	}
	key, recovery, err := h.svc.WebAuthnRegistrationFinish(r.Context(), uid, challengeID, name, r)
	if err != nil {
		if errors.Is(err, ErrWebAuthnChallenge) {
			writeErr(w, http.StatusBadRequest, "подтверждение истекло — начните заново")
			return
		}
		if errors.Is(err, ErrWebAuthnDisabled) {
			writeErr(w, http.StatusNotImplemented, "ключи доступа не настроены на этом стенде")
			return
		}
		// Ошибки проверки ответа аутентификатора (подпись, origin, rpId) — это отказ, а не
		// поломка сервера: 400 и текст без внутренностей библиотеки.
		h.logger.Warn("webauthn register finish", "err", err)
		writeErr(w, http.StatusBadRequest, "не удалось привязать ключ: браузер прислал неверный ответ")
		return
	}
	out := map[string]any{"key": key}
	if len(recovery) > 0 {
		// Показываются один раз, как и при включении TOTP: в базе только хеши.
		out["recovery_codes"] = recovery
		out["note"] = "сохраните коды: они показываются один раз и заменяют потерянный ключ при входе"
	}
	writeJSON(w, http.StatusCreated, out)
}

// WebAuthnDeleteKey — DELETE /keys/{id}.
func (h *Handler) WebAuthnDeleteKey(w http.ResponseWriter, r *http.Request) {
	uid, err := UserIDFromCtx(r.Context())
	if err != nil {
		writeErr(w, http.StatusUnauthorized, "unauthorized")
		return
	}
	id, err := uuid.Parse(chi.URLParam(r, "id"))
	if err != nil {
		writeErr(w, http.StatusBadRequest, "invalid id")
		return
	}
	if err := h.svc.DeleteWebAuthnKey(r.Context(), uid, id); err != nil {
		switch {
		case errors.Is(err, ErrWebAuthnDisabled):
			writeErr(w, http.StatusNotImplemented, "ключи доступа не настроены на этом стенде")
		case errors.Is(err, store.ErrNotFound):
			writeErr(w, http.StatusNotFound, "ключ не найден")
		default:
			h.logger.Error("webauthn delete key", "err", err)
			writeErr(w, http.StatusInternalServerError, "failed")
		}
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true})
}

// WebAuthnLoginBegin — POST /login/webauthn/begin {"challenge"}: параметры входа ключом.
//
// Публичная ручка: токенов до неё нет, но и знания «кто это» у неё тоже нет — только пропуск,
// выданный после верного пароля (см. WebAuthnLoginStart).
func (h *Handler) WebAuthnLoginBegin(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Challenge string `json:"challenge"`
	}
	if err := json.NewDecoder(io.LimitReader(r.Body, 8<<10)).Decode(&req); err != nil && err != io.EOF {
		writeErr(w, http.StatusBadRequest, "invalid json")
		return
	}
	if strings.TrimSpace(req.Challenge) == "" {
		writeErr(w, http.StatusBadRequest, "нужен пропуск второго шага (challenge)")
		return
	}
	if h.limiter != nil {
		// Ключ ограничения — пропуск: он живёт 5 минут и относится к одному человеку, а
		// email здесь не приходит вовсе.
		if ok, wait := h.limiter.AllowKey("2fa-webauthn:" + req.Challenge); !ok {
			ratelimit.WriteLimited(w, wait)
			return
		}
	}
	assertion, challengeID, err := h.svc.WebAuthnLoginStart(r.Context(), req.Challenge)
	if err != nil {
		switch {
		case errors.Is(err, ErrWebAuthnDisabled):
			writeErr(w, http.StatusNotImplemented, "ключи доступа не настроены на этом стенде")
		case errors.Is(err, ErrInvalidCreds):
			writeErr(w, http.StatusUnauthorized, "пропуск не подошёл — введите пароль заново")
		default:
			h.logger.Error("webauthn login begin", "err", err)
			writeErr(w, http.StatusInternalServerError, "login failed")
		}
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"challenge": challengeID,
		"publicKey": assertion.Response,
	})
}

// WebAuthnLoginFinish — POST /login/webauthn/finish?challenge=<id>.
//
// Тело — ответ `navigator.credentials.get()`. Успех выдаёт токены сразу: ключ заменяет и
// пароль, и второй фактор (он и есть «чем владею» вместе с биометрией/PIN).
func (h *Handler) WebAuthnLoginFinish(w http.ResponseWriter, r *http.Request) {
	challengeID, err := parseChallengeParam(w, r)
	if err != nil {
		return
	}
	if h.limiter != nil {
		// Ключ ограничения — сама церемония: она живёт 5 минут и относится к одному человеку.
		if ok, wait := h.limiter.AllowKey("wa:" + challengeID.String()); !ok {
			ratelimit.WriteLimited(w, wait)
			return
		}
	}
	u, tok, err := h.svc.WebAuthnLoginFinish(r.Context(), challengeID, r)
	if err != nil {
		switch {
		case errors.Is(err, ErrWebAuthnDisabled):
			writeErr(w, http.StatusNotImplemented, "ключи доступа не настроены на этом стенде")
		case errors.Is(err, ErrInvalidCreds), errors.Is(err, ErrWebAuthnChallenge):
			writeErr(w, http.StatusUnauthorized, "не удалось войти ключом")
		default:
			h.logger.Error("webauthn login finish", "err", err)
			writeErr(w, http.StatusInternalServerError, "login failed")
		}
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"user":   h.publicUserWith2FA(r, u),
		"tokens": toResp(tok),
	})
}

// parseChallengeParam читает и разбирает `?challenge=`.
func parseChallengeParam(w http.ResponseWriter, r *http.Request) (uuid.UUID, error) {
	id, err := uuid.Parse(r.URL.Query().Get("challenge"))
	if err != nil {
		writeErr(w, http.StatusBadRequest, "нужен параметр challenge")
		return uuid.Nil, err
	}
	return id, nil
}

// allowWebAuthnAttempt — ограничение попыток привязки ключа для человека: подбор параметров
// аутентификатора не должен быть бесплатным.
func (h *Handler) allowWebAuthnAttempt(w http.ResponseWriter, r *http.Request, userID uuid.UUID) bool {
	if h.limiter == nil {
		return true
	}
	if ok, wait := h.limiter.AllowKey("webauthn:" + userID.String()); !ok {
		ratelimit.WriteLimited(w, wait)
		return false
	}
	return true
}
