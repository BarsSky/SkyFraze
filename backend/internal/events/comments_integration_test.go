package events_test

// comments_integration_test.go — обсуждение кадров (миграция 0018).
//
// Что проверяем и почему именно это. Комментарии — первая сущность в проекте, которая
// живёт рядом с кадром, но НЕ в документе: ошибка «комментарий уехал в книгу» или
// «комментарий к чужому проекту виден» не ловится ни юнит-тестом парсера, ни глазами при
// ручной проверке. Поэтому проверяются ровно границы: кто пишет, кто читает, что бывает
// с комментарием, когда кадра нет, и что уборка не уносит живое.

import (
	"context"
	"errors"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"

	"github.com/skyfraze/backend/internal/events"
	"github.com/skyfraze/backend/internal/platform/testdb"
	"github.com/skyfraze/backend/internal/projects"
	"github.com/skyfraze/backend/internal/store"
)

type commentEnv struct {
	st    *store.Store
	svc   *events.Service
	proj  *projects.Service
	owner uuid.UUID
}

func setupComments(t *testing.T) *commentEnv {
	t.Helper()
	pool := testdb.Setup(t, "comments")
	testdb.Truncate(t, pool,
		"event_comments", "project_revisions", "ai_changes", "ai_messages", "ai_conversations",
		"project_event_state", "project_ratings", "project_views", "sessions",
		"invitations", "event_assets", "assets", "events", "team_memberships",
		"projects", "users")

	st := store.New(pool)
	proj := projects.New(st)
	svc := events.New(st, proj)
	owner, err := st.CreateUser(context.Background(), "owner@example.com", "hash", "Владелец")
	if err != nil {
		t.Fatalf("пользователь: %v", err)
	}
	return &commentEnv{st: st, svc: svc, proj: proj, owner: owner.ID}
}

// project создаёт проект с двумя кадрами и возвращает его id и оба кадра.
func (e *commentEnv) project(t *testing.T) (uuid.UUID, uuid.UUID, uuid.UUID) {
	t.Helper()
	ctx := context.Background()
	p, err := e.proj.Create(ctx, e.owner, "Проект с обсуждением", "")
	if err != nil {
		t.Fatalf("проект: %v", err)
	}
	first, second := uuid.New(), uuid.New()
	nodes := []events.NodeInput{
		{ID: first, Position: 0, Title: "Глава 1", Body: "первый текст"},
		{ID: second, Position: 1, Title: "Глава 2", Body: "второй текст"},
	}
	if err := e.svc.ProjectTreeServer(ctx, p.ID, e.owner, nodes); err != nil {
		t.Fatalf("дерево: %v", err)
	}
	return p.ID, first, second
}

// member заводит второго человека с ролью в проекте.
func (e *commentEnv) member(t *testing.T, projectID uuid.UUID, role store.Role) uuid.UUID {
	t.Helper()
	user, err := e.st.CreateUser(context.Background(),
		string(role)+"@example.com", "hash", strings.Title(string(role)))
	if err != nil {
		t.Fatalf("второй пользователь: %v", err)
	}
	if err := e.st.AddMembership(context.Background(), projectID, user.ID, role); err != nil {
		t.Fatalf("участие: %v", err)
	}
	return user.ID
}

// Комментарий пишется, читается с именем автора и попадает в счётчики кадров.
func TestCommentsAddListAndCount(t *testing.T) {
	e := setupComments(t)
	ctx := context.Background()
	projectID, first, second := e.project(t)

	comment, err := e.svc.AddComment(ctx, e.owner, projectID, first, "  Тут герой не мог знать про маяк.  ")
	if err != nil {
		t.Fatalf("комментарий: %v", err)
	}
	// Пробелы по краям срезаются: от них зависит, пустой комментарий или нет.
	if comment.Body != "Тут герой не мог знать про маяк." {
		t.Errorf("тело комментария: %q", comment.Body)
	}
	if comment.AuthorName != "Владелец" || comment.EventID != first {
		t.Errorf("комментарий: %+v", comment)
	}

	if _, err := e.svc.AddComment(ctx, e.owner, projectID, first, "И ещё одно замечание."); err != nil {
		t.Fatalf("второй комментарий: %v", err)
	}
	list, err := e.svc.ListComments(ctx, e.owner, projectID, first, 0)
	if err != nil {
		t.Fatalf("список: %v", err)
	}
	if len(list) != 2 {
		t.Fatalf("комментариев у кадра: %d, ожидалось 2", len(list))
	}
	// Порядок — как писали: обсуждение читается сверху вниз.
	if !strings.HasPrefix(list[0].Body, "Тут герой") {
		t.Errorf("порядок комментариев: %q", list[0].Body)
	}

	counts, err := e.svc.CommentCounts(ctx, e.owner, projectID)
	if err != nil {
		t.Fatalf("счётчики: %v", err)
	}
	if counts[first] != 2 {
		t.Errorf("счётчик первого кадра: %d, ожидалось 2", counts[first])
	}
	if _, ok := counts[second]; ok {
		t.Errorf("у кадра без обсуждения не должно быть счётчика: %v", counts)
	}

	// Комментарий не попадает в текст проекта: обсуждение — не история.
	rows, err := e.st.ListEvents(ctx, projectID)
	if err != nil {
		t.Fatalf("события: %v", err)
	}
	for _, row := range rows {
		if strings.Contains(row.Body, "маяк") {
			t.Fatalf("комментарий попал в текст кадра: %q", row.Body)
		}
	}
}

// Читатель видит обсуждение, но писать не может; редактор — может.
func TestCommentsRights(t *testing.T) {
	e := setupComments(t)
	ctx := context.Background()
	projectID, first, _ := e.project(t)
	if _, err := e.svc.AddComment(ctx, e.owner, projectID, first, "Замечание владельца."); err != nil {
		t.Fatalf("комментарий: %v", err)
	}
	reader := e.member(t, projectID, store.RoleViewer)
	editor := e.member(t, projectID, store.RoleEditor)

	// Читатель: список видит.
	if _, err := e.svc.ListComments(ctx, reader, projectID, first, 0); err != nil {
		t.Fatalf("читатель должен видеть обсуждение: %v", err)
	}
	// А писать — нет.
	if _, err := e.svc.AddComment(ctx, reader, projectID, first, "Влезу в разговор."); !errors.Is(err, projects.ErrForbidden) {
		t.Fatalf("читателю писать нельзя, получено %v", err)
	}
	// Редактор пишет.
	if _, err := e.svc.AddComment(ctx, editor, projectID, first, "Замечание редактора."); err != nil {
		t.Fatalf("редактор должен писать: %v", err)
	}

	// Посторонний (вовсе не участник) не видит ничего — и не должен узнать, что обсуждение есть.
	stranger, err := e.st.CreateUser(ctx, "stranger@example.com", "hash", "Посторонний")
	if err != nil {
		t.Fatalf("посторонний: %v", err)
	}
	if _, err := e.svc.ListComments(ctx, stranger.ID, projectID, first, 0); err == nil {
		t.Fatal("посторонний не должен читать обсуждение")
	}
}

// Удалить можно только свой комментарий.
func TestCommentsDelete(t *testing.T) {
	e := setupComments(t)
	ctx := context.Background()
	projectID, first, _ := e.project(t)
	editor := e.member(t, projectID, store.RoleEditor)

	mine, err := e.svc.AddComment(ctx, e.owner, projectID, first, "Моё замечание.")
	if err != nil {
		t.Fatalf("комментарий: %v", err)
	}
	theirs, err := e.svc.AddComment(ctx, editor, projectID, first, "Замечание редактора.")
	if err != nil {
		t.Fatalf("комментарий редактора: %v", err)
	}

	// Чужой удалить нельзя даже владельцу проекта: «автор сказал» — факт, а не черновик.
	if err := e.svc.DeleteComment(ctx, e.owner, projectID, theirs.ID); !errors.Is(err, store.ErrNotFound) {
		t.Fatalf("чужой комментарий удалять нельзя, получено %v", err)
	}
	// Свой — можно.
	if err := e.svc.DeleteComment(ctx, e.owner, projectID, mine.ID); err != nil {
		t.Fatalf("свой комментарий: %v", err)
	}
	list, err := e.svc.ListComments(ctx, e.owner, projectID, first, 0)
	if err != nil {
		t.Fatalf("список: %v", err)
	}
	if len(list) != 1 || list[0].ID != theirs.ID {
		t.Fatalf("после удаления остался не тот комментарий: %+v", list)
	}
}

// Пустой, слишком длинный комментарий и комментарий к несуществующему кадру — отказ.
func TestCommentsValidation(t *testing.T) {
	e := setupComments(t)
	ctx := context.Background()
	projectID, first, _ := e.project(t)

	if _, err := e.svc.AddComment(ctx, e.owner, projectID, first, "   \n\t "); !errors.Is(err, events.ErrValidation) {
		t.Fatalf("пустой комментарий должен быть отказом, получено %v", err)
	}
	long := strings.Repeat("я", events.MaxCommentRunes+1)
	if _, err := e.svc.AddComment(ctx, e.owner, projectID, first, long); !errors.Is(err, events.ErrValidation) {
		t.Fatalf("слишком длинный комментарий должен быть отказом, получено %v", err)
	}
	// Ровно по пределу — можно: предел не должен быть «на один знак меньше».
	atLimit := strings.Repeat("я", events.MaxCommentRunes)
	if _, err := e.svc.AddComment(ctx, e.owner, projectID, first, atLimit); err != nil {
		t.Fatalf("комментарий ровно по пределу должен проходить: %v", err)
	}
	if _, err := e.svc.AddComment(ctx, e.owner, projectID, uuid.New(), "К несуществующему кадру."); !errors.Is(err, events.ErrValidation) {
		t.Fatalf("комментарий к несуществующему кадру должен быть отказом, получено %v", err)
	}
}

// Уборка сносит комментарии к исчезнувшим кадрам — но только после карантина.
func TestCommentsPurgeOrphans(t *testing.T) {
	e := setupComments(t)
	ctx := context.Background()
	projectID, first, second := e.project(t)

	live, err := e.svc.AddComment(ctx, e.owner, projectID, first, "Живой кадр.")
	if err != nil {
		t.Fatalf("комментарий: %v", err)
	}
	orphan, err := e.svc.AddComment(ctx, e.owner, projectID, second, "Кадр сейчас исчезнет.")
	if err != nil {
		t.Fatalf("комментарий: %v", err)
	}

	// Кадр исчезает из проекции: так выглядит удаление кадра в документе после пересчёта
	// дерева. Удаляем строку напрямую — проверяем уборку, а не путь пересчёта дерева.
	if _, err := e.st.Pool.Exec(ctx, `DELETE FROM events WHERE id=$1`, second); err != nil {
		t.Fatalf("удалить кадр из проекции: %v", err)
	}

	// Свежий сирота остаётся: пропажа бывает серединой импорта.
	n, err := e.st.PurgeOrphanEventComments(ctx, 24*time.Hour)
	if err != nil {
		t.Fatalf("уборка: %v", err)
	}
	if n != 0 {
		t.Fatalf("свежие сироты не удаляются, удалено %d", n)
	}

	// А через сутки — уходит, и только он.
	if _, err := e.st.Pool.Exec(ctx,
		`UPDATE event_comments SET created_at = now() - interval '2 days' WHERE id=$1`, orphan.ID); err != nil {
		t.Fatalf("состарить комментарий: %v", err)
	}
	n, err = e.st.PurgeOrphanEventComments(ctx, 24*time.Hour)
	if err != nil {
		t.Fatalf("уборка: %v", err)
	}
	if n != 1 {
		t.Fatalf("удалено сирот: %d, ожидался 1", n)
	}
	list, err := e.svc.ListComments(ctx, e.owner, projectID, first, 0)
	if err != nil {
		t.Fatalf("список живого кадра: %v", err)
	}
	if len(list) != 1 || list[0].ID != live.ID {
		t.Fatalf("уборка тронула комментарий живого кадра: %+v", list)
	}
}
