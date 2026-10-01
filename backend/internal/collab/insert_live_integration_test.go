package collab_test

// insert_live_integration_test.go — импорт «в место» в ЖИВУЮ комнату.
//
// Здесь проверяется то, чего не видно в тестах transfer: пока проект кто-то
// редактирует, сервер держит документ в памяти и сохраняет именно его. Запись
// вставки только в снапшот базы была бы затёрта ближайшим сохранением комнаты, а
// подключённая вкладка не увидела бы кусок вообще. Поэтому InsertLive обязан:
//
//  1. положить события в документ комнаты;
//  2. разослать апдейт клиентам (в том числе тому, кто импорт и запустил);
//  3. сразу сохранить снапшот и перестроить таблицу событий, не дожидаясь тика;
//  4. честно сказать «комнаты нет» — тогда снапшот пишет вызывающий.
//
// Нужна Postgres (TEST_DATABASE_URL), как и остальным интеграционным тестам.

import (
	"context"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	ygo "github.com/Deln0r/ygo"
	"github.com/google/uuid"
	"github.com/gorilla/websocket"

	"github.com/skyfraze/backend/internal/auth"
	"github.com/skyfraze/backend/internal/collab"
	"github.com/skyfraze/backend/internal/collab/yjs"
	"github.com/skyfraze/backend/internal/events"
	"github.com/skyfraze/backend/internal/platform/testdb"
	"github.com/skyfraze/backend/internal/projects"
	"github.com/skyfraze/backend/internal/store"
)

func TestHubInsertLive(t *testing.T) {
	pool := testdb.Setup(t, "collab")
	testdb.Truncate(t, pool,
		"project_ratings", "project_views", "registration_requests", "app_settings",
		"project_event_state", "sessions", "invitations", "event_assets", "assets",
		"events", "team_memberships", "projects", "users")

	ctx := context.Background()
	st := store.New(pool)
	projSvc := projects.New(st)
	evSvc := events.New(st, projSvc)
	authSvc := auth.New(st, "test-secret")

	user, tokens, err := authSvc.Register(ctx, "insert@example.com", "hunter22!", "Импортёр")
	if err != nil {
		t.Fatalf("пользователь: %v", err)
	}
	project, err := projSvc.Create(ctx, user.ID, "Куда вставлять", "описание")
	if err != nil {
		t.Fatalf("проект: %v", err)
	}

	// Существующая глава — в снапшоте: комнату создаст подключение, а документ она
	// загрузит из базы, как в бою.
	chapter := uuid.New()
	seed := newClientDoc()
	seedEventBody(t, seed, chapter.String(), "Глава", "Текст главы.")
	if _, err := evSvc.SaveYjsStateServer(ctx, project.ID, user.ID, ygo.EncodeStateAsUpdate(seed)); err != nil {
		t.Fatalf("снапшот: %v", err)
	}

	logger := slog.New(slog.NewTextHandler(&testLogWriter{t: t}, &slog.HandlerOptions{Level: slog.LevelDebug}))
	hub := collab.NewHub(logger, "test-secret", evSvc, "")
	runCtx, stopHub := context.WithCancel(ctx)
	defer stopHub()
	go hub.Run(runCtx)

	server := httptest.NewServer(http.HandlerFunc(hub.HandleWS))
	defer server.Close()
	wsURL := "ws" + strings.TrimPrefix(server.URL, "http") +
		"/api/projects/" + project.ID.String() + "/collab?token=" + tokens.Access

	// Живой клиент — «вкладка редактора». Документ свой, как у браузера: получает
	// состояние комнаты при подключении и дальше только апдейты.
	conn, _, err := websocket.DefaultDialer.Dial(wsURL, nil)
	if err != nil {
		t.Fatalf("клиент не подключился: %v", err)
	}
	defer func() { _ = conn.Close() }()
	client := newClientDoc()
	_ = conn.SetReadDeadline(time.Now().Add(10 * time.Second))
	for findEvent(client, chapter.String()) == nil {
		_, data, err := conn.ReadMessage()
		if err != nil {
			t.Fatalf("клиент не получил состояние комнаты: %v", err)
		}
		if err := ygo.ApplyUpdate(client, data); err != nil {
			t.Fatalf("состояние комнаты не применилось: %v", err)
		}
	}

	// Вставка «внутрь главы»: место задаётся родителем в самом событии.
	inserted := uuid.New().String()
	outcome, err := hub.InsertLive(ctx, project.ID, user.ID, []yjs.EventSeed{{
		ID: inserted, ParentID: chapter.String(), Title: "Вставленная глава", Body: "Текст вставки.",
	}}, yjs.InsertPlace{})
	if err != nil {
		t.Fatalf("вставка: %v", err)
	}
	if !outcome.Handled {
		t.Fatal("в комнате с документом вставка обязана обрабатываться хабом")
	}
	if outcome.Warning != "" {
		t.Errorf("сохранение прошло без предупреждений, получено: %q", outcome.Warning)
	}

	// 1. Клиент видит вставку: апдейт доехал тем же сокетом.
	for findEvent(client, inserted) == nil {
		_, data, err := conn.ReadMessage()
		if err != nil {
			t.Fatalf("клиент не получил апдейт вставки: %v", err)
		}
		if err := ygo.ApplyUpdate(client, data); err != nil {
			t.Fatalf("апдейт вставки не применился: %v", err)
		}
	}
	if body := eventBody(client, inserted); body != "Текст вставки." {
		t.Errorf("текст вставки у клиента: %q", body)
	}
	if parent, _ := findEvent(client, inserted).Get("parent_id").(string); parent != chapter.String() {
		t.Errorf("родитель вставки у клиента: %q", parent)
	}

	// 2. Снапшот базы уже содержит вставку — не когда-нибудь по тику.
	saved, err := st.GetProjectEventState(ctx, project.ID)
	if err != nil || saved == nil {
		t.Fatalf("снапшот: %v", err)
	}
	doc, err := yjs.FromState(saved.YjsState)
	if err != nil {
		t.Fatalf("снапшот не читается: %v", err)
	}
	if body := persistedBody(doc, inserted); body != "Текст вставки." {
		t.Errorf("текст вставки в снапшоте: %q", body)
	}

	// 3. Таблица событий перестроена: вставка под главой, глава на месте.
	rows, err := st.ListEvents(ctx, project.ID)
	if err != nil {
		t.Fatalf("события: %v", err)
	}
	if len(rows) != 2 {
		t.Fatalf("событий %d, ожидалось 2: %+v", len(rows), rows)
	}
	var foundInserted, foundChapter bool
	for _, row := range rows {
		switch row.ID.String() {
		case inserted:
			foundInserted = true
			if row.ParentID == nil || *row.ParentID != chapter {
				t.Errorf("вставка в таблице не под главой: %+v", row.ParentID)
			}
		case chapter.String():
			foundChapter = true
			if row.Title != "Глава" {
				t.Errorf("прежняя глава испорчена: %+v", row)
			}
		}
	}
	if !foundInserted || !foundChapter {
		t.Errorf("в таблице нет вставки (%v) или главы (%v)", foundInserted, foundChapter)
	}

	// 4. Комнаты нет — хаб честно отдаёт вставку вызывающему.
	lonely, err := projSvc.Create(ctx, user.ID, "Никто не открыл", "")
	if err != nil {
		t.Fatalf("проект без комнаты: %v", err)
	}
	outcome, err = hub.InsertLive(ctx, lonely.ID, user.ID, []yjs.EventSeed{{
		ID: uuid.New().String(), Title: "Кусок", Body: "Текст.",
	}}, yjs.InsertPlace{})
	if err != nil {
		t.Fatalf("вставка без комнаты: %v", err)
	}
	if outcome.Handled {
		t.Error("без комнаты вставку обрабатывает вызывающий, а не хаб")
	}

	// 5. Слишком глубокий кусок не вставляется: в документе комнаты уже есть
	// вставленная глава (уровень 1), и кусок из четырёх уровней под ней дал бы
	// шесть — `NormalizeTree` такое дерево отвергнет уже ПОСЛЕ вставки, и проекция
	// таблицы событий застряла бы навсегда. Значит, отказ обязан быть до записи.
	rowsBefore := len(mustListEvents(t, st, ctx, project.ID))
	deep := []yjs.EventSeed{
		{ID: uuid.New().String(), ParentID: inserted, Title: "A"},
		{ID: uuid.New().String(), Title: "B"},
		{ID: uuid.New().String(), Title: "C"},
		{ID: uuid.New().String(), Title: "D"},
	}
	deep[1].ParentID = deep[0].ID
	deep[2].ParentID = deep[1].ID
	deep[3].ParentID = deep[2].ID
	outcome, err = hub.InsertLive(ctx, project.ID, user.ID, deep, yjs.InsertPlace{})
	if err != nil {
		t.Fatalf("слишком глубокий кусок: %v", err)
	}
	if !outcome.TooDeep {
		t.Fatalf("ожидался отказ по глубине, получено %+v", outcome)
	}
	if rows := len(mustListEvents(t, st, ctx, project.ID)); rows != rowsBefore {
		t.Errorf("после отказа событий %d, было %d — отказ должен быть до записи", rows, rowsBefore)
	}
	saved, err = st.GetProjectEventState(ctx, project.ID)
	if err != nil || saved == nil {
		t.Fatalf("снапшот после отказа: %v", err)
	}
	after, err := yjs.FromState(saved.YjsState)
	if err != nil {
		t.Fatalf("снапшот не читается: %v", err)
	}
	if after.EventCount() != rowsBefore {
		t.Errorf("в документе комнаты %d событий, было %d", after.EventCount(), rowsBefore)
	}
}

// mustListEvents — строки проекции (нужны как «сколько событий в проекте»).
func mustListEvents(t *testing.T, st *store.Store, ctx context.Context, projectID uuid.UUID) []store.Event {
	t.Helper()
	rows, err := st.ListEvents(ctx, projectID)
	if err != nil {
		t.Fatalf("события: %v", err)
	}
	return rows
}
