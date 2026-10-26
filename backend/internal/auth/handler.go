package auth

import (
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"net/http"

	"github.com/skyfraze/backend/internal/ratelimit"
	"github.com/skyfraze/backend/internal/store"
)

// Handler — HTTP-роуты /api/auth/*.
type Handler struct {
	svc    *Service
	store  *store.Store
	logger *slog.Logger
	// limiter — ограничение попыток входа по аккаунту (docs/security.md). Необязателен:
	// без него вход работает как раньше (и это видно в настройках стенда, а не подкравшись).
	limiter *ratelimit.Limiter
}

func NewHandler(svc *Service, store *store.Store, logger *slog.Logger) *Handler {
	return &Handler{svc: svc, store: store, logger: logger}
}

// UseRateLimit подключает ограничение попыток входа по email.
//
// Проверка стоит ЗДЕСЬ, после разбора тела, а не в middleware: ключ — сам аккаунт, и чтобы
// получить его, тело всё равно нужно прочитать. Граница по адресу клиента живёт в
// middleware (ей тело не нужно).
func (h *Handler) UseRateLimit(limiter *ratelimit.Limiter) { h.limiter = limiter }

type registerReq struct {
	Email       string `json:"email"`
	Password    string `json:"password"`
	DisplayName string `json:"display_name"`
}

type loginReq struct {
	Email    string `json:"email"`
	Password string `json:"password"`
}

type refreshReq struct {
	Refresh string `json:"refresh"`
}

type tokensResp struct {
	Access     string `json:"access"`
	Refresh    string `json:"refresh"`
	AccessExp  int64  `json:"access_exp_unix"`
	RefreshExp int64  `json:"refresh_exp_unix"`
}

type userPublic struct {
	ID          string `json:"id"`
	Email       string `json:"email"`
	DisplayName string `json:"display_name"`
	// Username — ник (@nick): по нему человека находят соавторы.
	Username string `json:"username"`
	// Bio и Crafts — карточка человека в каталоге людей: что он о себе рассказал
	// и за что берётся. Discoverable — галочка «не показывать меня».
	Bio          string   `json:"bio"`
	Crafts       []string `json:"crafts"`
	Discoverable bool     `json:"discoverable"`
	// NotifyComments — согласие получать письма о новых замечаниях. По умолчанию нет:
	// текст проекта уходит на чужой почтовый сервер только осознанно (docs/comments.md §5.2).
	NotifyComments bool `json:"notify_comments"`
	// TOTPEnabled — включён ли второй фактор входа (docs/security.md). Заполняется
	// обработчиками через publicUserWith2FA: таблица 2FA отдельная, и в самом store.User
	// этого поля нет.
	TOTPEnabled bool `json:"totp_enabled"`
	// PasskeysEnabled — настроены ли на стенде ключи доступа (docs/webauthn.md). Профиль по
	// этому признаку показывает (или прячет) раздел ключей: предлагать кнопку, которая
	// всегда отвечает 501, — хуже, чем не предлагать её вовсе.
	PasskeysEnabled bool `json:"passkeys_enabled"`
	IsAdmin         bool `json:"is_admin"`
}

func publicUser(u *store.User) userPublic {
	// Пустой список должен уезжать как [], а не null: интерфейс итерирует по crafts
	// и на null ломается.
	crafts := u.Crafts
	if crafts == nil {
		crafts = []string{}
	}
	return userPublic{
		ID: u.ID.String(), Email: u.Email, DisplayName: u.DisplayName,
		Username: u.Username, Bio: u.Bio, Crafts: crafts,
		Discoverable: u.Discoverable, NotifyComments: u.NotifyComments, IsAdmin: u.IsAdmin,
	}
}

type updateProfileReq struct {
	DisplayName string `json:"display_name"`
	Username    string `json:"username"`
	// Указатели ради «не прислали — не меняем»: иначе сохранение одного имени
	// стирало бы «о себе», специализации и галочку «показывать меня».
	Bio          *string   `json:"bio"`
	Crafts       *[]string `json:"crafts"`
	Discoverable *bool     `json:"discoverable"`
	// NotifyComments — галочка «присылать замечания на почту».
	NotifyComments *bool `json:"notify_comments"`
}

// UpdateProfile — имя, ник, «о себе», специализации и видимость в каталоге.
// Ник уникален: 409, если занят.
func (h *Handler) UpdateProfile(w http.ResponseWriter, r *http.Request) {
	uid, err := UserIDFromCtx(r.Context())
	if err != nil {
		writeErr(w, http.StatusUnauthorized, "unauthorized")
		return
	}
	var req updateProfileReq
	if err := json.NewDecoder(io.LimitReader(r.Body, 1<<16)).Decode(&req); err != nil {
		writeErr(w, http.StatusBadRequest, "invalid json")
		return
	}
	u, err := h.svc.UpdateProfile(r.Context(), uid, ProfileUpdate{
		DisplayName:  req.DisplayName,
		Username:     req.Username,
		Bio:          req.Bio,
		Crafts:       req.Crafts,
		Discoverable:   req.Discoverable,
		NotifyComments: req.NotifyComments,
	})
	if err != nil {
		switch {
		case errors.Is(err, ErrInvalidUsername):
			writeErr(w, http.StatusBadRequest, "invalid username")
		case errors.Is(err, ErrInvalidProfile):
			writeErr(w, http.StatusBadRequest, "invalid profile")
		case errors.Is(err, store.ErrAlreadyExists):
			writeErr(w, http.StatusConflict, "username taken")
		default:
			h.logger.Error("update profile", "err", err)
			writeErr(w, http.StatusInternalServerError, "update failed")
		}
		return
	}
	writeJSON(w, http.StatusOK, h.publicUserWith2FA(r, u))
}

// Config — публичная конфигурация входа: как на этой инсталляции пускают новых
// пользователей и пустая ли она ещё. Нужна странице регистрации, чтобы показать
// либо форму, либо заявку (а на пустой инсталляции — форму первого администратора).
func (h *Handler) Config(w http.ResponseWriter, r *http.Request) {
	mode, bootstrap := h.svc.RegistrationInfo(r.Context())
	writeJSON(w, http.StatusOK, map[string]any{
		"registration_mode": mode,
		"bootstrap":         bootstrap,
		// Ключи доступа настроены на стенде? Форма входа показывает по этому признаку
		// кнопку «войти ключом» (docs/webauthn.md §7).
		"passkeys": h.svc.WebAuthnEnabled(),
	})
}

func (h *Handler) Register(w http.ResponseWriter, r *http.Request) {
	r.Body = io.NopCloser(io.LimitReader(r.Body, 1<<20))
	var req registerReq
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeErr(w, http.StatusBadRequest, "invalid json")
		return
	}
	if req.Email == "" || req.Password == "" || req.DisplayName == "" {
		writeErr(w, http.StatusBadRequest, "email, password, display_name required")
		return
	}
	u, tok, err := h.svc.Register(r.Context(), req.Email, req.Password, req.DisplayName)
	if err != nil {
		switch {
		case errors.Is(err, ErrRegistrationClosed):
			writeErr(w, http.StatusForbidden, "registration is by request only")
		case errors.Is(err, ErrEmailTaken):
			writeErr(w, http.StatusConflict, "email already registered")
		default:
			h.logger.Error("register", "err", err)
			writeErr(w, http.StatusInternalServerError, "register failed")
		}
		return
	}
	writeJSON(w, http.StatusCreated, map[string]any{
		"user":   publicUser(u),
		"tokens": toResp(tok),
	})
}

type registrationRequestReq struct {
	Email       string `json:"email"`
	Password    string `json:"password"`
	DisplayName string `json:"display_name"`
	Message     string `json:"message"`
}

// RequestRegistration — POST /api/auth/registration-requests: заявка на доступ.
// Отвечает 202 Accepted: аккаунт появится только после решения администратора.
func (h *Handler) RequestRegistration(w http.ResponseWriter, r *http.Request) {
	r.Body = io.NopCloser(io.LimitReader(r.Body, 1<<20))
	var req registrationRequestReq
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeErr(w, http.StatusBadRequest, "invalid json")
		return
	}
	if req.Email == "" || req.Password == "" || req.DisplayName == "" {
		writeErr(w, http.StatusBadRequest, "email, password, display_name required")
		return
	}
	created, err := h.svc.SubmitRegistrationRequest(r.Context(), req.Email, req.Password, req.DisplayName, req.Message)
	if err != nil {
		switch {
		case errors.Is(err, ErrEmailTaken):
			writeErr(w, http.StatusConflict, "email already registered")
		case errors.Is(err, ErrInvalidCreds):
			writeErr(w, http.StatusBadRequest, "email, password, display_name required")
		case errors.Is(err, store.ErrPendingRequestExists):
			writeErr(w, http.StatusConflict, "registration request already pending")
		default:
			h.logger.Error("registration request", "err", err)
			writeErr(w, http.StatusInternalServerError, "request failed")
		}
		return
	}
	writeJSON(w, http.StatusAccepted, map[string]any{
		"status":     created.Status,
		"email":      created.Email,
		"created_at": created.CreatedAt,
	})
}

func (h *Handler) Login(w http.ResponseWriter, r *http.Request) {
	var req loginReq
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeErr(w, http.StatusBadRequest, "invalid json")
		return
	}
	// Ограничение по аккаунту: перебор одного пароля с разных адресов граница по IP не
	// остановит. Проверяем ДО обращения к базе с хешем — дорогую часть (bcrypt) не должен
	// оплачивать тот, кто уже превысил предел.
	if h.limiter != nil {
		if ok, wait := h.limiter.AllowKey(req.Email); !ok {
			h.logger.Warn("login: слишком много попыток для аккаунта", "email", req.Email)
			ratelimit.WriteLimited(w, wait)
			return
		}
	}
	u, tok, err := h.svc.Login(r.Context(), req.Email, req.Password)
	if err != nil {
		switch {
		case errors.Is(err, ErrTOTPRequired):
			// Пароль верный, но токенов ещё нет: отдаём короткоживущий пропуск и просим второй
			// шаг. Так интерфейс узнаёт про второй фактор только после пароля — до него это
			// знание ничего не даёт взломщику, а после даёт, и прятать его бессмысленно.
			challenge, challengeErr := h.svc.BeginTOTPChallenge(u.ID)
			if challengeErr != nil {
				h.logger.Error("login: пропуск для 2FA", "err", challengeErr)
				writeErr(w, http.StatusInternalServerError, "login failed")
				return
			}
			// Чем человек может пройти второй шаг: кодом из приложения и/или ключом доступа.
			// Ключи считаются отдельно от TOTP: включён только ключ — кода у человека нет.
			writeJSON(w, http.StatusOK, map[string]any{
				"totp_required": true,
				"challenge":     challenge,
				"totp":          h.svc.TOTPEnabled(r.Context(), u.ID),
				"passkeys":      h.svc.WebAuthnPasskeyCount(r.Context(), u.ID) > 0,
			})
			return
		case errors.Is(err, ErrInvalidCreds):
			writeErr(w, http.StatusUnauthorized, "invalid credentials")
		case errors.Is(err, ErrRequestPending):
			writeErr(w, http.StatusForbidden, "registration request is pending")
		case errors.Is(err, ErrRequestRejected):
			writeErr(w, http.StatusForbidden, "registration request was rejected")
		default:
			h.logger.Error("login", "err", err)
			writeErr(w, http.StatusInternalServerError, "login failed")
		}
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"user":   h.publicUserWith2FA(r, u),
		"tokens": toResp(tok),
	})
}

func (h *Handler) Refresh(w http.ResponseWriter, r *http.Request) {
	var req refreshReq
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeErr(w, http.StatusBadRequest, "invalid json")
		return
	}
	if req.Refresh == "" {
		writeErr(w, http.StatusBadRequest, "refresh required")
		return
	}
	tok, err := h.svc.Refresh(r.Context(), req.Refresh)
	if err != nil {
		writeErr(w, http.StatusUnauthorized, "refresh failed")
		return
	}
	writeJSON(w, http.StatusOK, toResp(tok))
}

func (h *Handler) Me(w http.ResponseWriter, r *http.Request) {
	uid, err := UserIDFromCtx(r.Context())
	if err != nil {
		writeErr(w, http.StatusUnauthorized, "unauthorized")
		return
	}
	u, err := h.store.GetUserByID(r.Context(), uid)
	if err != nil {
		writeErr(w, http.StatusNotFound, "user not found")
		return
	}
	writeJSON(w, http.StatusOK, h.publicUserWith2FA(r, u))
}

// helpers

func toResp(t *Tokens) tokensResp {
	return tokensResp{
		Access:     t.Access,
		Refresh:    t.Refresh,
		AccessExp:  t.AccessExp.Unix(),
		RefreshExp: t.RefreshExp.Unix(),
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
