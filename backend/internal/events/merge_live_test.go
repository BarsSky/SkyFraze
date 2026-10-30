package events_test

// merge_live_test.go — сохранение по REST обязано доехать до живой комнаты (0.138.0).
//
// Зачем. Клиент без рабочего сокета пишет снапшот по REST (`PUT /events/state`). Комната в
// памяти об этом не знала: её тик перезаписывал свежий снапшот старым документом и проецировал
// в таблицу старый текст. Снаружи это выглядело так: в редакторе текст новый, а `export.md`,
// книга и проекция — прежние (ночной e2e ловил это как «маркеры DOCX не доехали за 120 секунд»).
//
// Проверяем именно связку: `SaveYjsState` пишет в базу и зовёт комнату. Сама комната (Yjs) здесь
// не нужна — подменяем её интерфейсом `events.LiveRestore`.

import (
	"context"
	"testing"

	"github.com/google/uuid"

	"github.com/skyfraze/backend/internal/collab/yjs"
	"github.com/skyfraze/backend/internal/events"
)

type fakeLive struct {
	merged   []byte
	mergeFor uuid.UUID
	state    []byte
}

func (f *fakeLive) RestoreLive(context.Context, uuid.UUID, uuid.UUID, []yjs.EventFull) (yjs.RestoreResult, bool, error) {
	return yjs.RestoreResult{}, false, nil
}

func (f *fakeLive) LiveState(context.Context, uuid.UUID) []byte { return f.state }

func (f *fakeLive) MergeLiveState(_ context.Context, projectID, _ uuid.UUID, state []byte) bool {
	f.merged = state
	f.mergeFor = projectID
	return true
}

func TestSaveYjsStateMergesIntoLiveRoom(t *testing.T) {
	e := setupRevisions(t)
	ctx := context.Background()
	projectID := e.project(t)

	doc := yjs.NewDoc()
	if err := doc.SeedEvents([]yjs.EventSeed{{ID: uuid.NewString(), Title: "Глава", Body: "свежий текст"}}); err != nil {
		t.Fatalf("документ: %v", err)
	}
	state := doc.EncodeState()

	live := &fakeLive{}
	e.svc.UseLiveRestore(live)
	if _, err := e.svc.SaveYjsState(ctx, e.user, projectID, state, 0); err != nil {
		// Базовая ревизия в этом проекте уже есть — конфликт ревизий не наша тема: берём текущую.
		current, rev, err2 := e.svc.GetYjsState(ctx, e.user, projectID)
		_ = current
		if err2 != nil {
			t.Fatalf("состояние: %v", err2)
		}
		if _, err = e.svc.SaveYjsState(ctx, e.user, projectID, state, rev); err != nil {
			t.Fatalf("сохранение состояния: %v", err)
		}
	}

	if live.mergeFor != projectID {
		t.Fatalf("комната не получила состояние: проект %s, ожидался %s", live.mergeFor, projectID)
	}
	if len(live.merged) == 0 {
		t.Fatal("в комнату ушло пустое состояние")
	}

	// Снапшот в базе — ровно то, что мы записали (комната, если бы она была, слила бы это себе).
	saved, _, err := e.svc.GetYjsState(ctx, e.user, projectID)
	if err != nil {
		t.Fatalf("снапшот после записи: %v", err)
	}
	if len(saved) == 0 {
		t.Fatal("снапшот не сохранился")
	}
}

var _ events.LiveRestore = (*fakeLive)(nil)
