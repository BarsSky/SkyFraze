package store

// store_project_revisions.go — история версий проекта (миграция 0016).
//
// Версия — это снапшот документа Yjs целиком. Хранится рядом с текущим снапшотом
// (`project_event_state`), но в отдельной таблице: текущее состояние перезаписывается, а
// версии копятся и удаляются по удержанию.
//
// Удержание считается здесь, а не «когда-нибудь потом»: между «снимок раз в 5 минут» и
// «диск кончился» проходит примерно ничего, если не ограничивать объём. Поэтому после
// каждой вставки автоснимка старые уходят: сначала по количеству, потом по сумме байт.

import (
	"context"
	"time"

	"github.com/google/uuid"
)

// Виды версий.
const (
	// RevisionAuto — снята сервером по ходу правок (с троттлингом).
	RevisionAuto = "auto"
	// RevisionManual — человек нажал «Сохранить версию».
	RevisionManual = "manual"
)

// ProjectRevision — одна версия (без самого снапшота: он тяжёлый и нужен только
// предпросмотру и восстановлению).
type ProjectRevision struct {
	ID        uuid.UUID  `db:"id" json:"id"`
	ProjectID uuid.UUID  `db:"project_id" json:"project_id"`
	Events    int        `db:"events" json:"events"`
	Checksum  string     `db:"checksum" json:"-"`
	Kind      string     `db:"kind" json:"kind"`
	Label     string     `db:"label" json:"label"`
	CreatedBy *uuid.UUID `db:"created_by" json:"created_by"`
	CreatedAt time.Time  `db:"created_at" json:"created_at"`
	// Size — размер снапшота в байтах (для списка и для удержания по объёму).
	Size int `db:"size" json:"size"`
}

const projectRevisionColumns = `id, project_id, events, checksum, kind, label, created_by, created_at,
	octet_length(yjs_state) AS size`

// CreateProjectRevision добавляет версию.
func (s *Store) CreateProjectRevision(
	ctx context.Context, r ProjectRevision, state []byte,
) (*ProjectRevision, error) {
	return qOne[ProjectRevision](ctx, s.Pool,
		`INSERT INTO project_revisions (project_id, yjs_state, events, checksum, kind, label, created_by)
		 VALUES ($1, $2, $3, $4, $5, $6, $7)
		 RETURNING `+projectRevisionColumns,
		r.ProjectID, state, r.Events, r.Checksum, r.Kind, r.Label, r.CreatedBy)
}

// ListProjectRevisions — версии проекта, новые сверху.
func (s *Store) ListProjectRevisions(
	ctx context.Context, projectID uuid.UUID, limit int,
) ([]ProjectRevision, error) {
	if limit <= 0 || limit > 200 {
		limit = 50
	}
	return qAll[ProjectRevision](ctx, s.Pool,
		`SELECT `+projectRevisionColumns+` FROM project_revisions
		  WHERE project_id=$1 ORDER BY created_at DESC LIMIT $2`, projectID, limit)
}

// ProjectRevisionByID читает версию вместе со снапшотом.
func (s *Store) ProjectRevisionByID(
	ctx context.Context, projectID, id uuid.UUID,
) (ProjectRevision, []byte, error) {
	var rev ProjectRevision
	var state []byte
	err := s.Pool.QueryRow(ctx,
		`SELECT `+projectRevisionColumns+`, yjs_state FROM project_revisions
		  WHERE id=$1 AND project_id=$2`, id, projectID).
		Scan(&rev.ID, &rev.ProjectID, &rev.Events, &rev.Checksum, &rev.Kind, &rev.Label,
			&rev.CreatedBy, &rev.CreatedAt, &rev.Size, &state)
	return rev, state, err
}

// LastProjectRevision — последняя версия проекта (для троттлинга автоснимков).
func (s *Store) LastProjectRevision(ctx context.Context, projectID uuid.UUID) (*ProjectRevision, error) {
	return qOne[ProjectRevision](ctx, s.Pool,
		`SELECT `+projectRevisionColumns+` FROM project_revisions
		  WHERE project_id=$1 ORDER BY created_at DESC LIMIT 1`, projectID)
}

// DeleteProjectRevision удаляет версию (ErrNotFound, если её нет в этом проекте).
func (s *Store) DeleteProjectRevision(ctx context.Context, projectID, id uuid.UUID) error {
	tag, err := s.Pool.Exec(ctx,
		`DELETE FROM project_revisions WHERE id=$1 AND project_id=$2`, id, projectID)
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		return ErrNotFound
	}
	return nil
}

// TrimProjectRevisions применяет удержание: не больше keep версий и не больше maxBytes
// на проект. Удаляются САМЫЕ СТАРЫЕ автоснимки; ручные не трогаются, пока их количество
// само не выйдет за keep (иначе «я же нажал сохранить» терялось бы молча).
func (s *Store) TrimProjectRevisions(
	ctx context.Context, projectID uuid.UUID, keep int, maxBytes int64,
) error {
	if keep > 0 {
		// Оставляем keep самых новых, остальные — удаляем. Ручные версии в этот счёт
		// входят наравне: без этого «нажал сохранить» копилось бы без предела.
		if _, err := s.Pool.Exec(ctx,
			`DELETE FROM project_revisions
			  WHERE project_id=$1 AND id NOT IN (
			    SELECT id FROM project_revisions
			     WHERE project_id=$1 ORDER BY created_at DESC LIMIT $2)`,
			projectID, keep); err != nil {
			return err
		}
	}
	if maxBytes > 0 {
		// Дальше — по объёму: пока сумма больше предела, убираем самый старый автоснимок.
		// Цикл, а не один DELETE: размеры разные, и «удалить N штук» не гарантирует предел.
		for {
			var total int64
			if err := s.Pool.QueryRow(ctx,
				`SELECT coalesce(sum(octet_length(yjs_state)), 0) FROM project_revisions
				  WHERE project_id=$1`, projectID).Scan(&total); err != nil {
				return err
			}
			if total <= maxBytes {
				return nil
			}
			tag, err := s.Pool.Exec(ctx,
				`DELETE FROM project_revisions WHERE id = (
				   SELECT id FROM project_revisions
				    WHERE project_id=$1 ORDER BY created_at ASC LIMIT 1)`, projectID)
			if err != nil {
				return err
			}
			if tag.RowsAffected() == 0 {
				// Кроме одной версии удалять нечего: предел недостижим, но и зацикливаться
				// на этом нельзя — оставляем последнюю версию и выходим.
				return nil
			}
		}
	}
	return nil
}
