package store_test

import (
	"context"
	"fmt"
	"sync"
	"testing"

	"github.com/google/uuid"

	"github.com/skyfraze/backend/internal/platform/testdb"
	"github.com/skyfraze/backend/internal/projects"
	"github.com/skyfraze/backend/internal/store"
)

// Дерево событий — проекция проекта ЦЕЛИКОМ: правки из редактора приезжают
// отдельными PUT'ами, и два сохранения одного проекта легко заходят наперегонки.
// Строки блокировались в разном порядке (FOR UPDATE + проверки внешних ключей при
// переносе узлов), Postgres снимал одну транзакцию как жертву deadlock'а (40P01),
// и человек получал 500 «правки не сохранились». Транзакционная блокировка по
// проекту выстраивает сохранения в очередь — этот тест держит её на месте.
func TestReplaceEventTree_ConcurrentSyncDoesNotDeadlock(t *testing.T) {
	pool := testdb.Setup(t, "store")
	testdb.Truncate(t, pool,
		"project_ratings", "project_views", "registration_requests", "app_settings",
		"project_event_state", "sessions", "invitations", "event_assets", "assets",
		"events", "team_memberships", "projects", "users")

	ctx := context.Background()
	st := store.New(pool)
	user, err := st.CreateUser(ctx, "owner@example.com", "hash", "Владелец")
	if err != nil {
		t.Fatalf("create user: %v", err)
	}
	project, err := projects.New(st).Create(ctx, user.ID, "Проект", "описание")
	if err != nil {
		t.Fatalf("create project: %v", err)
	}

	// Общий каркас: глава с двумя под-событиями. Каждая «версия» переставляет
	// детей между родителями — именно так выглядят параллельные сохранения.
	chapter := uuid.New()
	first := uuid.New()
	second := uuid.New()
	seed := []store.Event{
		{ID: chapter, ProjectID: project.ID, Position: 0, Depth: 0, Title: "Глава", Body: "текст"},
		{ID: first, ProjectID: project.ID, ParentID: &chapter, Position: 0, Depth: 1, Title: "Первое", Body: "текст"},
		{ID: second, ProjectID: project.ID, ParentID: &chapter, Position: 1, Depth: 1, Title: "Второе", Body: "текст"},
	}
	if err := st.ReplaceEventTree(ctx, project.ID, user.ID, seed); err != nil {
		t.Fatalf("seed: %v", err)
	}

	// Вариант дерева: у половины горутин дети переставлены и добавлен новый узел,
	// у половины порядок другой — блокировки берутся в разном порядке.
	tree := func(variant int) []store.Event {
		if variant%2 == 0 {
			return []store.Event{
				{ID: chapter, ProjectID: project.ID, Position: 0, Depth: 0, Title: "Глава", Body: "текст"},
				{ID: second, ProjectID: project.ID, ParentID: &chapter, Position: 0, Depth: 1, Title: "Второе", Body: "текст"},
				{ID: first, ProjectID: project.ID, ParentID: &chapter, Position: 1, Depth: 1, Title: "Первое", Body: "текст"},
			}
		}
		child := uuid.New()
		return []store.Event{
			{ID: chapter, ProjectID: project.ID, Position: 0, Depth: 0, Title: "Глава", Body: "текст"},
			{ID: first, ProjectID: project.ID, ParentID: &chapter, Position: 0, Depth: 1, Title: "Первое", Body: "текст"},
			{ID: second, ProjectID: project.ID, ParentID: &chapter, Position: 1, Depth: 1, Title: "Второе", Body: "текст"},
			{ID: child, ProjectID: project.ID, ParentID: &first, Position: 0, Depth: 2, Title: "Новое", Body: "текст"},
		}
	}

	const workers = 8
	const rounds = 6
	var wg sync.WaitGroup
	failures := make(chan error, workers)
	for w := 0; w < workers; w++ {
		wg.Add(1)
		go func(w int) {
			defer wg.Done()
			for round := 0; round < rounds; round++ {
				if err := st.ReplaceEventTree(ctx, project.ID, user.ID, tree(w+round)); err != nil {
					failures <- fmt.Errorf("воркер %d, круг %d: %w", w, round, err)
					return
				}
			}
		}(w)
	}
	wg.Wait()
	close(failures)
	for err := range failures {
		t.Fatalf("параллельная синхронизация дерева: %v", err)
	}

	// Дерево осталось целым: глава на месте, дети ссылаются на неё.
	rows, err := st.ListEvents(ctx, project.ID)
	if err != nil {
		t.Fatalf("list events: %v", err)
	}
	roots := 0
	for _, row := range rows {
		if row.Depth == 0 {
			roots++
		}
	}
	if roots != 1 {
		t.Fatalf("после параллельных сохранений корней %d, ожидался 1 (событий всего %d)", roots, len(rows))
	}
}
