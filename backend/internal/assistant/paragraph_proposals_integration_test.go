package assistant_test

// paragraph_proposals_integration_test.go — правка кадра абзацами (0.143.0).
//
// Почему эта возможность вообще появилась. Живой прогон на gemma-4-E4B показал: модель
// НЕ может отдать всю главу внутри JSON-аргумента — генерация обрывается на середине
// строки (3 020 знаков, невалидный JSON на позиции 2 718, finish=stop), и вызов не
// разбирается. При этом вход был ~3 000 токенов из 16 384, то есть дело не в контексте,
// а в длине и экранировании ОТВЕТА. Абзац — короткий ответ, и экранировать в нём нечего.
//
// Что проверяется здесь:
//
//   - read_event_paragraphs отдаёт страницу с номерами и общим числом абзацев, и следующая
//     страница берётся с того места, где кончилась предыдущая (контекст набирается частями);
//   - update_event_paragraph НЕ меняет кадр: он сохраняет предложение «было/станет»;
//   - новый текст кадра собирает СЕРВЕР по номеру абзаца — соседние абзацы остаются как были;
//   - применяет человек, и правка доезжает до проекции;
//   - абзаца вне диапазона нет — это отказ модели словами, а не тихая правка соседнего.

import (
	"context"
	"strings"
	"testing"

	"github.com/google/uuid"

	"github.com/skyfraze/backend/internal/ai"
	"github.com/skyfraze/backend/internal/assistant"
	"github.com/skyfraze/backend/internal/store"
)

// paragraphBody — текст кадра в четыре абзаца: на нём видно и страницы, и «соседей».
const paragraphBody = "Первый абзац.\n\nВторой абзац.\n\nТретий абзац.\n\nЧетвёртый абзац."

// seedParagraphProject заводит проект, в котором у главы есть текст в несколько абзацев.
//
// Расставлять тело через ReplaceEventTree, а не через seedProject, приходится потому, что
// seedProject кладёт короткий текст «текст главы» — на нём страницы абзацев не проверить.
func (e *env) seedParagraphProject(t *testing.T, owner uuid.UUID) (uuid.UUID, uuid.UUID) {
	t.Helper()
	ctx := context.Background()
	projectID, _, _ := e.seedProject(t, owner)
	chapter := uuid.New()
	if err := e.st.ReplaceEventTree(ctx, projectID, owner, []store.Event{
		{
			ID: chapter, ProjectID: projectID, Position: 0, Depth: 0,
			Title: "Глава 1", Body: paragraphBody,
		},
	}); err != nil {
		t.Fatalf("текст главы: %v", err)
	}
	return projectID, chapter
}

// toolMessages — то, что модель увидела как результаты вызовов (роль tool).
func (e *env) toolMessages(t *testing.T) string {
	t.Helper()
	var b strings.Builder
	for _, message := range e.stub.lastRequest().Messages {
		if message.Role == "tool" {
			b.WriteString(message.Content)
			b.WriteString("\n")
		}
	}
	return b.String()
}

// Чтение абзацами: страница с номерами и общим числом, продолжение — с нужного места.
func TestParagraphReadGivesPageAndContinuation(t *testing.T) {
	e := setup(t,
		ai.Reply{ToolCalls: []ai.ToolCall{createCall(assistant.ToolReadEventParagraphs, map[string]any{
			"id": placeholderID, "from": 2, "count": 2,
		})}},
		ai.Reply{Content: "Прочитал абзацы 2–3."},
	)
	ctx := context.Background()
	owner := e.user(t, "owner@example.com")
	projectID, chapter := e.seedParagraphProject(t, owner)
	e.stub.replaceArgs(assistant.ToolReadEventParagraphs, map[string]any{"id": chapter.String()})

	turn, err := e.asst.Send(ctx, owner, projectID, uuid.Nil, "stub:stub-1",
		"Что написано во втором и третьем абзацах?")
	if err != nil {
		t.Fatalf("send: %v", err)
	}
	if turn.Answer != "Прочитал абзацы 2–3." {
		t.Fatalf("ответ модели: %q", turn.Answer)
	}

	results := e.toolMessages(t)
	for _, want := range []string{"Второй абзац.", "Третий абзац.", `"total":4`, `"next_from":4`} {
		if !strings.Contains(results, want) {
			t.Fatalf("в результате инструмента нет %q:\n%s", want, results)
		}
	}
	// Первый и четвёртый абзацы в эту страницу не попали — иначе «страница» ничего не режет,
	// и модель снова получает всю главу одним куском.
	for _, unwanted := range []string{"Первый абзац.", "Четвёртый абзац."} {
		if strings.Contains(results, unwanted) {
			t.Fatalf("на странице 2–3 оказался абзац %q:\n%s", unwanted, results)
		}
	}
}

// Модель предлагает правку абзаца — кадр остаётся прежним, пока человек не подтвердил.
func TestParagraphToolProposesAndKeepsProject(t *testing.T) {
	e := setup(t,
		ai.Reply{ToolCalls: []ai.ToolCall{createCall(assistant.ToolUpdateParagraph, map[string]any{
			"id":        placeholderID,
			"paragraph": 2,
			"text":      "Второй абзац — переписан.",
			"reason":    "просили поправить именно его",
		})}},
		ai.Reply{Content: "Предлагаю правку второго абзаца — подтвердите."},
	)
	ctx := context.Background()
	owner := e.user(t, "owner@example.com")
	projectID, chapter := e.seedParagraphProject(t, owner)
	e.stub.replaceArgs(assistant.ToolUpdateParagraph, map[string]any{"id": chapter.String()})

	turn, err := e.asst.Send(ctx, owner, projectID, uuid.Nil, "stub:stub-1",
		"Поправь второй абзац: пусть будет «Второй абзац — переписан.»")
	if err != nil {
		t.Fatalf("send: %v", err)
	}
	if len(turn.Proposals) != 1 {
		t.Fatalf("предложений в ответе: %d, ожидалось 1 (%+v)", len(turn.Proposals), turn)
	}
	if len(turn.Changes) != 0 {
		t.Fatalf("правка не должна попасть в «изменения»: %+v", turn.Changes)
	}
	proposal := turn.Proposals[0]
	if proposal.Kind != store.AIChangeUpdateText || proposal.EventID != chapter {
		t.Fatalf("предложение: %+v", proposal)
	}
	if proposal.OldBody != paragraphBody {
		t.Errorf("снимок «было»: %q", proposal.OldBody)
	}
	wantBody := "Первый абзац.\n\nВторой абзац — переписан.\n\nТретий абзац.\n\nЧетвёртый абзац."
	if proposal.NewBody != wantBody {
		t.Errorf("снимок «станет»:\n%q\nожидался:\n%q", proposal.NewBody, wantBody)
	}

	// Проект НЕ изменился: правка ждёт человека.
	row, _ := e.eventByID(t, projectID, chapter)
	if row.Body != paragraphBody {
		t.Fatalf("текст изменился без подтверждения: %q", row.Body)
	}

	// Применяем — теперь текст новый, и соседние абзацы на месте.
	if _, warning, err := e.asst.ApplyProposal(ctx, owner, owner, projectID, proposal.ID); err != nil {
		t.Fatalf("применение: %v", err)
	} else if warning != "" {
		t.Errorf("предупреждение при применении: %q", warning)
	}
	row, _ = e.eventByID(t, projectID, chapter)
	if row.Body != wantBody {
		t.Fatalf("текст после применения:\n%q\nожидался:\n%q", row.Body, wantBody)
	}
}

// Абзаца с таким номером нет — отказ словами, а не правка соседнего.
func TestParagraphToolRefusesUnknownParagraph(t *testing.T) {
	e := setup(t,
		ai.Reply{ToolCalls: []ai.ToolCall{createCall(assistant.ToolUpdateParagraph, map[string]any{
			"id":        placeholderID,
			"paragraph": 9,
			"text":      "Девятый абзац.",
		})}},
		ai.Reply{Content: "В кадре всего четыре абзаца — уточните, какой править."},
	)
	ctx := context.Background()
	owner := e.user(t, "owner@example.com")
	projectID, chapter := e.seedParagraphProject(t, owner)
	e.stub.replaceArgs(assistant.ToolUpdateParagraph, map[string]any{"id": chapter.String()})

	turn, err := e.asst.Send(ctx, owner, projectID, uuid.Nil, "stub:stub-1", "Поправь девятый абзац")
	if err != nil {
		t.Fatalf("send: %v", err)
	}
	if len(turn.Proposals) != 0 {
		t.Fatalf("предложение по несуществующему абзацу: %+v", turn.Proposals)
	}
	results := e.toolMessages(t)
	if !strings.Contains(results, "всего 4") {
		t.Fatalf("модели не сказали, сколько абзацев есть:\n%s", results)
	}
	row, _ := e.eventByID(t, projectID, chapter)
	if row.Body != paragraphBody {
		t.Fatalf("текст изменился: %q", row.Body)
	}
}
