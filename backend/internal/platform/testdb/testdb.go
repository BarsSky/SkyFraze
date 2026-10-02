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
	"slices"
	"strings"
	"testing"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/skyfraze/backend/internal/ai"
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

// schemaSteps — проба «миграция уже применена?» и файл. Применяем только те
// файлы, чей объект ещё не создан: часть миграций не идемпотентна (0002 дропает
// legacy-колонку).
//
// Проба — не всегда таблица: 0006 добавляет только колонки, поэтому проверяем
// ровно тот объект, который создаёт миграция. Иначе существующая тестовая база
// (например, skyfraze_coauthors, созданная до 0006) осталась бы без bio/crafts,
// и упал бы уже не тест, а запрос.
var schemaSteps = []struct{ probe, file string }{
	{`SELECT EXISTS (SELECT 1 FROM information_schema.tables
	                  WHERE table_schema='public' AND table_name='users')`,
		"0001_init.up.sql"},
	{`SELECT EXISTS (SELECT 1 FROM information_schema.tables
	                  WHERE table_schema='public' AND table_name='project_event_state')`,
		"0002_events_hierarchy.up.sql"},
	{`SELECT EXISTS (SELECT 1 FROM information_schema.tables
	                  WHERE table_schema='public' AND table_name='project_ratings')`,
		"0003_public_feed.up.sql"},
	{`SELECT EXISTS (SELECT 1 FROM information_schema.tables
	                  WHERE table_schema='public' AND table_name='registration_requests')`,
		"0004_admin_registration.up.sql"},
	{`SELECT EXISTS (SELECT 1 FROM information_schema.tables
	                  WHERE table_schema='public' AND table_name='coauthor_links')`,
		"0005_coauthors.up.sql"},
	{`SELECT EXISTS (SELECT 1 FROM information_schema.columns
	                  WHERE table_schema='public' AND table_name='users'
	                    AND column_name='discoverable')`,
		"0006_people.up.sql"},
	{`SELECT EXISTS (SELECT 1 FROM information_schema.columns
	                  WHERE table_schema='public' AND table_name='assets'
	                    AND column_name='content_hash')`,
		"0007_asset_dedup.up.sql"},
	{`SELECT EXISTS (SELECT 1 FROM information_schema.tables
	                  WHERE table_schema='public' AND table_name='ai_user_keys')`,
		"0008_ai_assistant.up.sql"},
	{`SELECT EXISTS (SELECT 1 FROM information_schema.tables
	                  WHERE table_schema='public' AND table_name='ai_consents')`,
		"0009_ai_consents.up.sql"},
	{`SELECT EXISTS (SELECT 1 FROM information_schema.tables
	                  WHERE table_schema='public' AND table_name='project_ai_settings')`,
		"0010_ai_agent.up.sql"},
	{`SELECT EXISTS (SELECT 1 FROM information_schema.columns
	                  WHERE table_schema='public' AND table_name='users'
	                    AND column_name='is_system')`,
		"0011_users_is_system.up.sql"},
	{`SELECT EXISTS (SELECT 1 FROM information_schema.columns
	                  WHERE table_schema='public' AND table_name='ai_messages'
	                    AND column_name='stopped')`,
		"0012_ai_messages_stopped.up.sql"},
}

// Setup открывает отдельную БД для пакета (suffix), применяет миграции и
// возвращает пул. Если сервер недоступен — тест переходит в skip (локально) или
// падает (в CI): пропуск в CI означал бы «зелёный» прогон, в котором не проверили
// ничего.
func Setup(t *testing.T, suffix string) *pgxpool.Pool {
	t.Helper()
	ctx := context.Background()
	base := URL()
	target := dedicatedURL(base, "_"+suffix)
	ensureDatabase(t, base, target)

	pool, err := platform.NewDBPool(ctx, target)
	if err != nil {
		if os.Getenv("CI") != "" {
			t.Fatalf("test DB unavailable in CI: %v", err)
		}
		t.Skipf("test DB unavailable: %v", err)
	}
	t.Cleanup(pool.Close)
	applySchema(t, ctx, pool)
	return pool
}

// Truncate очищает перечисленные таблицы (RESTART IDENTITY — на них завязаны
// проверки порядка и счётчиков).
//
// Если среди таблиц есть users, системный аккаунт агента возвращается на место.
// В бою его заводит миграция 0010, и он есть ВСЕГДА; база, где его нет, отличается
// от боевой ровно в том месте, где ломается подсчёт людей. На этом уже проехали:
// bootstrap-тест на такой базе был зелёным и не заметил, что миграция 0010 закрыла
// регистрацию первого администратора (`COUNT(*) FROM users` считал агента человеком).
func Truncate(t *testing.T, pool *pgxpool.Pool, tables ...string) {
	t.Helper()
	if _, err := pool.Exec(context.Background(),
		`TRUNCATE `+strings.Join(tables, ", ")+` RESTART IDENTITY CASCADE`); err != nil {
		t.Fatalf("truncate: %v", err)
	}
	if slices.Contains(tables, "users") {
		EnsureAIAgent(t, pool)
	}
}

// EnsureAIAgent возвращает на место системного пользователя ИИ-агента.
//
// В бою его создаёт миграция 0010, и он оттуда никуда не девается. В тестах таблицу
// users чистят целиком, а на агента ссылаются created_by/updated_by событий и участие
// в проекте: без строки вставка кадра падала бы на внешнем ключе — и падало бы не
// утверждение теста, а то, что он проверяет. Truncate вызывает эту функцию сам, когда
// среди таблиц есть users; сюда стоит ходить только если users чистят как-то иначе.
func EnsureAIAgent(t *testing.T, pool *pgxpool.Pool) {
	t.Helper()
	_, err := pool.Exec(context.Background(),
		`INSERT INTO users (id, email, username, password_hash, display_name, discoverable, is_system)
		 VALUES ($1, $2, $3, '!', $4, false, true)
		 ON CONFLICT (id) DO NOTHING`,
		ai.AgentUserID, ai.AgentEmail, ai.AgentUsername, ai.AgentName)
	if err != nil {
		t.Fatalf("ensure ai agent: %v", err)
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

// maintenanceURL — та же база, но служебная `postgres`: к ней можно подключиться,
// даже когда базы из TEST_DATABASE_URL ещё нет.
func maintenanceURL(base string) string {
	u, err := url.Parse(base)
	if err != nil {
		return base
	}
	u.Path = "/postgres"
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
		// Базовой базы может не быть — её удаляют, когда хотят прогнать сюиту
		// «с нуля». Создаём целевые базы через служебную `postgres`: молчаливый
		// выход здесь выглядел бы позже как «test DB unavailable», то есть как
		// недоступный сервер, хотя сервер доступен, а базы просто нет.
		pool, err = platform.NewDBPool(ctx, maintenanceURL(adminURL))
		if err != nil {
			return // целевая база может уже существовать и быть доступной напрямую
		}
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
		if err := pool.QueryRow(ctx, step.probe).Scan(&exists); err != nil {
			t.Fatalf("schema probe %s: %v", step.file, err)
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
