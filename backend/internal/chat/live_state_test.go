package chat_test

// live_state_test.go — цитата проверяется по документу живой комнаты (0.139.0).
//
// Зачем. Проекцию таблицы `events` обновляет тик комнаты раз в несколько секунд. Человек
// выделяет только что написанную фразу и отправляет её в чат — а сервер сверял цитату с
// проекцией и отвечал «такой фразы в тексте кадра нет». Отказ приходил на собственную правку,
// которую человек видит на экране.
//
// Проверяем три состояния: документ главнее таблицы, без комнаты работает проекция, и «кадра
// нет в документе» — это «нет кадра», а не повод поискать его в таблице (документ не старее).

import (
	"context"
	"errors"
	"testing"

	"github.com/google/uuid"

	"github.com/skyfraze/backend/internal/chat"
	"github.com/skyfraze/backend/internal/collab/yjs"
)

// fakeLive — подмена хаба: сервису чата не нужна настоящая комната, чтобы проверить, что он
// спрашивает её и предпочитает проекции.
type fakeLive struct {
	state []byte
	calls int
}

func (f *fakeLive) LiveState(_ context.Context, _ uuid.UUID) []byte {
	f.calls++
	return f.state
}

// liveDoc собирает документ комнаты из одного кадра с заданным текстом.
func liveDoc(t *testing.T, eventID uuid.UUID, title, body string) []byte {
	t.Helper()
	doc := yjs.NewDoc()
	if err := doc.SeedEvents([]yjs.EventSeed{
		{ID: eventID.String(), Title: title, Body: body},
	}); err != nil {
		t.Fatalf("документ комнаты: %v", err)
	}
	return doc.EncodeState()
}

func TestChatQuoteUsesLiveDocument(t *testing.T) {
	e := setupChat(t)
	ctx := context.Background()

	// В проекции — прежний текст, в документе — только что написанный.
	id := e.frame(t, "Глава 1", "Земля ещё спит.")
	live := &fakeLive{state: liveDoc(t, id, "Глава 1", "Анна стоит на пороге, и земля ещё спит.")}
	e.svc.UseLiveState(live)

	answer, err := e.svc.Post(ctx, e.owner, e.project, chat.Input{
		Body: "Смотри, как лучше стало", EventID: &id, Quote: "Анна стоит на пороге",
	})
	if err != nil {
		t.Fatalf("цитата из документа комнаты отклонена: %v", err)
	}
	if answer.Message.Quote != "Анна стоит на пороге" {
		t.Fatalf("цитата в сообщении: %q", answer.Message.Quote)
	}
	if live.calls == 0 {
		t.Fatal("живая комната не была спрошена: цитата проверялась по проекции")
	}
}

func TestChatQuoteFromProjectionIsRefusedWhenDocumentDisagrees(t *testing.T) {
	e := setupChat(t)
	ctx := context.Background()

	// Таблица ещё помнит фразу, документ её уже не содержит (текст переписан).
	id := e.frame(t, "Глава 1", "Земля ещё спит.")
	e.svc.UseLiveState(&fakeLive{state: liveDoc(t, id, "Глава 1", "Совсем другой текст главы.")})

	_, err := e.svc.Post(ctx, e.owner, e.project, chat.Input{
		Body: "Вот эта фраза", EventID: &id, Quote: "Земля ещё спит",
	})
	if !errors.Is(err, chat.ErrQuoteNotFound) {
		t.Fatalf("цитата из устаревшей таблицы принята: %v", err)
	}
}

func TestChatQuoteFallsBackWithoutRoom(t *testing.T) {
	e := setupChat(t)
	ctx := context.Background()

	// Комнаты нет в этом процессе (пустое состояние): работает прежний путь — проекция.
	id := e.frame(t, "Глава 1", "Земля ещё спит.")
	live := &fakeLive{}
	e.svc.UseLiveState(live)

	if _, err := e.svc.Post(ctx, e.owner, e.project, chat.Input{
		Body: "Вот эта фраза", EventID: &id, Quote: "Земля ещё спит",
	}); err != nil {
		t.Fatalf("без комнаты цитата из проекции отклонена: %v", err)
	}
	if live.calls == 0 {
		t.Error("живая комната не была спрошена")
	}
}

func TestChatMissingFrameInDocumentIsNotFound(t *testing.T) {
	e := setupChat(t)
	ctx := context.Background()

	// В документе один кадр, в таблице — другой: id из таблицы в комнате отсутствует.
	id := e.frame(t, "Глава 1", "Земля ещё спит.")
	other := uuid.New()
	e.svc.UseLiveState(&fakeLive{state: liveDoc(t, other, "Другая глава", "текст")})

	_, err := e.svc.Post(ctx, e.owner, e.project, chat.Input{
		Body: "Вот эта фраза", EventID: &id, Quote: "Земля ещё спит",
	})
	if !errors.Is(err, chat.ErrEventNotFound) {
		t.Fatalf("кадр, которого нет в документе, принят по таблице: %v", err)
	}
}
