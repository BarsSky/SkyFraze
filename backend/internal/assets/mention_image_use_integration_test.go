package assets_test

// mention_image_use_integration_test.go — файл, ставший картинкой упоминания, не удаляется молча
// (0.93.1).
//
// Картинка упоминания — такая же ссылка, как привязка к кадру: удалить файл из-под неё значит
// оставить карточку в «Связях» с пустой рамкой, а человек не поймёт, почему картинка исчезла.
// Поэтому удаление отказывает с объяснением, а после «отвязать» — проходит.

import (
	"context"
	"errors"
	"strings"
	"testing"

	"github.com/google/uuid"

	"github.com/skyfraze/backend/internal/assets"
	"github.com/skyfraze/backend/internal/platform/testimage"
	"github.com/skyfraze/backend/internal/store"
)

func TestAssetUsedAsMentionImageIsProtected(t *testing.T) {
	e := setup(t)
	ctx := context.Background()
	owner := e.user(t, "owner@example.com")
	project, err := e.proj.Create(ctx, owner, "Роман", "")
	if err != nil {
		t.Fatalf("проект: %v", err)
	}

	png := testimage.SmallPNG()
	asset, err := e.assets.Upload(ctx, owner, project.ID, assets.UploadOpts{
		Filename: "портрет.png", ContentType: "image/png", Size: int64(len(png)),
		Reader: strings.NewReader(string(png)),
	})
	if err != nil {
		t.Fatalf("вложение: %v", err)
	}

	// Карточка, кадр и привязка — тем же путём, что у сервиса карточек: проверяем удаление
	// файла, а не создание карточки. Стартовые типы проекта до-создаются явно: без них
	// внешний ключ «вид карточки» не даст вставить строку.
	if err := e.st.EnsureEntityTypes(ctx, project.ID); err != nil {
		t.Fatalf("стартовые типы: %v", err)
	}
	entity, err := e.st.CreateEntity(ctx, store.ProjectEntity{
		ProjectID: project.ID, Kind: "character", Name: "Анна", Aliases: []string{},
	})
	if err != nil {
		t.Fatalf("карточка: %v", err)
	}
	eventID := uuid.New()
	if err := e.st.ReplaceEventTree(ctx, project.ID, owner, []store.Event{
		{ID: eventID, ProjectID: project.ID, Position: 0, Depth: 0, Title: "Глава", Body: "Анна вошла."},
	}); err != nil {
		t.Fatalf("кадр: %v", err)
	}
	if _, err := e.st.SetMentionImage(ctx, project.ID, entity.ID, eventID, asset.ID, owner); err != nil {
		t.Fatalf("привязка картинки: %v", err)
	}

	// Удаление файла отказывает — и говорит, из-за чего.
	err = e.assets.Delete(ctx, owner, asset.ID)
	var inUse *assets.InUseError
	if !errors.As(err, &inUse) {
		t.Fatalf("ожидался отказ «файл прикреплён», получено: %v", err)
	}
	if inUse.MentionImages != 1 {
		t.Fatalf("упоминаний в отказе %d, ожидалось 1", inUse.MentionImages)
	}
	if !strings.Contains(inUse.Error(), "упоминанию карточки") {
		t.Fatalf("текст отказа непонятен: %q", inUse.Error())
	}
	if _, err := e.st.GetAsset(ctx, asset.ID); err != nil {
		t.Fatalf("строка удалена, хотя файл — картинка упоминания: %v", err)
	}
	if files := e.files(t); len(files) != 1 {
		t.Fatalf("файл удалён, хотя он — картинка упоминания: %v", files)
	}

	// Отвязали — файл удаляется.
	if _, err := e.st.DeleteMentionImage(ctx, project.ID, entity.ID, eventID); err != nil {
		t.Fatalf("отвязка: %v", err)
	}
	if err := e.assets.Delete(ctx, owner, asset.ID); err != nil {
		t.Fatalf("после отвязки файл не удалился: %v", err)
	}
	if files := e.files(t); len(files) != 0 {
		t.Fatalf("файл остался в хранилище: %v", files)
	}
}
