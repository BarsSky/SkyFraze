package platform

import (
	"os"
	"testing"
)

func TestLoadConfig_Required(t *testing.T) {
	// DBURL и JWTSecret required — без них должна быть ошибка
	os.Unsetenv("DATABASE_URL")
	os.Unsetenv("JWT_SECRET")
	_, err := LoadConfig()
	if err == nil {
		t.Fatal("expected error when DATABASE_URL/JWT_SECRET missing")
	}
}

func TestLoadConfig_Defaults(t *testing.T) {
	os.Setenv("DATABASE_URL", "postgres://x")
	os.Setenv("JWT_SECRET", "secret")
	defer os.Unsetenv("DATABASE_URL")
	defer os.Unsetenv("JWT_SECRET")

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
	os.Setenv("DATABASE_URL", "postgres://x")
	os.Setenv("JWT_SECRET", "secret")
	os.Setenv("LISTEN", ":9090")
	defer os.Unsetenv("DATABASE_URL")
	defer os.Unsetenv("JWT_SECRET")
	defer os.Unsetenv("LISTEN")

	c, err := LoadConfig()
	if err != nil {
		t.Fatalf("unexpected err: %v", err)
	}
	if c.Listen != ":9090" {
		t.Errorf("Listen override failed: %q", c.Listen)
	}
}
