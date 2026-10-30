// Package livedoc — чтение строк проекта из документа живой комнаты (0.139.0).
//
// Зачем отдельный пакет. Текст проекта живёт в двух местах: в CRDT-документе живой комнаты
// (его видят открытые вкладки) и в реляционной проекции таблицы `events` (её обновляет тик
// комнаты раз в несколько секунд). В 0.136–0.138 этот разрыв уже ловили на выгрузке и
// публичной странице: читатель видел ПРОШЛЫЙ текст, потому что брал проекцию. Здесь та же
// логика вынесена в одно место, чтобы ею пользовались все читатели — чат, помощник и
// `GET /events`, — а не только экспорт: иначе «в редакторе одно, в обсуждении другое»
// воспроизводилось бы снова, по одному читателю за релиз.
//
// Почему не «обновлять проекцию чаще». Тик пишет ещё и снапшот целиком; частить им — платить
// за каждую букву. Читателю же нужен не «свежий ряд в таблице», а «тот текст, который сейчас
// в документе», — его и берём напрямую. Комнаты нет (никто не открывал проект, или он живёт
// в другом процессе) — работает прежний путь: проекция.
package livedoc

import (
	"context"
	"sort"
	"time"

	"github.com/google/uuid"

	"github.com/skyfraze/backend/internal/collab/yjs"
	"github.com/skyfraze/backend/internal/store"
)

// dateLayout — формат даты кадра в документе («YYYY-MM-DD»).
const dateLayout = "2006-01-02"

// Live — состояние документа живой комнаты проекта.
//
// Интерфейс, а не зависимость на транспорт: пакеты, которым нужны строки, не должны тащить
// websocket-хаб. Так же устроены `feed.LiveState`, `transfer.LiveState` и
// `events.LiveRestore`. Пусто — комнаты нет.
type Live interface {
	LiveState(ctx context.Context, projectID uuid.UUID) []byte
}

// RowsLive — строки из живой комнаты `live`, если она есть и в документе есть кадры.
// Второе значение — «взяли из комнаты»: false значит «читайте проекцию».
func RowsLive(ctx context.Context, live Live, projectID uuid.UUID) ([]store.Event, bool) {
	if live == nil {
		return nil, false
	}
	state := live.LiveState(ctx, projectID)
	return Rows(state, projectID)
}

// Rows — строки проекта из состояния CRDT-документа в том виде, в каком их отдают
// `store.ListEvents`: те же поля и тот же порядок (глубина, позиция, порядок в документе).
//
// Поля, которых в документе нет (автор, время создания), остаются пустыми: читателям
// (чат, помощник, выгрузка) они не нужны. Глубина в документе не хранится, поэтому
// считается по цепочке родителей — тем же правилом, что у проекции.
//
// Пустое или битое состояние, а также документ без кадров — это «нет данных»: false,
// и вызывающий обязан взять проекцию. Молча возвращать пустой список нельзя: он означал бы
// «в проекте нет кадров» и, например, помощник решил бы, что кадр удалён.
func Rows(state []byte, projectID uuid.UUID) ([]store.Event, bool) {
	if len(state) == 0 {
		return nil, false
	}
	doc, err := yjs.FromState(state)
	if err != nil {
		return nil, false
	}
	rows := doc.Events()
	if len(rows) == 0 {
		return nil, false
	}
	out := make([]store.Event, 0, len(rows))
	for _, row := range rows {
		id, err := uuid.Parse(row.ID)
		if err != nil {
			// Битая строка в документе не повод ронять чтение: пропускаем её, как это
			// делает и клиент (`yFlatTree` пропускает узлы без id).
			continue
		}
		var parent *uuid.UUID
		if row.ParentID != "" {
			if parsed, err := uuid.Parse(row.ParentID); err == nil {
				parent = &parsed
			}
		}
		out = append(out, store.Event{
			ID:        id,
			ProjectID: projectID,
			ParentID:  parent,
			Position:  row.Position,
			Title:     row.Title,
			Body:      row.Body,
			EventDate: parseDate(row.EventDate),
		})
	}
	if len(out) == 0 {
		return nil, false
	}
	fillDepth(out)
	// Проекция отдаёт строки по (глубина, позиция, created_at). В документе created_at нет,
	// поэтому порядок «глубина, позиция» + устойчивость к порядку документа дают тот же
	// обход дерева: родитель раньше детей, соседи — по позиции.
	sort.SliceStable(out, func(i, j int) bool {
		if out[i].Depth != out[j].Depth {
			return out[i].Depth < out[j].Depth
		}
		return out[i].Position < out[j].Position
	})
	return out, true
}

// parseDate переводит дату документа в то же представление, что у проекции.
// Пустая строка и мусор — «даты нет» (так же читает документ и серверная правка).
func parseDate(raw string) *time.Time {
	if raw == "" {
		return nil
	}
	parsed, err := time.Parse(dateLayout, raw)
	if err != nil {
		return nil
	}
	return &parsed
}

// fillDepth расставляет Depth по цепочке родителей.
//
// Цикл в документе теоретически возможен (клиент мог собрать его сам), но чтение не должно
// от него зависать: на повторно встреченном родителе обход останавливается, а такие строки
// остаются на глубине 0 — проекция их всё равно не запишет (`NormalizeTree` откажет).
func fillDepth(rows []store.Event) {
	parentOf := make(map[uuid.UUID]uuid.UUID, len(rows))
	for _, row := range rows {
		if row.ParentID != nil {
			parentOf[row.ID] = *row.ParentID
		}
	}
	depthOf := make(map[uuid.UUID]int16, len(rows))
	for i := range rows {
		id := rows[i].ID
		if _, done := depthOf[id]; done {
			continue
		}
		// chain[0] — сам кадр, chain[1] — его родитель, и так до верхнего элемента,
		// глубину которого мы знаем (или до корня, у которого она 0). Каждый следующий
		// вниз по цепочке на единицу глубже.
		chain := make([]uuid.UUID, 0, 8)
		seen := make(map[uuid.UUID]bool, 8)
		var base int16
		for current := id; ; {
			if known, ok := depthOf[current]; ok {
				// current в цепочку не попал: chain[len-1] — его ребёнок.
				base = known + 1
				break
			}
			parent, hasParent := parentOf[current]
			if !hasParent || seen[current] {
				// Корень цепочки: он сам на глубине 0.
				chain = append(chain, current)
				base = 0
				break
			}
			seen[current] = true
			chain = append(chain, current)
			current = parent
		}
		for j := len(chain) - 1; j >= 0; j-- {
			depthOf[chain[j]] = base
			base++
		}
	}
	for i := range rows {
		rows[i].Depth = depthOf[rows[i].ID]
	}
}
