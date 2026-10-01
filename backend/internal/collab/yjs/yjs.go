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
	// Background — id вложения, выбранного фоном кадра (пусто, если фон
	// унаследован или задан тоном): в реляционной модели этого поля нет, но
	// импорт «в место» и привязка картинок обязаны его видеть.
	Background string
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
		// Фон кадра: только явно выбранная картинка (`bg_kind: asset`). Тон и
		// «наследовать» фоном не считаются — это не вложение.
		if stringField(item, "bg_kind") == "asset" {
			event.Background = stringField(item, "bg_asset")
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

// EventSeed — событие для вставки в документ (импорт куска в существующий проект,
// засев документа из реляционных строк, сборка документа при импорте).
type EventSeed struct {
	ID        string
	ParentID  string
	Title     string
	Body      string
	EventDate string
	// Assets — вложения события: идентификаторы файлов проекта в том порядке, в
	// каком они прикреплены. Единственное место, где живёт эта привязка, — CRDT
	// (таблица event_assets пуста с миграции 0002), поэтому импорт файлов обязан
	// писать документ, а не только строки `events`.
	Assets []string
	// Background — id вложения, которое становится фоном кадра. Интерфейс ставит
	// фоном первую загруженную картинку события; импорт делает так же.
	Background string
}

// InsertEvents вставляет события в корневой массив, начиная с позиции index.
//
// Полем `parent_id` задаётся место в дереве, а позицией в массиве — порядок среди
// соседей: так же устроен документ клиента, поэтому вставленный кусок сразу
// выглядит для редакторов обычным деревом.
func (d *Doc) InsertEvents(index int, seeds []EventSeed) error {
	if len(seeds) == 0 {
		return nil
	}
	events := ygo.NewArray(d.inner, EventsRoot)
	at := index
	if at < 0 {
		at = 0
	}
	if length := int(events.Len()); at > length {
		at = length
	}

	txn := d.inner.WriteTxn()
	for _, s := range seeds {
		item := events.InsertMap(txn, uint64(at))
		item.Set(txn, "id", s.ID)
		if s.ParentID != "" {
			item.Set(txn, "parent_id", s.ParentID)
		}
		if s.Title != "" {
			item.SetText(txn, "title_text").Insert(txn, 0, s.Title)
		}
		if s.Body != "" {
			item.SetText(txn, "body_text").Insert(txn, 0, s.Body)
		}
		if s.EventDate != "" {
			item.Set(txn, "event_date", s.EventDate)
		}
		// Вложения — тем же способом, что и в браузере: map.set('assets', [...])
		// (frontend/src/components/editors/EditorsPanel.tsx). Список идёт как []any:
		// кодировщик lib0-Any понимает именно его, а []string паникует.
		if len(s.Assets) > 0 {
			list := make([]any, 0, len(s.Assets))
			for _, id := range s.Assets {
				list = append(list, id)
			}
			item.Set(txn, "assets", list)
		}
		if s.Background != "" {
			item.Set(txn, "bg_kind", "asset")
			item.Set(txn, "bg_asset", s.Background)
		}
		at++
	}
	txn.Commit()
	return nil
}

// InsertPlace — где в документе встанет вставляемый кусок (импорт «в место»).
//
// Пустые поля — обычные значения по умолчанию: корень куска на верхнем уровне, в
// конец массива. BeforeID сильнее AfterID: «вставить перед» задаёт позицию точнее,
// чем «после», и вместе они не имеют смысла (обработчик такое сочетание отвергает).
type InsertPlace struct {
	// ParentID — под какое событие положить корень куска.
	ParentID string
	// AfterID — сразу после какого события (вместе со всем его поддеревом).
	AfterID string
	// BeforeID — перед каким событием.
	BeforeID string
}

// InsertAt вставляет события в место, описанное place.
func (d *Doc) InsertAt(place InsertPlace, seeds []EventSeed) error {
	return d.InsertEvents(d.InsertIndex(place), seeds)
}

// InsertIndex — позиция в корневом массиве для place.
//
// «После события» означает после всего его поддерева, а не сразу за родителем:
// для человека «вставить после главы» — это после главы вместе с её пунктами.
// Порядок отображения строится обходом дерева, поэтому позиция в массиве и
// видимое место совпадают только при таком правиле.
func (d *Doc) InsertIndex(place InsertPlace) int {
	events := d.Events()
	if place.BeforeID != "" {
		for _, e := range events {
			if e.ID == place.BeforeID {
				return e.Position
			}
		}
		return len(events)
	}
	if place.AfterID == "" {
		return len(events)
	}

	byID := make(map[string]Event, len(events))
	children := make(map[string][]string, len(events))
	for _, e := range events {
		byID[e.ID] = e
		if e.ParentID != "" {
			children[e.ParentID] = append(children[e.ParentID], e.ID)
		}
	}
	if _, ok := byID[place.AfterID]; !ok {
		return len(events)
	}

	// Обход поддерева в ширину: позиция берётся максимальная, поэтому неважно, в
	// каком порядке дети оказались в массиве (у документа, пережившего переносы,
	// он не обязан быть строго «глубина-вперёд»).
	seen := map[string]bool{place.AfterID: true}
	queue := []string{place.AfterID}
	last := byID[place.AfterID].Position
	for len(queue) > 0 {
		id := queue[0]
		queue = queue[1:]
		if pos := byID[id].Position; pos > last {
			last = pos
		}
		for _, child := range children[id] {
			if seen[child] {
				continue
			}
			seen[child] = true
			queue = append(queue, child)
		}
	}
	return last + 1
}

// EventIDs — идентификаторы событий в порядке массива: нужны, чтобы найти место
// вставки (например, «сразу после поддерева события X»).
func (d *Doc) EventIDs() []string {
	events := ygo.NewArray(d.inner, EventsRoot)
	out := make([]string, 0, events.Len())
	events.Range(func(_ uint64, value any) bool {
		if item, ok := value.(*ygo.Map); ok {
			out = append(out, stringField(item, "id"))
		}
		return true
	})
	return out
}

// SeedEvents дописывает события в конец документа: так собирается документ
// проекта, у которого снапшота ещё нет (только реляционные строки).
func (d *Doc) SeedEvents(seeds []EventSeed) error {
	return d.InsertEvents(int(ygo.NewArray(d.inner, EventsRoot).Len()), seeds)
}

// SeedDepth — самая глубокая вложенность внутри набора вставляемых событий
// относительно его корней (0 — одни главы верхнего уровня).
//
// Нужна для текста отказа человеку («в куске N уровней»), а не для проверки
// глубины: сколько получится в документе, знает только InsertMaxDepth.
func SeedDepth(seeds []EventSeed) int {
	if len(seeds) == 0 {
		return 0
	}
	known := make(map[string]bool, len(seeds))
	parent := make(map[string]string, len(seeds))
	for _, s := range seeds {
		known[s.ID] = true
	}
	for _, s := range seeds {
		if s.ParentID != "" && known[s.ParentID] {
			parent[s.ID] = s.ParentID
		}
	}

	max := 0
	for _, s := range seeds {
		// Поднимаемся к корню набора, считая шаги. Цикл (данных, которых быть не
		// должно) обрываем: глубину проверяют ДО вставки, и зацикливаться здесь
		// нельзя — иначе импорт повесил бы обработчик.
		steps := 0
		seen := map[string]bool{s.ID: true}
		for cur := parent[s.ID]; cur != ""; cur = parent[cur] {
			if seen[cur] || steps > len(seeds) {
				break
			}
			seen[cur] = true
			steps++
		}
		if steps > max {
			max = steps
		}
	}
	return max
}

// DepthOf — глубина события в дереве (0 — верхний уровень).
//
// Пустой id и неизвестное событие тоже дают 0: кусок без родителя встаёт на
// верхний уровень, а сироту проекция поднимает в корень.
func (d *Doc) DepthOf(id string) int {
	if id == "" {
		return 0
	}
	parentOf := make(map[string]string)
	for _, e := range d.Events() {
		parentOf[e.ID] = e.ParentID
	}
	if _, ok := parentOf[id]; !ok {
		return 0
	}
	depth := 0
	seen := map[string]bool{id: true}
	for cur := parentOf[id]; cur != ""; cur = parentOf[cur] {
		if seen[cur] {
			break // цикл: дальше не считаем
		}
		seen[cur] = true
		depth++
	}
	return depth
}

// InsertMaxDepth — на какой глубине окажется САМОЕ ГЛУБОКОЕ событие куска, если
// его вставить в документ как есть.
//
// Считать «уровень места плюс глубина куска» нельзя: у корня куска родителем
// бывает не только выбранное место, но и уже существующее событие документа —
// тогда уровень берётся из документа. Здесь одно правило на все случаи:
//
//   - родителя нет → верхний уровень (0);
//   - родитель внутри куска → на уровень ниже него;
//   - родитель — существующее событие документа → его глубина плюс один;
//   - родителя нет в документе → 0: проекция поднимает такого сироту в корень
//     (см. `events.NodesFromSeeds`), и кусок встаёт на верхний уровень.
//
// Место вставки сюда не передаётся намеренно: оно уже записано в `parent_id`
// корней куска (transfer подставляет его ровно там), а лишний параметр — это
// лишняя возможность ошибиться на единицу. А цена ошибки велика: `NormalizeTree`
// отвергает слишком глубокое дерево уже ПОСЛЕ вставки, и проекция таблицы событий
// осталась бы устаревшей, а документ — с событиями, которых в таблице нет.
func (d *Doc) InsertMaxDepth(seeds []EventSeed) int {
	if len(seeds) == 0 {
		return 0
	}
	known := make(map[string]bool, len(seeds))
	parent := make(map[string]string, len(seeds))
	for _, s := range seeds {
		known[s.ID] = true
		parent[s.ID] = s.ParentID
	}

	// Глубины существующих событий считаем один раз на весь кусок: событий в
	// проекте бывают тысячи, а кусок — до двух тысяч.
	doc := d.Events()
	docParent := make(map[string]string, len(doc))
	for _, e := range doc {
		docParent[e.ID] = e.ParentID
	}
	docDepth := make(map[string]int, len(doc))
	depthInDoc := func(id string) (int, bool) {
		if _, ok := docParent[id]; !ok {
			return 0, false
		}
		if value, ok := docDepth[id]; ok {
			return value, true
		}
		value := 0
		seen := map[string]bool{id: true}
		for cur := docParent[id]; cur != ""; cur = docParent[cur] {
			if seen[cur] {
				break // цикл в документе: дальше не считаем
			}
			seen[cur] = true
			value++
		}
		docDepth[id] = value
		return value, true
	}

	depth := make(map[string]int, len(seeds))
	visiting := make(map[string]bool, len(seeds))
	var of func(id string) int
	of = func(id string) int {
		if value, ok := depth[id]; ok {
			return value
		}
		if visiting[id] {
			// Цикл в куске (данных, которых быть не должно): считаем ветку корнем,
			// а не зацикливаемся — проверка идёт до вставки.
			return 0
		}
		visiting[id] = true
		up := parent[id]
		var value int
		switch {
		case up == "":
			value = 0
		case known[up]:
			value = of(up) + 1
		default:
			if docValue, ok := depthInDoc(up); ok {
				value = docValue + 1
			}
		}
		delete(visiting, id)
		depth[id] = value
		return value
	}

	max := 0
	for _, s := range seeds {
		if value := of(s.ID); value > max {
			max = value
		}
	}
	return max
}

// InsertOutcome — что вышло из попытки вставить кусок в ЖИВОЙ документ комнаты.
//
// Отдельный тип, а не набор ошибок: часть исходов — не ошибки вовсе. Вставку
// сделали (Handled); документ комнаты ещё грузится, и трогать его нельзя, а
// снапшот писать нельзя тем более — комната его затрёт (RoomLoading); кусок не
// помещается в выбранное место, и об этом нужно сказать ДО вставки (TooDeep);
// наконец, вставка прошла, но серверная копия не обновилась (Warning).
// Так контракт между хабом и импортом остаётся словарём, а не угадыванием
// sentinel-ошибок в чужом пакете.
type InsertOutcome struct {
	// Handled — вставку сделала комната: снапшот вызывающему писать не нужно.
	Handled bool
	// RoomLoading — документ комнаты ещё загружается: запрос нужно повторить.
	RoomLoading bool
	// TooDeep — уровень места плюс глубина куска больше предела дерева.
	TooDeep bool
	// Warning — вставка сделана, но серверная копия не обновилась: текст человеку.
	Warning string
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
