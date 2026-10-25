package events_test

// comments_unread_integration_test.go — непрочитанные замечания (миграция 0019).
//
// Главное, что здесь проверяется: «новое» — это замечание ДРУГОГО человека, написанное
// после того, как я открывал обсуждение этого кадра. Ошибка в любую сторону делает
// уведомление бесполезным: если считать свои — счётчик горит всегда; если не сбрасывать
// после просмотра — он тоже горит всегда, и человек перестаёт на него смотреть.

import (
	"context"
	"testing"

	"github.com/google/uuid"

	"github.com/skyfraze/backend/internal/events"
	"github.com/skyfraze/backend/internal/store"
)

func TestCommentsUnreadLifecycle(t *testing.T) {
	e := setupComments(t)
	ctx := context.Background()
	projectID, first, second := e.project(t)
	editor := e.member(t, projectID, store.RoleEditor)

	// Своё замечание новым не считается — иначе счётчик горел бы от собственных слов.
	if _, err := e.svc.AddComment(ctx, e.owner, projectID, first, "Моё замечание."); err != nil {
		t.Fatalf("свой комментарий: %v", err)
	}
	unread, err := e.svc.UnseenComments(ctx, e.owner, projectID)
	if err != nil {
		t.Fatalf("непрочитанные: %v", err)
	}
	if len(unread) != 0 {
		t.Fatalf("свои замечания не должны быть новыми: %+v", unread)
	}

	// Замечание другого человека — новое.
	if _, err := e.svc.AddComment(ctx, editor, projectID, first, "Замечание редактора."); err != nil {
		t.Fatalf("комментарий редактора: %v", err)
	}
	unread, err = e.svc.UnseenComments(ctx, e.owner, projectID)
	if err != nil {
		t.Fatalf("непрочитанные: %v", err)
	}
	if len(unread) != 1 || unread[0].EventID != first || unread[0].Unread != 1 {
		t.Fatalf("ожидалось одно новое у первого кадра: %+v", unread)
	}

	// И в списке проектов видно, что есть куда заглянуть.
	byProject, err := e.svc.UnseenCommentsByProject(ctx, e.owner)
	if err != nil {
		t.Fatalf("по проектам: %v", err)
	}
	if len(byProject) != 1 || byProject[0].ProjectID != projectID || byProject[0].Unread != 1 {
		t.Fatalf("проект с новыми замечаниями: %+v", byProject)
	}
	if byProject[0].Title == "" {
		t.Error("в списке должно быть название проекта: иначе непонятно, куда идти")
	}

	// Просмотр обсуждения снимает отметку — и только у этого кадра.
	if err := e.svc.MarkCommentsSeen(ctx, e.owner, projectID, first); err != nil {
		t.Fatalf("отметка прочитанного: %v", err)
	}
	unread, err = e.svc.UnseenComments(ctx, e.owner, projectID)
	if err != nil {
		t.Fatalf("непрочитанные: %v", err)
	}
	if len(unread) != 0 {
		t.Fatalf("после просмотра новых быть не должно: %+v", unread)
	}

	// Новое замечание после просмотра снова новое.
	if _, err := e.svc.AddComment(ctx, editor, projectID, first, "Ещё одно."); err != nil {
		t.Fatalf("третье замечание: %v", err)
	}
	unread, err = e.svc.UnseenComments(ctx, e.owner, projectID)
	if err != nil {
		t.Fatalf("непрочитанные: %v", err)
	}
	if len(unread) != 1 || unread[0].Unread != 1 {
		t.Fatalf("после нового замечания ожидалось одно: %+v", unread)
	}

	// Прочитанное по одному кадру не гасит другой: это разные разговоры.
	if _, err := e.svc.AddComment(ctx, editor, projectID, second, "Замечание ко второму кадру."); err != nil {
		t.Fatalf("замечание ко второму кадру: %v", err)
	}
	unread, err = e.svc.UnseenComments(ctx, e.owner, projectID)
	if err != nil {
		t.Fatalf("непрочитанные: %v", err)
	}
	if len(unread) != 2 {
		t.Fatalf("ожидалось два кадра с новыми замечаниями: %+v", unread)
	}
	if err := e.svc.MarkCommentsSeen(ctx, e.owner, projectID, second); err != nil {
		t.Fatalf("отметка второго кадра: %v", err)
	}
	unread, err = e.svc.UnseenComments(ctx, e.owner, projectID)
	if err != nil {
		t.Fatalf("непрочитанные: %v", err)
	}
	if len(unread) != 1 || unread[0].EventID != first {
		t.Fatalf("просмотр второго кадра не должен гасить первый: %+v", unread)
	}
}

// Чужие проекты в «непрочитанные» не попадают.
func TestCommentsUnreadOnlyMyProjects(t *testing.T) {
	e := setupComments(t)
	ctx := context.Background()
	projectID, first, _ := e.project(t)

	// Второй человек со своим проектом и своим обсуждением.
	other, err := e.st.CreateUser(ctx, "other@example.com", "hash", "Другой")
	if err != nil {
		t.Fatalf("другой: %v", err)
	}
	foreign, err := e.proj.Create(ctx, other.ID, "Чужой проект", "")
	if err != nil {
		t.Fatalf("чужой проект: %v", err)
	}
	foreignEvent := uuid.New()
	if err := e.svc.ProjectTreeServer(ctx, foreign.ID, other.ID, []events.NodeInput{
		{ID: foreignEvent, Position: 0, Title: "Глава", Body: "текст"},
	}); err != nil {
		t.Fatalf("дерево чужого проекта: %v", err)
	}
	if _, err := e.svc.AddComment(ctx, other.ID, foreign.ID, foreignEvent, "Тут я писал."); err != nil {
		t.Fatalf("комментарий в чужом проекте: %v", err)
	}
	// И комментарий в моём проекте, чтобы список был не пустым.
	editor := e.member(t, projectID, store.RoleEditor)
	if _, err := e.svc.AddComment(ctx, editor, projectID, first, "Замечание."); err != nil {
		t.Fatalf("комментарий редактора: %v", err)
	}

	byProject, err := e.svc.UnseenCommentsByProject(ctx, e.owner)
	if err != nil {
		t.Fatalf("по проектам: %v", err)
	}
	for _, item := range byProject {
		if item.ProjectID == foreign.ID {
			t.Fatalf("чужой проект попал в непрочитанные: %+v", item)
		}
	}
	if len(byProject) != 1 || byProject[0].ProjectID != projectID {
		t.Fatalf("ожидался только свой проект: %+v", byProject)
	}
	if _, err := e.svc.CommentCounts(ctx, e.owner, foreign.ID); err == nil {
		t.Fatal("счётчики чужого проекта читать нельзя")
	}
	if err := e.svc.MarkCommentsSeen(ctx, e.owner, foreign.ID, foreignEvent); err == nil {
		t.Fatal("отмечать прочитанное в чужом проекте нельзя")
	}
}
