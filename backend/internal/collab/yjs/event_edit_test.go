package yjs_test

// event_edit_test.go — правка текста и удаление кадра в документе.
//
// Это самая тонкая часть новой возможности: правка пишет в Y.Text (`title_text`/
// `body_text`), а не в скалярные поля, иначе открытые вкладки увидели бы не правку, а
// расхождение. Поэтому проверяем именно то, что должно быть в документе после неё:
// новое содержимое, отсутствие legacy-строк и сохранность соседей.

import (
	"testing"

	"github.com/google/uuid"

	"github.com/skyfraze/backend/internal/collab/yjs"
)

func TestDocSetEventText(t *testing.T) {
	first, second := uuid.NewString(), uuid.NewString()
	doc := yjs.NewDoc()
	if err := doc.InsertEvents(0, []yjs.EventSeed{
		{ID: first, Title: "Глава 1", Body: "старый текст"},
		{ID: second, Title: "Глава 2", Body: "другой текст"},
	}); err != nil {
		t.Fatalf("документ: %v", err)
	}

	body := "новый текст"
	found, err := doc.SetEventText(first, nil, &body)
	if err != nil || !found {
		t.Fatalf("правка текста: found=%v err=%v", found, err)
	}
	event, ok := doc.EventByID(first)
	if !ok {
		t.Fatal("кадр пропал после правки")
	}
	if event.Body != body {
		t.Errorf("текст в документе: %q", event.Body)
	}
	// Заголовок не трогали: nil означает «не менять», а не «стереть».
	if event.Title != "Глава 1" {
		t.Errorf("заголовок изменился без просьбы: %q", event.Title)
	}
	// Сосед не пострадал.
	if other, _ := doc.EventByID(second); other.Body != "другой текст" {
		t.Errorf("соседний кадр: %q", other.Body)
	}

	// Заголовок тоже меняется, когда его просят.
	title := "Глава 1 (переписана)"
	if _, err := doc.SetEventText(first, &title, nil); err != nil {
		t.Fatalf("правка заголовка: %v", err)
	}
	event, _ = doc.EventByID(first)
	if event.Title != "Глава 1 (переписана)" || event.Body != body {
		t.Errorf("после правки заголовка: %+v", event)
	}

	// Пустая строка — это «стереть», а не «оставить»: nil и "" разные вещи.
	empty := ""
	if _, err := doc.SetEventText(first, &empty, nil); err != nil {
		t.Fatalf("стирание заголовка: %v", err)
	}
	if event, _ := doc.EventByID(first); event.Title != "" {
		t.Errorf("заголовок должен был стереться: %q", event.Title)
	}

	// Несуществующий кадр — found=false, без ошибки: вызывающий сам решает, что сказать.
	if found, err := doc.SetEventText(uuid.NewString(), nil, &body); found || err != nil {
		t.Errorf("неизвестный кадр: found=%v err=%v", found, err)
	}
	// Ничего не передали — ошибка, а не молчаливое «ничего не сделал».
	if _, err := doc.SetEventText(first, nil, nil); err == nil {
		t.Error("правка без полей должна быть ошибкой")
	}
}

func TestDocDeleteEvent(t *testing.T) {
	chapter, child := uuid.NewString(), uuid.NewString()
	doc := yjs.NewDoc()
	if err := doc.InsertEvents(0, []yjs.EventSeed{
		{ID: chapter, Title: "Глава 1", Body: "текст"},
		{ID: child, ParentID: chapter, Title: "Под-событие", Body: "вложенный"},
	}); err != nil {
		t.Fatalf("документ: %v", err)
	}

	gone, err := doc.DeleteEvent(child)
	if err != nil || gone == nil {
		t.Fatalf("удаление: gone=%v err=%v", gone, err)
	}
	// Снимок — часть удаления, а не отдельный запрос: в нём должны быть все поля кадра,
	// иначе «Вернуть» вернёт кадр-пустышку.
	if gone.ID != child || gone.Title != "Под-событие" || gone.Body != "вложенный" ||
		gone.ParentID != chapter || gone.Index != 1 {
		t.Errorf("снимок удалённого кадра: %+v", gone)
	}
	if _, ok := doc.EventByID(child); ok {
		t.Fatal("кадр остался в документе")
	}
	if _, ok := doc.EventByID(chapter); !ok {
		t.Fatal("соседний кадр удалён вместе с ним")
	}
	if count := doc.EventCount(); count != 1 {
		t.Errorf("кадров в документе: %d, ожидался 1", count)
	}

	// Повторное удаление — снимка нет, а не ошибка: так вызывающий отличает «уже нет»
	// от «сломалось».
	if gone, err := doc.DeleteEvent(child); gone != nil || err != nil {
		t.Errorf("повторное удаление: gone=%v err=%v", gone, err)
	}
}

// Возврат удалённого кадра: на прежнее место, с полями и с прежним id.
func TestDocReviveEvent(t *testing.T) {
	first, second, third := uuid.NewString(), uuid.NewString(), uuid.NewString()
	doc := yjs.NewDoc()
	if err := doc.InsertEvents(0, []yjs.EventSeed{
		{ID: first, Title: "Первая", Body: "раз"},
		{ID: second, Title: "Вторая", Body: "два"},
		{ID: third, Title: "Третья", Body: "три"},
	}); err != nil {
		t.Fatalf("документ: %v", err)
	}
	gone, err := doc.DeleteEvent(second)
	if err != nil || gone == nil {
		t.Fatalf("удаление: gone=%v err=%v", gone, err)
	}

	// Пока кадра не было, документ менялся: вернуть кадр нужно, не ломая это.
	newTitle := "Третья (правлено)"
	if _, err := doc.SetEventText(third, &newTitle, nil); err != nil {
		t.Fatalf("правка соседа: %v", err)
	}

	result, err := doc.ReviveEvent(*gone)
	if err != nil {
		t.Fatalf("возврат: %v", err)
	}
	if !result.Inserted || result.Orphan || result.Index != 1 {
		t.Fatalf("возврат: %+v", result)
	}
	order := make([]string, 0, 3)
	for _, event := range doc.EventsFull() {
		order = append(order, event.ID)
	}
	if want := []string{first, second, third}; len(order) != 3 ||
		order[0] != want[0] || order[1] != want[1] || order[2] != want[2] {
		t.Errorf("порядок после возврата: %v", order)
	}
	back, ok := doc.EventByID(second)
	if !ok {
		t.Fatal("кадр не вернулся")
	}
	if back.Title != "Вторая" || back.Body != "два" {
		t.Errorf("содержимое вернувшегося кадра: %+v", back)
	}
	if other, _ := doc.EventByID(third); other.Title != newTitle {
		t.Errorf("правка соседа потерялась: %q", other.Title)
	}

	// Повторный возврат — не вторая копия кадра: оба с одним id сломали бы все выборки.
	if again, err := doc.ReviveEvent(*gone); err != nil || again.Inserted {
		t.Errorf("повторный возврат: result=%+v err=%v", again, err)
	}
	if count := doc.EventCount(); count != 3 {
		t.Errorf("кадров после повторного возврата: %d, ожидалось 3", count)
	}
}

// Возврат кадра, родителя которого уже удалили: кадр возвращается главой верхнего
// уровня, а не ссылкой на несуществующего родителя.
func TestDocReviveEventWithoutParent(t *testing.T) {
	parent, child := uuid.NewString(), uuid.NewString()
	doc := yjs.NewDoc()
	if err := doc.InsertEvents(0, []yjs.EventSeed{
		{ID: parent, Title: "Глава", Body: "текст"},
		{ID: child, ParentID: parent, Title: "Под-событие", Body: "вложенный"},
	}); err != nil {
		t.Fatalf("документ: %v", err)
	}
	gone, err := doc.DeleteEvent(child)
	if err != nil || gone == nil {
		t.Fatalf("удаление: gone=%v err=%v", gone, err)
	}
	if _, err := doc.DeleteEvent(parent); err != nil {
		t.Fatalf("удаление родителя: %v", err)
	}

	result, err := doc.ReviveEvent(*gone)
	if err != nil {
		t.Fatalf("возврат: %v", err)
	}
	if !result.Inserted || !result.Orphan {
		t.Fatalf("возврат без родителя: %+v", result)
	}
	back, ok := doc.EventByID(child)
	if !ok {
		t.Fatal("кадр не вернулся")
	}
	if back.ParentID != "" {
		t.Errorf("вернувшийся кадр ссылается на удалённого родителя: %q", back.ParentID)
	}
}

// Снапшот после правки читается заново: правка не «растворяется» при сохранении.
func TestDocSetEventTextSurvivesSnapshot(t *testing.T) {
	id := uuid.NewString()
	doc := yjs.NewDoc()
	if err := doc.InsertEvents(0, []yjs.EventSeed{{ID: id, Title: "Глава", Body: "старое"}}); err != nil {
		t.Fatalf("документ: %v", err)
	}
	body := "новое"
	if _, err := doc.SetEventText(id, nil, &body); err != nil {
		t.Fatalf("правка: %v", err)
	}

	restored, err := yjs.FromState(doc.EncodeState())
	if err != nil {
		t.Fatalf("снапшот не читается: %v", err)
	}
	event, ok := restored.EventByID(id)
	if !ok {
		t.Fatal("кадр пропал при перечитывании снапшота")
	}
	if event.Body != "новое" || event.Title != "Глава" {
		t.Errorf("после снапшота: %+v", event)
	}
}

// TestDocSetEventDate — дата кадра: ставится, снимается и не пускает мусор.
//
// Дата — скалярное поле `event_date` (в редакторе это `<input type="date">`), поэтому
// проверяем именно документ: после «поставить» поле есть и читается как YYYY-MM-DD, после
// «убрать» — поля нет вовсе (а не пустая строка: для проекции дерева это разные вещи).
func TestDocSetEventDate(t *testing.T) {
	first := uuid.NewString()
	doc := yjs.NewDoc()
	if err := doc.InsertEvents(0, []yjs.EventSeed{{ID: first, Title: "Глава 1", Body: "текст"}}); err != nil {
		t.Fatalf("документ: %v", err)
	}

	found, err := doc.SetEventDate(first, "2026-03-02")
	if err != nil || !found {
		t.Fatalf("поставить дату: found=%v err=%v", found, err)
	}
	event, ok := doc.EventByID(first)
	if !ok || event.EventDate != "2026-03-02" {
		t.Fatalf("дата в документе: %+v", event)
	}

	// Снять дату — значит удалить поле.
	if found, err := doc.SetEventDate(first, ""); err != nil || !found {
		t.Fatalf("убрать дату: found=%v err=%v", found, err)
	}
	if event, _ := doc.EventByID(first); event.EventDate != "" {
		t.Errorf("дата после снятия: %q", event.EventDate)
	}

	// Формат проверяется до записи: «3 марта» не должно доехать до документа.
	if _, err := doc.SetEventDate(first, "3 марта"); err == nil {
		t.Fatal("ожидался отказ на не-ISO дату")
	}
	// Неизвестный кадр — не ошибка, а «нечего менять»: вызывающий сам решает, что сказать.
	if found, err := doc.SetEventDate(uuid.NewString(), "2026-03-02"); found || err != nil {
		t.Errorf("чужой кадр: found=%v err=%v", found, err)
	}
}
