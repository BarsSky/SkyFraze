// Package yjs — серверная сторона CRDT: чтение документа, слияние апдейтов
// клиентов и снапшот для сохранения в базу.
//
// Зачем это вообще. До Фазы 3 снапшот писал каждый клиент своим debounce'ом:
// N вкладок конкурировали за одну ревизию (шторм 409), каждая перезаписывала
// yjs_state целиком, а сервер умел только релеить байты и хранить чужой
// снапшот. Теперь тот же CRDT работает и на сервере: хаб применяет к своей копии
// документа апдейты клиентов, а в базу пишет один писатель — сервер.
//
// Почему порт, а не своя реализация. Yjs — это формат: байты `encodeStateAsUpdate`
// должны читаться обеими сторонами, включая разрешение конфликтов в Y.Text.
// `github.com/Deln0r/ygo` — чистый Go-порт Yjs (MIT, без CGO), официально указан
// в документации Yjs, проверен на 188 кросс-языковых фикстурах, собранных из
// yjs@13.6.33 — ровно той версии, что стоит у нас на клиенте. Наши собственные
// фикстуры (`testdata/`, генератор `frontend/tests/yjs-fixtures.ts`) проверяют то
// же самое на нашем формате документа.
//
// Границы пакета: только работа с документом. Транспорт (WebSocket), комнаты и
// расписание сохранений живут в collab/hub.go — там же, где и раньше.
package yjs

import (
	"errors"
	"fmt"

	ygo "github.com/Deln0r/ygo"
)

// EventsRoot — имя корневого массива событий: совпадает с клиентом
// (frontend/src/collab/yprovider.ts, `doc.getArray('events')`).
const EventsRoot = "events"

// ErrInvalidUpdate — байты не являются корректным апдейтом Yjs.
var ErrInvalidUpdate = errors.New("invalid yjs update")

// Doc — документ проекта на сервере.
type Doc struct {
	inner *ygo.Doc
}

// NewDoc — пустой документ.
func NewDoc() *Doc {
	return &Doc{inner: ygo.NewDoc()}
}

// FromState — документ из снапшота. Пустой снапшот даёт пустой документ: так
// выглядит проект, который ещё ни разу не правили.
func FromState(state []byte) (*Doc, error) {
	doc := NewDoc()
	if len(state) == 0 {
		return doc, nil
	}
	if err := doc.Apply(state); err != nil {
		return nil, err
	}
	return doc, nil
}

// Apply принимает апдейт от клиента (или снапшот из базы).
//
// Байты приходят из сети, поэтому сначала проверяются: `ValidateUpdate` не даёт
// битому или враждебному апдейту дойти до применения. Ошибка не ломает документ —
// вызывающий просто не рассылает этот апдейт дальше.
func (d *Doc) Apply(update []byte) error {
	if len(update) == 0 {
		return nil
	}
	if err := ygo.ValidateUpdate(update); err != nil {
		return fmt.Errorf("%w: %v", ErrInvalidUpdate, err)
	}
	if err := ygo.ApplyUpdate(d.inner, update); err != nil {
		return fmt.Errorf("%w: %v", ErrInvalidUpdate, err)
	}
	return nil
}

// EncodeState — полное состояние документа: те же байты, что клиент пишет в
// снапшот (`Y.encodeStateAsUpdate`), поэтому они ложатся в project_event_state
// без конвертации и читаются клиентом как есть.
func (d *Doc) EncodeState() []byte {
	return ygo.EncodeStateAsUpdate(d.inner)
}

// StateVector — вектор состояния: по нему клиент получает только недостающие
// изменения (`EncodeDiff`), а не весь документ.
func (d *Doc) StateVector() []byte {
	return ygo.EncodeStateVector(d.inner)
}

// Diff — изменения, которых нет у клиента с таким вектором состояния. Нужен,
// чтобы отвечать на подключение разницей, а не полным состоянием.
func (d *Doc) Diff(remoteStateVector []byte) ([]byte, error) {
	return ygo.EncodeDiff(d.inner, remoteStateVector)
}

// Event — событие проекта в том виде, в каком его читает серверная проекция.
type Event struct {
	ID       string
	ParentID string
	Title    string
	Body     string
	// Position — индекс в корневом массиве: порядок задаёт клиент, сервер лишь
	// переносит его в реляционную модель.
	Position int
	// EventDate — дата события в формате «YYYY-MM-DD» (пусто, если даты нет).
	EventDate string
}

// Events читает корневой массив событий.
//
// Текст берётся из `title_text`/`body_text` (Фаза 2), а если их нет — из старых
// скалярных `title`/`body`: сервер обязан понимать и снапшоты, снятые до перехода
// на Y.Text, иначе проекция дерева на время миграции теряла бы текст.
func (d *Doc) Events() []Event {
	events := ygo.NewArray(d.inner, EventsRoot)
	out := make([]Event, 0, events.Len())
	events.Range(func(index uint64, value any) bool {
		item, ok := value.(*ygo.Map)
		if !ok {
			return true
		}
		event := Event{
			ID:        stringField(item, "id"),
			ParentID:  stringField(item, "parent_id"),
			Title:     textField(item, "title"),
			Body:      textField(item, "body"),
			Position:  int(index),
			EventDate: stringField(item, "event_date"),
		}
		if event.ID == "" {
			// Событие без id проекции не нужно: так же считает и клиент
			// (yFlatTree пропускает такие узлы).
			return true
		}
		out = append(out, event)
		return true
	})
	return out
}

// EventCount — сколько событий в корневом массиве (без чтения их полей).
//
// Нужен, чтобы не прогонять миграцию текста на каждой букве: она перепроверяется
// только когда состав событий изменился (засев из базы, новая глава, удаление).
func (d *Doc) EventCount() int {
	return int(ygo.NewArray(d.inner, EventsRoot).Len())
}

// MergeUpdates сливает набор апдейтов в один — без документа. Нужен как
// «компактор» для накопленных в памяти апдейтов и как проверяемая операция.
func MergeUpdates(updates [][]byte) ([]byte, error) {
	if len(updates) == 0 {
		return nil, nil
	}
	merged, err := ygo.MergeUpdates(updates)
	if err != nil {
		return nil, fmt.Errorf("%w: %v", ErrInvalidUpdate, err)
	}
	return merged, nil
}

// EnsureTextFields заводит `title_text`/`body_text` из старых скалярных строк там,
// где их ещё нет, и возвращает число созданных полей.
//
// Почему это делает сервер. У Yjs на одном ключе `Y.Map` может оказаться только
// один тип: если два клиента одновременно создадут свой `Y.Text` (а именно так
// выглядит миграция, запущенная каждым при открытии проекта), LWW выберет одну
// ветку, и правки, набранные во второй, станут невидимыми — они физически
// останутся в документе, но `title_text` будет указывать на другую ветку.
// Сервер — единственный писатель, поэтому миграция идёт здесь, один раз на проект,
// до того как клиенты начнут печатать; клиентам остаётся только читать текст.
func (d *Doc) EnsureTextFields() int {
	events := ygo.NewArray(d.inner, EventsRoot)
	type pending struct {
		item   *ygo.Map
		fields map[string]string
	}
	var todo []pending

	events.Range(func(_ uint64, value any) bool {
		item, ok := value.(*ygo.Map)
		if !ok {
			return true
		}
		fields := map[string]string{}
		for _, field := range []string{"title", "body"} {
			if _, isText := item.Get(field + "_text").(*ygo.Text); isText {
				continue
			}
			legacy, isString := item.Get(field).(string)
			if !isString {
				// Не заводим текст там, где его и не было: у события без единого
				// поля незачем создавать пустые ветки.
				continue
			}
			fields[field] = legacy
		}
		if len(fields) > 0 {
			todo = append(todo, pending{item: item, fields: fields})
		}
		return true
	})

	if len(todo) == 0 {
		return 0
	}

	created := 0
	txn := d.inner.WriteTxn()
	for _, entry := range todo {
		for _, field := range []string{"title", "body"} {
			legacy, ok := entry.fields[field]
			if !ok {
				continue
			}
			text := entry.item.SetText(txn, field+"_text")
			if legacy != "" {
				text.Insert(txn, 0, legacy)
			}
			created++
		}
	}
	txn.Commit()
	return created
}

// textField читает текстовое поле: сначала Y.Text, затем старую строку.
func textField(m *ygo.Map, field string) string {
	if text, ok := m.Get(field + "_text").(*ygo.Text); ok {
		return text.String()
	}
	return stringField(m, field)
}

func stringField(m *ygo.Map, key string) string {
	value, ok := m.Get(key).(string)
	if !ok {
		return ""
	}
	return value
}
