package store_test

import (
	"context"
	"errors"
	"fmt"
	"sync"
	"testing"
	"time"

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

// Проекция дерева собирается из локального CRDT вкладки. Если вкладка не видела
// чужих правок (снапшот уже сохранили), её payload не содержит чужих событий — и
// полная замена дерева их удалила бы. Ревизионная проверка обязана это отсечь,
// а «свежий» клиент с актуальной ревизией — проходить.
func TestReplaceEventTreeChecked_StaleRevisionRejected(t *testing.T) {
	pool := testdb.Setup(t, "store")
	testdb.Truncate(t, pool,
		"project_ratings", "project_views", "registration_requests", "app_settings",
		"project_event_state", "sessions", "invitations", "event_assets", "assets",
		"events", "team_memberships", "projects", "users")

	ctx := context.Background()
	st := store.New(pool)
	user, err := st.CreateUser(ctx, "owner2@example.com", "hash", "Владелец")
	if err != nil {
		t.Fatalf("create user: %v", err)
	}
	project, err := projects.New(st).Create(ctx, user.ID, "Проект", "описание")
	if err != nil {
		t.Fatalf("create project: %v", err)
	}

	chapter := uuid.New()
	seed := []store.Event{
		{ID: chapter, ProjectID: project.ID, Position: 0, Depth: 0, Title: "Глава", Body: "текст"},
	}
	// Снапшота ещё нет: базовой считается нулевая ревизия.
	if err := st.ReplaceEventTreeChecked(ctx, project.ID, user.ID, seed, 0); err != nil {
		t.Fatalf("первая запись с ревизией 0: %v", err)
	}

	// Кто-то сохранил снапшот — ревизия стала 1.
	revision, err := st.SaveProjectEventState(ctx, project.ID, user.ID, []byte("state"), 0)
	if err != nil {
		t.Fatalf("save state: %v", err)
	}
	if revision != 1 {
		t.Fatalf("ревизия снапшота %d, ожидалась 1", revision)
	}

	// Устаревший клиент (видел ревизию 0) пытается снести дерево целиком.
	stale := []store.Event{}
	if err := st.ReplaceEventTreeChecked(ctx, project.ID, user.ID, stale, 0); !errors.Is(err, store.ErrRevisionConflict) {
		t.Fatalf("устаревшая проекция: ожидался ErrRevisionConflict, получено %v", err)
	}
	rows, err := st.ListEvents(ctx, project.ID)
	if err != nil {
		t.Fatalf("list events: %v", err)
	}
	if len(rows) != 1 {
		t.Fatalf("после отклонённой проекции событий %d, ожидалось 1", len(rows))
	}

	// Актуальный клиент (прочитал ревизию 1) пишет успешно.
	fresh := []store.Event{
		{ID: chapter, ProjectID: project.ID, Position: 0, Depth: 0, Title: "Глава", Body: "текст"},
		{ID: uuid.New(), ProjectID: project.ID, ParentID: &chapter, Position: 0, Depth: 1, Title: "Новое", Body: "текст"},
	}
	if err := st.ReplaceEventTreeChecked(ctx, project.ID, user.ID, fresh, revision); err != nil {
		t.Fatalf("свежая проекция: %v", err)
	}
	rows, err = st.ListEvents(ctx, project.ID)
	if err != nil {
		t.Fatalf("list events: %v", err)
	}
	if len(rows) != 2 {
		t.Fatalf("после свежей проекции событий %d, ожидалось 2", len(rows))
	}
}

// Дата события в проекции дерева: «не пришла» — не трогать, null — очистить,
// значение — записать. Без этого различия проекция клиента, который даты не
// видел (старый снапшот, импорт без CRDT), стирала бы её молча.
func TestReplaceEventTree_EventDateIsThreeState(t *testing.T) {
	pool := testdb.Setup(t, "store")
	testdb.Truncate(t, pool,
		"project_ratings", "project_views", "registration_requests", "app_settings",
		"project_event_state", "sessions", "invitations", "event_assets", "assets",
		"events", "team_memberships", "projects", "users")

	ctx := context.Background()
	st := store.New(pool)
	user, err := st.CreateUser(ctx, "owner3@example.com", "hash", "Владелец")
	if err != nil {
		t.Fatalf("create user: %v", err)
	}
	project, err := projects.New(st).Create(ctx, user.ID, "Проект", "описание")
	if err != nil {
		t.Fatalf("create project: %v", err)
	}

	eventID := uuid.New()
	date := time.Date(2024, time.May, 17, 0, 0, 0, 0, time.UTC)
	// Импорт: дата пришла и записывается.
	if err := st.ReplaceEventTree(ctx, project.ID, user.ID, []store.Event{{
		ID: eventID, ProjectID: project.ID, Position: 0, Depth: 0, Title: "Глава", Body: "текст",
		EventDate: &date, EventDateSet: true,
	}}); err != nil {
		t.Fatalf("seed с датой: %v", err)
	}
	dateOf := func() *time.Time {
		ev, err := st.GetEvent(ctx, project.ID, eventID)
		if err != nil {
			t.Fatalf("get event: %v", err)
		}
		return ev.EventDate
	}
	if got := dateOf(); got == nil || got.Format("2006-01-02") != "2024-05-17" {
		t.Fatalf("дата в базе: %v, ожидалась 2024-05-17", got)
	}

	// Проекция клиента, который даты не видел: поля нет — дата остаётся.
	if err := st.ReplaceEventTree(ctx, project.ID, user.ID, []store.Event{{
		ID: eventID, ProjectID: project.ID, Position: 0, Depth: 0, Title: "Глава", Body: "текст",
	}}); err != nil {
		t.Fatalf("проекция без даты: %v", err)
	}
	if got := dateOf(); got == nil {
		t.Fatal("дата стёрта проекцией без поля event_date — так быть не должно")
	}

	// Редактор очистил дату: поле пришло пустым — дата очищается.
	if err := st.ReplaceEventTree(ctx, project.ID, user.ID, []store.Event{{
		ID: eventID, ProjectID: project.ID, Position: 0, Depth: 0, Title: "Глава", Body: "текст",
		EventDateSet: true,
	}}); err != nil {
		t.Fatalf("проекция с очисткой даты: %v", err)
	}
	if got := dateOf(); got != nil {
		t.Fatalf("дата после очистки: %v, ожидалось пусто", got)
	}

	// И снова записывается, если пришла значением.
	if err := st.ReplaceEventTree(ctx, project.ID, user.ID, []store.Event{{
		ID: eventID, ProjectID: project.ID, Position: 0, Depth: 0, Title: "Глава", Body: "текст",
		EventDate: &date, EventDateSet: true,
	}}); err != nil {
		t.Fatalf("проекция с датой: %v", err)
	}
	if got := dateOf(); got == nil {
		t.Fatal("дата не записалась из проекции")
	}
}
