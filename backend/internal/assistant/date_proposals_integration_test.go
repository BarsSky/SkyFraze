package assistant_test

// date_proposals_integration_test.go — правка ДАТЫ кадра по подтверждению (0.106.0).
//
// Что здесь проверяется и почему именно так:
//
//   - модель предлагает дату, а проект остаётся прежним: дата в проекции и в документе не
//     меняется до нажатия «Применить» — это главное обещание возможности;
//   - применяет человек, и дата доезжает до ОБОИХ мест — таблицы событий и CRDT-документа,
//     который видят открытые вкладки (дата там скалярное поле `event_date`);
//   - «Вернуть» снимает дату обратно, а не подставляет «сегодня»;
//   - если человек сам поменял дату после предложения, применять старое нельзя (иначе
//     затрём его правку), и предложение помечается `superseded`;
//   - формат проверяется ДО предложения: «3 марта» не должно доехать до окна помощника.

import (
	"context"
	"errors"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"

	"github.com/skyfraze/backend/internal/ai"
	"github.com/skyfraze/backend/internal/assistant"
	"github.com/skyfraze/backend/internal/collab/yjs"
	"github.com/skyfraze/backend/internal/store"
)

// docEventDate — дата кадра в CRDT-документе проекта (пусто — даты нет).
func (e *env) docEventDate(t *testing.T, projectID, eventID uuid.UUID) string {
	t.Helper()
	state, err := e.st.GetProjectEventState(context.Background(), projectID)
	if err != nil {
		t.Fatalf("снапшот: %v", err)
	}
	if state == nil {
		return ""
	}
	doc, err := yjs.FromState(state.YjsState)
	if err != nil {
		t.Fatalf("документ: %v", err)
	}
	for _, event := range doc.Events() {
		if event.ID == eventID.String() {
			return event.EventDate
		}
	}
	return ""
}

// projectionDate — дата кадра в таблице событий (пусто — даты нет).
func (e *env) projectionDate(t *testing.T, projectID, eventID uuid.UUID) string {
	t.Helper()
	row, ok := e.eventByID(t, projectID, eventID)
	if !ok {
		t.Fatalf("кадра %v нет в проекции", eventID)
	}
	if row.EventDate == nil {
		return ""
	}
	return row.EventDate.Format("2006-01-02")
}

// newDateProposal заводит предложение даты напрямую (без модели): механику применения
// проверяем дешевле, а путь «модель → инструмент → предложение» — отдельным тестом ниже.
func newDateProposal(t *testing.T, e *env, projectID, userID, eventID uuid.UUID, oldDate, newDate string) uuid.UUID {
	t.Helper()
	row, ok := e.eventByID(t, projectID, eventID)
	if !ok {
		t.Fatalf("кадра %v нет в проекте", eventID)
	}
	change, err := e.st.CreateAIChange(context.Background(), store.AIChange{
		ProjectID: projectID, UserID: userID, Kind: store.AIChangeUpdateDate,
		EventID: eventID, EventTitle: row.Title,
		OldDate: oldDate, NewDate: newDate,
	})
	if err != nil {
		t.Fatalf("предложение даты: %v", err)
	}
	return change.ID
}

// Модель предлагает дату — проект не меняется, формат проверяется до предложения.
func TestDateToolProposesAndDoesNotChangeProject(t *testing.T) {
	e := setup(t,
		ai.Reply{ToolCalls: []ai.ToolCall{createCall(assistant.ToolUpdateDate, map[string]any{
			"id":     placeholderID,
			"date":   "2026-03-05",
			"reason": "в тексте сказано «пятого марта»",
		})}},
		ai.Reply{Content: "Предлагаю поставить кадру дату 5 марта — подтвердите в окне."},
	)
	ctx := context.Background()
	owner := e.user(t, "owner@example.com")
	projectID, chapter, _ := e.seedProject(t, owner)
	e.stub.setReplies(
		ai.Reply{ToolCalls: []ai.ToolCall{createCall(assistant.ToolUpdateDate, map[string]any{
			"id":     chapter.String(),
			"date":   "2026-03-05",
			"reason": "в тексте сказано «пятого марта»",
		})}},
		ai.Reply{Content: "Предлагаю поставить кадру дату 5 марта — подтвердите в окне."},
	)

	turn, err := e.asst.Send(ctx, owner, projectID, uuid.Nil, "stub:stub-1", "Поставь этому кадру 5 марта")
	if err != nil {
		t.Fatalf("вопрос: %v", err)
	}
	if len(turn.Calls) != 1 || !turn.Calls[0].OK {
		t.Fatalf("вызовы: %+v", turn.Calls)
	}
	// Проект НЕ изменился: ни проекция, ни документ.
	if got := e.projectionDate(t, projectID, chapter); got != "" {
		t.Errorf("дата в проекции после предложения: %q, ожидалось пусто", got)
	}
	if got := e.docEventDate(t, projectID, chapter); got != "" {
		t.Errorf("дата в документе после предложения: %q, ожидалось пусто", got)
	}
	// Предложение — ожидающее, со «было/станет».
	pending, err := e.st.PendingAIChanges(ctx, projectID, owner)
	if err != nil {
		t.Fatalf("предложения: %v", err)
	}
	if len(pending) != 1 || pending[0].Kind != store.AIChangeUpdateDate {
		t.Fatalf("ожидалось одно предложение даты: %+v", pending)
	}
	if pending[0].OldDate != "" || pending[0].NewDate != "2026-03-05" {
		t.Errorf("даты предложения: было %q, станет %q", pending[0].OldDate, pending[0].NewDate)
	}
}

// Формат «3 марта» до предложения не доезжает: модель получает отказ словами.
func TestDateToolRejectsNonISODate(t *testing.T) {
	e := setup(t,
		ai.Reply{ToolCalls: []ai.ToolCall{createCall(assistant.ToolUpdateDate, map[string]any{
			"id":   placeholderID,
			"date": "3 марта",
		})}},
		ai.Reply{Content: "Нужна дата в виде 2026-03-03."},
	)
	ctx := context.Background()
	owner := e.user(t, "owner@example.com")
	projectID, chapter, _ := e.seedProject(t, owner)
	e.stub.setReplies(
		ai.Reply{ToolCalls: []ai.ToolCall{createCall(assistant.ToolUpdateDate, map[string]any{
			"id":   chapter.String(),
			"date": "3 марта",
		})}},
		ai.Reply{Content: "Нужна дата в виде 2026-03-03."},
	)

	turn, err := e.asst.Send(ctx, owner, projectID, uuid.Nil, "stub:stub-1", "Поставь 3 марта")
	if err != nil {
		t.Fatalf("вопрос: %v", err)
	}
	if len(turn.Calls) != 1 || turn.Calls[0].OK {
		t.Fatalf("вызов должен быть отвергнут: %+v", turn.Calls)
	}
	if !strings.Contains(turn.Calls[0].Error, "YYYY-MM-DD") {
		t.Errorf("причина отказа: %q", turn.Calls[0].Error)
	}
	pending, err := e.st.PendingAIChanges(ctx, projectID, owner)
	if err != nil {
		t.Fatalf("предложения: %v", err)
	}
	if len(pending) != 0 {
		t.Errorf("предложение не должно создаваться: %+v", pending)
	}
}

// Применение и возврат даты: оба места (таблица и документ) идут вместе.
func TestDateProposalApplyAndRevert(t *testing.T) {
	e := setup(t)
	ctx := context.Background()
	owner := e.user(t, "owner@example.com")
	projectID, chapter, _ := e.seedProject(t, owner)

	id := newDateProposal(t, e, projectID, owner, chapter, "", "2026-03-05")

	if _, _, err := e.asst.ApplyProposal(ctx, owner, owner, projectID, id); err != nil {
		t.Fatalf("применение: %v", err)
	}
	if got := e.projectionDate(t, projectID, chapter); got != "2026-03-05" {
		t.Errorf("дата в проекции после применения: %q", got)
	}
	if got := e.docEventDate(t, projectID, chapter); got != "2026-03-05" {
		t.Errorf("дата в документе после применения: %q", got)
	}

	if _, _, err := e.asst.RevertProposal(ctx, owner, owner, projectID, id); err != nil {
		t.Fatalf("возврат: %v", err)
	}
	if got := e.projectionDate(t, projectID, chapter); got != "" {
		t.Errorf("дата в проекции после возврата: %q, ожидалось пусто", got)
	}
	if got := e.docEventDate(t, projectID, chapter); got != "" {
		t.Errorf("дата в документе после возврата: %q, ожидалось пусто", got)
	}
}

// Человек сам поменял дату после предложения — применять старое нельзя.
func TestDateProposalStaleAfterManualChange(t *testing.T) {
	e := setup(t)
	ctx := context.Background()
	owner := e.user(t, "owner@example.com")
	projectID, chapter, _ := e.seedProject(t, owner)

	id := newDateProposal(t, e, projectID, owner, chapter, "", "2026-03-05")
	// Человек поставил другую дату (это и есть правка, которую нельзя затирать). Меняем её в
	// проекции тем же путём, каким её пишет документ: этого достаточно, чтобы сверка увидела
	// расхождение — а сам путь «документ → проекция» проверен в transfer и collab.
	row, ok := e.eventByID(t, projectID, chapter)
	if !ok {
		t.Fatalf("кадра нет в проекции")
	}
	date, err := time.Parse("2006-01-02", "2026-04-01")
	if err != nil {
		t.Fatalf("дата: %v", err)
	}
	if err := e.st.UpdateEventContent(ctx, projectID, chapter, row.Title, row.Body, &date, owner); err != nil {
		t.Fatalf("правка даты человеком: %v", err)
	}

	if _, _, err := e.asst.ApplyProposal(ctx, owner, owner, projectID, id); !errors.Is(err, assistant.ErrProposalStale) {
		t.Fatalf("применение устаревшего: %v, ожидалось ErrProposalStale", err)
	}
	if got := e.projectionDate(t, projectID, chapter); got != "2026-04-01" {
		t.Errorf("дата после отказа: %q, правка человека должна остаться", got)
	}
	// Предложение помечено устаревшим: повторно оно не всплывёт.
	pending, err := e.st.PendingAIChanges(ctx, projectID, owner)
	if err != nil {
		t.Fatalf("предложения: %v", err)
	}
	if len(pending) != 0 {
		t.Errorf("устаревшее предложение осталось ожидающим: %+v", pending)
	}
}
