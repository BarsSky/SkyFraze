package entities_test

// mention_images_integration_test.go — картинка у упоминания карточки в кадре (0.93.0).
//
// Фича: в карточке упоминания привязывается вложение проекта — «как это выглядит». Проверяем то,
// что молча ломается: пара «карточка × кадр» одна (замена, а не вторая строка), чужие проекты и
// не-картинки отклоняются, читатель смотрит, но не меняет, удаление файла не оставляет висячую
// ссылку.

import (
	"context"
	"errors"
	"strings"
	"testing"

	"github.com/google/uuid"

	"github.com/skyfraze/backend/internal/entities"
	"github.com/skyfraze/backend/internal/projects"
	"github.com/skyfraze/backend/internal/store"
)

// mentionImageFixture — карточка, кадр и файлы в проекте и в «другом» проекте.
type mentionImageFixture struct {
	entity   uuid.UUID
	event    uuid.UUID
	image    uuid.UUID
	second   uuid.UUID
	document uuid.UUID
	foreign  uuid.UUID
}

func mentionImageSetup(t *testing.T, e *entityEnv) mentionImageFixture {
	t.Helper()
	// `assets.kind` — закрытый набор из миграции 0001; «image» у картинок, «pdf» у документа.
	kindOf := func(mime string) string {
		if strings.HasPrefix(mime, "image/") {
			return "image"
		}
		return "pdf"
	}
	ctx := context.Background()
	card, err := e.svc.Create(ctx, e.owner, e.project, entities.Input{Kind: "character", Name: "Анна"})
	if err != nil {
		t.Fatalf("карточка: %v", err)
	}
	eventID := uuid.New()
	if err := e.st.ReplaceEventTree(ctx, e.project, e.owner, []store.Event{
		{ID: eventID, ProjectID: e.project, Position: 0, Depth: 0, Title: "Глава", Body: "Анна вошла."},
	}); err != nil {
		t.Fatalf("кадр: %v", err)
	}

	addAsset := func(projectID, owner uuid.UUID, filename, mime string) uuid.UUID {
		asset := &store.Asset{
			ProjectID: projectID, OwnerID: owner, Filename: filename, Mime: mime,
			Size: 12, S3Key: "test/" + uuid.NewString(), Kind: kindOf(mime),
		}
		if err := e.st.CreateAsset(ctx, asset); err != nil {
			t.Fatalf("вложение «%s»: %v", filename, err)
		}
		return asset.ID
	}
	return mentionImageFixture{
		entity:   card.ID,
		event:    eventID,
		image:    addAsset(e.project, e.owner, "портрет.png", "image/png"),
		second:   addAsset(e.project, e.owner, "портрет-2.png", "image/png"),
		document: addAsset(e.project, e.owner, "письмо.pdf", "application/pdf"),
		foreign:  addAsset(e.other, e.owner, "чужое.png", "image/png"),
	}
}

func TestMentionImageSetReplaceAndClear(t *testing.T) {
	e := setupEntities(t)
	ctx := context.Background()
	prepare := func() (mentionImageFixture, *entities.Service) { return mentionImageSetup(t, e), e.svc }
	f, _ := prepare()

	image, err := e.svc.SetMentionImage(ctx, e.owner, e.project, f.entity, f.event, f.image)
	if err != nil {
		t.Fatalf("привязка: %v", err)
	}
	if image.EntityID != f.entity || image.EventID != f.event || image.AssetID != f.image {
		t.Fatalf("привязалось не то: %+v", image)
	}
	list, err := e.svc.MentionImages(ctx, e.viewer, e.project)
	if err != nil {
		t.Fatalf("список: %v", err)
	}
	if len(list) != 1 || list[0].AssetID != f.image {
		t.Fatalf("список привязок: %+v", list)
	}

	// Замена: одна картинка на пару, вторая строка не появляется.
	if _, err := e.svc.SetMentionImage(ctx, e.owner, e.project, f.entity, f.event, f.second); err != nil {
		t.Fatalf("замена: %v", err)
	}
	list, err = e.svc.MentionImages(ctx, e.viewer, e.project)
	if err != nil {
		t.Fatalf("список после замены: %v", err)
	}
	if len(list) != 1 || list[0].AssetID != f.second {
		t.Fatalf("после замены: %+v", list)
	}

	removed, err := e.svc.ClearMentionImage(ctx, e.owner, e.project, f.entity, f.event)
	if err != nil || !removed {
		t.Fatalf("отвязка: %v, %v", removed, err)
	}
	// Повторная отвязка — не ошибка: «отвязать» из двух вкладок должно просто сработать.
	if removed, err := e.svc.ClearMentionImage(ctx, e.owner, e.project, f.entity, f.event); err != nil || removed {
		t.Fatalf("повторная отвязка: %v, %v", removed, err)
	}
	list, err = e.svc.MentionImages(ctx, e.viewer, e.project)
	if err != nil || len(list) != 0 {
		t.Fatalf("после отвязки: %+v, %v", list, err)
	}
}

func TestMentionImageRejectsWrongTargets(t *testing.T) {
	e := setupEntities(t)
	ctx := context.Background()
	f := mentionImageSetup(t, e)

	// Не картинка: pdf в роли портрета — ошибка выбора, а не задумка.
	if _, err := e.svc.SetMentionImage(ctx, e.owner, e.project, f.entity, f.event, f.document); !errors.Is(err, entities.ErrNotImage) {
		t.Fatalf("pdf принят как картинка: %v", err)
	}
	// Файл из другого проекта.
	if _, err := e.svc.SetMentionImage(ctx, e.owner, e.project, f.entity, f.event, f.foreign); !errors.Is(err, entities.ErrMentionImageTarget) {
		t.Fatalf("чужой файл принят: %v", err)
	}
	// Несуществующая карточка или кадр.
	if _, err := e.svc.SetMentionImage(ctx, e.owner, e.project, uuid.New(), f.event, f.image); !errors.Is(err, entities.ErrMentionImageTarget) {
		t.Fatalf("несуществующая карточка принята: %v", err)
	}
	if _, err := e.svc.SetMentionImage(ctx, e.owner, e.project, f.entity, uuid.New(), f.image); !errors.Is(err, entities.ErrMentionImageTarget) {
		t.Fatalf("несуществующий кадр принят: %v", err)
	}
}

func TestMentionImagePermissions(t *testing.T) {
	e := setupEntities(t)
	ctx := context.Background()
	f := mentionImageSetup(t, e)

	// Читатель видит список, но не меняет.
	if _, err := e.svc.MentionImages(ctx, e.viewer, e.project); err != nil {
		t.Fatalf("читателю список должен быть виден: %v", err)
	}
	if _, err := e.svc.SetMentionImage(ctx, e.viewer, e.project, f.entity, f.event, f.image); !errors.Is(err, projects.ErrForbidden) {
		t.Fatalf("читатель привязал картинку, получено %v", err)
	}
	if _, err := e.svc.ClearMentionImage(ctx, e.viewer, e.project, f.entity, f.event); !errors.Is(err, projects.ErrForbidden) {
		t.Fatalf("читатель отвязал картинку, получено %v", err)
	}
	// Посторонний не видит даже список.
	if _, err := e.svc.MentionImages(ctx, e.outsider, e.project); !errors.Is(err, projects.ErrForbidden) {
		t.Fatalf("посторонний увидел список, получено %v", err)
	}
	// Редактор — может: это правка вида карточки, а не настройка проекта.
	if _, err := e.svc.SetMentionImage(ctx, e.editor, e.project, f.entity, f.event, f.image); err != nil {
		t.Fatalf("редактор не смог привязать: %v", err)
	}
}

// Удаление файла не оставляет висячую привязку: карточка упоминания не должна показывать «есть
// картинка», которую потом не открыть.
func TestMentionImageRemovedWithAsset(t *testing.T) {
	e := setupEntities(t)
	ctx := context.Background()
	f := mentionImageSetup(t, e)
	if _, err := e.svc.SetMentionImage(ctx, e.owner, e.project, f.entity, f.event, f.image); err != nil {
		t.Fatalf("привязка: %v", err)
	}
	if _, err := e.st.Pool.Exec(ctx, `DELETE FROM assets WHERE id = $1`, f.image); err != nil {
		t.Fatalf("удаление файла: %v", err)
	}
	list, err := e.svc.MentionImages(ctx, e.owner, e.project)
	if err != nil {
		t.Fatalf("список: %v", err)
	}
	if len(list) != 0 {
		t.Fatalf("привязка пережила удаление файла: %+v", list)
	}
}
