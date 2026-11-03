package assistant_test

// conversations_integration_test.go — удаление бесед с помощником (0.148.0).
//
// Зачем отдельный файл. Беседы копятся: у живого проекта их может быть десятки, и человек
// должен уметь убрать и одну, и всю историю разом. Проверяем ровно то, что обещано:
//
//   - свою беседу удалить можно, и сообщения уходят вместе с ней (иначе остались бы сироты);
//   - чужую беседу удалить нельзя, и ответ тот же, что на несуществующую (404, а не 403):
//     по ответу нельзя узнать, что беседа есть;
//   - очистка убирает все беседы этого человека в проекте и НЕ трогает чужие;
//   - удаление не требует права править проект: это личная история, а не содержимое.

import (
	"context"
	"errors"
	"testing"

	"github.com/google/uuid"

	"github.com/skyfraze/backend/internal/assistant"
	"github.com/skyfraze/backend/internal/store"
)

// ownConversation заводит беседу с одной репликой и возвращает её.
func ownConversation(
	t *testing.T, e *env, ctx context.Context, projectID, userID uuid.UUID, title string,
) *store.AIConversation {
	t.Helper()
	conversation, err := e.st.CreateAIConversation(ctx, projectID, userID, title, "stub:1")
	if err != nil {
		t.Fatalf("беседа: %v", err)
	}
	if _, err := e.st.AppendAIMessage(ctx, store.AIMessage{
		ConversationID: conversation.ID, Role: "user", Content: "вопрос",
	}); err != nil {
		t.Fatalf("сообщение: %v", err)
	}
	return conversation
}

func TestDeleteConversationRemovesOnlyOwn(t *testing.T) {
	e := setup(t)
	ctx := context.Background()
	owner := e.user(t, "owner@example.com")
	projectID, _, _ := e.seedProject(t, owner)
	other := e.user(t, "other@example.com")

	own := ownConversation(t, e, ctx, projectID, owner, "Моя беседа")
	foreign := ownConversation(t, e, ctx, projectID, other, "Чужая беседа")

	// Чужую удалить нельзя: ответ тот же, что на несуществующую.
	if err := e.asst.DeleteConversation(ctx, owner, projectID, foreign.ID); !errors.Is(err, store.ErrNotFound) {
		t.Fatalf("чужая беседа: %v, ожидалось ErrNotFound", err)
	}
	if list, err := e.st.ListAIConversations(ctx, projectID, other); err != nil || len(list) != 1 {
		t.Fatalf("чужая беседа исчезла: %v, %d", err, len(list))
	}

	// Свою — можно, и сообщения уходят вместе с ней.
	if err := e.asst.DeleteConversation(ctx, owner, projectID, own.ID); err != nil {
		t.Fatalf("своя беседа: %v", err)
	}
	if list, err := e.st.ListAIConversations(ctx, projectID, owner); err != nil || len(list) != 0 {
		t.Fatalf("беседа не удалилась: %v, %d", err, len(list))
	}
	if messages, err := e.st.ListAIMessages(ctx, own.ID, 10); err != nil || len(messages) != 0 {
		t.Fatalf("сообщения удалённой беседы остались: %v, %d", err, len(messages))
	}
	// Повторное удаление — снова «не найдено», а не тихий успех.
	if err := e.asst.DeleteConversation(ctx, owner, projectID, own.ID); !errors.Is(err, store.ErrNotFound) {
		t.Fatalf("повторное удаление: %v", err)
	}
}

func TestClearConversationsKeepsOthersAndReturnsCount(t *testing.T) {
	e := setup(t)
	ctx := context.Background()
	owner := e.user(t, "owner@example.com")
	projectID, _, _ := e.seedProject(t, owner)
	other := e.user(t, "other@example.com")

	for _, title := range []string{"Первая", "Вторая", "Третья"} {
		ownConversation(t, e, ctx, projectID, owner, title)
	}
	ownConversation(t, e, ctx, projectID, other, "Чужая")

	deleted, err := e.asst.ClearConversations(ctx, owner, projectID)
	if err != nil {
		t.Fatalf("очистка: %v", err)
	}
	if deleted != 3 {
		t.Fatalf("удалено %d, ожидалось 3", deleted)
	}
	if list, err := e.st.ListAIConversations(ctx, projectID, owner); err != nil || len(list) != 0 {
		t.Fatalf("история не очищена: %v, %d", err, len(list))
	}
	if list, err := e.st.ListAIConversations(ctx, projectID, other); err != nil || len(list) != 1 {
		t.Fatalf("чужая беседа пострадала: %v, %d", err, len(list))
	}
}

// Удаление своей переписки доступно читателю проекта: это личная история, а не правка.
func TestDeleteConversationAllowedForReader(t *testing.T) {
	e := setup(t)
	ctx := context.Background()
	owner := e.user(t, "owner@example.com")
	projectID, _, _ := e.seedProject(t, owner)
	reader := e.user(t, "reader@example.com")
	if err := e.st.AddMembership(ctx, projectID, reader, store.RoleViewer); err != nil {
		t.Fatalf("участие: %v", err)
	}

	own := ownConversation(t, e, ctx, projectID, reader, "Беседа читателя")
	if err := e.asst.DeleteConversation(ctx, reader, projectID, own.ID); err != nil {
		t.Fatalf("читатель не смог удалить свою беседу: %v", err)
	}
	if _, err := e.asst.ClearConversations(ctx, reader, projectID); err != nil {
		t.Fatalf("читатель не смог очистить историю: %v", err)
	}
	// А «проект не мой» — по-прежнему отказ.
	if err := e.asst.DeleteConversation(ctx, reader, uuid.New(), own.ID); !errors.Is(err, assistant.ErrForbidden) {
		t.Fatalf("чужой проект: %v", err)
	}
}
