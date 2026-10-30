package collab

// adopt_integration_test.go — слепая комната доливает документ из базы (0.140.3).
//
// Проверяем два состояния, из которых вырос CI-баг «глава помощника исчезла после
// перезагрузки»: комната, загрузившая пустой документ при непустой базе (должна долить и
// перестать быть слепой), и комната, у которой в базе только таблица событий без снапшота
// (долить нечего — писать пустоту нельзя, таблица должна остаться).

import (
	"context"
	"io"
	"log/slog"
	"testing"

	"github.com/google/uuid"

	"github.com/skyfraze/backend/internal/collab/yjs"
	"github.com/skyfraze/backend/internal/events"
	"github.com/skyfraze/backend/internal/platform/testdb"
	"github.com/skyfraze/backend/internal/projects"
	"github.com/skyfraze/backend/internal/store"
)

type adoptEnv struct {
	st      *store.Store
	ev      *events.Service
	project uuid.UUID
	user    uuid.UUID
}

func setupAdopt(t *testing.T) *adoptEnv {
	t.Helper()
	pool := testdb.Setup(t, "collab-adopt")
	testdb.Truncate(t, pool,
		"project_ratings", "project_views", "registration_requests", "app_settings",
		"project_event_state", "sessions", "invitations", "event_assets", "assets",
		"events", "team_memberships", "projects", "users")

	ctx := context.Background()
	st := store.New(pool)
	proj := projects.New(st)
	svc := events.New(st, proj)
	user, err := st.CreateUser(ctx, "adopt@example.com", "hash", "Хозяин")
	if err != nil {
		t.Fatalf("пользователь: %v", err)
	}
	project, err := proj.Create(ctx, user.ID, "Слепая комната", "")
	if err != nil {
		t.Fatalf("проект: %v", err)
	}
	return &adoptEnv{st: st, ev: svc, project: project.ID, user: user.ID}
}

// blindRoom — комната, которая загрузилась пустой: ровно то состояние, в котором она не
// видит базу.
func blindRoom(projectID uuid.UUID) *Room {
	return &Room{
		projectID:    projectID,
		doc:          yjs.NewDoc(),
		clients:      map[*client]struct{}{},
		loadedEvents: 0,
	}
}

func testLogger() *slog.Logger {
	return slog.New(slog.NewTextHandler(io.Discard, nil))
}

func TestAdoptBaseFillsBlindRoom(t *testing.T) {
	e := setupAdopt(t)
	ctx := context.Background()

	// База: снапшот с одной главой — так его записал бы путь помощника, минуя комнату.
	stored := yjs.NewDoc()
	if err := stored.SeedEvents([]yjs.EventSeed{
		{ID: uuid.NewString(), Title: "Пролог", Body: "Текст главы."},
	}); err != nil {
		t.Fatalf("документ базы: %v", err)
	}
	if _, err := e.st.SaveProjectEventStateServer(ctx, e.project, e.user, stored.EncodeState()); err != nil {
		t.Fatalf("снапшот базы: %v", err)
	}

	room := blindRoom(e.project)
	if !room.blind() {
		t.Fatal("комната с пустым документом должна считаться слепой")
	}
	if !room.adoptBase(ctx, e.ev, testLogger()) {
		t.Fatal("доливка не сработала: кадры из базы не доехали")
	}
	if got := room.doc.EventCount(); got != 1 {
		t.Fatalf("после доливки в комнате %d кадров, ожидался 1", got)
	}
	if room.blind() {
		t.Fatal("комната осталась слепой после доливки")
	}
	if !room.dirty {
		t.Fatal("после доливки состояние должно уйти в базу")
	}
	// Идемпотентность: повторная доливка ничего не ломает и не задваивает кадры.
	if !room.adoptBase(ctx, e.ev, testLogger()) {
		t.Fatal("комната с кадрами должна отвечать «кадры есть»")
	}
	if got := room.doc.EventCount(); got != 1 {
		t.Fatalf("после повторной доливки %d кадров", got)
	}
}

func TestBlindRoomDoesNotOverwriteTable(t *testing.T) {
	e := setupAdopt(t)
	ctx := context.Background()

	// База: кадры только в таблице (снапшота нет) — так выглядит проект, импортированный
	// без CRDT, и ровно так база оставалась в CI после помощника.
	chapter := uuid.New()
	if err := e.ev.ProjectTreeServer(ctx, e.project, e.user, []events.NodeInput{
		{ID: chapter, Position: 0, Title: "Пролог", Body: "Текст главы."},
	}); err != nil {
		t.Fatalf("дерево: %v", err)
	}

	room := blindRoom(e.project)
	room.dirty = true
	if err := room.persistFromAnyClient(ctx, e.ev, testLogger()); err != nil {
		t.Fatalf("сохранение слепой комнаты: %v", err)
	}
	// Главное: таблица не опустела от «пустого» сохранения.
	rows, err := e.st.ListEvents(ctx, e.project)
	if err != nil {
		t.Fatalf("таблица событий: %v", err)
	}
	if len(rows) != 1 || rows[0].Title != "Пролог" {
		t.Fatalf("слепая комната затёрла проекцию: %+v", rows)
	}
	// И комната по-прежнему слепая: врать себе, что состояние записано, она не должна.
	if !room.blind() {
		t.Fatal("комната притворилась, что видела базу")
	}
}

func TestNewEmptyProjectStillSaves(t *testing.T) {
	e := setupAdopt(t)
	ctx := context.Background()

	// Новый проект: пусто и в комнате, и в базе — писать можно (это не затирание).
	room := blindRoom(e.project)
	room.dirty = true
	if err := room.persistFromAnyClient(ctx, e.ev, testLogger()); err != nil {
		t.Fatalf("сохранение пустого проекта: %v", err)
	}
	if room.dirty {
		t.Fatal("флаг «грязно» должен сняться: запись прошла")
	}
}
