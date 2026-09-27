package platform

import (
	"context"
	"errors"
	"fmt"
	"io/fs"
	"sort"
	"strings"

	"github.com/jackc/pgx/v5/pgxpool"
)

// migrationsFS — SQL-файлы схемы (build-time inclusion). Корень FS — директория
// с миграциями, файлы видны как "0001_init.up.sql".
var migrationsFS fs.FS

// SetMigrationsFS — инжектит FS с миграциями (обычно migrations.FS).
// Принимает любой fs.FS, что позволяет тестировать раннер на fstest.MapFS.
func SetMigrationsFS(fsys fs.FS) {
	migrationsFS = fsys
}

const createMigrationsTable = `
CREATE TABLE IF NOT EXISTS schema_migrations (
    version    TEXT PRIMARY KEY,
    applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
)`

// RunMigrations применяет неприменённые *.up.sql в лексическом порядке.
//
// Версионность: каждый файл применяется ровно один раз, факт применения
// фиксируется в schema_migrations (первичный ключ по version). Файл целиком
// выполняется в одной транзакции: упавшая миграция не оставляет
// полуприменённую схему и не помечается применённой.
//
// Идемпотентность: повторный запуск ничего не делает. Существующая БД без
// schema_migrations безопасна, потому что 0001 написан идемпотентно
// (IF NOT EXISTS / OR REPLACE).
func RunMigrations(ctx context.Context, pool *pgxpool.Pool) error {
	if migrationsFS == nil {
		return errors.New("migrations FS not initialized — call platform.SetMigrationsFS first")
	}

	entries, err := listMigrations(migrationsFS)
	if err != nil {
		return err
	}
	if len(entries) == 0 {
		return errors.New("no *.up.sql migrations found in embedded FS")
	}

	if _, err := pool.Exec(ctx, createMigrationsTable); err != nil {
		return fmt.Errorf("create schema_migrations: %w", err)
	}

	applied := map[string]bool{}
	rows, err := pool.Query(ctx, `SELECT version FROM schema_migrations`)
	if err != nil {
		return fmt.Errorf("read schema_migrations: %w", err)
	}
	for rows.Next() {
		var v string
		if err := rows.Scan(&v); err != nil {
			rows.Close()
			return fmt.Errorf("scan schema_migrations: %w", err)
		}
		applied[v] = true
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return fmt.Errorf("iterate schema_migrations: %w", err)
	}

	for _, name := range entries {
		version := strings.TrimSuffix(name, ".up.sql")
		if applied[version] {
			continue
		}
		sqlBytes, err := fs.ReadFile(migrationsFS, name)
		if err != nil {
			return fmt.Errorf("read %s: %w", name, err)
		}
		if err := applyMigration(ctx, pool, version, name, string(sqlBytes)); err != nil {
			return err
		}
	}
	return nil
}

// listMigrations возвращает имена *.up.sql в лексическом порядке (порядок
// применения). Директории и *.down.sql игнорируются.
func listMigrations(fsys fs.FS) ([]string, error) {
	entries, err := fs.ReadDir(fsys, ".")
	if err != nil {
		return nil, fmt.Errorf("read migrations dir: %w", err)
	}
	var ups []string
	for _, e := range entries {
		if e.IsDir() {
			continue
		}
		if name := e.Name(); strings.HasSuffix(name, ".up.sql") {
			ups = append(ups, name)
		}
	}
	sort.Strings(ups)
	return ups, nil
}

// applyMigration выполняет один файл в транзакции и помечает версию применённой.
//
// Многостейтментный SQL поддержан только simple-протоколом, а pgx в
// extended-протоколе его не принимает: поэтому тело выполняется через
// PgConn().Exec (simple query protocol) на соединении той же транзакции.
// Собственных BEGIN/COMMIT в файлах быть не должно — транзакцию открывает раннер.
func applyMigration(ctx context.Context, pool *pgxpool.Pool, version, name, sqlText string) error {
	tx, err := pool.Begin(ctx)
	if err != nil {
		return fmt.Errorf("begin %s: %w", name, err)
	}
	defer func() { _ = tx.Rollback(ctx) }()

	mrr := tx.Conn().PgConn().Exec(ctx, sqlText)
	if _, err := mrr.ReadAll(); err != nil {
		return fmt.Errorf("apply %s: %w", name, err)
	}

	if _, err := tx.Exec(ctx,
		`INSERT INTO schema_migrations (version) VALUES ($1) ON CONFLICT (version) DO NOTHING`,
		version,
	); err != nil {
		return fmt.Errorf("record %s: %w", name, err)
	}

	if err := tx.Commit(ctx); err != nil {
		return fmt.Errorf("commit %s: %w", name, err)
	}
	return nil
}
