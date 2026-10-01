package platform

import (
	"os"
	"testing"
)

// clearEnv убирает переменную на время теста и возвращает её обратно после.
//
// Без этого тест умолчаний зависел бы от окружения: в CI прогон выставляет
// LISTEN=:8181, и «умолчание» оказывалось чужим значением (это и поймал CI, когда
// workflow наконец стал запускаться). Пустая строка не подходит: envconfig берёт
// default только когда переменной нет вовсе.
func clearEnv(t *testing.T, key string) {
	t.Helper()
	old, had := os.LookupEnv(key)
	if err := os.Unsetenv(key); err != nil {
		t.Fatalf("unset %s: %v", key, err)
	}
	t.Cleanup(func() {
		if had {
			_ = os.Setenv(key, old)
			return
		}
		_ = os.Unsetenv(key)
	})
}

func TestLoadConfig_Required(t *testing.T) {
	// DBURL и JWTSecret required — без них должна быть ошибка
	clearEnv(t, "DATABASE_URL")
	clearEnv(t, "JWT_SECRET")
	_, err := LoadConfig()
	if err == nil {
		t.Fatal("expected error when DATABASE_URL/JWT_SECRET missing")
	}
}

func TestLoadConfig_Defaults(t *testing.T) {
	clearEnv(t, "LISTEN")
	clearEnv(t, "S3_BUCKET")
	t.Setenv("DATABASE_URL", "postgres://x")
	t.Setenv("JWT_SECRET", "secret")

	c, err := LoadConfig()
	if err != nil {
		t.Fatalf("unexpected err: %v", err)
	}
	if c.Listen != ":8080" {
		t.Errorf("Listen default wrong: %q", c.Listen)
	}
	if c.S3Bucket != "skyfraze-assets" {
		t.Errorf("S3Bucket default wrong: %q", c.S3Bucket)
	}
}

func TestLoadConfig_Override(t *testing.T) {
	t.Setenv("DATABASE_URL", "postgres://x")
	t.Setenv("JWT_SECRET", "secret")
	t.Setenv("LISTEN", ":9090")

	c, err := LoadConfig()
	if err != nil {
		t.Fatalf("unexpected err: %v", err)
	}
	if c.Listen != ":9090" {
		t.Errorf("Listen override failed: %q", c.Listen)
	}
}
