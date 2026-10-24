package events_test

// revisions_integration_test.go — история версий проекта (миграция 0016).
//
// Проверяем то, ради чего она сделана: версия снимается и переживает дальнейшие правки;
// троттлинг не даёт автоснимку превратиться в ленту нажатий; удержание не даёт истории
// съесть диск; восстановление возвращает содержимое проекта — в снапшот и в проекцию.
//
// Живой комнаты здесь нет намеренно: путь «через комнату» проверяется тестами коллаборации,
// а здесь важно, что версия работает и без неё (проект никто не открыл — обычный случай
// для восстановления из истории).

import (
	"context"
	"testing"
	"time"

	"github.com/google/uuid"

	"github.com/skyfraze/backend/internal/collab/yjs"
	"github.com/skyfraze/backend/internal/events"
	"github.com/skyfraze/backend/internal/platform/testdb"
	"github.com/skyfraze/backend/internal/projects"
	"github.com/skyfraze/backend/internal/store"
)

type revEnv struct {
	st   *store.Store
	svc  *events.Service
	proj *projects.Service
	user uuid.UUID
}

func setupRevisions(t *testing.T) *revEnv {
	t.Helper()
	pool := testdb.Setup(t, "eventsrev")
	testdb.Truncate(t, pool,
		"project_revisions", "ai_changes", "ai_messages", "ai_conversations",
		"project_event_state", "project_ratings", "project_views", "sessions",
		"invitations", "event_assets", "assets", "events", "team_memberships",
		"projects", "users")

	st := store.New(pool)
	proj := projects.New(st)
	svc := events.New(st, proj)
	user, err := st.CreateUser(context.Background(), "author@example.com", "hash", "Автор")
	if err != nil {
		t.Fatalf("пользователь: %v", err)
	}
	return &revEnv{st: st, svc: svc, proj: proj, user: user.ID}
}

// project создаёт проект с двумя кадрами и снапшотом документа.
func (e *revEnv) project(t *testing.T, nodes ...events.NodeInput) uuid.UUID {
	t.Helper()
	ctx := context.Background()
	p, err := e.proj.Create(ctx, e.user, "Проект с историей", "")
	if err != nil {
		t.Fatalf("проект: %v", err)
	}
	if len(nodes) == 0 {
		nodes = []events.NodeInput{
			{ID: uuid.New(), Position: 0, Title: "Глава 1", Body: "первый текст"},
			{ID: uuid.New(), Position: 1, Title: "Глава 2", Body: "второй текст"},
		}
	}
	if err := e.svc.ProjectTreeServer(ctx, p.ID, e.user, nodes); err != nil {
		t.Fatalf("дерево: %v", err)
	}
	// Снапшот из проекции: так выглядит проект, который открывали в живой комнате.
	doc := yjs.NewDoc()
	seeds := make([]yjs.EventSeed, 0, len(nodes))
	for _, node := range nodes {
		seeds = append(seeds, yjs.EventSeed{ID: node.ID.String(), Title: node.Title, Body: node.Body})
	}
	if err := doc.InsertEvents(0, seeds); err != nil {
		t.Fatalf("документ: %v", err)
	}
	if _, err := e.st.SaveProjectEventStateServer(ctx, p.ID, e.user, doc.EncodeState()); err != nil {
		t.Fatalf("снапшот: %v", err)
	}
	return p.ID
}

func (e *revEnv) bodies(t *testing.T, projectID uuid.UUID) []string {
	t.Helper()
	rows, err := e.st.ListEvents(context.Background(), projectID)
	if err != nil {
		t.Fatalf("события: %v", err)
	}
	out := make([]string, 0, len(rows))
	for _, row := range rows {
		out = append(out, row.Body)
	}
	return out
}

// Ручная версия снимается, читается в списке и в предпросмотре.
func TestSaveAndPreviewRevision(t *testing.T) {
	e := setupRevisions(t)
	ctx := context.Background()
	projectID := e.project(t)

	rev, err := e.svc.SaveRevision(ctx, e.user, projectID, "перед переписыванием")
	if err != nil {
		t.Fatalf("сохранение версии: %v", err)
	}
	if rev.Kind != store.RevisionManual || rev.Label != "перед переписыванием" {
		t.Errorf("версия: %+v", rev)
	}
	if rev.Events != 2 {
		t.Errorf("кадров в версии: %d", rev.Events)
	}

	list, err := e.svc.ListRevisions(ctx, e.user, projectID, 10)
	if err != nil || len(list) != 1 {
		t.Fatalf("список версий: %v (%d)", err, len(list))
	}

	preview, err := e.svc.RevisionPreview(ctx, e.user, projectID, rev.ID)
	if err != nil {
		t.Fatalf("предпросмотр: %v", err)
	}
	if len(preview.Frames) != 2 || preview.Chars == 0 {
		t.Fatalf("предпросмотр: %+v", preview)
	}
	if preview.Frames[0].Title != "Глава 1" || preview.Frames[0].Depth != 0 {
		t.Errorf("первый кадр предпросмотра: %+v", preview.Frames[0])
	}
}

// Восстановление возвращает содержимое: удалённый кадр, текст и порядок.
func TestRestoreRevisionBringsContentBack(t *testing.T) {
	e := setupRevisions(t)
	ctx := context.Background()
	first, second := uuid.New(), uuid.New()
	projectID := e.project(t,
		events.NodeInput{ID: first, Position: 0, Title: "Глава 1", Body: "старый текст"},
		events.NodeInput{ID: second, Position: 1, Title: "Глава 2", Body: "второй"},
	)
	rev, err := e.svc.SaveRevision(ctx, e.user, projectID, "")
	if err != nil {
		t.Fatalf("версия: %v", err)
	}

	// Проект живёт дальше: текст переписали, вторую главу удалили. Правки идут в ДОКУМЕНТ
	// (как в бою через живую комнату), и снапшот сохраняется тем же путём — иначе проекция
	// и документ разошлись бы, чего в реальности не бывает.
	snapshot, _, err := e.svc.GetYjsState(ctx, e.user, projectID)
	if err != nil {
		t.Fatalf("снапшот: %v", err)
	}
	doc, err := yjs.FromState(snapshot)
	if err != nil {
		t.Fatalf("снапшот не читается: %v", err)
	}
	body := "новый текст"
	if _, err := doc.SetEventText(first.String(), nil, &body); err != nil {
		t.Fatalf("правка текста: %v", err)
	}
	if _, err := doc.DeleteEvent(second.String()); err != nil {
		t.Fatalf("удаление кадра: %v", err)
	}
	if _, err := e.st.SaveProjectEventStateServer(ctx, projectID, e.user, doc.EncodeState()); err != nil {
		t.Fatalf("сохранение снапшота: %v", err)
	}
	if err := e.st.UpdateEventContent(ctx, projectID, first, "Глава 1", body, nil, e.user); err != nil {
		t.Fatalf("проекция текста: %v", err)
	}
	if _, err := e.st.DeleteEvent(ctx, projectID, second); err != nil {
		t.Fatalf("проекция удаления: %v", err)
	}
	if bodies := e.bodies(t, projectID); len(bodies) != 1 || bodies[0] != body {
		t.Fatalf("состояние до восстановления: %v", bodies)
	}

	outcome, err := e.svc.RestoreRevision(ctx, e.user, e.user, projectID, rev.ID)
	if err != nil {
		t.Fatalf("восстановление: %v", err)
	}
	if outcome.Added != 1 || outcome.Updated != 1 {
		t.Errorf("исход восстановления: %+v", outcome)
	}

	bodies := e.bodies(t, projectID)
	if len(bodies) != 2 || bodies[0] != "старый текст" || bodies[1] != "второй" {
		t.Fatalf("после восстановления: %v", bodies)
	}
	// И снапшот теперь тот же: открытые вкладки увидят восстановленное.
	snapshot, _, err = e.svc.GetYjsState(ctx, e.user, projectID)
	if err != nil {
		t.Fatalf("снапшот: %v", err)
	}
	restoredDoc, err := yjs.FromState(snapshot)
	if err != nil {
		t.Fatalf("снапшот не читается: %v", err)
	}
	if count := restoredDoc.EventCount(); count != 2 {
		t.Errorf("кадров в снапшоте после восстановления: %d", count)
	}
	// Повторное восстановление той же версии — «менять нечего», без ложных изменений.
	again, err := e.svc.RestoreRevision(ctx, e.user, e.user, projectID, rev.ID)
	if err != nil {
		t.Fatalf("повторное восстановление: %v", err)
	}
	if again.Removed+again.Added+again.Updated+again.Moved != 0 {
		t.Errorf("повторное восстановление что-то изменило: %+v", again)
	}
}

// Автоснимок не плодит версии: троттлинг по времени и по содержимому.
func TestAutoRevisionThrottles(t *testing.T) {
	e := setupRevisions(t)
	ctx := context.Background()
	projectID := e.project(t)
	e.svc.UseRevisionPolicy(events.RevisionPolicy{Interval: time.Hour, Keep: 50})

	snapshot, _, err := e.svc.GetYjsState(ctx, e.user, projectID)
	if err != nil {
		t.Fatalf("снапшот: %v", err)
	}
	e.svc.MaybeSaveRevision(ctx, projectID, e.user, snapshot)
	list, _ := e.svc.ListRevisions(ctx, e.user, projectID, 10)
	if len(list) != 1 {
		t.Fatalf("первый автоснимок не снялся: %d", len(list))
	}
	// Тот же снапшот сразу — вторая версия не нужна.
	e.svc.MaybeSaveRevision(ctx, projectID, e.user, snapshot)
	list, _ = e.svc.ListRevisions(ctx, e.user, projectID, 10)
	if len(list) != 1 {
		t.Fatalf("продублировался автоснимок: %d", len(list))
	}
	// Изменившееся содержимое, но интервал не прошёл — тоже не снимаем.
	doc, _ := yjs.FromState(snapshot)
	if err := doc.InsertEvents(2, []yjs.EventSeed{{ID: uuid.NewString(), Title: "Глава 3", Body: "третий"}}); err != nil {
		t.Fatalf("документ: %v", err)
	}
	e.svc.MaybeSaveRevision(ctx, projectID, e.user, doc.EncodeState())
	list, _ = e.svc.ListRevisions(ctx, e.user, projectID, 10)
	if len(list) != 1 {
		t.Fatalf("снял версию раньше интервала: %d", len(list))
	}
}

// Удержание: не больше keep версий на проект.
func TestRevisionsRetentionKeepsNewest(t *testing.T) {
	e := setupRevisions(t)
	ctx := context.Background()
	projectID := e.project(t)
	e.svc.UseRevisionPolicy(events.RevisionPolicy{Interval: time.Nanosecond, Keep: 2})

	for i := 0; i < 4; i++ {
		if _, err := e.svc.SaveRevision(ctx, e.user, projectID, ""); err != nil {
			t.Fatalf("версия %d: %v", i, err)
		}
	}
	list, err := e.svc.ListRevisions(ctx, e.user, projectID, 10)
	if err != nil {
		t.Fatalf("список: %v", err)
	}
	if len(list) > 2 {
		t.Fatalf("удержание не сработало: %d версий", len(list))
	}
}

// Читатель версии видит, но не восстанавливает.
func TestRestoreRequiresEditor(t *testing.T) {
	e := setupRevisions(t)
	ctx := context.Background()
	projectID := e.project(t)
	rev, err := e.svc.SaveRevision(ctx, e.user, projectID, "")
	if err != nil {
		t.Fatalf("версия: %v", err)
	}
	viewer, err := e.st.CreateUser(ctx, "viewer@example.com", "hash", "Читатель")
	if err != nil {
		t.Fatalf("читатель: %v", err)
	}
	if err := e.st.AddMembership(ctx, projectID, viewer.ID, store.RoleViewer); err != nil {
		t.Fatalf("участие: %v", err)
	}
	if _, err := e.svc.RestoreRevision(ctx, viewer.ID, viewer.ID, projectID, rev.ID); err == nil {
		t.Fatal("читатель не должен восстанавливать версии")
	}
	// А список и предпросмотр — можно: историю читает любой участник.
	if _, err := e.svc.ListRevisions(ctx, viewer.ID, projectID, 10); err != nil {
		t.Fatalf("список для читателя: %v", err)
	}
	if _, err := e.svc.RevisionPreview(ctx, viewer.ID, projectID, rev.ID); err != nil {
		t.Fatalf("предпросмотр для читателя: %v", err)
	}
}
