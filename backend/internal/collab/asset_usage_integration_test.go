package collab_test

// asset_usage_integration_test.go — сколько кадров ссылаются на файл.
//
// Ответ нужен удалению вложения: пока на файл смотрят кадры, файл удалять нельзя —
// в CRDT-документе осталась бы ссылка на несуществующий объект. Ссылки живут
// только в документе (таблица event_assets пуста), поэтому спрашивать надо либо
// живую комнату, либо снапшот базы. Проверяем оба пути: они дают один и тот же
// ответ, но берут его из разных мест, а «проект никто не открывал» — это не
// редкий случай, а половина проектов.
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

// usageEnv — общее окружение обоих тестов: база, сервисы, пользователь и проект.
type usageEnv struct {
	st      *store.Store
	projSvc *projects.Service
	evSvc   *events.Service
	user    uuid.UUID
	tokens  *auth.Tokens
	project uuid.UUID
}

func setupUsageEnv(t *testing.T, email string) *usageEnv {
	t.Helper()
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
	user, tokens, err := authSvc.Register(ctx, email, "hunter22!", "Проверяющий")
	if err != nil {
		t.Fatalf("пользователь: %v", err)
	}
	project, err := projSvc.Create(ctx, user.ID, "Проект с вложениями", "описание")
	if err != nil {
		t.Fatalf("проект: %v", err)
	}
	return &usageEnv{st: st, projSvc: projSvc, evSvc: evSvc, user: user.ID, tokens: tokens, project: project.ID}
}

func (e *usageEnv) hub(t *testing.T) *collab.Hub {
	t.Helper()
	logger := slog.New(slog.NewTextHandler(&testLogWriter{t: t}, &slog.HandlerOptions{Level: slog.LevelDebug}))
	hub := collab.NewHub(logger, "test-secret", e.evSvc, "")
	ctx, stop := context.WithCancel(context.Background())
	t.Cleanup(stop)
	go hub.Run(ctx)
	return hub
}

// assetEvent — событие с вложениями и/или фоном: ровно так их пишет интерфейс.
func assetEvent(id, title string, assets []string, background string) yjs.EventSeed {
	return yjs.EventSeed{ID: id, Title: title, Body: "Текст.", Assets: assets, Background: background}
}

func TestHubAssetUsageFromSnapshot(t *testing.T) {
	e := setupUsageEnv(t, "usage@example.com")
	ctx := context.Background()

	used := uuid.NewString()
	background := uuid.NewString()
	other := uuid.NewString()

	// Документ собираем серверным конструктором: нужен снапшот, а не браузер.
	doc := yjs.NewDoc()
	if err := doc.InsertEvents(0, []yjs.EventSeed{
		assetEvent(uuid.NewString(), "Кадр с вложением", []string{used}, ""),
		assetEvent(uuid.NewString(), "Кадр с фоном", nil, background),
		assetEvent(uuid.NewString(), "Кадр без вложений", nil, ""),
	}); err != nil {
		t.Fatalf("документ: %v", err)
	}
	if _, err := e.evSvc.SaveYjsStateServer(ctx, e.project, e.user, doc.EncodeState()); err != nil {
		t.Fatalf("снапшот: %v", err)
	}

	hub := e.hub(t)

	// Комнаты нет: ответ обязан прийти из снапшота базы.
	if usage, err := hub.AssetUsage(ctx, e.project, uuid.MustParse(used)); err != nil || usage != 1 {
		t.Errorf("вложение: расход %d (err=%v), ожидался 1", usage, err)
	}
	// Фон кадра — это тоже ссылка: без него удаление оставило бы кадр без картинки.
	if usage, err := hub.AssetUsage(ctx, e.project, uuid.MustParse(background)); err != nil || usage != 1 {
		t.Errorf("фон: расход %d (err=%v), ожидался 1", usage, err)
	}
	// Файл, которого в документе нет, не «используется»: 0 — и удалять его можно.
	if usage, err := hub.AssetUsage(ctx, e.project, uuid.MustParse(other)); err != nil || usage != 0 {
		t.Errorf("посторонний файл: расход %d (err=%v), ожидался 0", usage, err)
	}
}

func TestHubAssetUsageFromLiveRoom(t *testing.T) {
	e := setupUsageEnv(t, "live-usage@example.com")
	ctx := context.Background()

	chapter := uuid.NewString()
	seed := newClientDoc()
	seedEventBody(t, seed, chapter, "Глава", "Текст главы.")
	if _, err := e.evSvc.SaveYjsStateServer(ctx, e.project, e.user, ygo.EncodeStateAsUpdate(seed)); err != nil {
		t.Fatalf("снапшот: %v", err)
	}

	hub := e.hub(t)
	server := httptest.NewServer(http.HandlerFunc(hub.HandleWS))
	defer server.Close()
	wsURL := "ws" + strings.TrimPrefix(server.URL, "http") +
		"/api/projects/" + e.project.String() + "/collab?token=" + e.tokens.Access
	conn, _, err := websocket.DefaultDialer.Dial(wsURL, nil)
	if err != nil {
		t.Fatalf("клиент не подключился: %v", err)
	}
	defer func() { _ = conn.Close() }()

	// Ждём состояние комнаты: без загруженного документа проверять нечего.
	client := newClientDoc()
	_ = conn.SetReadDeadline(time.Now().Add(10 * time.Second))
	for findEvent(client, chapter) == nil {
		_, data, err := conn.ReadMessage()
		if err != nil {
			t.Fatalf("клиент не получил состояние комнаты: %v", err)
		}
		if err := ygo.ApplyUpdate(client, data); err != nil {
			t.Fatalf("состояние комнаты не применилось: %v", err)
		}
	}

	// Вставка в живую комнату: файл прикреплён, и расход обязан увидеть это из
	// документа КОМНАТЫ — снапшот в этот момент ещё не перечитан.
	assetID := uuid.NewString()
	parentID := chapter
	if _, err := hub.InsertLive(ctx, e.project, e.user, []yjs.EventSeed{
		assetEvent(uuid.NewString(), "Кадр с картинкой", []string{assetID}, assetID),
	}, yjs.InsertPlace{ParentID: parentID}); err != nil {
		t.Fatalf("вставка: %v", err)
	}

	if usage, err := hub.AssetUsage(ctx, e.project, uuid.MustParse(assetID)); err != nil || usage != 1 {
		t.Errorf("расход из комнаты: %d (err=%v), ожидался 1", usage, err)
	}
}
