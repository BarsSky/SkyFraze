package auth

// totp_handler.go — HTTP-ручки второго фактора и сеансов.
//
// Пути: /api/auth/2fa/* и /api/auth/sessions. Отдельный файл, чтобы Login остался читаемым:
// двухшаговый вход — это три ветки в одном обработчике, и без выделения тут было бы тесно.

import (
	"encoding/json"
	"errors"
	"io"
	"net/http"

	"github.com/google/uuid"

	"github.com/skyfraze/backend/internal/store"

	"github.com/skyfraze/backend/internal/ratelimit"
)

// MountTwoFactor вешает ручки 2FA и сеансов на /api/auth (внутри группы с WithUser).
func (h *Handler) MountTwoFactor(r interface {
	Post(string, http.HandlerFunc)
	Get(string, http.HandlerFunc)
}) {
	r.Post("/2fa/setup", h.TOTPSetup)
	r.Post("/2fa/enable", h.TOTPEnable)
	r.Post("/2fa/disable", h.TOTPDisable)
	r.Get("/sessions", h.ListSessions)
	r.Post("/sessions/revoke-others", h.RevokeOtherSessions)
}

// TOTPSetup — POST /2fa/setup: выдать секрет (ещё не включённый).
func (h *Handler) TOTPSetup(w http.ResponseWriter, r *http.Request) {
	uid, err := UserIDFromCtx(r.Context())
	if err != nil {
		writeErr(w, http.StatusUnauthorized, "unauthorized")
		return
	}
	setup, err := h.svc.SetupTOTP(r.Context(), uid)
	if err != nil {
		if errors.Is(err, ErrTOTPNotEnabled) {
			writeErr(w, http.StatusConflict, "двухфакторный вход уже включён: сначала выключите его")
			return
		}
		h.logger.Error("totp setup", "err", err)
		writeErr(w, http.StatusInternalServerError, "failed")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"secret": setup.Secret,
		"url":    setup.URL,
		// Подсказка для интерфейса: QR не рисуем, ссылку показываем текстом.
		"hint": "добавьте секрет в приложение-аутентификатор и введите код ниже",
	})
}

// TOTPEnable — POST /2fa/enable {"code"}: подтвердить и получить коды восстановления.
func (h *Handler) TOTPEnable(w http.ResponseWriter, r *http.Request) {
	uid, err := UserIDFromCtx(r.Context())
	if err != nil {
		writeErr(w, http.StatusUnauthorized, "unauthorized")
		return
	}
	var req struct {
		Code string `json:"code"`
	}
	if err := json.NewDecoder(io.LimitReader(r.Body, 4<<10)).Decode(&req); err != nil && err != io.EOF {
		writeErr(w, http.StatusBadRequest, "invalid json")
		return
	}
	// Код подтверждения тоже ограничиваем по частоте: перебор шестизначного кода вручную
	// невозможен, скриптом — вполне.
	if !h.allowTOTPAttempt(w, r, uid) {
		return
	}
	codes, err := h.svc.EnableTOTP(r.Context(), uid, req.Code)
	if err != nil {
		switch {
		case errors.Is(err, ErrTOTPInvalid):
			writeErr(w, http.StatusBadRequest, "неверный код: проверьте время на телефоне и введите код заново")
		case errors.Is(err, ErrTOTPNotEnabled):
			writeErr(w, http.StatusBadRequest, "сначала запросите секрет (setup)")
		default:
			h.logger.Error("totp enable", "err", err)
			writeErr(w, http.StatusInternalServerError, "failed")
		}
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"recovery_codes": codes,
		"note":           "сохраните коды: они показываются один раз и заменяют телефон при входе",
	})
}

// TOTPDisable — POST /2fa/disable {"code"}: код приложения или код восстановления.
func (h *Handler) TOTPDisable(w http.ResponseWriter, r *http.Request) {
	uid, err := UserIDFromCtx(r.Context())
	if err != nil {
		writeErr(w, http.StatusUnauthorized, "unauthorized")
		return
	}
	var req struct {
		Code string `json:"code"`
	}
	if err := json.NewDecoder(io.LimitReader(r.Body, 4<<10)).Decode(&req); err != nil && err != io.EOF {
		writeErr(w, http.StatusBadRequest, "invalid json")
		return
	}
	if !h.allowTOTPAttempt(w, r, uid) {
		return
	}
	if err := h.svc.DisableTOTP(r.Context(), uid, req.Code); err != nil {
		switch {
		case errors.Is(err, ErrTOTPInvalid):
			writeErr(w, http.StatusBadRequest, "неверный код")
		case errors.Is(err, ErrTOTPNotEnabled):
			writeErr(w, http.StatusBadRequest, "двухфакторный вход не настроен")
		default:
			h.logger.Error("totp disable", "err", err)
			writeErr(w, http.StatusInternalServerError, "failed")
		}
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"totp_enabled": false})
}

// LoginTOTP — POST /login/2fa {"challenge","code"}: второй шаг входа.
//
// Публичная ручка (до неё токенов ещё нет), поэтому ограничение по адресу — middleware
// в main, а по «пропуску» — здесь: перебор шестизначного кода в одном окне не должен
// проходить бесконечно.
func (h *Handler) LoginTOTP(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Challenge string `json:"challenge"`
		Code      string `json:"code"`
	}
	if err := json.NewDecoder(io.LimitReader(r.Body, 8<<10)).Decode(&req); err != nil {
		writeErr(w, http.StatusBadRequest, "invalid json")
		return
	}
	if req.Challenge == "" || req.Code == "" {
		writeErr(w, http.StatusBadRequest, "нужны challenge и code")
		return
	}
	if h.limiter != nil {
		// Ключ — сам пропуск: он живёт 5 минут и относится к одному человеку.
		if ok, wait := h.limiter.AllowKey("2fa:" + req.Challenge); !ok {
			ratelimit.WriteLimited(w, wait)
			return
		}
	}
	u, tok, err := h.svc.LoginTOTP(r.Context(), req.Challenge, req.Code)
	if err != nil {
		if errors.Is(err, ErrTOTPInvalid) {
			writeErr(w, http.StatusUnauthorized, "неверный или просроченный код")
			return
		}
		h.logger.Error("login 2fa", "err", err)
		writeErr(w, http.StatusInternalServerError, "login failed")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"user":   h.publicUserWith2FA(r, u),
		"tokens": toResp(tok),
	})
}

// ListSessions — GET /sessions: где человек вошёл.
func (h *Handler) ListSessions(w http.ResponseWriter, r *http.Request) {
	uid, err := UserIDFromCtx(r.Context())
	if err != nil {
		writeErr(w, http.StatusUnauthorized, "unauthorized")
		return
	}
	list, err := h.svc.Sessions(r.Context(), uid)
	if err != nil {
		h.logger.Error("sessions", "err", err)
		writeErr(w, http.StatusInternalServerError, "failed")
		return
	}
	out := make([]map[string]any, 0, len(list))
	for _, sess := range list {
		out = append(out, map[string]any{
			"id":         sess.ID.String(),
			"user_agent": sess.UserAgent,
			"ip":         sess.IP,
			"created_at": sess.CreatedAt,
			"expires_at": sess.ExpiresAt,
		})
	}
	writeJSON(w, http.StatusOK, map[string]any{"sessions": out})
}

// RevokeOtherSessions — POST /sessions/revoke-others {"refresh"}: закрыть чужие входы.
func (h *Handler) RevokeOtherSessions(w http.ResponseWriter, r *http.Request) {
	uid, err := UserIDFromCtx(r.Context())
	if err != nil {
		writeErr(w, http.StatusUnauthorized, "unauthorized")
		return
	}
	var req struct {
		Refresh string `json:"refresh"`
	}
	if err := json.NewDecoder(io.LimitReader(r.Body, 8<<10)).Decode(&req); err != nil && err != io.EOF {
		writeErr(w, http.StatusBadRequest, "invalid json")
		return
	}
	revoked, err := h.svc.RevokeOtherSessions(r.Context(), uid, req.Refresh)
	if err != nil {
		h.logger.Error("revoke sessions", "err", err)
		writeErr(w, http.StatusInternalServerError, "failed")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"revoked": revoked})
}

// allowTOTPAttempt — общее ограничение на попытки ввода кода для человека.
func (h *Handler) allowTOTPAttempt(w http.ResponseWriter, r *http.Request, userID uuid.UUID) bool {
	if h.limiter == nil {
		return true
	}
	if ok, wait := h.limiter.AllowKey("totp:" + userID.String()); !ok {
		ratelimit.WriteLimited(w, wait)
		return false
	}
	return true
}

// publicUserWith2FA — профиль с признаками факторов входа.
func (h *Handler) publicUserWith2FA(r *http.Request, u *store.User) userPublic {
	out := publicUser(u)
	out.TOTPEnabled = h.svc.TOTPEnabled(r.Context(), u.ID)
	out.PasskeysEnabled = h.svc.WebAuthnEnabled()
	return out
}
