package store

// store_project_trash.go — корзина проектов (миграция 0022).
//
// Правило одно и оно важное: ВСЕ чтения проекта по умолчанию видят только активные проекты.
// Удалённый проект возвращается лишь методами, которые явно про корзину (DeletedProjects,
// GetProjectAny, DeletedProject). Фильтр стоит в GetProject и GetMembership — это те две
// точки, через которые проходят и владелец, и команда, поэтому забыть фильтр в отдельном
// обработчике нельзя.

import (
	"context"
	"errors"
	"time"

	"github.com/google/uuid"
)

// SoftDeleteProject отправляет проект в корзину.
//
// Ничего не удаляется: события, вложения и история версий остаются на месте, чтобы возврат был
// мгновенным и полным. Повторное удаление уже удалённого — не ошибка (человек мог нажать
// дважды), но время первого удаления не перезаписывается: срок хранения в корзине считается
// от него.
func (s *Store) SoftDeleteProject(ctx context.Context, id uuid.UUID) error {
	_, err := s.Pool.Exec(ctx,
		`UPDATE projects SET deleted_at = COALESCE(deleted_at, now()) WHERE id = $1`, id)
	return err
}

// RestoreProject возвращает проект из корзины.
func (s *Store) RestoreProject(ctx context.Context, id uuid.UUID) error {
	tag, err := s.Pool.Exec(ctx,
		`UPDATE projects SET deleted_at = NULL WHERE id = $1 AND deleted_at IS NOT NULL`, id)
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		return ErrNotFound
	}
	return nil
}

// DeletedProjects — корзина человека: его собственные удалённые проекты.
//
// Только свои: корзина — личное хозяйство владельца. Проект, удалённый владельцем, не должен
// всплывать у соавтора в списке «что можно вернуть».
func (s *Store) DeletedProjects(ctx context.Context, ownerID uuid.UUID) ([]Project, error) {
	return qAll[Project](ctx, s.Pool,
		`SELECT `+projectColumns+`, deleted_at
		   FROM projects
		  WHERE owner_id = $1 AND deleted_at IS NOT NULL
		  ORDER BY deleted_at DESC`, ownerID)
}

// DeletedProject — проект из корзины по идентификатору (с отметкой удаления).
func (s *Store) DeletedProject(ctx context.Context, id uuid.UUID) (*Project, error) {
	p, err := qOne[Project](ctx, s.Pool,
		`SELECT `+projectColumns+`, deleted_at FROM projects WHERE id = $1 AND deleted_at IS NOT NULL`, id)
	if err != nil {
		if errors.Is(err, ErrNotFound) {
			return nil, ErrNotFound
		}
		return nil, err
	}
	return p, nil
}

// PurgeProject — удалить проект из корзины окончательно (жёстко, с каскадом).
//
// Возвращает ключи файлов ДО удаления: строки вложений уходят каскадом, и после этого о
// файлах нечего спросить. Сами объекты удаляет вызывающий (или уборщик хранилища — он
// подберёт их, когда не останется ссылок).
func (s *Store) PurgeProject(ctx context.Context, id uuid.UUID) ([]string, error) {
	rows, err := s.Pool.Query(ctx,
		`SELECT s3_key FROM assets WHERE project_id = $1`, id)
	if err != nil {
		return nil, err
	}
	var keys []string
	for rows.Next() {
		var key string
		if err := rows.Scan(&key); err != nil {
			rows.Close()
			return nil, err
		}
		keys = append(keys, key)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return nil, err
	}
	if _, err := s.Pool.Exec(ctx, `DELETE FROM projects WHERE id = $1`, id); err != nil {
		return nil, err
	}
	return keys, nil
}

// PurgeExpiredProjects удаляет то, что пролежало в корзине дольше срока, и возвращает ключи
// файлов по каждому проекту: вызывающий освобождает хранилище.
//
// Вызывается уборщиком раз в сутки. «30 дней» — обещание интерфейса, и выполнять его должен
// тот же процесс, что и всё остальное фоновое: отдельный механизм для одной уборки завёл бы
// второе расписание, которое забудут включить на новом стенде.
func (s *Store) PurgeExpiredProjects(ctx context.Context, olderThan time.Duration) (map[uuid.UUID][]string, error) {
	if olderThan < 0 {
		olderThan = 0
	}
	// Интервал передаём секундами и собираем make_interval: строку вида "720h0m0s"
	// Postgres разбирает не так однозначно, как хотелось бы, а ошибка здесь удаляла бы
	// проекты не по тому сроку.
	rows, err := s.Pool.Query(ctx,
		`SELECT id FROM projects
		  WHERE deleted_at IS NOT NULL AND deleted_at < now() - make_interval(secs => $1)`,
		olderThan.Seconds())
	if err != nil {
		return nil, err
	}
	var ids []uuid.UUID
	for rows.Next() {
		var id uuid.UUID
		if err := rows.Scan(&id); err != nil {
			rows.Close()
			return nil, err
		}
		ids = append(ids, id)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return nil, err
	}
	out := make(map[uuid.UUID][]string, len(ids))
	for _, id := range ids {
		keys, err := s.PurgeProject(ctx, id)
		if err != nil {
			return out, err
		}
		out[id] = keys
	}
	return out, nil
}
