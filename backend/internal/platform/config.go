package platform

import (
	"fmt"
	"strings"

	"github.com/kelseyhightower/envconfig"
)

// Config — runtime configuration loaded from environment variables.
// 12-factor: every field has an env binding.
type Config struct {
	Listen     string `envconfig:"LISTEN" default:":8080"`
	DBURL      string `envconfig:"DATABASE_URL" required:"true"`
	JWTSecret  string `envconfig:"JWT_SECRET" required:"true"`
	StorageDir string `envconfig:"STORAGE_DIR" default:"./storage"`

	// Object store (filesystem in MVP; MinIO/S3 в Phase 2)
	S3Endpoint string `envconfig:"S3_ENDPOINT" default:""`
	S3Bucket   string `envconfig:"S3_BUCKET" default:"skyfraze-assets"`
	S3Key      string `envconfig:"S3_KEY" default:""`
	S3Secret   string `envconfig:"S3_SECRET" default:""`
	S3UseSSL   bool   `envconfig:"S3_USE_SSL" default:"false"`

	// Frontend CORS
	CORSOrigins string `envconfig:"CORS_ORIGINS" default:"http://localhost:5173"`

	// Администрирование развёртывания.
	//
	// AdminEmails — список администраторов через запятую. Права выдаются и уже
	// зарегистрированным, и тем, кто зарегистрируется позже. Если список пуст,
	// администратором становится первый зарегистрированный пользователь: иначе
	// инсталляция осталась бы без способа управлять регистрацией.
	AdminEmails string `envconfig:"ADMIN_EMAILS" default:""`

	// RegistrationMode — начальный режим регистрации, если в БД его ещё нет:
	// 'request' (по заявке, по умолчанию) | 'open' (любой может регистрироваться).
	// Значение из БД приоритетнее: после первого старта режим меняется в админке.
	RegistrationMode string `envconfig:"REGISTRATION_MODE" default:"request"`

	// Механизм обновления (см. internal/update и deploy/skyfraze-update.sh).
	//
	// UpdateRepo — 'owner/name' репозитория на GitHub, откуда берутся релизы.
	// Пусто → страница обновления честно скажет, что источник не настроен.
	UpdateRepo string `envconfig:"UPDATE_REPO" default:""`
	// UpdateToken — токен для приватного репозитория или поднятия лимита API.
	UpdateToken string `envconfig:"UPDATE_TOKEN" default:""`
	// UpdateChannel — 'stable' (по умолчанию, предрелизы игнорируются) | 'any'.
	UpdateChannel string `envconfig:"UPDATE_CHANNEL" default:"stable"`
	// UpdateStateDir — каталог, общий с хостом: сюда админка пишет заявку
	// (request.json), а хост-скрипт — состояние (status.json) и лог (update.log).
	UpdateStateDir string `envconfig:"UPDATE_STATE_DIR" default:""`
}

// AdminEmailList — ADMIN_EMAILS как список (нормализованный, без пустых).
func (c *Config) AdminEmailList() []string {
	out := []string{}
	for _, part := range strings.Split(c.AdminEmails, ",") {
		part = strings.ToLower(strings.TrimSpace(part))
		if part != "" {
			out = append(out, part)
		}
	}
	return out
}

// LoadConfig — читает env через envconfig.
func LoadConfig() (*Config, error) {
	var c Config
	if err := envconfig.Process("", &c); err != nil {
		return nil, fmt.Errorf("load config: %w", err)
	}
	return &c, nil
}
