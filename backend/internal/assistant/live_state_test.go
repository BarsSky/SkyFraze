package assistant

// live_state_test.go — помощник читает документ живой комнаты (0.139.0).
//
// Зачем. Помощник читал дерево проекта из проекции таблицы `events`, а она обновляется тиком
// комнаты раз в несколько секунд. В эти секунды модель видела ПРЕЖНИЙ текст — и предлагала
// правку по нему, а проверка «кадр не изменился с момента предложения» прощала правку,
// сделанную буквально только что. Путь записи при этом давно идёт в документ, так что читать
// проекцию было несимметрично.
//
// Тесты внутренние: `currentEvents` и сверки предложения — не экспорт, а именно они решают,
// какой источник правды у модели. База не нужна: при живой комнате до `store` дело не доходит.

import (
	"context"
	"errors"
	"testing"

	"github.com/google/uuid"

	"github.com/skyfraze/backend/internal/ai"
	"github.com/skyfraze/backend/internal/collab/yjs"
)

// fakeLive — подмена хаба: сервису не нужна настоящая комната, чтобы проверить выбор источника.
type fakeLive struct {
	state []byte
	calls int
}

func (f *fakeLive) LiveState(_ context.Context, _ uuid.UUID) []byte {
	f.calls++
	return f.state
}

// liveDoc собирает документ комнаты с одним кадром (или с главой и её под-событием).
func liveDoc(t *testing.T, seeds ...yjs.EventSeed) []byte {
	t.Helper()
	doc := yjs.NewDoc()
	if err := doc.SeedEvents(seeds); err != nil {
		t.Fatalf("документ комнаты: %v", err)
	}
	return doc.EncodeState()
}

func TestToolReadEventUsesLiveDocument(t *testing.T) {
	projectID := uuid.New()
	chapter, scene := uuid.New(), uuid.New()
	live := &fakeLive{state: liveDoc(t,
		yjs.EventSeed{ID: chapter.String(), Title: "Глава", Body: "свежий текст главы"},
		yjs.EventSeed{ID: scene.String(), ParentID: chapter.String(), Title: "Сцена", Body: "только что дописано"},
	)}
	svc := &Service{live: live}

	res := svc.toolReadEvent(context.Background(), projectID, ai.ToolCall{
		ID: "call-1", Name: ToolReadEvent, Arguments: map[string]any{"id": scene.String()},
	})
	if !res.report.OK {
		t.Fatalf("read_event отказал: %s", res.report.Detail)
	}
	payload, ok := res.payload.(map[string]any)
	if !ok {
		t.Fatalf("payload не карта: %T", res.payload)
	}
	if payload["body_md"] != "только что дописано" {
		t.Fatalf("модель получила не текст документа: %v", payload["body_md"])
	}
	// Глубина в документе не хранится: помощник обязан видеть уровень так же, как в проекции.
	if payload["depth"] != int16(1) {
		t.Fatalf("глубина сцены: %v, ожидалось 1", payload["depth"])
	}
	if live.calls == 0 {
		t.Fatal("живая комната не была спрошена")
	}
}

func TestToolListEventsUsesLiveDocument(t *testing.T) {
	projectID := uuid.New()
	live := &fakeLive{state: liveDoc(t,
		yjs.EventSeed{ID: uuid.NewString(), Title: "Глава из документа", Body: "текст"},
	)}
	svc := &Service{live: live}

	res := svc.toolListEvents(context.Background(), projectID, ai.ToolCall{
		ID: "call-2", Name: ToolListEvents, Arguments: map[string]any{},
	})
	if !res.report.OK {
		t.Fatalf("list_events отказал: %s", res.report.Detail)
	}
	payload, ok := res.payload.(map[string]any)
	if !ok {
		t.Fatalf("payload не карта: %T", res.payload)
	}
	rows, ok := payload["events"].([]treeRow)
	if !ok || len(rows) != 1 {
		t.Fatalf("события: %v", payload["events"])
	}
	if rows[0].Title != "Глава из документа" || rows[0].Depth != 0 {
		t.Fatalf("list_events отдал не документ: %+v", rows[0])
	}
}

// TestRequireUnchangedComparesLiveDocument — сверка предложения идёт по документу.
//
// Это ровно та проверка, что защищает человека от «применить правку, которую он уже отменил
// сам»: если смотреть в проекцию, правка секунду назад не считалась изменением.
func TestRequireUnchangedComparesLiveDocument(t *testing.T) {
	ctx := context.Background()
	projectID, eventID := uuid.New(), uuid.New()
	svc := &Service{live: &fakeLive{state: liveDoc(t,
		yjs.EventSeed{ID: eventID.String(), Title: "Глава", Body: "новый текст"},
	)}}

	if err := svc.requireUnchanged(ctx, projectID, eventID, "Глава", "новый текст"); err != nil {
		t.Fatalf("сверка с документом: %v", err)
	}
	err := svc.requireUnchanged(ctx, projectID, eventID, "Глава", "прежний текст")
	if !errors.Is(err, ErrProposalStale) {
		t.Fatalf("устаревшее предложение не отклонено: %v", err)
	}
	// Кадра нет в документе — значит его нет: «не изменился» подтверждать нечем.
	err = svc.requireUnchanged(ctx, projectID, uuid.New(), "Глава", "новый текст")
	if !errors.Is(err, ErrProposalStale) {
		t.Fatalf("отсутствующий кадр не отклонён: %v", err)
	}
}

// TestRequireParentUnchangedComparesLiveDocument — перенос кадра сверяется по документу.
func TestRequireParentUnchangedComparesLiveDocument(t *testing.T) {
	ctx := context.Background()
	projectID, chapter, scene := uuid.New(), uuid.New(), uuid.New()
	svc := &Service{live: &fakeLive{state: liveDoc(t,
		yjs.EventSeed{ID: chapter.String(), Title: "Глава", Body: "текст"},
		yjs.EventSeed{ID: scene.String(), ParentID: chapter.String(), Title: "Сцена", Body: "текст"},
	)}}

	if err := svc.requireParentUnchanged(ctx, projectID, scene, &chapter); err != nil {
		t.Fatalf("родитель из документа: %v", err)
	}
	if err := svc.requireParentUnchanged(ctx, projectID, scene, nil); !errors.Is(err, ErrProposalStale) {
		t.Fatalf("смена уровня не замечена: %v", err)
	}
}
