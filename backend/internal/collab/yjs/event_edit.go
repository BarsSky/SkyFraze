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
	"time"

	ygo "github.com/Deln0r/ygo"
)

// TextOf отдаёт `Y.Text` поля кадра — то, к чему привязываются якоря замечаний к фрагменту.
//
// Зачем снаружи. Якорь (`Y.RelativePosition`) создаётся и резолвится против конкретного
// `Y.Text`, а не против строки: иначе он теряет смысл. Клиент делает это в браузере, а
// серверу доступ нужен, чтобы проверять и применять правки фрагментов (docs/fragment-comments.md).
//
// Возвращает false, если кадра нет или в нём ещё нет `Y.Text` (старый снапшот, где текст лежит
// скалярной строкой): создавать его здесь нельзя — писатель документа один, и это не сервис
// комментариев.
func (d *Doc) TextOf(eventID, field string) (*ygo.Text, bool) {
	m, ok := d.eventMap(eventID)
	if !ok {
		return nil, false
	}
	text, ok := m.Get(field + "_text").(*ygo.Text)
	if !ok {
		return nil, false
	}
	return text, true
}

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

// SetEventDate ставит или снимает дату кадра.
//
// Дата — скалярное поле `event_date`, а не `Y.Text`: в редакторе это `<input type="date">`,
// и человек выбирает день целиком, а не правит символы. Поэтому здесь `Set`/`Delete`, как это
// делает и сама вкладка (`ymap.set('event_date', value)`) — открытые вкладки увидят ту же
// правку, что сделали бы пальцем.
//
// Пустая строка — осознанная очистка даты. Это отличается от «поля нет»: для проекции дерева
// отсутствие поля значит «клиент даты не видел, не трогать» (старый снапшот, импорт без CRDT),
// и путать эти два состояния нельзя — иначе «убрать дату» стирало бы её у проектов, которые
// её просто не присылали.
func (d *Doc) SetEventDate(eventID, date string) (bool, error) {
	if strings.TrimSpace(eventID) == "" {
		return false, errors.New("нужен идентификатор кадра")
	}
	date = strings.TrimSpace(date)
	if date != "" {
		if _, err := time.Parse("2006-01-02", date); err != nil {
			return false, errors.New("дата должна быть в формате 2026-03-02 или пустой")
		}
	}
	target, ok := d.eventMap(eventID)
	if !ok {
		return false, nil
	}
	txn := d.inner.WriteTxn()
	if date == "" {
		target.Delete(txn, "event_date")
	} else {
		target.Set(txn, "event_date", date)
	}
	txn.Commit()
	return true, nil
}

// DeleteEvent удаляет кадр из документа и возвращает его снимок.
//
// Снимок — не «приятное дополнение»: без него удаление необратимо, а сервер его уже
// обещает кнопкой «Вернуть» (ai_changes.frame, миграция 0017). Поэтому удаление и чтение
// снимка — одна операция: сначала прочитать карту, потом удалить её, иначе между двумя
// вызовами кадр успел бы измениться и вернулся бы не тем, чем был.
//
// Удаляется только сам кадр. Детей у него быть не должно — это проверяет вызывающий по
// проекции: «что делать с детьми» — решение уровня сервиса (сейчас: отказать и
// попросить решить), а не документа.
func (d *Doc) DeleteEvent(eventID string) (*RemovedEvent, error) {
	if strings.TrimSpace(eventID) == "" {
		return nil, errors.New("нужен идентификатор кадра")
	}
	events := ygo.NewArray(d.inner, EventsRoot)
	index := -1
	var removed RemovedEvent
	events.Range(func(idx uint64, value any) bool {
		item, ok := value.(*ygo.Map)
		if !ok {
			return true
		}
		if stringField(item, "id") == eventID {
			index = int(idx)
			removed = RemovedEvent{EventFull: fieldsOf(item), Index: int(idx)}
			return false
		}
		return true
	})
	if index < 0 {
		return nil, nil
	}

	txn := d.inner.WriteTxn()
	defer txn.Commit()
	events.Delete(txn, uint64(index), 1)
	return &removed, nil
}

// SetEventParent меняет родителя кадра — перенос по дереву.
//
// Почему только `parent_id`, без перестановки в массиве. Документ — плоская
// последовательность (`events`), а дерево строится из неё по `parent_id`
// (`events.NormalizeTree`): место в массиве и есть порядок в дереве. Переставлять элемент
// (Delete + Insert) оказалось нельзя: ygo показывает переставленную карту, но записи в неё
// после перестановки молча теряются — проверено тестом (`TestDocSetEventParent`), и это
// означало бы «кадр виден, а править его больше нельзя». Поэтому перенос меняет только
// родителя: кадр сохраняет свой индекс, а среди новых соседей встаёт по порядку документа.
// Возврат на прежнее место — просто вернуть прежнего родителя, порядок при этом не менялся
// вовсе.
//
// Дети переезжают вместе с кадром сами: они ссылаются на него по идентификатору, а не на
// место в массиве. Проверки цикла («нельзя в собственного потомка») живут в сервисе — документ
// иерархии не знает.
func (d *Doc) SetEventParent(eventID, parentID string) (bool, error) {
	if strings.TrimSpace(eventID) == "" {
		return false, errors.New("нужен идентификатор кадра")
	}
	if parentID == eventID {
		return false, errors.New("кадр не может быть родителем самому себе")
	}
	target, ok := d.eventMap(eventID)
	if !ok {
		return false, nil
	}
	txn := d.inner.WriteTxn()
	defer txn.Commit()
	if parentID == "" {
		target.Delete(txn, "parent_id")
	} else {
		target.Set(txn, "parent_id", parentID)
	}
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
