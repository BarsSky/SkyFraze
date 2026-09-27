// Package testdb — подготовка тестовой базы для интеграционных тестов.
//
// Зачем отдельный пакет: `go test ./...` запускает пакеты параллельно, и если все
// интеграционные тесты ходят в одну базу, TRUNCATE одного пакета обнуляет данные
// другого прямо посреди проверки (на этом уже ломались тесты ленты: публикация
// «падала» с forbidden, потому что проект исчезал из-под ног).
//
// Поэтому каждый пакет получает СВОЮ базу <TEST_DATABASE_URL>_<suffix>, создаёт её
// при необходимости и сам доводит схему до актуальной.
package testdb

import (
	"context"
	"net/url"
	"os"
	"strings"
	"testing"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/skyfraze/backend/internal/platform"
	"github.com/skyfraze/backend/migrations"
)

// URL — базовая тестовая БД (переопределяется TEST_DATABASE_URL).
func URL() string {
	if u := os.Getenv("TEST_DATABASE_URL"); u != "" {
		return u
	}
	return "postgres://skyfraze:skyfraze_dev@localhost:5432/skyfraze_test?sslmode=disable"
}

// schemaSteps — маркерная таблица каждой миграции. Применяем только те файлы,
// чьей таблицы ещё нет: часть миграций не идемпотентна (0002 дропает legacy-колонку).
var schemaSteps = []struct{ table, file string }{
	{"users", "0001_init.up.sql"},
	{"project_event_state", "0002_events_hierarchy.up.sql"},
	{"project_ratings", "0003_public_feed.up.sql"},
	{"registration_requests", "0004_admin_registration.up.sql"},
}

// Setup открывает отдельную БД для пакета (suffix), применяет миграции и
// возвращает пул. Если сервер недоступен — тест переходит в skip.
func Setup(t *testing.T, suffix string) *pgxpool.Pool {
	t.Helper()
	ctx := context.Background()
	base := URL()
	target := dedicatedURL(base, "_"+suffix)
	ensureDatabase(t, base, target)

	pool, err := platform.NewDBPool(ctx, target)
	if err != nil {
		t.Skipf("test DB unavailable: %v", err)
	}
	t.Cleanup(pool.Close)
	applySchema(t, ctx, pool)
	return pool
}

// Truncate очищает перечисленные таблицы (RESTART IDENTITY — на них завязаны
// проверки порядка и счётчиков).
func Truncate(t *testing.T, pool *pgxpool.Pool, tables ...string) {
	t.Helper()
	if _, err := pool.Exec(context.Background(),
		`TRUNCATE `+strings.Join(tables, ", ")+` RESTART IDENTITY CASCADE`); err != nil {
		t.Fatalf("truncate: %v", err)
	}
}

func dedicatedURL(base, suffix string) string {
	u, err := url.Parse(base)
	if err != nil || u.Path == "" || strings.HasSuffix(u.Path, suffix) {
		return base
	}
	u.Path = u.Path + suffix
	return u.String()
}

func ensureDatabase(t *testing.T, adminURL, targetURL string) {
	t.Helper()
	target, err := url.Parse(targetURL)
	if err != nil {
		return
	}
	name := strings.TrimPrefix(target.Path, "/")
	if name == "" {
		return
	}
	ctx := context.Background()
	pool, err := platform.NewDBPool(ctx, adminURL)
	if err != nil {
		return // целевая база может уже существовать и быть доступной напрямую
	}
	defer pool.Close()

	var exists bool
	if err := pool.QueryRow(ctx,
		`SELECT EXISTS (SELECT 1 FROM pg_database WHERE datname=$1)`, name).Scan(&exists); err != nil || exists {
		return
	}
	_, _ = pool.Exec(ctx, `CREATE DATABASE "`+name+`"`)
}

func applySchema(t *testing.T, ctx context.Context, pool *pgxpool.Pool) {
	t.Helper()
	for _, step := range schemaSteps {
		var exists bool
		if err := pool.QueryRow(ctx,
			`SELECT EXISTS (SELECT 1 FROM information_schema.tables
			                 WHERE table_schema='public' AND table_name=$1)`, step.table).Scan(&exists); err != nil {
			t.Fatalf("schema probe %s: %v", step.table, err)
		}
		if exists {
			continue
		}
		sql, err := migrations.FS.ReadFile(step.file)
		if err != nil {
			t.Fatalf("read migration %s: %v", step.file, err)
		}
		if _, err := pool.Exec(ctx, string(sql)); err != nil {
			t.Fatalf("apply migration %s: %v", step.file, err)
		}
	}
}
