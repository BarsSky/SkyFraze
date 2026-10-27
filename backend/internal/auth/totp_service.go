package auth

// totp_service.go — второй фактор входа в сервисе: настройка, включение, вход, отключение.
//
// Логика входа двухшаговая, и это не «лишний запрос», а суть второго фактора: пароль
// проверяется первым, но токены не выдаются, пока не предъявлен код. Между шагами человеку
// отдаётся КОРОТКОЖИВУЩИЙ пропуск (5 минут, отдельный тип токена) — он не даёт доступа к API
// и не заменяет пароль, только позволяет сказать «пароль этого человека уже проверен».
//
// Что важно не сломать:
//   - пока 2FA не включена (enabled_at пуст), вход идёт по одному паролю: неудачная настройка
//     не должна запирать человека снаружи;
//   - код можно заменить кодом восстановления — иначе потерянный телефон означал бы потерянный
//     аккаунт (сброса пароля по почте здесь нет);
//   - имя пользователя в ошибках не различается: «нет аккаунта» и «неверный код» — это ответы
//     разной степени полезности для взломщика.

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/golang-jwt/jwt/v5"
	"github.com/google/uuid"

	"github.com/skyfraze/backend/internal/store"
)

// ErrTOTPRequired — пароль верный, но нужен второй фактор.
var ErrTOTPRequired = errors.New("требуется код двухфакторного входа")

// ErrTOTPInvalid — код неверный (или просроченный пропуск, или код восстановления уже
// использован). Один ответ на все случаи: человеку нужно «попробуйте ещё», а не карта причин.
var ErrTOTPInvalid = errors.New("неверный код двухфакторного входа")

// ErrTOTPNotEnabled — попытка выключить/подтвердить то, что не настроено.
var ErrTOTPNotEnabled = errors.New("двухфакторный вход не настроен")

// totpChallengeTTL — сколько живёт пропуск между паролем и кодом.
//
// Пять минут: человек успевает открыть приложение и ввести код, а украденный перехватом
// пропуск не живёт до утра.
const totpChallengeTTL = 5 * time.Minute

// recoveryCodesCount — сколько кодов восстановления выдаётся.
const recoveryCodesCount = 8

// TOTPSetup — что отдаётся человеку при настройке.
type TOTPSetup struct {
	// Secret — base32 для ручного ввода в приложение.
	Secret string
	// URL — ссылка otpauth://, которую можно вставить в приложение или превратить в QR.
	URL string
}

// SetupTOTP выдаёт новый секрет (ещё не включённый).
//
// Если 2FA уже включена, повторная настройка не разрешается: иначе украденная сессия могла бы
// подменить секрет и запереть настоящего владельца. Сначала — выключить, предъявив код.
func (s *Service) SetupTOTP(ctx context.Context, userID uuid.UUID) (*TOTPSetup, error) {
	u, err := s.store.GetUserByID(ctx, userID)
	if err != nil {
		return nil, err
	}
	if _, enabled, err := s.store.TOTPOf(ctx, userID); err == nil && enabled {
		return nil, ErrTOTPNotEnabled
	}
	secret, err := GenerateTOTPSecret()
	if err != nil {
		return nil, err
	}
	if err := s.store.SetTOTPSecret(ctx, userID, secret); err != nil {
		return nil, err
	}
	return &TOTPSetup{
		Secret: secret,
		URL:    OTPAuthURL("SkyFraze", u.Email, secret),
	}, nil
}

// EnableTOTP подтверждает настройку кодом из приложения и выдаёт коды восстановления.
//
// Коды показываются ОДИН раз (в базе только хеши): если человек их не сохранил, остаётся
// выключить 2FA паролем и настроить заново — это лучше, чем хранить их открытым текстом.
func (s *Service) EnableTOTP(ctx context.Context, userID uuid.UUID, code string) ([]string, error) {
	secret, enabled, err := s.store.TOTPOf(ctx, userID)
	if err != nil || enabled {
		return nil, ErrTOTPNotEnabled
	}
	if !VerifyTOTP(secret, code, time.Now()) {
		return nil, ErrTOTPInvalid
	}
	if err := s.store.EnableTOTP(ctx, userID); err != nil {
		return nil, err
	}
	codes, err := GenerateRecoveryCodes(recoveryCodesCount)
	if err != nil {
		return nil, err
	}
	hashes := make([]string, 0, len(codes))
	for _, plain := range codes {
		hashes = append(hashes, sha256Hex(normalizeRecoveryCode(plain)))
	}
	if err := s.store.ReplaceRecoveryCodes(ctx, userID, hashes); err != nil {
		return nil, err
	}
	return codes, nil
}

// DisableTOTP выключает второй фактор. Код обязателен: иначе включённая 2FA снималась бы
// одной украденной сессией.
func (s *Service) DisableTOTP(ctx context.Context, userID uuid.UUID, code string) error {
	secret, enabled, err := s.store.TOTPOf(ctx, userID)
	if err != nil {
		return ErrTOTPNotEnabled
	}
	if !enabled {
		return ErrTOTPNotEnabled
	}
	if !s.checkTOTPOrRecovery(ctx, userID, secret, code) {
		return ErrTOTPInvalid
	}
	return s.store.DisableTOTP(ctx, userID)
}

// TOTPEnabled — включён ли второй фактор (для интерфейса и для /me).
func (s *Service) TOTPEnabled(ctx context.Context, userID uuid.UUID) bool {
	_, enabled, err := s.store.TOTPOf(ctx, userID)
	return err == nil && enabled
}

// RecoveryCodeCount — сколько неиспользованных кодов восстановления осталось.
func (s *Service) RecoveryCodeCount(ctx context.Context, userID uuid.UUID) (int, error) {
	return s.store.UnusedRecoveryCodes(ctx, userID)
}

// verifySecondFactor проверяет код и говорит, ЧЕМ он был.
//
// Фактор нужен журналу входов: «вошёл по коду восстановления» — сигнал, что листок с кодами у
// кого-то в руках, и его стоит видеть в списке последних входов. Пустой secret означает «кода
// из приложения у человека нет» (TOTP не включён) — тогда принимается только код восстановления.
func (s *Service) verifySecondFactor(
	ctx context.Context, userID uuid.UUID, secret, code string,
) (string, bool) {
	if secret != "" && VerifyTOTP(secret, code, time.Now()) {
		return loginFactorTOTP, true
	}
	if s.consumeRecoveryCode(ctx, userID, code) {
		return loginFactorRecovery, true
	}
	return "", false
}

// checkTOTPOrRecovery — то же, но без указания фактора (нужно выключению второго фактора,
// где журнал входа не ведётся).
func (s *Service) checkTOTPOrRecovery(ctx context.Context, userID uuid.UUID, secret, code string) bool {
	_, ok := s.verifySecondFactor(ctx, userID, secret, code)
	return ok
}

// consumeRecoveryCode гасит код восстановления. Один раз и навсегда: повтор того же кода —
// отказ, иначе листок с кодами был бы многоразовым.
func (s *Service) consumeRecoveryCode(ctx context.Context, userID uuid.UUID, code string) bool {
	normalized := normalizeRecoveryCode(code)
	if len(normalized) < 8 {
		return false
	}
	used, err := s.store.ConsumeRecoveryCode(ctx, userID, sha256Hex(normalized))
	return err == nil && used
}

// BeginTOTPChallenge выпускает короткоживущий пропуск «пароль проверен, нужен код».
func (s *Service) BeginTOTPChallenge(userID uuid.UUID) (string, error) {
	claims := jwt.MapClaims{
		"sub": userID.String(),
		"typ": "totp",
		"exp": time.Now().Add(totpChallengeTTL).Unix(),
		"iat": time.Now().Unix(),
		"iss": "skyfraze",
	}
	token := jwt.NewWithClaims(jwt.SigningMethodHS256, claims)
	signed, err := token.SignedString([]byte(s.secret))
	if err != nil {
		return "", fmt.Errorf("totp: пропуск: %w", err)
	}
	return signed, nil
}

// LoginTOTP — второй шаг входа: пропуск + код, в ответ токены.
//
// Пропуск проверяется вместе с кодом: без этого достаточно было бы знать один пароль, а сам
// пропуск можно предъявить только с верным кодом.
//
// Если TOTP не включён, но привязаны ключи доступа, второй шаг всё равно был (ключи требуют
// его), и код восстановления здесь — единственный путь внутрь для того, кто потерял устройство.
// Поэтому в этом случае принимается ТОЛЬКО код восстановления: кода из приложения у него нет.
func (s *Service) LoginTOTP(
	ctx context.Context, challenge, code string, meta ...LoginMeta,
) (*store.User, *Tokens, error) {
	attempt := metaOf(meta)
	userID, err := s.parseTOTPChallenge(challenge)
	if err != nil {
		return nil, nil, ErrTOTPInvalid
	}
	u, err := s.store.GetUserByID(ctx, userID)
	if err != nil {
		return nil, nil, ErrTOTPInvalid
	}
	// Ошибка здесь значит «секрета нет» — это не повод отказывать: у человека может быть ключ.
	secret, enabled, _ := s.store.TOTPOf(ctx, userID)
	hasPasskeys := s.WebAuthnPasskeyCount(ctx, userID) > 0
	if !enabled && !hasPasskeys {
		return nil, nil, ErrTOTPInvalid
	}
	// Код из приложения принимается только если TOTP включён: иначе «секрета» нет, а код
	// восстановления остаётся последним путём внутрь.
	usableSecret := ""
	if enabled {
		usableSecret = secret
	}
	factor, ok := s.verifySecondFactor(ctx, userID, usableSecret, code)
	if !ok {
		s.recordLogin(ctx, userID, loginOutcomeCode, "", attempt)
		return nil, nil, ErrTOTPInvalid
	}
	// Сессия: тот же путь, что и при обычном входе (одна точка выдачи токенов).
	tok, err := s.issueTokens(ctx, u.ID, "")
	if err != nil {
		return nil, nil, err
	}
	s.recordLogin(ctx, userID, loginOutcomeOK, factor, attempt)
	return u, tok, nil
}

// parseTOTPChallenge разбирает пропуск и проверяет его тип и срок.
func (s *Service) parseTOTPChallenge(challenge string) (uuid.UUID, error) {
	parsed, err := jwt.Parse(strings.TrimSpace(challenge), func(token *jwt.Token) (any, error) {
		if _, ok := token.Method.(*jwt.SigningMethodHMAC); !ok {
			return nil, ErrTOTPInvalid
		}
		return []byte(s.secret), nil
	})
	if err != nil || !parsed.Valid {
		return uuid.Nil, ErrTOTPInvalid
	}
	claims, ok := parsed.Claims.(jwt.MapClaims)
	if !ok {
		return uuid.Nil, ErrTOTPInvalid
	}
	// Тип обязателен: refresh-токен или access не должны годиться как пропуск.
	if typ, _ := claims["typ"].(string); typ != "totp" {
		return uuid.Nil, ErrTOTPInvalid
	}
	sub, _ := claims["sub"].(string)
	id, err := uuid.Parse(sub)
	if err != nil {
		return uuid.Nil, ErrTOTPInvalid
	}
	return id, nil
}

// Sessions — активные сеансы человека.
func (s *Service) Sessions(ctx context.Context, userID uuid.UUID) ([]store.Session, error) {
	return s.store.ListSessions(ctx, userID)
}

// RevokeOtherSessions закрывает все сеансы, кроме текущего.
//
// Текущий определяется по refresh-токену из запроса: «выйти везде, кроме этого браузера» —
// то, чего человек ждёт от такой кнопки. Если токен не найден, отзываются все (безопаснее
// закрыть лишнее, чем оставить чужое).
func (s *Service) RevokeOtherSessions(ctx context.Context, userID uuid.UUID, refresh string) (int, error) {
	keep := uuid.Nil
	if strings.TrimSpace(refresh) != "" {
		if sess, err := s.store.GetSessionByRefreshHash(ctx, sha256Hex(refresh)); err == nil &&
			sess.UserID == userID {
			keep = sess.ID
		}
	}
	return s.store.RevokeOtherSessions(ctx, userID, keep)
}
