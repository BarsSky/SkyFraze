package yjs

// restore.go — привести документ к состоянию сохранённой версии.
//
// Как это делается и почему именно так. В Yjs нельзя «заменить документ»: апдейты только
// добавляют историю, а клиент, у которого уже есть более новые правки, при повторном
// подключении пришлёт их обратно — и восстановление отменилось бы само собой. Поэтому
// восстановление — это ОБЫЧНАЯ ПРАВКА, приведённая к целевому состоянию:
//
//	кадры, которых в версии не было → удалить (сначала самые глубокие);
//	кадры, которые есть в обеих версиях → переписать поля и поставить на своё место;
//	кадры, которых в текущей версии нет → вставить на своё место (родитель и порядок).
//
// Всё это — одна транзакция, поэтому клиенты получают один апдейт, а не полсотни, и
// промежуточного состояния (полу-восстановленный проект) не существует ни для кого.
// Побочный эффект честный: это не «откат часов», а восстановление содержимого — кадры,
// тексты и связи совпадут с версией, а записи «кто и когда правил» останутся новыми.
//
// Две детали реализации, которые важно знать, трогая этот файл:
//
//  1. `ygo.NewArray` берёт блокировку документа, а транзакция записи держит её всё своё
//     время. Поэтому корневой массив и чтение кадров делаются ДО транзакции; внутри —
//     только операции над уже полученными объектами (иначе восстановление встаёт намертво:
//     проверено отладкой).
//  2. Читать значения, записанные В ТОЙ ЖЕ транзакции, нельзя — видно только
//     зафиксированное состояние. Поэтому перенос кадра (в Yjs это «вставить копию и удалить
//     оригинал») берёт поля из целевой версии, а не из карты.

import (
	"errors"
	"sort"
	"strings"

	ygo "github.com/Deln0r/ygo"
)

// EventFull — кадр документа целиком: то, что нужно, чтобы восстановить его как было.
//
// Поля повторяют то, что пишет вкладка редактора (frontend/src/collab/yprovider.ts,
// BackgroundPicker): id, parent_id, title_text, body_text, event_date, assets, фон
// (`bg_kind` + `bg_asset`/`bg_tone`) и created_at. Восстановление обязано покрывать ВСЕ
// из них: «пропал тон фона» или «сбросилась дата создания» — тихая потеря данных, которую
// заметят уже после того, как старые версии уйдут по удержанию.
type EventFull struct {
	ID        string `json:"id"`
	ParentID  string `json:"parent_id"`
	Title     string `json:"title"`
	Body      string `json:"body"`
	EventDate string `json:"event_date"`
	Assets    []string `json:"assets"`
	// BackgroundKind — inherit | tone | asset (как у BackgroundKind в интерфейсе).
	BackgroundKind string `json:"bg_kind"`
	// BackgroundAsset — id вложения, выбранного фоном (при kind=asset).
	BackgroundAsset string `json:"bg_asset"`
	// BackgroundTone — тон фона (при kind=tone).
	BackgroundTone string `json:"bg_tone"`
	// CreatedAt — когда кадр создан (строка, как её пишет клиент).
	CreatedAt string `json:"created_at"`
}

// RemovedEvent — кадр, который был удалён, вместе с местом, где он стоял.
//
// Зачем отдельный тип, а не «EventFull + index». Снимок удалённого кадра уходит в базу
// (ai_changes.frame, миграция 0017) и живёт там до недели, поэтому он должен быть
// самодостаточным: без позиции возврат ставил бы кадр в конец, а «вернулось не туда» —
// это уже не отмена.
type RemovedEvent struct {
	EventFull
	// Index — позиция кадра в массиве документа до удаления.
	Index int `json:"index"`
}

// ReviveResult — что получилось при возврате удалённого кадра.
type ReviveResult struct {
	// Inserted — кадр действительно вставлен (false: он уже есть в документе).
	Inserted bool
	// Orphan — родителя в документе нет, кадр вернулся главой верхнего уровня. Так
	// бывает, если родителя удалили уже после предложения: вернуть кадр «в никуда»
	// нельзя — проекция не примет ссылку на несуществующего родителя.
	Orphan bool
	// Index — куда кадр встал.
	Index int
}

// EventsFull читает кадры документа целиком — в порядке массива.
func (d *Doc) EventsFull() []EventFull {
	events := ygo.NewArray(d.inner, EventsRoot)
	out := make([]EventFull, 0, events.Len())
	events.Range(func(_ uint64, value any) bool {
		item, ok := value.(*ygo.Map)
		if !ok {
			return true
		}
		event := fieldsOf(item)
		if event.ID == "" {
			return true
		}
		out = append(out, event)
		return true
	})
	return out
}

// fieldsOf читает все поля кадра.
func fieldsOf(item *ygo.Map) EventFull {
	return EventFull{
		ID:              stringField(item, "id"),
		ParentID:        stringField(item, "parent_id"),
		Title:           textField(item, "title"),
		Body:            textField(item, "body"),
		EventDate:       stringField(item, "event_date"),
		Assets:          assetList(item.Get("assets")),
		BackgroundKind:  stringField(item, "bg_kind"),
		BackgroundAsset: stringField(item, "bg_asset"),
		BackgroundTone:  stringField(item, "bg_tone"),
		CreatedAt:       stringField(item, "created_at"),
	}
}

// RestoreResult — что именно изменилось при восстановлении.
type RestoreResult struct {
	Removed int
	Added   int
	Updated int
	// Moved — сколько кадров переставлено на своё место. Порядок — тоже содержимое: без
	// этого учёта «человек переставил кадры» восстановление считалось бы пустым и не
	// рассылалось бы никому.
	Moved int
}

// Changed — было ли хоть одно изменение (пустое восстановление рассылать незачем).
func (r RestoreResult) Changed() bool { return r.Removed+r.Added+r.Updated+r.Moved > 0 }

// Restore приводит документ к состоянию `target`.
//
// target должен быть в порядке отображения (родители раньше детей, соседи по порядку) —
// так его и отдаёт EventsFull у сохранённой версии: массив документа хранится именно в
// порядке отображения.
func (d *Doc) Restore(target []EventFull) (RestoreResult, error) {
	var out RestoreResult
	want := make(map[string]EventFull, len(target))
	for _, event := range target {
		if event.ID == "" {
			continue
		}
		want[event.ID] = event
	}
	if len(want) == 0 {
		return out, errors.New("версия не содержит кадров — восстанавливать нечего")
	}

	// Всё, что требует блокировки документа, — до транзакции (см. комментарий в шапке).
	events := ygo.NewArray(d.inner, EventsRoot)
	current := d.EventsFull()
	have := make(map[string]EventFull, len(current))
	for _, event := range current {
		have[event.ID] = event
	}
	// Порядок кадров в текущем документе — чтобы понимать, нужно ли переносить.
	order := make(map[string]int, len(current))
	for i, event := range current {
		order[event.ID] = i
	}

	txn := d.inner.WriteTxn()
	defer txn.Commit()

	// 1. Удаляем то, чего в версии не было. Сначала самые глубокие: удалять главу раньше
	//    её под-событий — значит на шаг оставить детей без родителя.
	extra := make([]EventFull, 0)
	for _, event := range current {
		if _, ok := want[event.ID]; !ok {
			extra = append(extra, event)
		}
	}
	depth := func(id string) int {
		level := 0
		cur, ok := have[id]
		for ok && cur.ParentID != "" && level < 64 {
			level++
			cur, ok = have[cur.ParentID]
		}
		return level
	}
	sort.SliceStable(extra, func(i, j int) bool { return depth(extra[i].ID) > depth(extra[j].ID) })
	for _, event := range extra {
		if deleteEventTxn(txn, events, event.ID) {
			out.Removed++
		}
	}

	// 2. Один проход по версии: каждый кадр встаёт на своё итоговое место. Существующий
	//    либо переписывается, либо переносится (если он не там), отсутствующий —
	//    вставляется. Так за один проход решаются и порядок, и поля.
	at := 0
	for _, event := range target {
		if event.ID == "" {
			continue
		}
		old, exists := have[event.ID]
		switch {
		case !exists:
			writeEventFields(txn, events.InsertMap(txn, clampIndex(at, events.Len())), event)
			out.Added++
		case order[event.ID] == at:
			// Кадр на своём месте: правим только то, что разошлось.
			if !sameEvent(old, event) {
				if item, ok := eventMapTxn(events, event.ID); ok {
					if err := applyEventTxn(txn, item, event); err != nil {
						return out, err
					}
					out.Updated++
				}
			}
		default:
			// Не на своём месте: переносим — как перетаскивание в интерфейсе
			// (вставка копии и удаление оригинала).
			deleteEventTxn(txn, events, event.ID)
			writeEventFields(txn, events.InsertMap(txn, clampIndex(at, events.Len())), event)
			out.Moved++
		}
		at++
	}
	return out, nil
}

// clampIndex — индекс вставки в пределах длины массива.
func clampIndex(index int, length uint64) uint64 {
	if index < 0 {
		return 0
	}
	if uint64(index) > length {
		return length
	}
	return uint64(index)
}

// sameEvent — совпадают ли поля кадра (кроме порядка).
func sameEvent(old, want EventFull) bool {
	return old.Title == want.Title && old.Body == want.Body &&
		old.EventDate == want.EventDate && old.ParentID == want.ParentID &&
		old.BackgroundKind == want.BackgroundKind &&
		old.BackgroundAsset == want.BackgroundAsset &&
		old.BackgroundTone == want.BackgroundTone &&
		old.CreatedAt == want.CreatedAt &&
		sameAssets(old.Assets, want.Assets)
}

// applyEventTxn переписывает поля существующего кадра.
func applyEventTxn(txn *ygo.TransactionMut, item *ygo.Map, event EventFull) error {
	if err := setTextValue(txn, item, "title", event.Title); err != nil {
		return err
	}
	if err := setTextValue(txn, item, "body", event.Body); err != nil {
		return err
	}
	setOptionalString(txn, item, "event_date", event.EventDate)
	setOptionalString(txn, item, "parent_id", event.ParentID)
	setAssetList(txn, item, event.Assets)
	setOptionalString(txn, item, "bg_kind", event.BackgroundKind)
	setOptionalString(txn, item, "bg_asset", event.BackgroundAsset)
	setOptionalString(txn, item, "bg_tone", event.BackgroundTone)
	setOptionalString(txn, item, "created_at", event.CreatedAt)
	return nil
}

// writeEventFields заполняет карту нового кадра.
func writeEventFields(txn *ygo.TransactionMut, item *ygo.Map, event EventFull) {
	item.Set(txn, "id", event.ID)
	setOptionalString(txn, item, "parent_id", event.ParentID)
	if event.Title != "" {
		item.SetText(txn, "title_text").Insert(txn, 0, event.Title)
	}
	if event.Body != "" {
		item.SetText(txn, "body_text").Insert(txn, 0, event.Body)
	}
	setOptionalString(txn, item, "event_date", event.EventDate)
	setAssetList(txn, item, event.Assets)
	setOptionalString(txn, item, "bg_kind", event.BackgroundKind)
	setOptionalString(txn, item, "bg_asset", event.BackgroundAsset)
	setOptionalString(txn, item, "bg_tone", event.BackgroundTone)
	setOptionalString(txn, item, "created_at", event.CreatedAt)
}

// findEventTxn — индекс кадра в массиве (-1, если его нет).
func findEventTxn(events *ygo.Array, eventID string) int {
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
	return index
}

// eventMapTxn — карта кадра по идентификатору.
func eventMapTxn(events *ygo.Array, eventID string) (*ygo.Map, bool) {
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

// deleteEventTxn удаляет кадр по идентификатору.
func deleteEventTxn(txn *ygo.TransactionMut, events *ygo.Array, eventID string) bool {
	index := findEventTxn(events, eventID)
	if index < 0 {
		return false
	}
	events.Delete(txn, uint64(index), 1)
	return true
}

// setTextValue переписывает текстовое поле кадра (Y.Text) и убирает legacy-строку.
func setTextValue(txn *ygo.TransactionMut, item *ygo.Map, field, value string) error {
	text := item.SetText(txn, field+"_text")
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
	item.Delete(txn, field)
	return nil
}

// setOptionalString пишет строковое поле или убирает его, если значение пустое.
func setOptionalString(txn *ygo.TransactionMut, item *ygo.Map, field, value string) {
	if value == "" {
		item.Delete(txn, field)
		return
	}
	item.Set(txn, field, value)
}

// setAssetList пишет список вложений кадра.
func setAssetList(txn *ygo.TransactionMut, item *ygo.Map, assets []string) {
	if len(assets) == 0 {
		item.Delete(txn, "assets")
		return
	}
	list := make([]any, 0, len(assets))
	for _, id := range assets {
		list = append(list, id)
	}
	item.Set(txn, "assets", list)
}

// sameAssets сравнивает списки вложений по порядку и содержимому.
func sameAssets(a, b []string) bool {
	if len(a) != len(b) {
		return false
	}
	for i := range a {
		if a[i] != b[i] {
			return false
		}
	}
	return true
}

// ReviveEvent возвращает удалённый кадр на место — отмена удаления.
//
// Это частный случай Restore, вынесенный отдельно по двум причинам:
//
//   - Restore приводит документ к версии целиком и попутно удаляет то, чего в версии нет.
//     Возвращать один кадр такой ценой нельзя: «вернуть кадр» не должно уносить чужие
//     правки, сделанные после удаления;
//   - позиция известна из снимка (RemovedEvent.Index), и её достаточно — перестраивать
//     порядок всего дерева ради одной вставки не нужно.
//
// Кадр вставляется НОВОЙ картой с прежним значением поля `id`: идентичность кадра в
// проекте — это строка `id`, а не внутренний идентификатор Yjs-объекта (на этом же
// свойстве стоит весь Restore). История правок прежней карты при этом не возвращается —
// в проекции от неё остаются только поля, и это честно: «вернули кадр», а не «отмотали
// историю».
func (d *Doc) ReviveEvent(removed RemovedEvent) (ReviveResult, error) {
	var out ReviveResult
	if strings.TrimSpace(removed.ID) == "" {
		return out, errors.New("нужен идентификатор кадра")
	}

	// Всё, что требует блокировки документа, — до транзакции (как в Restore).
	events := ygo.NewArray(d.inner, EventsRoot)
	current := d.EventsFull()
	known := make(map[string]bool, len(current))
	for _, event := range current {
		known[event.ID] = true
	}
	if known[removed.ID] {
		// Кадр уже вернули (или создали заново с тем же id): второй раз вставлять его
		// нельзя — в документе оказались бы два кадра с одним идентификатором.
		return out, nil
	}
	if removed.ParentID != "" && !known[removed.ParentID] {
		removed.ParentID = ""
		out.Orphan = true
	}

	txn := d.inner.WriteTxn()
	defer txn.Commit()
	index := clampIndex(removed.Index, events.Len())
	writeEventFields(txn, events.InsertMap(txn, index), removed.EventFull)
	out.Inserted = true
	out.Index = int(index)
	return out, nil
}
