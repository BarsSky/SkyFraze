// Package storage — ObjectStore abstraction.
// MVP: локальная файловая система (см. LocalStore).
// Phase 2: MinIO/S3 через интерфейс ObjectStore (контракт сохраняется).
package storage

import (
	"context"
	"io"
)

type ObjectInfo struct {
	Key         string
	Size        int64
	ContentType string
}

// ObjectStore — единый интерфейс для хранилищ.
type ObjectStore interface {
	Put(ctx context.Context, key, contentType string, r io.Reader, size int64) error
	Get(ctx context.Context, key string) (io.ReadCloser, error)
	Delete(ctx context.Context, key string) error
	Stat(ctx context.Context, key string) (*ObjectInfo, error)
}
