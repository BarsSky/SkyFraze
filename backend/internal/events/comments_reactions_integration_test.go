package events_test

// comments_reactions_integration_test.go — реакции на замечания (миграция 0025).
//
// Что проверяется и почему. Реакция — единственное действие в обсуждении, которое ничего не
// пишет словами, поэтому ошибки здесь тихие: неверный счётчик, реакция на удалённое замечание,
// «моё» состояние не моё. Проверяются границы: набор видов, кто может ставить (редактор, а
// читатель — нет), снятие идемпотентно, удалённое замечание не принимает реакций, а счётчики
// в списке приходят вместе с обсуждением (интерфейс не должен считать их сам).

import (
	"context"
	"errors"
	"testing"

	"github.com/google/uuid"

	"github.com/skyfraze/backend/internal/events"
	"github.com/skyfraze/backend/internal/projects"
	"github.com/skyfraze/backend/internal/store"
)

// Реакция ставится, снимается, и счётчики приходят вместе со списком.
func TestCommentsReactions(t *testing.T) {
	e := setupComments(t)
	ctx := context.Background()
	projectID, first, _ := e.project(t)
	editor := e.member(t, projectID, store.RoleEditor)

	comment, err := e.svc.AddComment(ctx, e.owner, projectID, first, "Здесь провал в логике.", nil, nil)
	if err != nil {
		t.Fatalf("замечание: %v", err)
	}

	// «Согласен» от редактора: у замечания один счётчик и «моё» у редактора.
	reactions, err := e.svc.SetCommentReaction(ctx, editor, projectID, comment.ID, store.ReactionAgree, true)
	if err != nil {
		t.Fatalf("реакция: %v", err)
	}
	if reactions.Agree != 1 || reactions.Done != 0 {
		t.Fatalf("счётчики после первой реакции: %+v", reactions)
	}
	if len(reactions.Mine) != 1 || reactions.Mine[0] != string(store.ReactionAgree) {
		t.Fatalf("«моё» после реакции: %+v", reactions.Mine)
	}

	// Повторное нажатие (PUT ещё раз) не создаёт второй строки: это важно для телефона, где
	// двойное нажатие — норма.
	if _, err := e.svc.SetCommentReaction(ctx, editor, projectID, comment.ID, store.ReactionAgree, true); err != nil {
		t.Fatalf("повторная реакция: %v", err)
	}
	list, err := e.svc.ListComments(ctx, e.owner, projectID, first, 0)
	if err != nil || len(list) != 1 {
		t.Fatalf("список: %+v (err=%v)", list, err)
	}
	if list[0].Reactions.Agree != 1 {
		t.Errorf("после повтора счётчик %d, ожидался 1", list[0].Reactions.Agree)
	}
	// Для владельца это НЕ его реакция: «моё» считается по смотрящему.
	if len(list[0].Reactions.Mine) != 0 {
		t.Errorf("чужая реакция показана как своя: %+v", list[0].Reactions.Mine)
	}

	// Второй вид — независимое состояние: «согласен» и «сделано» живут вместе.
	if _, err := e.svc.SetCommentReaction(ctx, e.owner, projectID, comment.ID, store.ReactionDone, true); err != nil {
		t.Fatalf("«сделано»: %v", err)
	}
	list, err = e.svc.ListComments(ctx, editor, projectID, first, 0)
	if err != nil {
		t.Fatalf("список: %v", err)
	}
	if list[0].Reactions.Agree != 1 || list[0].Reactions.Done != 1 {
		t.Errorf("счётчики: %+v", list[0].Reactions)
	}
	if len(list[0].Reactions.Mine) != 1 || list[0].Reactions.Mine[0] != string(store.ReactionAgree) {
		t.Errorf("«моё» у редактора: %+v", list[0].Reactions.Mine)
	}

	// Снятие: счётчик падает, и повторное снятие — не ошибка (идемпотентно).
	if _, err := e.svc.SetCommentReaction(ctx, editor, projectID, comment.ID, store.ReactionAgree, false); err != nil {
		t.Fatalf("снятие: %v", err)
	}
	if _, err := e.svc.SetCommentReaction(ctx, editor, projectID, comment.ID, store.ReactionAgree, false); err != nil {
		t.Fatalf("повторное снятие: %v", err)
	}
	list, err = e.svc.ListComments(ctx, editor, projectID, first, 0)
	if err != nil {
		t.Fatalf("список: %v", err)
	}
	if list[0].Reactions.Agree != 0 || list[0].Reactions.Done != 1 {
		t.Errorf("после снятия: %+v", list[0].Reactions)
	}
	if len(list[0].Reactions.Mine) != 0 {
		t.Errorf("после снятия «моё» непустое: %+v", list[0].Reactions.Mine)
	}
}

// Права: читатель реакций не ставит, посторонний не ставит, удалённое замечание не принимает.
func TestCommentsReactionsRights(t *testing.T) {
	e := setupComments(t)
	ctx := context.Background()
	projectID, first, _ := e.project(t)
	reader := e.member(t, projectID, store.RoleViewer)

	comment, err := e.svc.AddComment(ctx, e.owner, projectID, first, "Замечание.", nil, nil)
	if err != nil {
		t.Fatalf("замечание: %v", err)
	}
	// Читатель: проект открыт, следов он не оставляет — как и с комментариями.
	if _, err := e.svc.SetCommentReaction(ctx, reader, projectID, comment.ID, store.ReactionAgree, true); !errors.Is(err, projects.ErrForbidden) {
		t.Fatalf("реакция читателя: %v, ожидалось ErrForbidden", err)
	}

	// Реакция на удалённое замечание — отказ: тела нет, реагировать не на что.
	if err := e.svc.DeleteComment(ctx, e.owner, projectID, comment.ID); err != nil {
		t.Fatalf("удаление замечания: %v", err)
	}
	if _, err := e.svc.SetCommentReaction(ctx, e.owner, projectID, comment.ID, store.ReactionAgree, true); !errors.Is(err, events.ErrValidation) {
		t.Fatalf("реакция на удалённое: %v, ожидалось ErrValidation", err)
	}

	// Несуществующий комментарий — «не найдено», а не молчаливый успех.
	if _, err := e.svc.SetCommentReaction(ctx, e.owner, projectID, uuid.New(), store.ReactionAgree, true); !errors.Is(err, store.ErrNotFound) {
		t.Fatalf("реакция на несуществующее: %v, ожидалось ErrNotFound", err)
	}
}

// Разбор вида реакции: посторонняя строка не превращается в реакцию.
func TestParseReactionKind(t *testing.T) {
	for _, raw := range []string{"agree", "done"} {
		if _, ok := store.ParseReactionKind(raw); !ok {
			t.Errorf("%q должен быть допустимой реакцией", raw)
		}
	}
	for _, raw := range []string{"", "AGREE", "like", "😂"} {
		if _, ok := store.ParseReactionKind(raw); ok {
			t.Errorf("%q не должен быть допустимой реакцией", raw)
		}
	}
}
