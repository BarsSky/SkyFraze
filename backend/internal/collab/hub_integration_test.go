package collab_test

import (
	"context"
	"fmt"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
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

// Нагрузочная проверка серверного CRDT (Фазы 3–4): двадцать живых WebSocket-клиентов
// правят одно поле одного проекта. Проверяем то, чего не видно в юнит-тестах:
//
//  1. сходимость — у всех клиентов и в снапшоте базы в итоге один и тот же текст,
//     и в нём есть вставка каждого автора;
//  2. стоимость записи — сотни апдейтов не превращаются в сотни UPDATE'ов:
//     снапшот пишется по расписанию и при уходе последнего клиента;
//  3. размер снапшота — правки не раздувают состояние квадратично.
//
// Клиенты здесь говорят на том же формате, что и браузер (это те же байты Yjs), но
// собираются прямо на Go — так тест не зависит от скорости браузера и меряет сервер.
// Нужна Postgres (TEST_DATABASE_URL), как и остальным интеграционным тестам.
func TestHubMergesConcurrentClients(t *testing.T) {
	if testing.Short() {
		t.Skip("нагрузочный тест: пропущен в -short")
	}

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

	user, tokens, err := authSvc.Register(ctx, "hub@example.com", "hunter22!", "Хаб")
	if err != nil {
		t.Fatalf("пользователь: %v", err)
	}
	project, err := projSvc.Create(ctx, user.ID, "Проект нагрузки", "описание")
	if err != nil {
		t.Fatalf("проект: %v", err)
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

	const clients = 20
	const editsPerClient = 15
	const markerLength = len(" [00]")

	// Засев: одно событие с текстом, как после засева из REST-строк.
	eventID := uuid.New().String()
	seed := newClientDoc()
	seedEventBody(t, seed, eventID, "Глава нагрузки", "Общее начало.")

	peers := make([]*clientDoc, 0, clients)
	for i := 0; i < clients; i++ {
		conn, _, err := websocket.DefaultDialer.Dial(wsURL, nil)
		if err != nil {
			t.Fatalf("клиент %d не подключился: %v", i, err)
		}
		defer func() { _ = conn.Close() }()
		peers = append(peers, &clientDoc{
			index:  i,
			conn:   conn,
			doc:    newClientDoc(),
			marker: fmt.Sprintf(" [%02d]", i),
		})
	}

	// Каждый клиент применяет всё, что приходит из комнаты.
	var readers sync.WaitGroup
	stopReading := make(chan struct{})
	readers.Add(len(peers))
	for _, p := range peers {
		go func(p *clientDoc) {
			defer readers.Done()
			for {
				select {
				case <-stopReading:
					return
				default:
				}
				conn := p.currentConn()
				if conn == nil {
					time.Sleep(10 * time.Millisecond)
					continue
				}
				_ = conn.SetReadDeadline(time.Now().Add(20 * time.Second))
				_, data, err := conn.ReadMessage()
				if err != nil {
					// Сокет могли заменить переподключением — тогда читаем новый.
					if p.currentConn() != conn {
						continue
					}
					return
				}
				if err := ygo.ApplyUpdate(p.doc, data); err != nil {
					// Кадры присутствия в этом тесте не участвуют: замер про документ.
					continue
				}
			}
		}(p)
	}

	// Засев отправляет первый клиент; остальные ждут, пока он до них доедет.
	if err := ygo.ApplyUpdate(peers[0].doc, ygo.EncodeStateAsUpdate(seed)); err != nil {
		t.Fatalf("засев у клиента 0: %v", err)
	}
	if err := peers[0].conn.WriteMessage(websocket.BinaryMessage, ygo.EncodeStateAsUpdate(peers[0].doc)); err != nil {
		t.Fatalf("отправка засева: %v", err)
	}
	waitFor(t, 5*time.Second, func() bool {
		for _, p := range peers {
			if eventBody(p.doc, eventID) == "" {
				return false
			}
		}
		return true
	}, "все клиенты получили событие")

	revisionBefore := int64(0)
	if state, err := st.GetProjectEventState(ctx, project.ID); err == nil && state != nil {
		revisionBefore = state.Revision
	}

	// Правки: каждый автор вставляет свой кусок в конец текста и отправляет ДЕЛЬТУ —
	// как настоящий клиент (полное состояние уходит только при подключении, а после
	// разрыва клиент переподключается и досылает состояние целиком).
	start := time.Now()
	var senders sync.WaitGroup
	for _, p := range peers {
		senders.Add(1)
		go func(p *clientDoc) {
			defer senders.Done()
			for i := 0; i < editsPerClient; i++ {
				before := ygo.EncodeStateVector(p.doc)
				if err := appendEventBody(p.doc, eventID, p.marker); err != nil {
					t.Errorf("клиент %d: правка: %v", p.index, err)
					return
				}
				delta, err := ygo.EncodeDiff(p.doc, before)
				if err != nil {
					t.Errorf("клиент %d: дельта: %v", p.index, err)
					return
				}
				if err := p.sendDelta(wsURL, delta); err != nil {
					t.Errorf("клиент %d: отправка: %v", p.index, err)
					return
				}
			}
		}(p)
	}
	senders.Wait()
	elapsed := time.Since(start)

	// Сходимость. Каждый клиент досылает состояние целиком — так делает браузер
	// после переподключения (onopen), и это закрывает гонку, которую видно только
	// под нагрузкой: сервер рвёт медленного клиента, а его запись в закрывающийся
	// сокет выглядит успешной, поэтому последние дельты до сервера не доходят.
	// Проверяем результат НОВЫМ клиентом: он получает состояние комнаты целиком.
	// Попыток несколько: под нагрузкой разрыв может прийтись на момент отправки, и
	// тогда состояние просто досылается заново — ровно как в браузере.
	wantMarkers := make([]string, 0, clients)
	for _, p := range peers {
		wantMarkers = append(wantMarkers, p.marker)
	}
	wantLength := len([]rune("Общее начало.")) + clients*editsPerClient*markerLength

	var lateText string
	attempts := 0
	for ; attempts < 10; attempts++ {
		for _, p := range peers {
			if err := p.resend(wsURL); err != nil {
				t.Errorf("клиент %d: досыл состояния: %v", p.index, err)
			}
		}
		text, complete := readFullState(t, wsURL, eventID, wantLength, wantMarkers)
		if complete {
			lateText = text
			break
		}
		lateText = text
	}

	found := 0
	for _, marker := range wantMarkers {
		if strings.Contains(lateText, marker) {
			found++
		}
	}
	t.Logf("состояние комнаты: %d символов из %d, вставок %d из %d, попыток %d, фрагмент %q",
		len([]rune(lateText)), wantLength, found, clients, attempts+1, truncate(lateText, 80))
	if found != clients {
		t.Fatalf("в состоянии комнаты нет всех вставок: %d из %d (%q)", found, clients, truncate(lateText, 160))
	}
	sample := lateText

	// Клиенты, оставшиеся на связи, не должны ПРОТИВОРЕЧИТЬ серверу: отстать они
	// могут (сервер рвёт медленных, чтобы не терять апдейты молча), но выдумать
	// чужого текста или потерять свой — нет. Даём им пару секунд догнать.
	time.Sleep(3 * time.Second)
	live, complete := 0, 0
	for _, p := range peers {
		text := strings.TrimSpace(eventBody(p.doc, eventID))
		if text == "" {
			continue
		}
		live++
		if len([]rune(text)) > len([]rune(sample)) {
			t.Fatalf("клиент %d знает больше сервера: %d > %d", p.index, len([]rune(text)), len([]rune(sample)))
		}
		if strings.Contains(text, p.marker) && len([]rune(text)) == len([]rune(sample)) {
			complete++
		}
		// Каждый маркер, который видит клиент, обязан быть и в состоянии сервера.
		for _, q := range peers {
			if strings.Contains(text, q.marker) && !strings.Contains(sample, q.marker) {
				t.Fatalf("клиент %d видит вставку %q, которой нет на сервере", p.index, q.marker)
			}
		}
	}
	t.Logf("клиентов на связи: %d из %d, догнали сервер полностью: %d", live, clients, complete)

	// Уход последнего клиента заставляет сервер записать снапшот сразу.
	for _, p := range peers {
		_ = p.conn.Close()
	}
	close(stopReading)
	readers.Wait()

	var after *store.ProjectEventState
	waitFor(t, 15*time.Second, func() bool {
		state, err := st.GetProjectEventState(ctx, project.ID)
		if err != nil || state == nil || len(state.YjsState) == 0 {
			return false
		}
		after = state
		return true
	}, "снапшот записан после ухода клиентов")

	// Снапшот из базы читаем серверным же портом: он должен содержать тот же текст.
	persisted, err := yjs.FromState(after.YjsState)
	if err != nil {
		t.Fatalf("снапшот из базы не читается: %v", err)
	}
	if got := persistedBody(persisted, eventID); got != sample {
		t.Fatalf("снапшот в базе разошёлся с клиентами:\n база: %q\n клиент: %q", got, sample)
	}

	updates := clients * editsPerClient
	writes := after.Revision - revisionBefore
	if writes > 6 {
		t.Fatalf("апдейтов %d, а записей снапшота %d: похоже, пишем на каждую правку", updates, writes)
	}
	if size := len(after.YjsState); size > 512*1024 {
		t.Fatalf("снапшот вырос до %d байт при %d правках", size, updates)
	}

	t.Logf("клиентов %d, апдейтов %d, время %.2f с (%.0f апдейт/с), записей снапшота %d, размер снапшота %d байт, текста %d символов",
		clients, updates, elapsed.Seconds(), float64(updates)/elapsed.Seconds(), writes, len(after.YjsState), len([]rune(sample)))

	// Проекция дерева: сервер обязан перенести структуру в таблицу событий сам.
	// Она пишется в том же вызове, что и снапшот, но чуть позже — поэтому ждём.
	var rows []store.Event
	rowsDeadline := time.Now().Add(10 * time.Second)
	for time.Now().Before(rowsDeadline) {
		rows, err = st.ListEvents(ctx, project.ID)
		if err != nil {
			t.Fatalf("события в базе: %v", err)
		}
		if len(rows) > 0 {
			break
		}
		time.Sleep(100 * time.Millisecond)
	}
	if len(rows) != 1 {
		t.Fatalf("в таблице событий %d строк, ожидалась 1", len(rows))
	}
	if rows[0].ID.String() != eventID {
		t.Fatalf("в таблице событие %s, ожидалось %s", rows[0].ID, eventID)
	}
	if body := rows[0].Body; !strings.Contains(body, sample[:16]) {
		t.Fatalf("в таблице событий текст не тот: %q", body)
	}
}

// clientDoc — «браузер» в этом тесте: документ Yjs и сокет до хаба.
//
// Доступ к сокету под мьютексом: во время правок клиент может переподключаться
// (сервер рвёт медленных), а читающая горутина в это же время читает — без
// блокировки получается гонка за указатель, из-за которой тест падал.
type clientDoc struct {
	mu     sync.Mutex
	index  int
	conn   *websocket.Conn
	doc    *ygo.Doc
	marker string
}

func (c *clientDoc) currentConn() *websocket.Conn {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.conn
}

func (c *clientDoc) takeConn(conn *websocket.Conn) {
	c.mu.Lock()
	previous := c.conn
	c.conn = conn
	c.mu.Unlock()
	if previous != nil && previous != conn {
		_ = previous.Close()
	}
}

// sendDelta отправляет дельту, а при обрыве переподключается и досылает состояние
// целиком: сервер рвёт медленных клиентов (переполненный буфер — разрыв, а не
// молчаливая потеря), и без переподключения их правки до сервера не дойдут.
func (c *clientDoc) sendDelta(wsURL string, delta []byte) error {
	if conn := c.currentConn(); conn != nil {
		if err := conn.WriteMessage(websocket.BinaryMessage, delta); err == nil {
			return nil
		}
	}
	conn, _, err := websocket.DefaultDialer.Dial(wsURL, nil)
	if err != nil {
		return err
	}
	c.takeConn(conn)
	return conn.WriteMessage(websocket.BinaryMessage, ygo.EncodeStateAsUpdate(c.doc))
}

// resend переподключается и отправляет состояние целиком — поведение браузера
// после обрыва. Новый сокет на каждую попытку: если сервер только что закрыл
// предыдущий (переполненный буфер), запись в него уже не дойдёт.
func (c *clientDoc) resend(wsURL string) error {
	conn, _, err := websocket.DefaultDialer.Dial(wsURL, nil)
	if err != nil {
		return err
	}
	c.takeConn(conn)
	return conn.WriteMessage(websocket.BinaryMessage, ygo.EncodeStateAsUpdate(c.doc))
}

func newClientDoc() *ygo.Doc {
	return ygo.NewDoc()
}

// seedEventBody заводит событие с id и текстом — тем же способом, что и клиент.
func seedEventBody(t *testing.T, doc *ygo.Doc, id, title, body string) {
	t.Helper()
	events := ygo.NewArray(doc, "events")
	txn := doc.WriteTxn()
	item := events.InsertMap(txn, events.Len())
	item.Set(txn, "id", id)
	titleText := item.SetText(txn, "title_text")
	bodyText := item.SetText(txn, "body_text")
	titleText.Insert(txn, 0, title)
	bodyText.Insert(txn, 0, body)
	txn.Commit()
}

// appendEventBody дописывает текст в конец тела события.
func appendEventBody(doc *ygo.Doc, id, text string) error {
	item := findEvent(doc, id)
	if item == nil {
		return fmt.Errorf("событие %s не найдено", id)
	}
	body, ok := item.Get("body_text").(*ygo.Text)
	if !ok {
		return fmt.Errorf("у события %s нет текстового тела", id)
	}
	txn := doc.WriteTxn()
	body.Insert(txn, body.Length(), text)
	txn.Commit()
	return nil
}

func eventBody(doc *ygo.Doc, id string) string {
	item := findEvent(doc, id)
	if item == nil {
		return ""
	}
	if body, ok := item.Get("body_text").(*ygo.Text); ok {
		return body.String()
	}
	value, _ := item.Get("body").(string)
	return value
}

// persistedBody читает текст из снапшота серверным портом (он уже проверен на
// совместимость с Yjs отдельными тестами).
func persistedBody(doc *yjs.Doc, id string) string {
	for _, e := range doc.Events() {
		if e.ID == id {
			return e.Body
		}
	}
	return ""
}

func findEvent(doc *ygo.Doc, id string) *ygo.Map {
	events := ygo.NewArray(doc, "events")
	var found *ygo.Map
	events.Range(func(_ uint64, value any) bool {
		item, ok := value.(*ygo.Map)
		if !ok {
			return true
		}
		if got, _ := item.Get("id").(string); got == id {
			found = item
			return false
		}
		return true
	})
	return found
}

// testLogWriter отправляет логи сервера в вывод теста: без этого причина отказа
// проекции (единственное место, где она пишет в лог) осталась бы невидимой.
type testLogWriter struct{ t *testing.T }

func (w *testLogWriter) Write(p []byte) (int, error) {
	w.t.Logf("server: %s", strings.TrimSpace(string(p)))
	return len(p), nil
}

func truncate(s string, n int) string {
	r := []rune(s)
	if len(r) <= n {
		return s
	}
	return string(r[:n]) + "…"
}

func waitFor(t *testing.T, timeout time.Duration, cond func() bool, what string) {
	t.Helper()
	deadline := time.Now().Add(timeout)
	for time.Now().Before(deadline) {
		if cond() {
			return
		}
		time.Sleep(50 * time.Millisecond)
	}
	t.Fatalf("не дождались: %s", what)
}

// readFullState подключается новым клиентом и читает состояние комнаты, пока не
// соберётся ожидаемая длина или не истечёт короткое ожидание.
func readFullState(t *testing.T, wsURL, eventID string, wantLength int, markers []string) (string, bool) {
	t.Helper()
	conn, _, err := websocket.DefaultDialer.Dial(wsURL, nil)
	if err != nil {
		t.Fatalf("клиент-проверяющий не подключился: %v", err)
	}
	defer func() { _ = conn.Close() }()

	doc := newClientDoc()
	_ = conn.SetReadDeadline(time.Now().Add(5 * time.Second))
	for len([]rune(eventBody(doc, eventID))) < wantLength {
		_, data, err := conn.ReadMessage()
		if err != nil {
			break
		}
		_ = ygo.ApplyUpdate(doc, data)
	}
	text := eventBody(doc, eventID)
	for _, marker := range markers {
		if !strings.Contains(text, marker) {
			return text, false
		}
	}
	return text, true
}
