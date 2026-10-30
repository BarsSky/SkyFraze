package entities_test

// live_state_test.go — упоминания карточек считаются по документу живой комнаты (0.139.0).
//
// Зачем. «Где встречается Анна» и подсветка карточек в панели считаются по тексту кадров.
// Текст брался из проекции таблицы `events`, а её обновляет тик комнаты раз в несколько секунд:
// сразу после того, как персонажа дописали в главу, ответ был прежним (или пустым). Теперь
// источник — документ комнаты, проекция осталась запасным путём.

import (
	"context"
	"testing"

	"github.com/google/uuid"

	"github.com/skyfraze/backend/internal/collab/yjs"
	"github.com/skyfraze/backend/internal/entities"
	"github.com/skyfraze/backend/internal/store"
)

// fakeLive — подмена хаба: сервису карточек не нужна настоящая комната.
type fakeLive struct {
	state []byte
	calls int
}

func (f *fakeLive) LiveState(_ context.Context, _ uuid.UUID) []byte {
	f.calls++
	return f.state
}

func TestUsageUsesLiveDocument(t *testing.T) {
	e := setupEntities(t)
	ctx := context.Background()

	anna, err := e.svc.Create(ctx, e.owner, e.project, entities.Input{Kind: "character", Name: "Анна"})
	if err != nil {
		t.Fatalf("карточка: %v", err)
	}
	// В проекции Анны нет, в документе комнаты — есть: персонажа дописали только что.
	if err := e.st.ReplaceEventTree(ctx, e.project, e.owner, []store.Event{
		{ID: uuid.New(), ProjectID: e.project, Position: 0, Title: "Пролог", Body: "Тишина."},
	}); err != nil {
		t.Fatalf("дерево: %v", err)
	}
	doc := yjs.NewDoc()
	if err := doc.SeedEvents([]yjs.EventSeed{
		{ID: uuid.NewString(), Title: "Пролог", Body: "Анна вошла в комнату."},
	}); err != nil {
		t.Fatalf("документ комнаты: %v", err)
	}
	live := &fakeLive{state: doc.EncodeState()}
	e.svc.UseLiveState(live)

	usage, err := e.svc.Usage(ctx, e.viewer, e.project)
	if err != nil {
		t.Fatalf("usage: %v", err)
	}
	if len(usage) != 1 || usage[0].Mentions != 1 || usage[0].Frames != 1 {
		t.Fatalf("упоминание из документа не найдено: %+v", usage)
	}
	if live.calls == 0 {
		t.Fatal("живая комната не была спрошена")
	}

	frames, err := e.svc.Frames(ctx, e.viewer, e.project, anna.ID)
	if err != nil {
		t.Fatalf("frames: %v", err)
	}
	if len(frames) != 1 || frames[0].Title != "Пролог" || len(frames[0].Quotes) != 1 {
		t.Fatalf("кадры карточки из документа: %+v", frames)
	}
}

func TestUsageFallsBackWithoutRoom(t *testing.T) {
	e := setupEntities(t)
	ctx := context.Background()

	anna, err := e.svc.Create(ctx, e.owner, e.project, entities.Input{Kind: "character", Name: "Анна"})
	if err != nil {
		t.Fatalf("карточка: %v", err)
	}
	if err := e.st.ReplaceEventTree(ctx, e.project, e.owner, []store.Event{
		{ID: uuid.New(), ProjectID: e.project, Position: 0, Title: "Пролог", Body: "Анна вошла."},
	}); err != nil {
		t.Fatalf("дерево: %v", err)
	}
	live := &fakeLive{} // комнаты нет
	e.svc.UseLiveState(live)

	usage, err := e.svc.Usage(ctx, e.viewer, e.project)
	if err != nil {
		t.Fatalf("usage без комнаты: %v", err)
	}
	if len(usage) != 1 || usage[0].Mentions != 1 {
		t.Fatalf("без комнаты потеряна проекция: %+v", usage)
	}
	if frames, err := e.svc.Frames(ctx, e.viewer, e.project, anna.ID); err != nil || len(frames) != 1 {
		t.Fatalf("frames без комнаты: %v / %+v", err, frames)
	}
	if live.calls == 0 {
		t.Error("живая комната не была спрошена")
	}
}
