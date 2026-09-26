package platform

import (
	"fmt"

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
}

// LoadConfig — читает env через envconfig.
func LoadConfig() (*Config, error) {
	var c Config
	if err := envconfig.Process("", &c); err != nil {
		return nil, fmt.Errorf("load config: %w", err)
	}
	return &c, nil
}
