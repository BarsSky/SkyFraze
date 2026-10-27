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
func (s *Store) RecordLoginAudit(ctx context.Context, e LoginAuditEntry) error {
	_, err := s.Pool.Exec(ctx,
		`INSERT INTO login_audit (user_id, outcome, factor, ip, user_agent)
		 VALUES ($1, $2, $3, $4, $5)`,
		e.UserID, e.Outcome, e.Factor, e.IP, e.UserAgent)
	return err
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
