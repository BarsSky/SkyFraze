package yjs_test

// attach_asset_test.go — привязка вложения к существующему кадру.
//
// Проверяем то, что делает сервер вместо вкладки редактора: список вложений (`assets`) и
// выбор фона (`bg_kind`/`bg_asset`). Ошибка здесь не видна сразу: картинка просто не
// появится у кадра, а ссылка на файл останется висеть.

import (
	"testing"

	"github.com/skyfraze/backend/internal/collab/yjs"
)

func docWithEvent(t *testing.T, id string) *yjs.Doc {
	t.Helper()
	doc := yjs.NewDoc()
	if err := doc.SeedEvents([]yjs.EventSeed{{ID: id, Title: "Пролог", Body: "Текст."}}); err != nil {
		t.Fatalf("засев: %v", err)
	}
	return doc
}

func TestAttachAssetAddsToEvent(t *testing.T) {
	doc := docWithEvent(t, "e1")
	found, err := doc.AttachAsset("e1", "asset-1", false)
	if err != nil {
		t.Fatalf("привязка: %v", err)
	}
	if !found {
		t.Fatal("кадр не найден, хотя он есть")
	}
	// Повторная привязка не должна плодить дубликаты: вкладка показывает список как есть.
	if _, err := doc.AttachAsset("e1", "asset-1", false); err != nil {
		t.Fatalf("повтор: %v", err)
	}
	if _, err := doc.AttachAsset("e1", "asset-2", false); err != nil {
		t.Fatalf("второе вложение: %v", err)
	}
	if usage := doc.AssetUsage("asset-1"); usage != 1 {
		t.Errorf("asset-1 упомянут %d раз, ожидался 1", usage)
	}
	if usage := doc.AssetUsage("asset-2"); usage != 1 {
		t.Errorf("asset-2 упомянут %d раз, ожидался 1", usage)
	}
}

func TestAttachAssetCanSetBackground(t *testing.T) {
	doc := docWithEvent(t, "e1")
	if _, err := doc.AttachAsset("e1", "asset-7", true); err != nil {
		t.Fatalf("привязка: %v", err)
	}
	events := doc.Events()
	if len(events) != 1 {
		t.Fatalf("событий: %d", len(events))
	}
	// Фон читается через Events(): это то же поле, что видит стадия.
	if events[0].Background != "asset-7" {
		t.Errorf("фон кадра: %q", events[0].Background)
	}
	if usage := doc.AssetUsage("asset-7"); usage != 1 {
		t.Errorf("фон не считается использованием: %d", usage)
	}
}

func TestAttachAssetRefusesUnknownEvent(t *testing.T) {
	doc := docWithEvent(t, "e1")
	found, err := doc.AttachAsset("нет-такого", "asset-1", false)
	if err != nil {
		t.Fatalf("ошибка: %v", err)
	}
	if found {
		t.Error("несуществующий кадр не может быть «найден»")
	}
	if usage := doc.AssetUsage("asset-1"); usage != 0 {
		t.Errorf("вложение привязалось к никуда: %d", usage)
	}
}

func TestAttachAssetNeedsBothIDs(t *testing.T) {
	doc := docWithEvent(t, "e1")
	if _, err := doc.AttachAsset("", "asset-1", false); err == nil {
		t.Error("без кадра привязывать нечего")
	}
	if _, err := doc.AttachAsset("e1", "", false); err == nil {
		t.Error("без вложения привязывать нечего")
	}
}
