package storage

import (
	"context"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
)

// ErrNotFound — ключ не найден.
var ErrNotFound = errors.New("storage: key not found")

// LocalStore — файловая система. Для MVP.
// Phase 2: реализация S3Store / MinioStore с тем же контрактом.
type LocalStore struct {
	BaseDir string
}

func NewLocal(baseDir string) (*LocalStore, error) {
	if err := os.MkdirAll(baseDir, 0o755); err != nil {
		return nil, fmt.Errorf("mkdir: %w", err)
	}
	return &LocalStore{BaseDir: baseDir}, nil
}

// safeKey — запрещаем path traversal.
func safeKey(k string) error {
	if k == "" || strings.Contains(k, "..") || strings.HasPrefix(k, "/") {
		return fmt.Errorf("invalid key: %q", k)
	}
	return nil
}

func (l *LocalStore) path(k string) (string, error) {
	if err := safeKey(k); err != nil {
		return "", err
	}
	return filepath.Join(l.BaseDir, filepath.FromSlash(k)), nil
}

func (l *LocalStore) Put(ctx context.Context, key, contentType string, r io.Reader, size int64) error {
	p, err := l.path(key)
	if err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
		return err
	}
	f, err := os.Create(p)
	if err != nil {
		return err
	}
	defer f.Close()
	if _, err := io.Copy(f, r); err != nil {
		_ = os.Remove(p)
		return err
	}
	return nil
}

func (l *LocalStore) Get(ctx context.Context, key string) (io.ReadCloser, error) {
	p, err := l.path(key)
	if err != nil {
		return nil, err
	}
	f, err := os.Open(p)
	if err != nil {
		if os.IsNotExist(err) {
			return nil, ErrNotFound
		}
		return nil, err
	}
	return f, nil
}

func (l *LocalStore) Delete(ctx context.Context, key string) error {
	p, err := l.path(key)
	if err != nil {
		return err
	}
	if err := os.Remove(p); err != nil {
		if os.IsNotExist(err) {
			return nil
		}
		return err
	}
	return nil
}

func (l *LocalStore) Stat(ctx context.Context, key string) (*ObjectInfo, error) {
	p, err := l.path(key)
	if err != nil {
		return nil, err
	}
	fi, err := os.Stat(p)
	if err != nil {
		if os.IsNotExist(err) {
			return nil, ErrNotFound
		}
		return nil, err
	}
	return &ObjectInfo{Key: key, Size: fi.Size()}, nil
}
