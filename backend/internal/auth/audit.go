package auth

// audit.go — журнал входов: что записываем и когда (миграция 0029).
//
// Что решаем здесь и почему:
//   - пишем только ЗАВЕРШЁННЫЕ попытки: успешный вход (с указанием фактора) и отказ. Промежуточный
//     шаг «пароль верный, нужен код» записью не считается — токенов он не дал;
//   - неизвестный адрес не сохраняется: показать его некому, а хранить чужие адреса — сбор
//     персональных данных без цели. Такой отказ не пишется вовсе;
//   - поломка журнала НЕ отменяет вход: человек пришёл за доступом, а не за отчётом. Ошибка
//     уходит в журнал сервера, а не в ответ;
//   - срок хранения — константа рядом с уборкой (LoginAuditRetention), чтобы «90 дней» не
//     разошлось между кодом, документацией и уборщиком.

import (
	"context"
	"net/http"
	"strings"
	"time"

	"github.com/google/uuid"

	"github.com/skyfraze/backend/internal/ratelimit"
	"github.com/skyfraze/backend/internal/store"
)

// LoginAuditRetention — сколько хранится журнал входов.
//
// Девяносто дней: достаточно, чтобы заметить «кто-то входил в мой аккаунт» задним числом, и
// не настолько долго, чтобы журнал стал досье на человека. Та же константа — у уборщика.
const LoginAuditRetention = 90 * 24 * time.Hour

// LoginAuditPerUser — верхняя граница записей на человека (0.72.0).
//
// Срок хранения объём не ограничивает: активный вход раз в день даёт ~90 строк, а бот,
// долбящийся в аккаунт, — тысячи за сутки. Двести записей — это месяцы обычной жизни и при
// этом потолок, который не даёт журналу вырасти в базу перебора. Держит его уборщик.
const LoginAuditPerUser = 200

// loginAuditDedupWindow — окно подавления повторов.
//
// Одинаковое событие с того же адреса в пределах минуты не пишется второй раз: подбирающий
// пароль не должен превращать журнал в тысячу одинаковых строк, а «долбятся с этого адреса» —
// один факт, а не тысяча. Разные исходы и разные адреса по-прежнему пишутся отдельно.
const loginAuditDedupWindow = time.Minute

// loginAuditPageSize — сколько последних входов отдаётся профилю.
const loginAuditPageSize = 20

// Исходы попытки входа.
const (
	loginOutcomeOK       = "ok"
	loginOutcomePassword = "bad_password"
	loginOutcomeCode     = "bad_code"
	loginOutcomeKey      = "bad_key"
	loginOutcomeLocked   = "locked"
)

// Факторы успешного входа.
const (
	loginFactorPassword = "password"
	loginFactorTOTP     = "totp"
	loginFactorRecovery = "recovery"
	loginFactorPasskey  = "passkey"
)

// LoginMeta — откуда была попытка. Адрес и браузер берутся из запроса, а не из сервиса:
// сервис не должен знать про HTTP, но и HTTP-слой не должен знать про устройство журнала.
type LoginMeta struct {
	IP        string
	UserAgent string
}

// MetaFromRequest собирает метаданные попытки из запроса.
func MetaFromRequest(r *http.Request) LoginMeta {
	if r == nil {
		return LoginMeta{}
	}
	agent := r.UserAgent()
	// Длинный user-agent обрезаем: это подпись браузера, а не текст, который кто-то читает
	// целиком, и 500 символов хватает любому настоящему.
	if len(agent) > 500 {
		agent = agent[:500]
	}
	return LoginMeta{IP: ratelimit.ClientIP(r), UserAgent: agent}
}

// recordLogin пишет попытку в журнал; поломка журнала вход не отменяет.
func (s *Service) recordLogin(
	ctx context.Context, userID uuid.UUID, outcome, factor string, meta LoginMeta,
) {
	if err := s.store.RecordLoginAudit(ctx, store.LoginAuditEntry{
		UserID: userID, Outcome: outcome, Factor: factor,
		IP: meta.IP, UserAgent: meta.UserAgent,
	}, loginAuditDedupWindow); err != nil {
		s.log().Warn("auth: вход не записан в журнал", "err", err, "outcome", outcome)
	}
}

// Logins — последние входы человека (для профиля).
//
// Это его собственный журнал: чужие попытки человека не касаются, а администратору отдельной
// ручки нет намеренно — «кто куда входил» на всю инсталляцию это уже слежка, и без запроса
// владельца такая возможность не нужна.
func (s *Service) Logins(ctx context.Context, userID uuid.UUID) ([]store.LoginAuditEntry, error) {
	return s.store.LoginAudit(ctx, userID, loginAuditPageSize)
}

// RecordLocked отмечает отказ по частоте попыток.
//
// Пишется по адресу, а не по человеку: в этот момент мы ещё не проверяли пароль и не знаем,
// тот ли это человек. Если аккаунт с таким адресом есть — запись попадёт в его журнал, и это
// ровно то, что нужно: «в мой аккаунт долбятся с одного адреса».
func (s *Service) RecordLocked(ctx context.Context, email string, meta LoginMeta) {
	u, err := s.store.GetUserByEmail(ctx, strings.ToLower(strings.TrimSpace(email)))
	if err != nil || u == nil {
		return
	}
	s.recordLogin(ctx, u.ID, loginOutcomeLocked, "", meta)
}

// metaOf — необязательные метаданные: вызов не из HTTP (тесты, скрипты) допустим и просто
// не пишет адрес и браузер.
func metaOf(meta []LoginMeta) LoginMeta {
	if len(meta) > 0 {
		return meta[0]
	}
	return LoginMeta{}
}
