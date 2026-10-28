package assistant_test

// answer_readonly_integration_test.go — ответ в общий чат не меняет проект (0.95.0).
//
// Живая проверка поймала дыру: бот, которому запретили менять проект, всё равно создал главу —
// модель прислала вызов инструмента ТЕКСТОВЫМ блоком (`skyfraze-tools`), а этот путь идёт мимо
// списка инструментов в правилах. Поэтому запрет стоит НА ИСПОЛНЕНИИ, и это надо закрепить
// тестом: «в списке не было» — не защита.

import (
	"context"
	"testing"

	"github.com/skyfraze/backend/internal/ai"
)

func TestAnswerIsReadOnly(t *testing.T) {
	// Первый ответ модели — вызов создания главы текстом (так отвечают слабые локальные модели),
	// второй — обычный текст после отказа.
	textCall := `[{"name":"create_chapter","arguments":{"title":"Пролог","body_md":"Начало."}}]`
	e := setup(t, ai.Reply{Content: textCall}, ai.Reply{Content: "Только текстом: сцена держит внимание."})
	ctx := context.Background()
	owner := e.user(t, "owner@example.com")
	projectID, _, _ := e.seedProject(t, owner)

	before, err := e.st.ListEvents(ctx, projectID)
	if err != nil {
		t.Fatalf("кадры до: %v", err)
	}

	answer, err := e.asst.Answer(ctx, owner, projectID, "Нестор, что скажешь про сцену?")
	if err != nil {
		t.Fatalf("ответ в чат: %v", err)
	}
	if answer == "" {
		t.Fatal("пустой ответ")
	}

	after, err := e.st.ListEvents(ctx, projectID)
	if err != nil {
		t.Fatalf("кадры после: %v", err)
	}
	if len(after) != len(before) {
		t.Fatalf("ответ из чата изменил проект: кадров было %d, стало %d", len(before), len(after))
	}
	for _, event := range after {
		if event.Title == "Пролог" {
			t.Fatalf("бот создал главу из чата: %+v", event)
		}
	}
	// Инструмент отклонён, а не выполнен молча: модель получила отказ и ответила текстом.
	if answer == textCall {
		t.Fatalf("ответ остался служебным вызовом: %q", answer)
	}
}
