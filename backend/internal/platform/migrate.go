package platform

import (
	"context"
	"embed"
	"errors"
	"fmt"
	"io/fs"
	"sort"
	"strings"

	"github.com/jackc/pgx/v5/pgxpool"
)

// migrationsFS — embedded SQL-файлы (build-time inclusion).
// Каждый файл вида NNNN_name.up.sql применяется в лексическом порядке.
var migrationsFS embed.FS

// SetMigrationsFS — инжектит embed.FS из вызывающего пакета (cmd/server).
// Это позволяет хранить миграции в директории migrations/ рядом с main.go.
func SetMigrationsFS(fsys fs.FS) {
	if f, ok := fsys.(embed.FS); ok {
		migrationsFS = f
	}
}

// RunMigrations — применяет все .up.sql в отсортированном порядке.
// Idempotent: повторный запуск безопасен (CREATE без IF NOT EXISTS не сработает
// на повторе, поэтому вызывающий код должен либо дропать схему, либо
// использовать миграции в духе "create if not exists").
func RunMigrations(ctx context.Context, pool *pgxpool.Pool) error {
	if migrationsFS == (embed.FS{}) {
		return errors.New("migrations FS not initialized — call platform.SetMigrationsFS first")
	}

	entries, err := fs.ReadDir(migrationsFS, ".")
	if err != nil {
		return fmt.Errorf("read migrations dir: %w", err)
	}

	var ups []string
	for _, e := range entries {
		name := e.Name()
		if strings.HasSuffix(name, ".up.sql") {
			ups = append(ups, name)
		}
	}
	sort.Strings(ups)

	for _, name := range ups {
		sqlBytes, err := fs.ReadFile(migrationsFS, name)
		if err != nil {
			return fmt.Errorf("read %s: %w", name, err)
		}
		if _, err := pool.Exec(ctx, string(sqlBytes)); err != nil {
			return fmt.Errorf("apply %s: %w", name, err)
		}
	}
	return nil
}
