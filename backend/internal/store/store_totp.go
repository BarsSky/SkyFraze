package store

// store_totp.go — второй фактор входа: секрет TOTP и коды восстановления (миграция 0021).
//
// Здесь только хранение. Правила (когда требовать код, как проверять окно шагов, какие коды
// считать использованными) живут в auth.Service — там же, где пароль и сессии.

import (
	"context"
	"errors"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

// ErrTOTPNotConfigured — у пользователя нет секрета (2FA не настраивали).
var ErrTOTPNotConfigured = errors.New("двухфакторный вход не настроен")

// SetTOTPSecret выдаёт новый секрет и снимает отметку «включено».
//
// Секрет выдаётся ДО подтверждения: человек должен увидеть код в приложении и ввести его,
// и только тогда вход станет двухфакторным. Пока enabled_at пуст, вход идёт по паролю —
// иначе неудачная настройка запирала бы человека снаружи.
func (s *Store) SetTOTPSecret(ctx context.Context, userID uuid.UUID, secret string) error {
	_, err := s.Pool.Exec(ctx,
		`INSERT INTO user_totp (user_id, secret, enabled_at) VALUES ($1, $2, NULL)
		 ON CONFLICT (user_id) DO UPDATE SET secret = EXCLUDED.secret, enabled_at = NULL`,
		userID, secret)
	return err
}

// TOTPOf читает секрет и признак «включено».
func (s *Store) TOTPOf(ctx context.Context, userID uuid.UUID) (secret string, enabled bool, err error) {
	var enabledAt *time.Time
	err = s.Pool.QueryRow(ctx,
		`SELECT secret, enabled_at FROM user_totp WHERE user_id = $1`, userID).Scan(&secret, &enabledAt)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return "", false, ErrTOTPNotConfigured
		}
		return "", false, err
	}
	return secret, enabledAt != nil, nil
}

// EnableTOTP подтверждает настройку: с этого момента вход требует код.
func (s *Store) EnableTOTP(ctx context.Context, userID uuid.UUID) error {
	tag, err := s.Pool.Exec(ctx,
		`UPDATE user_totp SET enabled_at = now() WHERE user_id = $1`, userID)
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		return ErrTOTPNotConfigured
	}
	return nil
}

// DisableTOTP выключает второй фактор и стирает коды восстановления.
//
// Коды стираются, потому что без включённого 2FA они бессмысленны, а лежать «на будущее» им
// незачем: это вторые пароли, и хранить их без причины — лишний риск.
func (s *Store) DisableTOTP(ctx context.Context, userID uuid.UUID) error {
	if _, err := s.Pool.Exec(ctx, `DELETE FROM user_totp WHERE user_id = $1`, userID); err != nil {
		return err
	}
	_, err := s.Pool.Exec(ctx, `DELETE FROM user_recovery_codes WHERE user_id = $1`, userID)
	return err
}

// ReplaceRecoveryCodes выдаёт новый набор кодов (старые удаляются).
func (s *Store) ReplaceRecoveryCodes(ctx context.Context, userID uuid.UUID, hashes []string) error {
	tx, err := s.Pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx) //nolint:errcheck // откат после успешного Commit — no-op
	if _, err := tx.Exec(ctx, `DELETE FROM user_recovery_codes WHERE user_id = $1`, userID); err != nil {
		return err
	}
	for _, hash := range hashes {
		if _, err := tx.Exec(ctx,
			`INSERT INTO user_recovery_codes (user_id, code_hash) VALUES ($1, $2)`,
			userID, hash); err != nil {
			return err
		}
	}
	return tx.Commit(ctx)
}

// ConsumeRecoveryCode отмечает код использованным.
//
// Условие «ещё не использован» — в самом UPDATE, а не в проверке перед ним: два одновременных
// входа одним кодом не должны оба пройти. Возвращает false, если код не найден или уже был
// использован — вызывающий не различает эти случаи намеренно (это ответ для человека, а не
// для администратора).
func (s *Store) ConsumeRecoveryCode(ctx context.Context, userID uuid.UUID, hash string) (bool, error) {
	tag, err := s.Pool.Exec(ctx,
		`UPDATE user_recovery_codes SET used_at = now()
		  WHERE user_id = $1 AND code_hash = $2 AND used_at IS NULL`, userID, hash)
	if err != nil {
		return false, err
	}
	return tag.RowsAffected() > 0, nil
}

// UnusedRecoveryCodes — сколько кодов осталось (для предупреждения «пора перевыпустить»).
func (s *Store) UnusedRecoveryCodes(ctx context.Context, userID uuid.UUID) (int, error) {
	var count int
	err := s.Pool.QueryRow(ctx,
		`SELECT count(*) FROM user_recovery_codes WHERE user_id = $1 AND used_at IS NULL`,
		userID).Scan(&count)
	return count, err
}

// ListSessions — активные сеансы человека, свежие сверху.
//
// Только не истёкшие и не отозванные: «список устройств» с мёртвыми сеансами заставлял бы
// гадать, что из этого действительно работает.
func (s *Store) ListSessions(ctx context.Context, userID uuid.UUID) ([]Session, error) {
	return qAll[Session](ctx, s.Pool,
		`SELECT id, user_id, refresh_token_hash, user_agent, ip, expires_at, revoked_at, created_at
		   FROM sessions
		  WHERE user_id = $1 AND revoked_at IS NULL AND expires_at > now()
		  ORDER BY created_at DESC`, userID)
}

// RevokeOtherSessions отзывает все активные сеансы, кроме указанного.
//
// Нужно и при смене пароля, и кнопкой «выйти на всех устройствах»: человек, который подозревает
// утечку, должен уметь закрыть чужие входы, не выкидывая себя.
func (s *Store) RevokeOtherSessions(ctx context.Context, userID, keep uuid.UUID) (int, error) {
	tag, err := s.Pool.Exec(ctx,
		`UPDATE sessions SET revoked_at = now()
		  WHERE user_id = $1 AND id <> $2 AND revoked_at IS NULL AND expires_at > now()`,
		userID, keep)
	if err != nil {
		return 0, err
	}
	return int(tag.RowsAffected()), nil
}
