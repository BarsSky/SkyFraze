package events

import (
	"time"

	"github.com/google/uuid"
)

// EventSeed — событие в «сыром» виде, как его отдаёт документ: идентификаторы и
// дата строками, потому что так они лежат в CRDT.
//
// Зачем отдельный тип. Узлы проекции собираются из двух источников: серверного
// документа (хаб, Фаза 4) и импорта куска в существующий проект. Оба обязаны
// проходить одни и те же проверки — циклы, сироты, глубина, — поэтому приведение
// к NodeInput живёт здесь, а не в каждом вызывающем.
type EventSeed struct {
	ID        string
	ParentID  string
	Title     string
	Body      string
	EventDate string
	Position  int
}

// NodesFromSeeds превращает сырые события в узлы проекции и чинит структуру,
// которую NormalizeTree иначе отверг бы: родителя нет в наборе (сирота) или
// цепочка родителей замыкается на сам узел — такой узел поднимается в корень.
//
// Чинить, а не отклонять, важно: проекция — единственный путь структуры в
// реляционную модель, и «застрявшее» дерево остановило бы её целиком.
func NodesFromSeeds(seeds []EventSeed) []NodeInput {
	ids := make(map[uuid.UUID]bool, len(seeds))
	for _, s := range seeds {
		if id, err := uuid.Parse(s.ID); err == nil {
			ids[id] = true
		}
	}

	nodes := make([]NodeInput, 0, len(seeds))
	for _, s := range seeds {
		id, err := uuid.Parse(s.ID)
		if err != nil {
			continue
		}
		var parent *uuid.UUID
		if pid, err := uuid.Parse(s.ParentID); err == nil && pid != id && ids[pid] {
			parent = &pid
		}
		nodes = append(nodes, NodeInput{
			ID:       id,
			ParentID: parent,
			Position: s.Position,
			Title:    s.Title,
			Body:     s.Body,
			// Дата из документа приходит строкой «YYYY-MM-DD» или пустой, значит
			// поле авторитетно: пустое значение очищает дату в базе.
			EventDate: EventDatePatch{Set: true, Value: ParseSeedDate(s.EventDate)},
		})
	}

	parentOf := make(map[uuid.UUID]uuid.UUID, len(nodes))
	for _, n := range nodes {
		if n.ParentID != nil {
			parentOf[n.ID] = *n.ParentID
		} else {
			parentOf[n.ID] = uuid.Nil
		}
	}
	for i := range nodes {
		seen := map[uuid.UUID]bool{nodes[i].ID: true}
		cur := parentOf[nodes[i].ID]
		for cur != uuid.Nil {
			if seen[cur] {
				parentOf[nodes[i].ID] = uuid.Nil
				break
			}
			seen[cur] = true
			next, ok := parentOf[cur]
			if !ok {
				parentOf[nodes[i].ID] = uuid.Nil
				break
			}
			cur = next
		}
	}
	for i := range nodes {
		parent := parentOf[nodes[i].ID]
		if parent == uuid.Nil {
			nodes[i].ParentID = nil
			continue
		}
		value := parent
		nodes[i].ParentID = &value
	}
	return nodes
}

// ParseSeedDate читает дату события из CRDT («YYYY-MM-DD»). Пустая или непонятная
// строка означает «даты нет»: сервер её не выдумывает.
func ParseSeedDate(value string) *time.Time {
	if value == "" {
		return nil
	}
	parsed, err := time.Parse("2006-01-02", value)
	if err != nil {
		return nil
	}
	return &parsed
}
