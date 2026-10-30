package collab_test

// ack_integration_test.go — сервер подтверждает приём правки (0.140.0).
//
// Зачем подтверждение. До 0.140.0 клиент узнавал о судьбе правки косвенно: `readyState OPEN` не
// доказывает доставку, поэтому снапшот писался по REST раз в 10 с тишины — с окном потери до
// 10 с. Теперь на кадр правки с номером сервер отвечает подтверждением, и подтверждение означает
// буквально «эти байты уже в документе комнаты». Здесь проверяется эта связка, а не формат (он в
// ack_test.go): подтверждение приходит после применения, приходит только тому, кто прислал, не
// приходит за битые байты и не приходит наблюдателю.

import (
	"bytes"
	"context"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/gorilla/websocket"

	ygo "github.com/Deln0r/ygo"

	"github.com/skyfraze/backend/internal/auth"
	"github.com/skyfraze/backend/internal/collab"
	"github.com/skyfraze/backend/internal/collab/yjs"
	"github.com/skyfraze/backend/internal/events"
	"github.com/skyfraze/backend/internal/platform/testdb"
	"github.com/skyfraze/backend/internal/projects"
	"github.com/skyfraze/backend/internal/store"
)

// Кадры протокола — литералами, а не константами пакета: это проводной контракт с браузером
// (frontend/src/collab/ack.ts), и тест должен падать, если формат поменяли с одной стороны.
const (
	updateFramePrefix = "sfu1:"
	ackFramePrefix    = "sfa1:"
)

type ackEnv struct {
	hub       *collab.Hub
	project   uuid.UUID
	ownerURL  string
	viewerURL string
}

// setupAckHub поднимает хаб с проектом и адресами для двух ролей: владельца и читателя.
func setupAckHub(t *testing.T) *ackEnv {
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

	owner, ownerTokens, err := authSvc.Register(ctx, "ack-owner@example.com", "hunter22!", "Владелец")
	if err != nil {
		t.Fatalf("владелец: %v", err)
	}
	// Второй пользователь — мимо регистрации: на свежей базе она открыта только для первого
	// (так устроена установка), а читатель нужен именно вторым аккаунтом.
	hash, err := auth.HashPassword("hunter22!")
	if err != nil {
		t.Fatalf("хеш пароля: %v", err)
	}
	viewer, err := st.CreateUser(ctx, "ack-viewer@example.com", hash, "Читатель")
	if err != nil {
		t.Fatalf("читатель: %v", err)
	}
	_, viewerTokens, err := authSvc.Login(ctx, "ack-viewer@example.com", "hunter22!")
	if err != nil {
		t.Fatalf("вход читателя: %v", err)
	}
	project, err := projSvc.Create(ctx, owner.ID, "Проект с подтверждением", "")
	if err != nil {
		t.Fatalf("проект: %v", err)
	}
	if err := st.AddMembership(ctx, project.ID, viewer.ID, store.RoleViewer); err != nil {
		t.Fatalf("читатель в проекте: %v", err)
	}

	// Логи хаба живут дольше теста (см. testLogWriter): пишем в буфер, а не в t.Log.
	var logBuf strings.Builder
	logger := slog.New(slog.NewTextHandler(&logBuf, &slog.HandlerOptions{Level: slog.LevelWarn}))
	hub := collab.NewHub(logger, "test-secret", evSvc, "")
	runCtx, stopHub := context.WithCancel(ctx)
	t.Cleanup(stopHub)
	go hub.Run(runCtx)

	server := httptest.NewServer(http.HandlerFunc(hub.HandleWS))
	t.Cleanup(server.Close)
	base := "ws" + strings.TrimPrefix(server.URL, "http") +
		"/api/projects/" + project.ID.String() + "/collab?token="

	return &ackEnv{
		hub:       hub,
		project:   project.ID,
		ownerURL:  base + ownerTokens.Access,
		viewerURL: base + viewerTokens.Access,
	}
}

// dial подключает клиента и ждёт, пока хаб зарегистрирует его в комнате.
func (e *ackEnv) dial(t *testing.T, url string, room int) *websocket.Conn {
	t.Helper()
	conn, _, err := websocket.DefaultDialer.Dial(url, nil)
	if err != nil {
		t.Fatalf("подключение: %v", err)
	}
	t.Cleanup(func() { _ = conn.Close() })
	waitFor(t, 5*time.Second, func() bool { return e.hub.RoomSize(e.project) == room }, "клиент в комнате")
	return conn
}

// sendUpdate отправляет кадр правки так же, как это делает браузер.
func sendUpdate(t *testing.T, conn *websocket.Conn, id string, update []byte) {
	t.Helper()
	frame := make([]byte, 0, len(updateFramePrefix)+len(id)+len(update))
	frame = append(frame, updateFramePrefix...)
	frame = append(frame, id...)
	frame = append(frame, update...)
	if err := conn.WriteMessage(websocket.BinaryMessage, frame); err != nil {
		t.Fatalf("отправка правки: %v", err)
	}
}

// waitForAck читает кадры до подтверждения с нужным номером. false — не дождались.
func waitForAck(t *testing.T, conn *websocket.Conn, id string, timeout time.Duration) bool {
	t.Helper()
	deadline := time.Now().Add(timeout)
	for {
		if err := conn.SetReadDeadline(deadline); err != nil {
			return false
		}
		_, data, err := conn.ReadMessage()
		if err != nil {
			return false
		}
		if bytes.HasPrefix(data, []byte(ackFramePrefix)) && string(data[len(ackFramePrefix):]) == id {
			return true
		}
		// Всё остальное (состояние комнаты, апдейты соседей) к подтверждению отношения не имеет.
	}
}

// serverBody читает текст кадра из документа комнаты серверным разбором.
func (e *ackEnv) serverBody(t *testing.T, eventID string) string {
	t.Helper()
	state := e.hub.LiveState(context.Background(), e.project)
	doc, err := yjs.FromState(state)
	if err != nil {
		t.Fatalf("документ комнаты: %v", err)
	}
	for _, row := range doc.Events() {
		if row.ID == eventID {
			return row.Body
		}
	}
	return ""
}

func TestHubAcksAppliedUpdate(t *testing.T) {
	e := setupAckHub(t)
	conn := e.dial(t, e.ownerURL, 1)

	const eventID = "11111111-1111-1111-1111-111111111111"
	const marker = "текст, который сервер обязан подтвердить"
	doc := newClientDoc()
	seedEventBody(t, doc, eventID, "Глава", marker)
	update := ygo.EncodeStateAsUpdate(doc)

	sendUpdate(t, conn, "0000000a", update)

	if !waitForAck(t, conn, "0000000a", 10*time.Second) {
		t.Fatal("подтверждение не пришло: клиент не знает, доехала ли правка")
	}
	// Подтверждение значит «уже в документе комнаты», а не «скоро будет».
	if body := e.serverBody(t, eventID); body != marker {
		t.Fatalf("после подтверждения в документе комнаты %q, ожидался %q", body, marker)
	}
}

func TestHubDoesNotAckBrokenUpdate(t *testing.T) {
	e := setupAckHub(t)
	conn := e.dial(t, e.ownerURL, 1)

	// Номер есть, апдейта нет — применять нечего. Подтверждение здесь означало бы
	// «правка сохранена» при пустом документе.
	sendUpdate(t, conn, "0000000b", []byte{0xde, 0xad, 0xbe, 0xef})

	if waitForAck(t, conn, "0000000b", time.Second) {
		t.Fatal("сервер подтвердил правку, которую не смог применить")
	}
}

func TestHubDoesNotAckReadOnlyClient(t *testing.T) {
	e := setupAckHub(t)
	conn := e.dial(t, e.viewerURL, 1)

	const eventID = "22222222-2222-2222-2222-222222222222"
	const marker = "правка читателя"
	doc := newClientDoc()
	seedEventBody(t, doc, eventID, "Глава", marker)

	sendUpdate(t, conn, "0000000c", ygo.EncodeStateAsUpdate(doc))

	if waitForAck(t, conn, "0000000c", time.Second) {
		t.Fatal("наблюдатель получил подтверждение: он решил бы, что правка сохранена")
	}
	if body := e.serverBody(t, eventID); body != "" {
		t.Fatalf("апдейт наблюдателя попал в документ комнаты: %q", body)
	}
}

