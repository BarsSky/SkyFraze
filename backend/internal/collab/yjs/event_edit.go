package yjs

// event_edit.go — правка и удаление существующего кадра в документе.
//
// До этого файла сервер умел в документе только ДОБАВЛЯТЬ: вставку куска (импорт) и
// привязку вложения. Переписать текст и удалить кадр он не мог вовсе — не потому, что
// это технически сложно, а потому, что не было решено, кто и когда это делает
// (миграция 0015, docs/ai-assistant.md). Теперь решено: правку заказывает человек, а
// применяет сервер по его подтверждению.
//
// Пишем ровно то, что писала бы вкладка редактора: текст живёт в `title_text`/`body_text`
// (Y.Text), поэтому правка — это Delete + Insert в тех же ветках, а не замена скалярных
// полей. Иначе открытые вкладки увидели бы не правку, а расхождение: у них своя Y.Text,
// и скалярное поле они не читают.

import (
	"errors"
	"strings"

	ygo "github.com/Deln0r/ygo"
)

// EventByID находит кадр по идентификатору.
func (d *Doc) EventByID(id string) (Event, bool) {
	if strings.TrimSpace(id) == "" {
		return Event{}, false
	}
	for _, event := range d.Events() {
		if event.ID == id {
			return event, true
		}
	}
	return Event{}, false
}

// SetEventText заменяет заголовок и/или текст кадра.
//
// `title`/`body` — указатели: nil означает «не трогать». Это не украшение: «перепиши
// текст, заголовок оставь» — самый частый случай, а пустая строка как «оставить» не дала
// бы стереть заголовок, когда это действительно нужно.
//
// Возвращает false, если кадра нет: править нечего, и вызывающий обязан сказать об этом
// человеку, а не делать вид, что правка применена.
func (d *Doc) SetEventText(eventID string, title, body *string) (bool, error) {
	if strings.TrimSpace(eventID) == "" {
		return false, errors.New("нужен идентификатор кадра")
	}
	if title == nil && body == nil {
		return false, errors.New("нечего менять: не задан ни заголовок, ни текст")
	}
	target, ok := d.eventMap(eventID)
	if !ok {
		return false, nil
	}

	txn := d.inner.WriteTxn()

	// Порядок — заголовок, потом текст: если запись оборвётся между ними, кадр останется
	// с новым заголовком и старым текстом, то есть узнаваемым, а не полупустым.
	replace := func(field, value string) error {
		text := target.SetText(txn, field+"_text")
		if length := text.Length(); length > 0 {
			if err := text.Delete(txn, 0, length); err != nil {
				return err
			}
		}
		if value != "" {
			if err := text.Insert(txn, 0, value); err != nil {
				return err
			}
		}
		// Legacy-строка рядом (`title`, `body`) удаляется: пока она лежит, текст
		// хранится дважды, и старая копия всплывает там, где `*_text` ещё нет.
		target.Delete(txn, field)
		return nil
	}

	if title != nil {
		if err := replace("title", *title); err != nil {
			txn.Commit()
			return true, err
		}
	}
	if body != nil {
		if err := replace("body", *body); err != nil {
			txn.Commit()
			return true, err
		}
	}
	txn.Commit()
	return true, nil
}

// DeleteEvent удаляет кадр из документа.
//
// Удаляется только сам кадр. Детей у него быть не должно — это проверяет вызывающий по
// проекции: «что делать с детьми» — решение уровня сервиса (сейчас: отказать и
// попросить решить), а не документа.
func (d *Doc) DeleteEvent(eventID string) (bool, error) {
	if strings.TrimSpace(eventID) == "" {
		return false, errors.New("нужен идентификатор кадра")
	}
	events := ygo.NewArray(d.inner, EventsRoot)
	index := -1
	events.Range(func(idx uint64, value any) bool {
		item, ok := value.(*ygo.Map)
		if !ok {
			return true
		}
		if stringField(item, "id") == eventID {
			index = int(idx)
			return false
		}
		return true
	})
	if index < 0 {
		return false, nil
	}

	txn := d.inner.WriteTxn()
	defer txn.Commit()
	events.Delete(txn, uint64(index), 1)
	return true, nil
}

// eventMap находит карту кадра в корневом массиве.
func (d *Doc) eventMap(eventID string) (*ygo.Map, bool) {
	events := ygo.NewArray(d.inner, EventsRoot)
	var target *ygo.Map
	events.Range(func(_ uint64, value any) bool {
		item, ok := value.(*ygo.Map)
		if !ok {
			return true
		}
		if stringField(item, "id") == eventID {
			target = item
			return false
		}
		return true
	})
	return target, target != nil
}
