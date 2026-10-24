package yjs_test

// restore_test.go — приведение документа к состоянию сохранённой версии.
//
// Проверяем именно то, ради чего восстановление сделано правкой, а не «заменой файла»:
// содержимое приходит к версии, кадры, появившиеся позже, исчезают, пропавшие —
// возвращаются, порядок совпадает, а повторное восстановление той же версии ничего не
// меняет (иначе кнопка «Восстановить» каждый раз гоняла бы апдейт по всем вкладкам).

import (
	"testing"

	"github.com/skyfraze/backend/internal/collab/yjs"
)

func TestDocRestoreBringsContentBack(t *testing.T) {
	doc := yjs.NewDoc()
	if err := doc.InsertEvents(0, []yjs.EventSeed{
		{ID: "a", Title: "Глава 1", Body: "Старый текст."},
		{ID: "b", ParentID: "a", Title: "Под-событие", Body: "вложенный"},
	}); err != nil {
		t.Fatalf("документ: %v", err)
	}
	// Версия — то, что было: две главы, у первой другой текст.
	version := doc.EventsFull()

	// Дальше проект жил: текст переписали, под-событие удалили, добавили новую главу.
	body := "Новый текст."
	if _, err := doc.SetEventText("a", nil, &body); err != nil {
		t.Fatalf("правка текста: %v", err)
	}
	if _, err := doc.DeleteEvent("b"); err != nil {
		t.Fatalf("удаление: %v", err)
	}
	if err := doc.InsertEvents(2, []yjs.EventSeed{{ID: "c", Title: "Глава 2", Body: "текст"}}); err != nil {
		t.Fatalf("вставка: %v", err)
	}

	result, err := doc.Restore(version)
	if err != nil {
		t.Fatalf("восстановление: %v", err)
	}
	if result.Updated != 1 || result.Added != 1 || result.Removed != 1 {
		t.Fatalf("изменения: %+v", result)
	}

	got := doc.EventsFull()
	if len(got) != 2 {
		t.Fatalf("кадров после восстановления: %d (%+v)", len(got), got)
	}
	if got[0].ID != "a" || got[0].Body != "Старый текст." {
		t.Errorf("первый кадр: %+v", got[0])
	}
	if got[1].ID != "b" || got[1].ParentID != "a" {
		t.Errorf("под-событие не вернулось: %+v", got[1])
	}
	for _, event := range got {
		if event.ID == "c" {
			t.Error("кадр, появившийся после версии, остался в документе")
		}
	}

	// Повторное восстановление той же версии — без изменений: кнопка не должна
	// рассылать апдейт там, где всё уже на месте.
	again, err := doc.Restore(version)
	if err != nil {
		t.Fatalf("повторное восстановление: %v", err)
	}
	if again.Changed() {
		t.Errorf("повторное восстановление что-то изменило: %+v", again)
	}
}

func TestDocRestoreKeepsOrderAndAttachments(t *testing.T) {
	doc := yjs.NewDoc()
	if err := doc.InsertEvents(0, []yjs.EventSeed{
		{ID: "one", Title: "Первый", Body: "1", Assets: []string{"asset-1"}, Background: "asset-1"},
		{ID: "two", Title: "Второй", Body: "2"},
		{ID: "three", Title: "Третий", Body: "3"},
	}); err != nil {
		t.Fatalf("документ: %v", err)
	}
	version := doc.EventsFull()

	// Человек переставил кадры и снял вложение: версия должна вернуть и порядок, и файл.
	if _, err := doc.DeleteEvent("one"); err != nil {
		t.Fatalf("удаление: %v", err)
	}
	if err := doc.InsertEvents(2, append([]yjs.EventSeed{}, yjs.EventSeed{ID: "one", Title: "Первый", Body: "1"})); err != nil {
		t.Fatalf("вставка: %v", err)
	}

	if _, err := doc.Restore(version); err != nil {
		t.Fatalf("восстановление: %v", err)
	}
	got := doc.EventsFull()
	ids := make([]string, 0, len(got))
	for _, event := range got {
		ids = append(ids, event.ID)
	}
	if len(ids) != 3 || ids[0] != "one" || ids[1] != "two" || ids[2] != "three" {
		t.Fatalf("порядок после восстановления: %v", ids)
	}
	first := got[0]
	if len(first.Assets) != 1 || first.Assets[0] != "asset-1" {
		t.Errorf("вложения не вернулись: %+v", first.Assets)
	}
	if first.BackgroundKind != "asset" || first.BackgroundAsset != "asset-1" {
		t.Errorf("фон не вернулся: kind=%q asset=%q", first.BackgroundKind, first.BackgroundAsset)
	}
}

func TestDocRestoreOfEmptyVersionIsRefused(t *testing.T) {
	doc := yjs.NewDoc()
	if err := doc.InsertEvents(0, []yjs.EventSeed{{ID: "a", Title: "Глава", Body: "текст"}}); err != nil {
		t.Fatalf("документ: %v", err)
	}
	if _, err := doc.Restore(nil); err == nil {
		t.Fatal("восстановление пустой версии должно быть отвергнуто")
	}
	if len(doc.EventsFull()) != 1 {
		t.Fatal("документ изменился при отказе")
	}
}
