package store

// store_login_audit.go — журнал входов (миграция 0029).
//
// Что здесь есть и чего нет — это решение о приватности, а не удобство:
//   - строки только для существующих аккаунтов (user_id NOT NULL): адрес, который ввели по
//     ошибке, нигде не сохраняется;
//   - ни пароля, ни хешей, ни кода — только факт, способ и откуда;
//   - срок хранения задаёт вызывающий (auth.LoginAuditRetention), уборка — фоновая.

import (
	"context"
	"time"

	"github.com/google/uuid"
)

// LoginAuditEntry — одна запись журнала входов.
type LoginAuditEntry struct {
	ID        uuid.UUID `db:"id" json:"id"`
	UserID    uuid.UUID `db:"user_id" json:"-"`
	Outcome   string    `db:"outcome" json:"outcome"`
	Factor    string    `db:"factor" json:"factor"`
	IP        string    `db:"ip" json:"ip"`
	UserAgent string    `db:"user_agent" json:"user_agent"`
	CreatedAt time.Time `db:"created_at" json:"created_at"`
}

const loginAuditColumns = `id, user_id, outcome, factor, ip, user_agent, created_at`

// RecordLoginAudit записывает попытку входа.
//
// Ошибку возвращает, а не глотает: вызывающий решает, важнее ли ему не сорвать вход (ответ —
// да) или узнать о поломке (журнал). Молча ничего не делать здесь было бы худшим выбором.
//
// Повтор того же события (`outcome`, `factor`, `ip`) в пределах окна подавления не пишется
// второй раз (0.72.0): подбирающий пароль с одного адреса не должен превращать журнал в список
// из тысячи одинаковых строк — по нему всё равно не видно ничего, кроме «долбятся с этого
// адреса». Фактор в ключе обязателен: вход кодом и вход кодом восстановления — РАЗНЫЕ события,
// и склеивать их значило бы терять самый важный сигнал журнала. Подавление — в том же запросе, а
// не отдельной проверкой: иначе между проверкой и вставкой остаётся щель, и под нагрузкой она
// как раз и открывается.
func (s *Store) RecordLoginAudit(
	ctx context.Context, e LoginAuditEntry, suppressWindow time.Duration,
) error {
	_, err := s.Pool.Exec(ctx,
		`INSERT INTO login_audit (user_id, outcome, factor, ip, user_agent)
		 SELECT $1, $2, $3, $4, $5
		  WHERE $6 <= 0 OR NOT EXISTS (
		        SELECT 1 FROM login_audit
		         WHERE user_id = $1 AND outcome = $2 AND factor = $3 AND ip = $4
		           AND created_at > now() - make_interval(secs => $6))`,
		e.UserID, e.Outcome, e.Factor, e.IP, e.UserAgent, suppressWindow.Seconds())
	return err
}

// TrimLoginAudit оставляет у каждого человека не больше `perUser` свежих записей (0.72.0).
//
// Срок хранения (90 дней) сам по себе не ограничивает объём: активный вход раз в день даёт
// ~90 строк, а бот, долбящийся в аккаунт, — тысячи за сутки. Здесь верхняя граница на человека,
// и она одна на сервис и уборщик (auth.LoginAuditPerUser).
func (s *Store) TrimLoginAudit(ctx context.Context, perUser int) (int64, error) {
	if perUser <= 0 {
		return 0, nil
	}
	tag, err := s.Pool.Exec(ctx,
		`DELETE FROM login_audit WHERE id IN (
		   SELECT id FROM (
		     SELECT id, row_number() OVER (PARTITION BY user_id ORDER BY created_at DESC) AS rn
		       FROM login_audit
		   ) ranked WHERE rn > $1)`, perUser)
	if err != nil {
		return 0, err
	}
	return tag.RowsAffected(), nil
}

// LoginAudit читает последние входы человека (свежие сверху).
func (s *Store) LoginAudit(
	ctx context.Context, userID uuid.UUID, limit int,
) ([]LoginAuditEntry, error) {
	if limit <= 0 {
		limit = 20
	}
	return qAll[LoginAuditEntry](ctx, s.Pool,
		`SELECT `+loginAuditColumns+`
		   FROM login_audit
		  WHERE user_id = $1
		  ORDER BY created_at DESC
		  LIMIT $2`, userID, limit)
}

// PurgeLoginAudit удаляет записи старше срока хранения.
func (s *Store) PurgeLoginAudit(ctx context.Context, retention time.Duration) (int64, error) {
	cutoff := time.Now().Add(-retention)
	tag, err := s.Pool.Exec(ctx, `DELETE FROM login_audit WHERE created_at < $1`, cutoff)
	if err != nil {
		return 0, err
	}
	return tag.RowsAffected(), nil
}
