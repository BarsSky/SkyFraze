package collab

import (
	"os"
	"path/filepath"
	"testing"

	"github.com/google/uuid"

	"github.com/skyfraze/backend/internal/collab/yjs"
	"github.com/skyfraze/backend/internal/events"
)

// Проекция дерева строится из серверного документа (Фаза 4): строки таблицы events
// собираются из слитого CRDT, а не из payload'а клиента. Здесь проверяется то, что
// раньше делал клиент — порядок, родители, даты — плюс починка структуры, которую
// NormalizeTree иначе отверг бы (сироты и циклы).
func loadDoc(t *testing.T, name string) *yjs.Doc {
	t.Helper()
	raw, err := os.ReadFile(filepath.Join("yjs", "testdata", name))
	if err != nil {
		t.Fatalf("фикстура %s: %v (перегенерировать: cd frontend && npx tsx tests/yjs-fixtures.ts)", name, err)
	}
	doc, err := yjs.FromState(raw)
	if err != nil {
		t.Fatalf("фикстура %s не применилась: %v", name, err)
	}
	return doc
}

func TestProjectionPayloadFromClientSnapshot(t *testing.T) {
	doc := loadDoc(t, "base.bin")
	nodes, signature := projectionPayload(doc)

	if len(nodes) != 2 {
		t.Fatalf("узлов %d, ожидалось 2", len(nodes))
	}
	if nodes[0].Position != 0 || nodes[1].Position != 1 {
		t.Fatalf("порядок не сохранён: %d, %d", nodes[0].Position, nodes[1].Position)
	}
	if nodes[1].ParentID == nil || *nodes[1].ParentID != nodes[0].ID {
		t.Fatalf("родитель под-события не перенесён: %+v", nodes[1])
	}
	if nodes[0].Title == "" || nodes[0].Body == "" {
		t.Fatalf("текст главы не попал в проекцию: %+v", nodes[0])
	}
	if nodes[0].EventDate.Value == nil || nodes[0].EventDate.Value.Format("2006-01-02") != "2789-04-12" {
		t.Fatalf("дата не перенесена: %+v", nodes[0].EventDate.Value)
	}
	if signature == "" {
		t.Fatal("подпись проекции пуста")
	}

	// Подпись стабильна: тот же документ — та же подпись, иначе проекция
	// переписывалась бы на каждом тике.
	if _, again := projectionPayload(doc); again != signature {
		t.Fatalf("подпись нестабильна: %s → %s", signature, again)
	}
}

// Правка текста меняет подпись: значит, проекция обновится, и текст в базе не отстанет.
// Слияние тех же правок в другом порядке даёт тот же текст — и ту же подпись.
func TestProjectionSignatureChangesWithText(t *testing.T) {
	doc := loadDoc(t, "base.bin")
	_, before := projectionPayload(doc)

	if err := doc.Apply(mustRead(t, "edit-a.bin")); err != nil {
		t.Fatalf("правка A: %v", err)
	}
	if err := doc.Apply(mustRead(t, "edit-b.bin")); err != nil {
		t.Fatalf("правка B: %v", err)
	}
	_, after := projectionPayload(doc)
	if before == after {
		t.Fatal("подпись не изменилась после правки текста")
	}

	reverse := loadDoc(t, "base.bin")
	if err := reverse.Apply(mustRead(t, "edit-b.bin")); err != nil {
		t.Fatalf("правка B: %v", err)
	}
	if err := reverse.Apply(mustRead(t, "edit-a.bin")); err != nil {
		t.Fatalf("правка A: %v", err)
	}
	_, reverseSignature := projectionPayload(reverse)
	if reverseSignature != after {
		t.Fatalf("слияние в другом порядке дало другую подпись: %s ≠ %s", reverseSignature, after)
	}
}

// Сироты и циклы поднимаются в корень: иначе NormalizeTree отверг бы дерево, и
// проекция «застряла» бы навсегда.
func TestProjectionRepairsOrphansAndCycles(t *testing.T) {
	doc := loadDoc(t, "base.bin")
	nodes, _ := projectionPayload(doc)
	chapter, step := nodes[0].ID, nodes[1].ID

	t.Run("родителя нет в наборе — узел в корень", func(t *testing.T) {
		broken := append([]events.NodeInput{}, nodes...)
		missing := uuid.MustParse("99999999-9999-4999-8999-999999999999")
		broken[1].ParentID = &missing
		repaired := repairProjectionNodes(broken)
		if repaired[1].ParentID != nil {
			t.Fatalf("сирота осталась с родителем: %+v", repaired[1].ParentID)
		}
		if repaired[0].ParentID != nil {
			t.Fatalf("глава потеряла корень: %+v", repaired[0].ParentID)
		}
	})

	t.Run("цикл разрывается", func(t *testing.T) {
		broken := append([]events.NodeInput{}, nodes...)
		broken[0].ParentID = &step
		broken[1].ParentID = &chapter
		repaired := repairProjectionNodes(broken)
		// Главное — обход родителей завершается: цикла больше нет.
		byID := map[uuid.UUID]*uuid.UUID{}
		for i := range repaired {
			byID[repaired[i].ID] = repaired[i].ParentID
		}
		for id := range byID {
			seen := map[uuid.UUID]bool{}
			cur := byID[id]
			for cur != nil {
				if seen[*cur] {
					t.Fatalf("цикл не разорван на узле %s", id)
				}
				seen[*cur] = true
				cur = byID[*cur]
			}
		}
	})

	t.Run("здоровая структура не меняется", func(t *testing.T) {
		repaired := repairProjectionNodes(nodes)
		if repaired[1].ParentID == nil || *repaired[1].ParentID != chapter {
			t.Fatalf("валидный родитель потерян: %+v", repaired[1].ParentID)
		}
	})
}

func mustRead(t *testing.T, name string) []byte {
	t.Helper()
	raw, err := os.ReadFile(filepath.Join("yjs", "testdata", name))
	if err != nil {
		t.Fatalf("фикстура %s: %v", name, err)
	}
	return raw
}
