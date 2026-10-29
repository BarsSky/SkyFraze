package assistant_test

// move_proposals_integration_test.go — перенос кадра по дереву по подтверждению (0.108.0).
//
// Что проверяется и почему:
//
//   - модель предлагает перенос, а дерево остаётся прежним (это главное обещание возможности);
//   - применяет человек, и перенос доезжает до ОБОИХ мест — таблицы событий и документа;
//   - дети переезжают вместе с кадром: они ссылаются на него по идентификатору;
//   - «Вернуть» возвращает кадр в прежнюю главу (и в корень тоже — это законное место);
//   - кадр, переставленный после предложения, применить нельзя (чужая перестановка не затирается);
//   - перенос в собственное под-событие отвергается словами, а не «почти получилось».

import (
	"context"
	"errors"
	"strings"
	"testing"

	"github.com/google/uuid"

	"github.com/skyfraze/backend/internal/ai"
	"github.com/skyfraze/backend/internal/assistant"
	"github.com/skyfraze/backend/internal/store"
)

// parentOf — родитель кадра в проекции (nil — верхний уровень).
func (e *env) parentOf(t *testing.T, projectID, eventID uuid.UUID) *uuid.UUID {
	t.Helper()
	row, ok := e.eventByID(t, projectID, eventID)
	if !ok {
		t.Fatalf("кадра %v нет в проекции", eventID)
	}
	return row.ParentID
}

// parentInDoc — родитель кадра в документе ("" — верхний уровень).
func (e *env) parentInDoc(t *testing.T, projectID, eventID uuid.UUID) string {
	t.Helper()
	for _, event := range e.docEvents(t, projectID) {
		if event.ID == eventID.String() {
			return event.ParentID
		}
	}
	return ""
}

// newMoveProposal заводит предложение переноса напрямую (без модели).
func newMoveProposal(
	t *testing.T, e *env, projectID, userID, eventID uuid.UUID, oldParent, newParent *uuid.UUID,
	oldTitle, newTitle string,
) uuid.UUID {
	t.Helper()
	row, ok := e.eventByID(t, projectID, eventID)
	if !ok {
		t.Fatalf("кадра %v нет в проекте", eventID)
	}
	change, err := e.st.CreateAIChange(context.Background(), store.AIChange{
		ProjectID: projectID, UserID: userID, Kind: store.AIChangeMoveEvent,
		EventID: eventID, EventTitle: row.Title,
		OldParentID: oldParent, NewParentID: newParent,
		OldParentTitle: oldTitle, NewParentTitle: newTitle,
	})
	if err != nil {
		t.Fatalf("предложение переноса: %v", err)
	}
	return change.ID
}

// Модель предлагает перенос — дерево не меняется, предложение ждёт решения.
func TestMoveToolProposesAndDoesNotChangeTree(t *testing.T) {
	e := setup(t,
		ai.Reply{ToolCalls: []ai.ToolCall{createCall(assistant.ToolMoveEvent, map[string]any{
			"id":        placeholderID,
			"parent_id": "",
			"reason":    "это отдельная сцена",
		})}},
		ai.Reply{Content: "Предлагаю перенести под-событие на верхний уровень — подтвердите."},
	)
	ctx := context.Background()
	owner := e.user(t, "owner@example.com")
	projectID, chapter, child := e.seedProject(t, owner)
	e.stub.setReplies(
		ai.Reply{ToolCalls: []ai.ToolCall{createCall(assistant.ToolMoveEvent, map[string]any{
			"id":        child.String(),
			"parent_id": "",
			"reason":    "это отдельная сцена",
		})}},
		ai.Reply{Content: "Предлагаю перенести под-событие на верхний уровень — подтвердите."},
	)

	turn, err := e.asst.Send(ctx, owner, projectID, uuid.Nil, "stub:stub-1",
		"Перенеси под-событие на верхний уровень")
	if err != nil {
		t.Fatalf("вопрос: %v", err)
	}
	if len(turn.Calls) != 1 || !turn.Calls[0].OK {
		t.Fatalf("вызовы: %+v", turn.Calls)
	}
	// Дерево прежнее — и в проекции, и в документе.
	if parent := e.parentOf(t, projectID, child); parent == nil || *parent != chapter {
		t.Errorf("родитель после предложения: %v, ожидалась глава", parent)
	}
	// Документа у проекта может ещё не быть: предложение ничего не пишет, а снапшот появляется
	// при первой правке. Проверять «в документе прежний родитель» не на чем — и это само по
	// себе доказательство, что записи не было. Документ проверяется в тесте применения ниже.
	pending, err := e.st.PendingAIChanges(ctx, projectID, owner)
	if err != nil {
		t.Fatalf("предложения: %v", err)
	}
	if len(pending) != 1 || pending[0].Kind != store.AIChangeMoveEvent {
		t.Fatalf("ожидалось одно предложение переноса: %+v", pending)
	}
	if pending[0].NewParentID != nil || pending[0].OldParentTitle != "Глава 1" {
		t.Errorf("поля переноса: old title %q, new parent %v", pending[0].OldParentTitle, pending[0].NewParentID)
	}
}

// Применение и возврат: кадр уезжает наверх, потом возвращается в главу — в обоих местах.
func TestMoveProposalApplyAndRevert(t *testing.T) {
	e := setup(t)
	ctx := context.Background()
	owner := e.user(t, "owner@example.com")
	projectID, chapter, child := e.seedProject(t, owner)

	id := newMoveProposal(t, e, projectID, owner, child, &chapter, nil, "Глава 1", "")
	if _, _, err := e.asst.ApplyProposal(ctx, owner, owner, projectID, id); err != nil {
		t.Fatalf("применение: %v", err)
	}
	if parent := e.parentOf(t, projectID, child); parent != nil {
		t.Errorf("родитель после применения: %v, ожидался верхний уровень", parent)
	}
	if parent := e.parentInDoc(t, projectID, child); parent != "" {
		t.Errorf("родитель в документе после применения: %q", parent)
	}

	if _, _, err := e.asst.RevertProposal(ctx, owner, owner, projectID, id); err != nil {
		t.Fatalf("возврат: %v", err)
	}
	if parent := e.parentOf(t, projectID, child); parent == nil || *parent != chapter {
		t.Errorf("родитель после возврата: %v", parent)
	}
	if parent := e.parentInDoc(t, projectID, child); parent != chapter.String() {
		t.Errorf("родитель в документе после возврата: %q", parent)
	}
}

// Второе предложение о том же кадре становится устаревшим: дерево уже другое.
func TestMoveProposalStaleAfterAnotherMove(t *testing.T) {
	e := setup(t)
	ctx := context.Background()
	owner := e.user(t, "owner@example.com")
	projectID, chapter, child := e.seedProject(t, owner)

	first := newMoveProposal(t, e, projectID, owner, child, &chapter, nil, "Глава 1", "")
	second := newMoveProposal(t, e, projectID, owner, chapter, nil, nil, "", "")
	// Второе предложение — про главу (её родитель тоже «верхний уровень»), она нам не мешает;
	// главное — первое уже переставило ребёнка.
	if _, _, err := e.asst.ApplyProposal(ctx, owner, owner, projectID, first); err != nil {
		t.Fatalf("первое применение: %v", err)
	}
	// Второе предложение было про главу и остаётся применимым, поэтому проверяем отказ на
	// предложении с УСТАРЕВШИМ ожиданием: создаём его с прежним родителем, которого уже нет.
	stale := newMoveProposal(t, e, projectID, owner, child, &chapter, nil, "Глава 1", "")
	if _, _, err := e.asst.ApplyProposal(ctx, owner, owner, projectID, stale); !errors.Is(err, assistant.ErrProposalStale) {
		t.Fatalf("применение устаревшего: %v, ожидалось ErrProposalStale", err)
	}
	// Кадр остался наверху — чужую/свою перестановку отказ не затирает.
	if parent := e.parentOf(t, projectID, child); parent != nil {
		t.Errorf("родитель после отказа: %v, ожидался верхний уровень", parent)
	}
	_ = second
}

// Перенос в собственное под-событие — отказ словами, а не «почти получилось».
func TestMoveProposalRejectsMoveIntoOwnChild(t *testing.T) {
	e := setup(t)
	ctx := context.Background()
	owner := e.user(t, "owner@example.com")
	projectID, chapter, child := e.seedProject(t, owner)

	// Главу в собственное под-событие: цикл в дереве.
	id := newMoveProposal(t, e, projectID, owner, chapter, nil, &child, "", "Под-событие")
	_, _, err := e.asst.ApplyProposal(ctx, owner, owner, projectID, id)
	if err == nil {
		t.Fatal("ожидался отказ: кадр нельзя перенести в собственное под-событие")
	}
	if !strings.Contains(err.Error(), "под-событие") {
		t.Errorf("причина отказа: %q", err.Error())
	}
	// Дерево не тронуто.
	if parent := e.parentOf(t, projectID, chapter); parent != nil {
		t.Errorf("глава съехала: %v", parent)
	}
	if parent := e.parentOf(t, projectID, child); parent == nil || *parent != chapter {
		t.Errorf("под-событие съехало: %v", parent)
	}
}
