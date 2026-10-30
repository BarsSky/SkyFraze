package transfer_test

// live_export_test.go — выгрузка берёт текст из живой комнаты (0.138.0).
//
// Зачем. Таблица `events` — проекция серверного документа, и её обновляет тик комнаты раз в
// несколько секунд. Пока он не обновился, `/export.md`, книга и архив отдавали ПРОШЛЫЙ текст:
// ночной e2e ловил это как «маркеры DOCX не доехали до /export.md за 120 секунд». Здесь
// проверяется, что при живой комнате выгрузка берёт её документ, а комнаты нет — прежний путь.

import (
	"bytes"
	"context"
	"strings"
	"testing"

	"github.com/google/uuid"

	"github.com/skyfraze/backend/internal/collab/yjs"
)

// fakeLiveState — подмена живой комнаты: сервису не нужен настоящий хаб, чтобы проверить,
// что выгрузка спрашивает комнату и предпочитает её таблице.
type fakeLiveState struct {
	state []byte
	calls int
}

func (f *fakeLiveState) LiveState(_ context.Context, _ uuid.UUID) []byte {
	f.calls++
	return f.state
}

// liveDocWithBody собирает документ комнаты так же, как его держит сервер: массив событий с
// текстом кадра.
func liveDocWithBody(t *testing.T, title, body string) []byte {
	t.Helper()
	doc := yjs.NewDoc()
	id := uuid.NewString()
	if err := doc.SeedEvents([]yjs.EventSeed{{ID: id, Title: title, Body: body}}); err != nil {
		t.Fatalf("документ комнаты: %v", err)
	}
	return doc.EncodeState()
}

func TestExportMarkdownPrefersLiveRoom(t *testing.T) {
	e := setup(t)
	ctx := context.Background()
	owner := e.user(t, "owner-live-export@example.com")
	projectID := e.seedStoryProject(t, owner)

	// В таблице — прежний текст проекта (его создал seed). В комнате — новый, с маркером.
	live := &fakeLiveState{state: liveDocWithBody(t, "Пролог", "Свежий текст из документа комнаты.")}
	e.transfer.UseLiveState(live)

	var buf bytes.Buffer
	if _, err := e.transfer.ExportMarkdown(ctx, owner, projectID, &buf); err != nil {
		t.Fatalf("выгрузка: %v", err)
	}
	if live.calls == 0 {
		t.Fatal("живая комната не была спрошена: выгрузка пошла по таблице событий")
	}
	if !strings.Contains(buf.String(), "Свежий текст из документа комнаты.") {
		t.Fatalf("в выгрузке нет текста из комнаты:\n%s", buf.String())
	}
}

func TestExportMarkdownFallsBackWhenRoomIsGone(t *testing.T) {
	e := setup(t)
	ctx := context.Background()
	owner := e.user(t, "owner-nolive-export@example.com")
	projectID := e.seedStoryProject(t, owner)

	// Комнаты нет (пустое состояние): выгрузка обязана собраться по проекции и не упасть.
	live := &fakeLiveState{}
	e.transfer.UseLiveState(live)
	var buf bytes.Buffer
	info, err := e.transfer.ExportMarkdown(ctx, owner, projectID, &buf)
	if err != nil {
		t.Fatalf("выгрузка без комнаты: %v", err)
	}
	if live.calls == 0 {
		t.Error("живая комната не была спрошена")
	}
	if info.Events == 0 {
		t.Fatal("без комнаты выгрузка потеряла события проекта")
	}
}
