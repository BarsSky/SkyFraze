package assistant_test

// proposals_integration_test.go — правки существующих кадров по подтверждению (фаза 6).
//
// Что здесь важно проверить и почему именно так:
//
//   - модель НЕ меняет проект: после вызова update_event_text/delete_event текст в
//     проекции и в CRDT-документе прежний (это главное обещание возможности);
//   - применяет человек, и правка доезжает до ОБОИХ мест — таблицы событий и документа,
//     который видят открытые вкладки;
//   - «Вернуть» возвращает прежний текст (снимок «до» лежит в предложении);
//   - кадр, изменённый после предложения, применить нельзя (иначе затрём чужую правку);
//   - удаление с детьми не предлагается вовсе, а повторное «Применить» ничего не делает
//     дважды.

import (
	"context"
	"errors"
	"strings"
	"testing"

	"github.com/google/uuid"

	"github.com/skyfraze/backend/internal/ai"
	"github.com/skyfraze/backend/internal/assistant"
	"github.com/skyfraze/backend/internal/collab/yjs"
	"github.com/skyfraze/backend/internal/store"
)

// placeholderID — «идентификатор будет подставлен позже»: setup принимает ответы
// заглушки заранее, а настоящий id кадра появляется только после seedProject.
const placeholderID = "будет-подставлен"

// replaceArgs подставляет аргументы в ещё не отданные ответы заглушки.
func (p *stubProvider) replaceArgs(tool string, args map[string]any) {
	p.mu.Lock()
	defer p.mu.Unlock()
	for i := range p.replies {
		for j := range p.replies[i].ToolCalls {
			if p.replies[i].ToolCalls[j].Name != tool {
				continue
			}
			for key, value := range args {
				p.replies[i].ToolCalls[j].Arguments[key] = value
			}
		}
	}
}

// newProposal заводит предложение напрямую (без модели): механику применения проверяем
// дешевле, чем через заглушку провайдера, а путь «модель → предложение» проверяется
// отдельным тестом ниже.
func newProposal(
	t *testing.T, e *env, projectID, userID, eventID uuid.UUID, kind, newTitle, newBody string,
) uuid.UUID {
	t.Helper()
	row, ok := e.eventByID(t, projectID, eventID)
	if !ok {
		t.Fatalf("кадра %v нет в проекте", eventID)
	}
	change, err := e.st.CreateAIChange(context.Background(), store.AIChange{
		ProjectID: projectID, UserID: userID, Kind: kind,
		EventID: eventID, EventTitle: row.Title,
		OldTitle: row.Title, OldBody: row.Body, NewTitle: newTitle, NewBody: newBody,
	})
	if err != nil {
		t.Fatalf("предложение: %v", err)
	}
	return change.ID
}

func (e *env) eventByID(t *testing.T, projectID, eventID uuid.UUID) (store.Event, bool) {
	t.Helper()
	list, err := e.st.ListEvents(context.Background(), projectID)
	if err != nil {
		t.Fatalf("события: %v", err)
	}
	for _, row := range list {
		if row.ID == eventID {
			return row, true
		}
	}
	return store.Event{}, false
}

// seedSnapshot собирает CRDT-снапшот из проекции: так выглядит проект, который хоть раз
// открывали в живой комнате. Без него проверять «текст в документе не изменился» не на
// чем — у проекта, который никто не открывал, документа нет вовсе.
func (e *env) seedSnapshot(t *testing.T, projectID, by uuid.UUID) {
	t.Helper()
	ctx := context.Background()
	rows, err := e.st.ListEvents(ctx, projectID)
	if err != nil {
		t.Fatalf("события: %v", err)
	}
	seeds := make([]yjs.EventSeed, 0, len(rows))
	for _, row := range rows {
		seed := yjs.EventSeed{ID: row.ID.String(), Title: row.Title, Body: row.Body}
		if row.ParentID != nil {
			seed.ParentID = row.ParentID.String()
		}
		seeds = append(seeds, seed)
	}
	doc := yjs.NewDoc()
	if err := doc.SeedEvents(seeds); err != nil {
		t.Fatalf("снапшот: %v", err)
	}
	if _, err := e.st.SaveProjectEventStateServer(ctx, projectID, by, doc.EncodeState()); err != nil {
		t.Fatalf("сохранение снапшота: %v", err)
	}
}

// Модель предлагает переписать кадр — и проект остаётся прежним.
func TestProposalUpdateTextDoesNotChangeProjectUntilApplied(t *testing.T) {
	e := setup(t,
		ai.Reply{ToolCalls: []ai.ToolCall{createCall(assistant.ToolUpdateText, map[string]any{
			"id":      placeholderID,
			"body_md": "Новый текст главы.",
			"reason":  "короче и по делу",
		})}},
		ai.Reply{Content: "Предлагаю переписать первую главу."},
	)
	ctx := context.Background()
	owner := e.user(t, "owner@example.com")
	projectID, chapter, _ := e.seedProject(t, owner)
	// Снапшот из проекции: иначе «текст в документе не изменился» проверить не на чем —
	// проекта, который никто не открывал, в документе нет вовсе.
	e.seedSnapshot(t, projectID, owner)

	// Идентификатор кадра подставляем в ответ заглушки через маркер: setup принимает
	// готовые ответы заранее, а глава создаётся внутри seedProject.
	e.stub.replaceArgs(assistant.ToolUpdateText, map[string]any{"id": chapter.String()})

	turn, err := e.asst.Send(ctx, owner, projectID, uuid.Nil, "stub:stub-1", "Перепиши первую главу")
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
	if proposal.OldBody != "текст главы" || proposal.NewBody != "Новый текст главы." {
		t.Errorf("снимок «было/станет»: %+v", proposal)
	}

	// Проект НЕ изменился — ни проекция, ни документ.
	row, _ := e.eventByID(t, projectID, chapter)
	if row.Body != "текст главы" {
		t.Fatalf("текст изменился без подтверждения: %q", row.Body)
	}
	for _, event := range e.docEvents(t, projectID) {
		if event.ID == chapter.String() && event.Body != "текст главы" {
			t.Fatalf("текст изменился в документе без подтверждения: %q", event.Body)
		}
	}

	// Применяем — теперь меняется в обоих местах.
	applied, warning, err := e.asst.ApplyProposal(ctx, owner, owner, projectID, proposal.ID)
	if err != nil {
		t.Fatalf("применение: %v", err)
	}
	if warning != "" {
		t.Errorf("предупреждение при применении: %q", warning)
	}
	if applied.Kind != store.AIChangeUpdateText {
		t.Errorf("применено не то предложение: %+v", applied)
	}
	row, _ = e.eventByID(t, projectID, chapter)
	if row.Body != "Новый текст главы." {
		t.Fatalf("текст в проекции: %q", row.Body)
	}
	found := false
	for _, event := range e.docEvents(t, projectID) {
		if event.ID == chapter.String() {
			found = true
			if event.Body != "Новый текст главы." {
				t.Errorf("текст в документе: %q", event.Body)
			}
		}
	}
	if !found {
		t.Fatal("кадр пропал из документа")
	}

	// Ожидающих предложений больше нет: оно решено.
	pending, err := e.asst.PendingProposals(ctx, owner, projectID)
	if err != nil {
		t.Fatalf("ожидающие: %v", err)
	}
	if len(pending) != 0 {
		t.Fatalf("применённое предложение осталось в ожидающих: %+v", pending)
	}

	// «Вернуть» возвращает прежний текст.
	if _, _, err := e.asst.RevertProposal(ctx, owner, owner, projectID, proposal.ID); err != nil {
		t.Fatalf("возврат: %v", err)
	}
	row, _ = e.eventByID(t, projectID, chapter)
	if row.Body != "текст главы" {
		t.Fatalf("после возврата текст: %q", row.Body)
	}
}

// Повторное «Применить» не применяет правку дважды.
func TestProposalApplyTwiceIsRefused(t *testing.T) {
	e := setup(t)
	ctx := context.Background()
	owner := e.user(t, "owner@example.com")
	projectID, chapter, _ := e.seedProject(t, owner)
	id := newProposal(t, e, projectID, owner, chapter, store.AIChangeUpdateText, "", "Другой текст.")

	if _, _, err := e.asst.ApplyProposal(ctx, owner, owner, projectID, id); err != nil {
		t.Fatalf("первое применение: %v", err)
	}
	if _, _, err := e.asst.ApplyProposal(ctx, owner, owner, projectID, id); !errors.Is(err, assistant.ErrProposalNotFound) {
		t.Fatalf("второе применение должно быть отвергнуто, получено %v", err)
	}
}

// Применённая правка не исчезает из вида: у неё есть «Вернуть», и после перезагрузки
// страницы отмена не должна пропадать (снимок старого текста лежит на сервере).
func TestAppliedProposalIsListedForRevert(t *testing.T) {
	e := setup(t)
	ctx := context.Background()
	owner := e.user(t, "owner@example.com")
	projectID, chapter, _ := e.seedProject(t, owner)
	id := newProposal(t, e, projectID, owner, chapter, store.AIChangeUpdateText, "", "Новый текст.")

	if _, _, err := e.asst.ApplyProposal(ctx, owner, owner, projectID, id); err != nil {
		t.Fatalf("применение: %v", err)
	}
	list, err := e.asst.Proposals(ctx, owner, projectID)
	if err != nil {
		t.Fatalf("список правок: %v", err)
	}
	var found *assistant.Proposal
	for i := range list {
		if list[i].ID == id {
			found = &list[i]
		}
	}
	if found == nil {
		t.Fatalf("применённой правки нет в списке — «Вернуть» некуда нажать: %+v", list)
	}
	if found.Status != store.AIChangeApplied {
		t.Errorf("состояние правки в списке: %q", found.Status)
	}
	// Ожидающих по-прежнему нет: это разные вещи.
	pending, err := e.asst.PendingProposals(ctx, owner, projectID)
	if err != nil {
		t.Fatalf("ожидающие: %v", err)
	}
	if len(pending) != 0 {
		t.Fatalf("применённое попало в ожидающие: %+v", pending)
	}
}

// Кадр изменили после предложения — применять нельзя.
func TestProposalRefusedWhenFrameChanged(t *testing.T) {
	e := setup(t)
	ctx := context.Background()
	owner := e.user(t, "owner@example.com")
	projectID, chapter, _ := e.seedProject(t, owner)
	id := newProposal(t, e, projectID, owner, chapter, store.AIChangeUpdateText, "", "Предложенный текст.")

	// Человек (или другая вкладка) правит кадр в обход предложения.
	if err := e.st.UpdateEventContent(ctx, projectID, chapter, "Глава 1", "правка после предложения", nil, owner); err != nil {
		t.Fatalf("правка кадра: %v", err)
	}

	if _, _, err := e.asst.ApplyProposal(ctx, owner, owner, projectID, id); !errors.Is(err, assistant.ErrProposalStale) {
		t.Fatalf("устаревшее предложение должно быть отвергнуто, получено %v", err)
	}
	row, _ := e.eventByID(t, projectID, chapter)
	if row.Body != "правка после предложения" {
		t.Fatalf("правка человека затёрта: %q", row.Body)
	}
	// И предложение помечено устаревшим, а не осталось висеть.
	pending, err := e.asst.PendingProposals(ctx, owner, projectID)
	if err != nil {
		t.Fatalf("ожидающие: %v", err)
	}
	if len(pending) != 0 {
		t.Fatalf("устаревшее предложение осталось в ожидающих: %+v", pending)
	}
}

// Удаление кадра без детей применяется, кадр исчезает из проекции и документа.
func TestProposalDeleteEventApplies(t *testing.T) {
	e := setup(t)
	ctx := context.Background()
	owner := e.user(t, "owner@example.com")
	projectID, _, child := e.seedProject(t, owner)
	id := newProposal(t, e, projectID, owner, child, store.AIChangeDeleteEvent, "", "")

	if _, _, err := e.asst.ApplyProposal(ctx, owner, owner, projectID, id); err != nil {
		t.Fatalf("удаление: %v", err)
	}
	if _, ok := e.eventByID(t, projectID, child); ok {
		t.Fatal("кадр остался в проекции")
	}
	for _, event := range e.docEvents(t, projectID) {
		if event.ID == child.String() {
			t.Fatal("кадр остался в документе")
		}
	}
	// Удаление не отменяется: «Вернуть» — не про него, и обещать это кнопкой нельзя.
	if _, _, err := e.asst.RevertProposal(ctx, owner, owner, projectID, id); err == nil {
		t.Fatal("возврат удаления должен быть отвергнут")
	}
}

// Удаление кадра с детьми не предлагается даже моделью.
func TestProposalDeleteWithChildrenIsRefused(t *testing.T) {
	e := setup(t,
		ai.Reply{ToolCalls: []ai.ToolCall{createCall(assistant.ToolDeleteEvent, map[string]any{
			"id": assistant.ToolUpdateText,
		})}},
		ai.Reply{Content: "Не могу удалить главу с под-событиями."},
	)
	ctx := context.Background()
	owner := e.user(t, "owner@example.com")
	projectID, chapter, _ := e.seedProject(t, owner)
	e.stub.replaceArgs(assistant.ToolDeleteEvent, map[string]any{"id": chapter.String()})

	turn, err := e.asst.Send(ctx, owner, projectID, uuid.Nil, "stub:stub-1", "Удали первую главу")
	if err != nil {
		t.Fatalf("send: %v", err)
	}
	if len(turn.Proposals) != 0 {
		t.Fatalf("предложение про удаление главы с детьми: %+v", turn.Proposals)
	}
	refused := false
	for _, call := range turn.Calls {
		if call.Name == assistant.ToolDeleteEvent && !call.OK &&
			strings.Contains(call.Error, "под-события") {
			refused = true
		}
	}
	if !refused {
		t.Fatalf("отказа с объяснением про под-события нет: %+v", turn.Calls)
	}
	// И проект не тронут.
	if _, ok := e.eventByID(t, projectID, chapter); !ok {
		t.Fatal("глава исчезла без подтверждения")
	}
}

// Чужое предложение применить нельзя: беседа, из которой оно пришло, — личная.
func TestProposalIsPersonal(t *testing.T) {
	e := setup(t)
	ctx := context.Background()
	owner := e.user(t, "owner@example.com")
	other := e.user(t, "other@example.com")
	projectID, chapter, _ := e.seedProject(t, owner)
	// Второго человека делаем редактором: права есть, а предложение всё равно чужое.
	if err := e.st.AddMembership(ctx, projectID, other, store.RoleEditor); err != nil {
		t.Fatalf("участие: %v", err)
	}
	id := newProposal(t, e, projectID, owner, chapter, store.AIChangeUpdateText, "", "Текст.")

	if _, _, err := e.asst.ApplyProposal(ctx, other, other, projectID, id); !errors.Is(err, assistant.ErrProposalWrongUser) {
		t.Fatalf("чужое предложение должно быть отвергнуто, получено %v", err)
	}
	// И в списке ожидающих у него его нет.
	pending, err := e.asst.PendingProposals(ctx, other, projectID)
	if err != nil {
		t.Fatalf("ожидающие: %v", err)
	}
	if len(pending) != 0 {
		t.Fatalf("чужое предложение видно: %+v", pending)
	}
}

// Отказ от предложения ничего не меняет и убирает его из ожидающих.
func TestProposalDiscard(t *testing.T) {
	e := setup(t)
	ctx := context.Background()
	owner := e.user(t, "owner@example.com")
	projectID, chapter, _ := e.seedProject(t, owner)
	id := newProposal(t, e, projectID, owner, chapter, store.AIChangeUpdateText, "", "Текст.")

	if err := e.asst.DiscardProposal(ctx, owner, projectID, id); err != nil {
		t.Fatalf("отказ: %v", err)
	}
	pending, err := e.asst.PendingProposals(ctx, owner, projectID)
	if err != nil {
		t.Fatalf("ожидающие: %v", err)
	}
	if len(pending) != 0 {
		t.Fatalf("отклонённое предложение осталось: %+v", pending)
	}
	row, _ := e.eventByID(t, projectID, chapter)
	if row.Body != "текст главы" {
		t.Fatalf("отказ изменил текст: %q", row.Body)
	}
}
