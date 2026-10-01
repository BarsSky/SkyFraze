package events

import (
	"encoding/json"
	"errors"
	"fmt"
	"sort"
	"strings"
	"time"

	"github.com/google/uuid"

	"github.com/skyfraze/backend/internal/store"
)

// MaxDepth — максимальная глубина вложенности (0 = глава, 1 = под-событие, ...).
const MaxDepth = 4

// FitsDepth — укладывается ли событие на этой глубине в предел дерева.
//
// Одно место для этого правила: глубину ограничивают и обычные события, и импорт
// «в место». Проверять её нужно заранее: `NormalizeTree` отвергает слишком
// глубокое дерево уже ПОСЛЕ вставки в документ, и проекция таблицы событий
// осталась бы устаревшей, а документ — с событиями, которых в таблице нет.
func FitsDepth(depth int) bool {
	return depth <= MaxDepth
}

// ErrValidation — данные не проходят проверку иерархии/полей.
var ErrValidation = errors.New("validation failed")

// NodeInput — событие в плоском payload'е (создание/синхронизация дерева).
type NodeInput struct {
	ID        uuid.UUID      `json:"id"`
	ParentID  *uuid.UUID     `json:"parent_id"`
	Position  int            `json:"position"`
	Title     string         `json:"title"`
	Body      string         `json:"body"`
	EventDate EventDatePatch `json:"event_date"`
}

// EventDatePatch — дата события с различением «не пришла» и «очищена».
//
// Проекция дерева приходит от клиента, который мог дату и не видеть: у старых
// снапшотов её в CRDT нет вовсе, а у импортированного проекта она есть только в
// таблице events. Если считать отсутствие поля очисткой, первая же проекция
// такого клиента сотрёт дату — ровно то, от чего защищает ревизия снапшота.
// Поэтому состояний три:
//   - поля нет в JSON        → Set=false: дату в базе не трогаем;
//   - поле null или ""       → Set=true, Value=nil: дату очищаем;
//   - поле с датой           → Set=true, Value=<дата>: дату записываем.
//
// «Поля нет» получается само собой: encoding/json не вызывает UnmarshalJSON для
// отсутствующего ключа, а Set выставляется только внутри него.
type EventDatePatch struct {
	Set   bool
	Value *time.Time
}

func (p *EventDatePatch) UnmarshalJSON(data []byte) error {
	p.Set = true
	text := strings.TrimSpace(string(data))
	if text == "null" || text == `""` {
		p.Value = nil
		return nil
	}
	var t time.Time
	if err := json.Unmarshal(data, &t); err != nil {
		return err
	}
	p.Value = &t
	return nil
}

// NormalizedNode — проверенный узел с вычисленной глубиной и позицией.
type NormalizedNode struct {
	NodeInput
	Depth int16
}

// TreeEvent — узел дерева в ответе API.
type TreeEvent struct {
	store.Event
	Children []TreeEvent `json:"children"`
}

// NormalizeTree проверяет плоский список событий и возвращает его в виде,
// пригодном для записи в БД:
//
//   - пустой/нулевой id и дубликаты id → ошибка;
//   - parent_id == id → ошибка;
//   - parent_id отсутствует в наборе (чужой проект, удалённый родитель) → ошибка;
//   - цикл в иерархии → ошибка (детектируется обходом в глубину);
//   - глубина больше MaxDepth → ошибка;
//   - position переиндексовывается 0..n-1 внутри каждой группы соседей
//     (порядок соседей — как во входном списке);
//   - результат отсортирован по глубине (родители раньше детей), чтобы
//     вставка не нарушала FK parent_id.
func NormalizeTree(nodes []NodeInput) ([]NormalizedNode, error) {
	if len(nodes) == 0 {
		return nil, nil
	}

	parentOf := make(map[uuid.UUID]*uuid.UUID, len(nodes))
	seen := make(map[uuid.UUID]bool, len(nodes))
	for i := range nodes {
		n := nodes[i]
		if n.ID == uuid.Nil {
			return nil, fmt.Errorf("%w: событие #%d без id", ErrValidation, i)
		}
		if seen[n.ID] {
			return nil, fmt.Errorf("%w: дубликат id %s", ErrValidation, n.ID)
		}
		seen[n.ID] = true
		if n.ParentID != nil && *n.ParentID == n.ID {
			return nil, fmt.Errorf("%w: событие %s не может быть родителем самому себе", ErrValidation, n.ID)
		}
		parentOf[n.ID] = n.ParentID
	}
	for i := range nodes {
		pid := nodes[i].ParentID
		if pid != nil && !seen[*pid] {
			return nil, fmt.Errorf("%w: родитель %s события %s не найден в проекте",
				ErrValidation, *pid, nodes[i].ID)
		}
	}

	const (
		stateNew = iota
		stateInProgress
		stateDone
	)
	state := make(map[uuid.UUID]int, len(nodes))
	depth := make(map[uuid.UUID]int, len(nodes))

	var visit func(id uuid.UUID) (int, error)
	visit = func(id uuid.UUID) (int, error) {
		switch state[id] {
		case stateDone:
			return depth[id], nil
		case stateInProgress:
			return 0, fmt.Errorf("%w: цикл в иерархии событий (узел %s)", ErrValidation, id)
		}
		state[id] = stateInProgress
		d := 0
		if pid := parentOf[id]; pid != nil {
			parentDepth, err := visit(*pid)
			if err != nil {
				return 0, err
			}
			d = parentDepth + 1
		}
		if d > MaxDepth {
			return 0, fmt.Errorf("%w: глубина %d превышает максимум %d (событие %s)",
				ErrValidation, d, MaxDepth, id)
		}
		state[id] = stateDone
		depth[id] = d
		return d, nil
	}
	for i := range nodes {
		if _, err := visit(nodes[i].ID); err != nil {
			return nil, err
		}
	}

	out := make([]NormalizedNode, 0, len(nodes))
	nextPosition := make(map[uuid.UUID]int, len(nodes))
	for i := range nodes {
		n := nodes[i]
		group := uuid.Nil
		if n.ParentID != nil {
			group = *n.ParentID
		}
		position := nextPosition[group]
		nextPosition[group] = position + 1
		n.Position = position
		out = append(out, NormalizedNode{NodeInput: n, Depth: int16(depth[n.ID])})
	}

	sort.SliceStable(out, func(i, j int) bool { return out[i].Depth < out[j].Depth })
	return out, nil
}

// BuildTree собирает дерево из плоских строк БД.
//
// Строки приходят отсортированными (depth, position, created_at), поэтому
// порядок соседей сохраняется. Сироты (родитель удалён/чужой проект)
// поднимаются в корень — событие не исчезает из выдачи.
func BuildTree(evs []store.Event) []TreeEvent {
	known := make(map[uuid.UUID]bool, len(evs))
	for _, e := range evs {
		known[e.ID] = true
	}
	childrenOf := make(map[uuid.UUID][]store.Event, len(evs))
	roots := make([]store.Event, 0, len(evs))
	for _, e := range evs {
		if e.ParentID != nil && known[*e.ParentID] {
			childrenOf[*e.ParentID] = append(childrenOf[*e.ParentID], e)
			continue
		}
		e.Depth = 0
		roots = append(roots, e)
	}

	var build func(list []store.Event) []TreeEvent
	build = func(list []store.Event) []TreeEvent {
		out := make([]TreeEvent, 0, len(list))
		for _, e := range list {
			node := TreeEvent{Event: e, Children: []TreeEvent{}}
			if kids, ok := childrenOf[e.ID]; ok {
				node.Children = build(kids)
			}
			out = append(out, node)
		}
		return out
	}
	return build(roots)
}

// DescendantsIDs возвращает всех потомков события (без него самого).
func DescendantsIDs(evs []store.Event, id uuid.UUID) map[uuid.UUID]bool {
	childrenOf := make(map[uuid.UUID][]uuid.UUID, len(evs))
	for _, e := range evs {
		if e.ParentID != nil {
			childrenOf[*e.ParentID] = append(childrenOf[*e.ParentID], e.ID)
		}
	}
	out := make(map[uuid.UUID]bool)
	var walk func(uuid.UUID)
	walk = func(cur uuid.UUID) {
		for _, child := range childrenOf[cur] {
			if out[child] {
				continue
			}
			out[child] = true
			walk(child)
		}
	}
	walk(id)
	return out
}
