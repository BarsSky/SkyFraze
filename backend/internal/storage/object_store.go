// Package storage — ObjectStore abstraction.
// MVP: локальная файловая система (см. LocalStore).
// Phase 2: MinIO/S3 через интерфейс ObjectStore (контракт сохраняется).
package storage

import (
	"context"
	"io"
	"time"
)

type ObjectInfo struct {
	Key         string
	Size        int64
	ContentType string
	// ModTime — когда объект появился в хранилище. Нужен уборке: файл мог быть
	// записан только что, а строка `assets` появится следующим шагом (импорт
	// записывает файлы пачкой), поэтому «файл без строки» и «свежий файл» — не
	// одно и то же.
	ModTime time.Time
}

// ObjectStore — единый интерфейс для хранилищ.
type ObjectStore interface {
	Put(ctx context.Context, key, contentType string, r io.Reader, size int64) error
	Get(ctx context.Context, key string) (io.ReadCloser, error)
	Delete(ctx context.Context, key string) error
	Stat(ctx context.Context, key string) (*ObjectInfo, error)
	// List возвращает объекты с указанным префиксом ключа (пустой префикс — все).
	// Нужен уборке осиротевших файлов: список того, что реально лежит в хранилище,
	// иначе не с чем сравнивать строки `assets`.
	List(ctx context.Context, prefix string) ([]ObjectInfo, error)
}
