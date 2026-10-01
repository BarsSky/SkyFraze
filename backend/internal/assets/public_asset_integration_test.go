package assets_test

// public_asset_integration_test.go — доступ к файлу опубликованного проекта.
//
// Инвариант простой и важный: файл отдаётся анонимно ТОЛЬКО пока проект
// опубликован, и снятие с публикации закрывает его немедленно. Сегодня это
// обеспечивает приложение (`assets.OpenPublic` проверяет `projects.is_public` и
// стримит байты), и тест сторожит именно это свойство: если однажды файлы начнут
// отдавать через presigned-ссылки (см. docs/storage-s3.md), проверка «сняли с
// публикации → ссылка больше не выдаётся» должна остаться, а тест — обновиться
// вместе с решением, а не молча исчезнуть.
//
// Нужна Postgres (TEST_DATABASE_URL), как и остальным интеграционным тестам.

import (
	"bytes"
	"context"
	"errors"
	"testing"

	"github.com/skyfraze/backend/internal/assets"
	"github.com/skyfraze/backend/internal/feed"
	"github.com/skyfraze/backend/internal/store"
)

func TestPublicAssetFollowsPublication(t *testing.T) {
	e := setup(t)
	ctx := context.Background()
	owner := e.user(t, "owner@example.com")
	project, err := e.proj.Create(ctx, owner, "Публикуемый проект", "описание")
	if err != nil {
		t.Fatalf("проект: %v", err)
	}
	content := []byte("PNG-содержимое файла истории")
	asset, err := e.assets.Upload(ctx, owner, project.ID, assets.UploadOpts{
		Filename: "обложка.png", ContentType: "image/png", Size: int64(len(content)),
		Reader: bytes.NewReader(content),
	})
	if err != nil {
		t.Fatalf("вложение: %v", err)
	}
	feedSvc := feed.New(e.st, e.proj)

	// Пока проект закрыт, файл не отдаётся даже по прямому id — ровно так же, как
	// несуществующий (анонимный посетитель не должен отличать одно от другого).
	if _, _, err := e.assets.OpenPublic(ctx, asset.ID); !errors.Is(err, store.ErrNotFound) {
		t.Fatalf("закрытый проект: ожидался ErrNotFound, получено %v", err)
	}

	if _, err := feedSvc.SetPublication(ctx, owner, project.ID, true); err != nil {
		t.Fatalf("публикация: %v", err)
	}
	rc, served, err := e.assets.OpenPublic(ctx, asset.ID)
	if err != nil {
		t.Fatalf("опубликованный проект: %v", err)
	}
	defer rc.Close()
	if served.ID != asset.ID {
		t.Errorf("отдан не тот файл: %s", served.ID)
	}

	// Снятие с публикации закрывает файл немедленно — это и есть свойство, которое
	// сломали бы presigned-ссылки с длинным сроком жизни.
	if _, err := feedSvc.SetPublication(ctx, owner, project.ID, false); err != nil {
		t.Fatalf("снятие с публикации: %v", err)
	}
	if _, _, err := e.assets.OpenPublic(ctx, asset.ID); !errors.Is(err, store.ErrNotFound) {
		t.Errorf("после снятия с публикации файл всё ещё отдаётся: %v", err)
	}
}
