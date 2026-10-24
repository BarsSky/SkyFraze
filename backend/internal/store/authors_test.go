package store_test

// authors_test.go — «автора нет» не должно ломать запись.
//
// История дефекта. Живая комната сохраняет документ и проекцию, когда документ
// МИГРИРОВАЛ (появились `title_text`/`body_text`), — и это может случиться до первой правки
// человека, то есть `lastBy` в комнате ещё нулевой. Нулевой UUID уходил в `created_by` и
// `updated_by`, а там внешний ключ на `users`:
//
//   - проекция дерева падала с «violates foreign key constraint» и оставалась устаревшей до
//     следующей правки (поймал e2e-сценарий правок агента);
//   - сохранение снапшота отвечало «проект не найден» (FK 23503 → ErrNotFound), комната
//     считала запись неудачной и повторяла её каждый тик.
//
// Правильное поведение: пустой автор — это NULL («кто именно — неизвестно»), а не строка
// с нулевым UUID.

import (
	"context"
	"testing"

	"github.com/google/uuid"

	"github.com/skyfraze/backend/internal/platform/testdb"
	"github.com/skyfraze/backend/internal/store"
)

func setupStore(t *testing.T) (*store.Store, uuid.UUID) {
	t.Helper()
	pool := testdb.Setup(t, "storeauthors")
	testdb.Truncate(t, pool,
		"project_revisions", "ai_changes", "ai_messages", "ai_conversations",
		"project_event_state", "project_ratings", "project_views", "sessions",
		"invitations", "event_assets", "assets", "events", "team_memberships",
		"projects", "users")
	st := store.New(pool)
	owner, err := st.CreateUser(context.Background(), "owner@example.com", "hash", "Владелец")
	if err != nil {
		t.Fatalf("пользователь: %v", err)
	}
	project, err := st.CreateProject(context.Background(), owner.ID, "Проект", "")
	if err != nil {
		t.Fatalf("проект: %v", err)
	}
	return st, project.ID
}

// Проекция с неизвестным автором не падает на внешнем ключе и пишет NULL.
func TestReplaceEventTreeWithoutAuthor(t *testing.T) {
	st, projectID := setupStore(t)
	ctx := context.Background()

	chapter, child := uuid.New(), uuid.New()
	err := st.ReplaceEventTree(ctx, projectID, uuid.Nil, []store.Event{
		{ID: chapter, ProjectID: projectID, Position: 0, Depth: 0, Title: "Глава", Body: "текст"},
		{ID: child, ProjectID: projectID, ParentID: &chapter, Position: 1, Depth: 1, Title: "Под", Body: "текст"},
	})
	if err != nil {
		t.Fatalf("проекция без автора: %v", err)
	}
	rows, err := st.ListEvents(ctx, projectID)
	if err != nil || len(rows) != 2 {
		t.Fatalf("события: %v (%d)", err, len(rows))
	}
	for _, row := range rows {
		if row.CreatedBy != nil || row.UpdatedBy != nil {
			t.Errorf("автор должен быть NULL, получено created_by=%v updated_by=%v", row.CreatedBy, row.UpdatedBy)
		}
	}

	// Повторная проекция (теперь кадры уже есть) тоже не должна требовать автора:
	// именно этот путь вызывается при миграции текста в живой комнате.
	if err := st.ReplaceEventTree(ctx, projectID, uuid.Nil, []store.Event{
		{ID: chapter, ProjectID: projectID, Position: 0, Depth: 0, Title: "Глава", Body: "новый текст"},
	}); err != nil {
		t.Fatalf("повторная проекция без автора: %v", err)
	}
	rows, _ = st.ListEvents(ctx, projectID)
	if len(rows) != 1 || rows[0].Body != "новый текст" {
		t.Fatalf("после повторной проекции: %+v", rows)
	}
}

// Снапшот с неизвестным автором сохраняется (раньше это было «проект не найден»).
func TestSaveProjectEventStateServerWithoutAuthor(t *testing.T) {
	st, projectID := setupStore(t)
	ctx := context.Background()

	revision, err := st.SaveProjectEventStateServer(ctx, projectID, uuid.Nil, []byte("state-1"))
	if err != nil {
		t.Fatalf("сохранение снапшота без автора: %v", err)
	}
	if revision != 1 {
		t.Errorf("ревизия: %d", revision)
	}
	state, err := st.GetProjectEventState(ctx, projectID)
	if err != nil || state == nil {
		t.Fatalf("снапшот: %v", err)
	}
	if state.UpdatedBy != nil {
		t.Errorf("автор снапшота должен быть NULL, получено %v", state.UpdatedBy)
	}

	// Вторая запись без автора тоже проходит (rev+1) и не затирает снапшот.
	if _, err := st.SaveProjectEventStateServer(ctx, projectID, uuid.Nil, []byte("state-2")); err != nil {
		t.Fatalf("вторая запись: %v", err)
	}
	state, _ = st.GetProjectEventState(ctx, projectID)
	if state.Revision != 2 || string(state.YjsState) != "state-2" {
		t.Errorf("состояние после второй записи: rev=%d state=%q", state.Revision, state.YjsState)
	}
}
