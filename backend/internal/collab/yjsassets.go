package collab

// yjsassets.go — чтение привязок «событие → вложения» прямо из CRDT-снапшота.
//
// Зачем это бэкенду. Дерево событий живёт в двух местах: реляционная проекция
// (таблица events: id/parent/title/body) и CRDT-снапшот
// (project_event_state.yjs_state). Привязка вложения к кадру существует только в
// CRDT — интерфейс пишет её как map.set('assets', [...]) (см.
// frontend/src/components/editors/EditorsPanel.tsx), а таблица event_assets с
// миграции 0002 пустая. Поэтому выгрузка истории в Markdown, где картинки идут
// после текста своего события, обязана прочитать снапшот: без этого картинки
// некуда поставить.
//
// Читатель намеренно узкий и односторонний. Он разбирает формат update v1 —
// ровно тот, что отдаёт Y.encodeStateAsUpdate (его сохраняет yprovider.ts), — но
// не собирает документ: нужны только items Y.Map с ключами 'id' и 'assets'.
// Соответственно он не разбирает delete set (удаление ключа всё равно приходит
// отдельным item'ом с новым id, а он и так побеждает по правилу «правый выше»)
// и не умеет V2-кодирование. Любая неожиданность в потоке — ошибка, а вызывающий
// (экспорт Markdown) просто не рисует картинки: снапшот для выгрузки не критичен,
// ломать из-за него весь экспорт нельзя.

import (
	"encoding/binary"
	"fmt"
	"math"
	"unicode/utf16"
	"unicode/utf8"

	"github.com/google/uuid"
)

// Биты info-байта item'а (lib0/binary в yjs: BIT5..BIT8).
const (
	yjsBits5 = 0b00011111 // младшие 5 бит — номер типа содержимого
	yjsBit6  = 0b00100000 // в потоке есть ключ (parent sub)
	yjsBit7  = 0b01000000 // в потоке есть right origin
	yjsBit8  = 0b10000000 // в потоке есть origin
)

// Номера типов содержимого item (yjs/structs/Item.js: contentRefs).
const (
	yjsContentDeleted = 1
	yjsContentJSON    = 2
	yjsContentBinary  = 3
	yjsContentString  = 4
	yjsContentEmbed   = 5
	yjsContentFormat  = 6
	yjsContentType    = 7
	yjsContentAny     = 8
	yjsContentDoc     = 9
	yjsInfoSkip       = 10
)

// yjsUndefined отличает undefined от null при разборе ContentAny: для привязок
// вложений это не важно, но поток надо прочитать ровно на столько байт, на
// сколько его записали, иначе разъедется вся дальнейшая разметка структур.
type yjsUndefined struct{}

type yjsID struct {
	client uint64
	clock  uint64
}

// yjsItem — разобранная структура update'а (Item, GC или Skip — последние
// только прокручивают clock).
type yjsItem struct {
	id     yjsID
	length uint64

	// origin/rightOrigin — ссылки на соседей; когда origin задан, yjs НЕ пишет
	// parent/parentSub (см. Item.write: они пишутся только если оба origin'а
	// пусты), и родителя нужно восстановить по origin'у.
	origin      *yjsID
	rightOrigin *yjsID

	// parentName — имя корневого типа ("events"), parentID — id вложенного
	// типа (Y.Map события) внутри него.
	parentName string
	parentID   *yjsID
	parentSub  *string

	contentRef byte
	// values — элементы ContentAny/ContentJSON, value — строка ContentString.
	values []any
	value  string
}

// yjsResolved — восстановленный родитель/ключ item'а.
type yjsResolved struct {
	parentID  *yjsID
	parentSub *string
	ok        bool
}

type yjsDecoder struct {
	buf []byte
	pos int
	err error
}

// AssetBindings читает CRDT-снапшот и возвращает привязки вложений к событиям:
// id события → id вложений в том порядке, в каком они прикреплены в интерфейсе.
//
// Ошибка означает, что снапшот не разобран (чужой формат, V2-кодирование,
// повреждённые данные) — вызывающий должен просто продолжить без привязок.
func AssetBindings(state []byte) (map[uuid.UUID][]uuid.UUID, error) {
	if len(state) == 0 {
		return nil, nil
	}
	items, err := parseYjsItems(state)
	if err != nil {
		return nil, err
	}
	resolved := resolveYjsItems(items)

	// Победитель по ключу — item с наибольшим id: в Yjs при конфликте правый
	// (то есть больший по client/clock) становится текущим значением ключа.
	type winner struct {
		id  yjsID
		val any
	}
	idOf := map[yjsID]winner{}
	assetsOf := map[yjsID]winner{}
	for i := range items {
		it := items[i]
		r := resolved[i]
		if !r.ok || r.parentID == nil || r.parentSub == nil {
			continue
		}
		key := *r.parentID
		var content any
		switch it.contentRef {
		case yjsContentAny:
			if len(it.values) == 1 {
				content = it.values[0]
			}
		case yjsContentString:
			content = it.value
		case yjsContentDeleted:
			content = nil // ключ удалён — значение пустое
		default:
			continue
		}
		switch *r.parentSub {
		case "id":
			if prev, ok := idOf[key]; !ok || yjsIDLess(prev.id, it.id) {
				idOf[key] = winner{id: it.id, val: content}
			}
		case "assets":
			if prev, ok := assetsOf[key]; !ok || yjsIDLess(prev.id, it.id) {
				assetsOf[key] = winner{id: it.id, val: content}
			}
		}
	}

	out := make(map[uuid.UUID][]uuid.UUID, len(idOf))
	for parent, w := range idOf {
		eventID, err := uuid.Parse(yjsString(w.val))
		if err != nil {
			continue
		}
		aw, ok := assetsOf[parent]
		if !ok {
			continue
		}
		var list []uuid.UUID
		for _, raw := range yjsStrings(aw.val) {
			assetID, err := uuid.Parse(raw)
			if err != nil {
				continue
			}
			list = append(list, assetID)
		}
		out[eventID] = list
	}
	return out, nil
}

func yjsIDLess(a, b yjsID) bool {
	if a.client != b.client {
		return a.client < b.client
	}
	return a.clock < b.clock
}

func yjsString(v any) string {
	s, _ := v.(string)
	return s
}

func yjsStrings(v any) []string {
	arr, ok := v.([]any)
	if !ok {
		return nil
	}
	out := make([]string, 0, len(arr))
	for _, raw := range arr {
		if s, ok := raw.(string); ok {
			out = append(out, s)
		}
	}
	return out
}

// ---------- разбор потока ----------

func parseYjsItems(buf []byte) ([]*yjsItem, error) {
	d := &yjsDecoder{buf: buf}
	clients := d.varUint()
	if d.err != nil {
		return nil, d.err
	}
	// Потолок на счётчики: на мусоре varUint легко даёт 2^60, и цикл стал бы
	// бесконечным. Настоящий снапшот проекта сюда не приближается.
	const maxStructs = 1 << 20
	var items []*yjsItem
	for c := uint64(0); c < clients; c++ {
		count := d.varUint()
		client := d.varUint()
		clock := d.varUint()
		if d.err != nil {
			return nil, d.err
		}
		if count > maxStructs {
			return nil, fmt.Errorf("yjs: неправдоподобное число структур (%d)", count)
		}
		for i := uint64(0); i < count; i++ {
			info := d.uint8()
			switch {
			case info == yjsInfoSkip:
				clock += d.varUint()
			case info&yjsBits5 != 0:
				it := d.readItem(client, clock, info)
				items = append(items, it)
				clock += it.length
			default:
				clock += d.varUint() // GC: содержимое уже удалено, осталась длина
			}
			if d.err != nil {
				return nil, d.err
			}
		}
	}
	return items, nil
}

func (d *yjsDecoder) readItem(client, clock uint64, info byte) *yjsItem {
	it := &yjsItem{id: yjsID{client: client, clock: clock}, contentRef: info & yjsBits5}
	if info&yjsBit8 != 0 {
		it.origin = &yjsID{d.varUint(), d.varUint()}
	}
	if info&yjsBit7 != 0 {
		it.rightOrigin = &yjsID{d.varUint(), d.varUint()}
	}
	// yjs пишет parent и parentSub только когда ни origin, ни rightOrigin не
	// заданы: иначе они восстанавливаются по origin'у (см. resolveYjsItems).
	if info&(yjsBit7|yjsBit8) == 0 {
		if d.varUint() == 1 {
			it.parentName = d.varString()
		} else {
			it.parentID = &yjsID{d.varUint(), d.varUint()}
		}
		if info&yjsBit6 != 0 {
			sub := d.varString()
			it.parentSub = &sub
		}
	}
	it.length = d.readContent(it)
	return it
}

// readContent читает содержимое item'а и возвращает его длину (getLength в yjs).
func (d *yjsDecoder) readContent(it *yjsItem) uint64 {
	switch it.contentRef {
	case yjsContentDeleted:
		return d.varUint()
	case yjsContentJSON:
		n := d.varUint()
		return d.skipStrings(n)
	case yjsContentBinary:
		n := d.varUint()
		d.skip(n)
		return 1
	case yjsContentString:
		it.value = d.varString()
		// Длина — в единицах UTF-16 (JS String.length), а не в байтах и не в
		// рунах: на этом держится продвижение clock.
		return uint64(len(utf16.Encode([]rune(it.value))))
	case yjsContentEmbed:
		d.varString() // readJSON: строка с JSON, разбирать её незачем
		return 1
	case yjsContentFormat:
		d.varString()
		d.varString()
		return 1
	case yjsContentType:
		ref := d.varUint()
		// typeRefs: YArray/YMap/YText/YXmlFragment/YXmlText читаются без данных,
		// YXmlElement/YXmlHook — со строкой-именем узла.
		switch ref {
		case 3, 5:
			d.varString()
		case 0, 1, 2, 4, 6:
		default:
			d.fail(fmt.Errorf("yjs: неизвестная ссылка на тип %d", ref))
		}
		return 1
	case yjsContentAny:
		n := d.varUint()
		if n > 1<<20 {
			d.fail(fmt.Errorf("yjs: неправдоподобная длина ContentAny (%d)", n))
			return 1
		}
		it.values = make([]any, 0, n)
		for i := uint64(0); i < n; i++ {
			it.values = append(it.values, d.any())
		}
		return n
	case yjsContentDoc:
		d.varString()
		d.any()
		return 1
	default:
		d.fail(fmt.Errorf("yjs: неизвестный тип содержимого %d", it.contentRef))
		return 1
	}
}

// resolveYjsItems восстанавливает родителя и ключ для каждого item'а. Items,
// записанные поверх существующего ключа Y.Map, приходят без parent/parentSub —
// yjs берёт их у левого соседа (Item.getMissing: parent = left.parent), поэтому
// идём по цепочке origin'ов.
func resolveYjsItems(items []*yjsItem) []yjsResolved {
	byID := make(map[yjsID]*yjsItem, len(items))
	for _, it := range items {
		byID[it.id] = it
	}
	find := func(id yjsID) *yjsItem {
		if it, ok := byID[id]; ok {
			return it
		}
		// origin может указывать внутрь item'а (после склейки/разрезания) —
		// ищем структуру, накрывающую этот clock.
		for _, it := range items {
			if it.id.client == id.client && it.id.clock <= id.clock && id.clock < it.id.clock+it.length {
				return it
			}
		}
		return nil
	}

	resolved := make([]yjsResolved, len(items))
	state := make([]int8, len(items)) // 0 — не разобран, 1 — в процессе, 2 — готово
	indexOf := make(map[*yjsItem]int, len(items))
	for i, it := range items {
		indexOf[it] = i
	}

	var resolve func(i int) yjsResolved
	resolve = func(i int) yjsResolved {
		switch state[i] {
		case 2:
			return resolved[i]
		case 1:
			return yjsResolved{} // цикл по origin'ам: дальше не разбираем
		}
		state[i] = 1
		it := items[i]
		var out yjsResolved
		if it.parentSub != nil {
			out = yjsResolved{parentID: it.parentID, parentSub: it.parentSub, ok: true}
		} else if it.origin != nil {
			if left := find(*it.origin); left != nil && left != it {
				if j, ok := indexOf[left]; ok {
					out = resolve(j)
				}
			}
		}
		resolved[i] = out
		if out.ok {
			state[i] = 2
		} else {
			state[i] = 0 // не смогли — пусть попробуют через другой origin
		}
		return out
	}
	for i := range items {
		resolve(i)
	}
	return resolved
}

// ---------- lib0-декодер ----------

func (d *yjsDecoder) fail(err error) {
	if d.err == nil {
		d.err = err
	}
}

func (d *yjsDecoder) uint8() byte {
	if d.pos >= len(d.buf) {
		d.fail(fmt.Errorf("yjs: неожиданный конец потока"))
		return 0
	}
	b := d.buf[d.pos]
	d.pos++
	return b
}

// varUint — LEB128 без знака (lib0/decoding.readVarUint).
func (d *yjsDecoder) varUint() uint64 {
	var num uint64
	var mult uint64 = 1
	for d.pos < len(d.buf) {
		b := d.buf[d.pos]
		d.pos++
		num += uint64(b&0b0111_1111) * mult
		mult *= 128
		if b < 0b1000_0000 {
			return num
		}
		if mult > math.MaxUint64/128 {
			break
		}
	}
	d.fail(fmt.Errorf("yjs: неожиданный конец потока в varUint"))
	return 0
}

// varInt — целое со знаком (lib0/decoding.readVarInt): первый байт несёт знак.
func (d *yjsDecoder) varInt() int64 {
	b := d.uint8()
	num := uint64(b & 0b0011_1111)
	mult := uint64(64)
	sign := int64(1)
	if b&0b0100_0000 != 0 {
		sign = -1
	}
	if b&0b1000_0000 == 0 {
		return sign * int64(num)
	}
	for d.pos < len(d.buf) {
		b = d.buf[d.pos]
		d.pos++
		num += uint64(b&0b0111_1111) * mult
		mult *= 128
		if b < 0b1000_0000 {
			return sign * int64(num)
		}
		if mult > math.MaxUint64/128 {
			break
		}
	}
	d.fail(fmt.Errorf("yjs: неожиданный конец потока в varInt"))
	return 0
}

func (d *yjsDecoder) varString() string {
	n := d.varUint()
	if d.err != nil {
		return ""
	}
	if n > uint64(len(d.buf)-d.pos) {
		d.fail(fmt.Errorf("yjs: строка длиной %d не помещается в поток", n))
		return ""
	}
	s := string(d.buf[d.pos : d.pos+int(n)])
	d.pos += int(n)
	if !utf8.ValidString(s) {
		// lib0 пишет UTF-8; невалидные байты означают, что мы разъехались.
		d.fail(fmt.Errorf("yjs: строка не в UTF-8"))
		return ""
	}
	return s
}

func (d *yjsDecoder) skip(n uint64) {
	if n > uint64(len(d.buf)-d.pos) {
		d.fail(fmt.Errorf("yjs: пропуск %d байт за концом потока", n))
		return
	}
	d.pos += int(n)
}

func (d *yjsDecoder) skipStrings(n uint64) uint64 {
	if n > 1<<20 {
		d.fail(fmt.Errorf("yjs: неправдоподобное число строк (%d)", n))
		return 1
	}
	for i := uint64(0); i < n; i++ {
		d.varString()
	}
	return n
}

// any читает произвольное значение по lib0/decoding.readAny. Типы, которые нам
// не нужны (объекты, даты, байты), всё равно читаются ровно на свою длину.
func (d *yjsDecoder) any() any {
	tag := d.uint8()
	if d.err != nil {
		return nil
	}
	switch tag {
	case 127:
		return yjsUndefined{}
	case 126:
		return nil
	case 125:
		return d.varInt()
	case 124:
		if d.pos+4 > len(d.buf) {
			d.fail(fmt.Errorf("yjs: обрезан float32"))
			return nil
		}
		v := math.Float32frombits(binary.BigEndian.Uint32(d.buf[d.pos:]))
		d.pos += 4
		return float64(v)
	case 123:
		if d.pos+8 > len(d.buf) {
			d.fail(fmt.Errorf("yjs: обрезан float64"))
			return nil
		}
		v := math.Float64frombits(binary.BigEndian.Uint64(d.buf[d.pos:]))
		d.pos += 8
		return v
	case 122: // bigint
		d.skip(8)
		return nil
	case 121:
		return false
	case 120:
		return true
	case 119:
		return d.varString()
	case 118: // объект: пары ключ-значение
		n := d.varUint()
		if n > 1<<20 {
			d.fail(fmt.Errorf("yjs: неправдоподобный размер объекта (%d)", n))
			return nil
		}
		for i := uint64(0); i < n; i++ {
			d.varString()
			d.any()
		}
		return nil
	case 117: // массив
		n := d.varUint()
		if n > 1<<20 {
			d.fail(fmt.Errorf("yjs: неправдоподобный размер массива (%d)", n))
			return nil
		}
		out := make([]any, 0, n)
		for i := uint64(0); i < n; i++ {
			out = append(out, d.any())
		}
		return out
	case 116: // Uint8Array
		d.skip(d.varUint())
		return nil
	default:
		d.fail(fmt.Errorf("yjs: неизвестный тег значения %d", tag))
		return nil
	}
}
