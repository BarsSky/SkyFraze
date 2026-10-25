// Package storage — ObjectStore abstraction.
//
// Две реализации за одним контрактом: LocalStore (файловая система, по умолчанию) и
// S3Store (S3/MinIO, включается STORAGE_DRIVER=s3). Сервисы о том, где лежат байты, не
// знают — именно поэтому переезд на S3 (0.49.0) не потребовал менять их код.
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
	// иначе не с чем сравнивать строки `assets`. Для больших хранилищ предпочтителен
	// Walk: List собирает всё в памяти.
	List(ctx context.Context, prefix string) ([]ObjectInfo, error)
	// Walk обходит хранилище и отдаёт объекты по одному, не собирая список.
	//
	// Зачем. Файлов в хранилище бывает НАМНОГО больше, чем строк в базе: осиротевшие
	// копятся месяцами (карантин, сбои), а строки удаляются сразу. Держать «все ключи
	// хранилища» в памяти ради сверки — лишние мегабайты на каждом проходе уборки.
	// Ошибка из fn останавливает обход и возвращается вызывающему.
	Walk(ctx context.Context, prefix string, fn func(ObjectInfo) error) error
}
