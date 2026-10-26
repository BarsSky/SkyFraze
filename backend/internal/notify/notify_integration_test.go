package notify_test

// notify_integration_test.go — письма о новых замечаниях (миграции 0020, 0018).
//
// Проверяем ровно те свойства, из-за которых это сделано очередью, а не отправкой «в
// момент комментария»: письмо уходит одному человеку, а не по письму на замечание; сбой
// почтового сервера не теряет письмо (попытка зачтена, следующая возьмёт снова); тот, кто
// не дал согласия, писем не получает, и автор не получает письмо о своём же замечании.
//
// Почтовый сервер поддельный (SMTP на 127.0.0.1): проверяется текст и поведение, а не сеть.

import (
	"bufio"
	"context"
	"encoding/base64"
	"io"
	"log/slog"
	"net"
	"strings"
	"sync"
	"testing"

	"github.com/google/uuid"

	"github.com/skyfraze/backend/internal/events"
	"github.com/skyfraze/backend/internal/notify"
	"github.com/skyfraze/backend/internal/platform/testdb"
	"github.com/skyfraze/backend/internal/projects"
	"github.com/skyfraze/backend/internal/store"
)

// fakeSMTP — минимальный SMTP-сервер: здоровается, принимает письмо, складывает его в
// messages. `reject` заставляет отвергать получателя — так проверяется путь неудачи.
type fakeSMTP struct {
	mu       sync.Mutex
	messages []string
	reject   bool
	server   net.Listener
}

func startFakeSMTP(t *testing.T) *fakeSMTP {
	t.Helper()
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("слушатель: %v", err)
	}
	fake := &fakeSMTP{server: listener}
	go fake.serve()
	t.Cleanup(func() { listener.Close() })
	return fake
}

func (f *fakeSMTP) port() int { return f.server.Addr().(*net.TCPAddr).Port }

func (f *fakeSMTP) serve() {
	for {
		conn, err := f.server.Accept()
		if err != nil {
			return
		}
		go f.handle(conn)
	}
}

func (f *fakeSMTP) handle(conn net.Conn) {
	defer conn.Close()
	reader := bufio.NewReader(conn)
	writer := bufio.NewWriter(conn)
	say := func(line string) {
		writer.WriteString(line + "\r\n")
		writer.Flush()
	}
	say("220 fake-smtp ready")
	for {
		line, err := reader.ReadString('\n')
		if err != nil {
			return
		}
		command := strings.ToUpper(strings.TrimSpace(line))
		switch {
		case strings.HasPrefix(command, "EHLO"), strings.HasPrefix(command, "HELO"):
			say("250-fake-smtp")
			say("250 SIZE 10240000")
		case strings.HasPrefix(command, "MAIL FROM"):
			say("250 ok")
		case strings.HasPrefix(command, "RCPT TO"):
			f.mu.Lock()
			reject := f.reject
			f.mu.Unlock()
			if reject {
				say("451 temporary failure")
				continue
			}
			say("250 ok")
		case command == "DATA":
			say("354 go ahead")
			var body strings.Builder
			for {
				dataLine, readErr := reader.ReadString('\n')
				if readErr != nil {
					return
				}
				if dataLine == ".\r\n" {
					break
				}
				body.WriteString(dataLine)
			}
			f.mu.Lock()
			f.messages = append(f.messages, body.String())
			f.mu.Unlock()
			say("250 queued")
		case command == "QUIT":
			say("221 bye")
			return
		default:
			say("250 ok")
		}
	}
}

func (f *fakeSMTP) take() []string {
	f.mu.Lock()
	defer f.mu.Unlock()
	out := f.messages
	f.messages = nil
	return out
}

func (f *fakeSMTP) setReject(value bool) {
	f.mu.Lock()
	f.reject = value
	f.mu.Unlock()
}

type notifyEnv struct {
	st    *store.Store
	svc   *events.Service
	proj  *projects.Service
	owner uuid.UUID
	other uuid.UUID
}

func setupNotify(t *testing.T) *notifyEnv {
	t.Helper()
	pool := testdb.Setup(t, "notify")
	testdb.Truncate(t, pool,
		"comment_notifications", "comment_views", "event_comments",
		"project_revisions", "ai_changes", "ai_messages", "ai_conversations",
		"project_event_state", "project_ratings", "project_views", "sessions",
		"invitations", "event_assets", "assets", "events", "team_memberships",
		"projects", "users")

	st := store.New(pool)
	projSvc := projects.New(st)
	svc := events.New(st, projSvc)
	svc.UseLogger(slog.New(slog.NewTextHandler(io.Discard, nil)))
	ctx := context.Background()
	owner, err := st.CreateUser(ctx, "owner@example.com", "hash", "Владелец")
	if err != nil {
		t.Fatalf("владелец: %v", err)
	}
	other, err := st.CreateUser(ctx, "editor@example.com", "hash", "Редактор")
	if err != nil {
		t.Fatalf("редактор: %v", err)
	}
	return &notifyEnv{st: st, svc: svc, proj: projSvc, owner: owner.ID, other: other.ID}
}

// seedProject создаёт проект с одним кадром; редактор — участник.
func (e *notifyEnv) seedProject(t *testing.T) (uuid.UUID, uuid.UUID) {
	t.Helper()
	ctx := context.Background()
	p, err := e.proj.Create(ctx, e.owner, "Проект с обсуждением", "")
	if err != nil {
		t.Fatalf("проект: %v", err)
	}
	eventID := uuid.New()
	if err := e.svc.ProjectTreeServer(ctx, p.ID, e.owner, []events.NodeInput{
		{ID: eventID, Position: 0, Title: "Глава 1", Body: "текст"},
	}); err != nil {
		t.Fatalf("дерево: %v", err)
	}
	if err := e.st.AddMembership(ctx, p.ID, e.other, store.RoleEditor); err != nil {
		t.Fatalf("участие: %v", err)
	}
	return p.ID, eventID
}


// Одно письмо на человека, даже если замечаний несколько; автор письма не получает.
func TestFlushGroupsCommentsPerPerson(t *testing.T) {
	e := setupNotify(t)
	fake := startFakeSMTP(t)
	// Хранилище сервису нужно для очереди: подменяем на реальное из env.
	svc := e.notifyService(t, fake)
	ctx := context.Background()
	projectID, eventID := e.seedProject(t)
	if err := e.st.SetNotifyComments(ctx, e.other, true); err != nil {
		t.Fatalf("согласие: %v", err)
	}

	// Два замечания владельца: редактор должен получить ОДНО письмо.
	if _, err := e.svc.AddComment(ctx, e.owner, projectID, eventID, "Первое замечание.", nil); err != nil {
		t.Fatalf("первое: %v", err)
	}
	if _, err := e.svc.AddComment(ctx, e.owner, projectID, eventID, "Второе замечание.", nil); err != nil {
		t.Fatalf("второе: %v", err)
	}

	sent, failed, err := svc.Flush(ctx)
	if err != nil {
		t.Fatalf("обход: %v", err)
	}
	if sent != 1 || failed != 0 {
		t.Fatalf("писем: отправлено %d, не удалось %d", sent, failed)
	}
	messages := fake.take()
	if len(messages) != 1 {
		t.Fatalf("писем в SMTP: %d, ожидалось 1", len(messages))
	}
	message := messages[0]
	if !strings.Contains(message, "To: editor@example.com") {
		t.Errorf("получатель: %s", firstLine(message, "To:"))
	}
	// Тема с кириллицей кодируется по RFC 2047 — проверяем, что раскодированная совпадает.
	if subject := decodeSubject(t, firstLine(message, "Subject:")); subject != "SkyFraze: 2 новых замечания в «Проект с обсуждением»" {
		t.Errorf("тема письма: %q", subject)
	}
	if !strings.Contains(message, "Первое замечание.") || !strings.Contains(message, "Второе замечание.") {
		t.Errorf("в письме нет обоих замечаний:\n%s", message)
	}
	if !strings.Contains(message, "https://skyfraze.example/projects/") {
		t.Errorf("в письме нет ссылки на проект:\n%s", message)
	}
	// Владелец — автор, письма ему быть не должно.
	if strings.Contains(message, "owner@example.com") {
		t.Errorf("автор получил письмо о своём замечании: %s", firstLine(message, "To:"))
	}
	// И очередь пуста: повторный обход ничего не отправит.
	sent, _, err = svc.Flush(ctx)
	if err != nil || sent != 0 {
		t.Fatalf("повторный обход: sent=%d err=%v", sent, err)
	}
}

// Без согласия письма не уходят: очередь пуста, письма нет.
func TestNoConsentNoEmail(t *testing.T) {
	e := setupNotify(t)
	fake := startFakeSMTP(t)
	svc := e.notifyService(t, fake)
	ctx := context.Background()
	projectID, eventID := e.seedProject(t)

	if _, err := e.svc.AddComment(ctx, e.owner, projectID, eventID, "Замечание без согласия.", nil); err != nil {
		t.Fatalf("комментарий: %v", err)
	}
	sent, _, err := svc.Flush(ctx)
	if err != nil {
		t.Fatalf("обход: %v", err)
	}
	if sent != 0 || len(fake.take()) != 0 {
		t.Fatalf("письмо ушло без согласия: sent=%d", sent)
	}
}

// Сбой сервера не теряет письмо: попытка зачтена, после починки сервера письмо уходит.
func TestFlushRetriesAfterFailure(t *testing.T) {
	e := setupNotify(t)
	fake := startFakeSMTP(t)
	svc := e.notifyService(t, fake)
	ctx := context.Background()
	projectID, eventID := e.seedProject(t)
	if err := e.st.SetNotifyComments(ctx, e.other, true); err != nil {
		t.Fatalf("согласие: %v", err)
	}
	if _, err := e.svc.AddComment(ctx, e.owner, projectID, eventID, "Замечание.", nil); err != nil {
		t.Fatalf("комментарий: %v", err)
	}

	fake.setReject(true)
	sent, failed, err := svc.Flush(ctx)
	if err != nil {
		t.Fatalf("обход: %v", err)
	}
	if sent != 0 || failed != 1 {
		t.Fatalf("при отказе сервера: отправлено %d, не удалось %d", sent, failed)
	}
	// Строка осталась в очереди с ошибкой и попыткой.
	pending, err := e.st.PendingCommentNotifications(ctx, 10, 3)
	if err != nil {
		t.Fatalf("очередь: %v", err)
	}
	if len(pending) != 1 || pending[0].Attempts != 1 {
		t.Fatalf("очередь после сбоя: %+v", pending)
	}

	fake.setReject(false)
	sent, failed, err = svc.Flush(ctx)
	if err != nil {
		t.Fatalf("повторный обход: %v", err)
	}
	if sent != 1 || failed != 0 {
		t.Fatalf("после починки сервера: отправлено %d, не удалось %d", sent, failed)
	}
}

// Замечание в проекте, где у человека нет доступа, письма не рождает.
func TestNoEmailForOutsiders(t *testing.T) {
	e := setupNotify(t)
	ctx := context.Background()
	projectID, eventID := e.seedProject(t)
	// Посторонний с включённым согласием, но без участия в проекте.
	outsider, err := e.st.CreateUser(ctx, "stranger@example.com", "hash", "Посторонний")
	if err != nil {
		t.Fatalf("посторонний: %v", err)
	}
	if err := e.st.SetNotifyComments(ctx, outsider.ID, true); err != nil {
		t.Fatalf("согласие: %v", err)
	}
	if _, err := e.svc.AddComment(ctx, e.owner, projectID, eventID, "Замечание.", nil); err != nil {
		t.Fatalf("комментарий: %v", err)
	}
	pending, err := e.st.PendingCommentNotifications(ctx, 10, 3)
	if err != nil {
		t.Fatalf("очередь: %v", err)
	}
	for _, row := range pending {
		if row.UserID == outsider.ID {
			t.Fatalf("письмо постороннему: %+v", row)
		}
	}
}

// notifyService — сервис уведомлений поверх хранилища этого окружения.
func (e *notifyEnv) notifyService(t *testing.T, fake *fakeSMTP) *notify.Service {
	t.Helper()
	cfg := notify.Config{
		Host: "127.0.0.1", Port: fake.port(), From: "skyfraze@example.com",
		BaseURL: "https://skyfraze.example", MaxAttempts: 3,
	}
	return notify.New(e.st, notify.NewSMTPSender(cfg), cfg,
		slog.New(slog.NewTextHandler(io.Discard, nil)))
}

// decodeSubject — раскодировать `Subject: =?UTF-8?B?…?=` (RFC 2047).
func decodeSubject(t *testing.T, header string) string {
	t.Helper()
	value := strings.TrimSpace(strings.TrimPrefix(header, "Subject:"))
	if !strings.HasPrefix(value, "=?UTF-8?B?") {
		return value
	}
	raw, err := base64.StdEncoding.DecodeString(strings.TrimSuffix(strings.TrimPrefix(value, "=?UTF-8?B?"), "?="))
	if err != nil {
		t.Fatalf("тема не раскодировалась: %v", err)
	}
	return string(raw)
}

func firstLine(message, prefix string) string {
	for _, line := range strings.Split(message, "\r\n") {
		if strings.HasPrefix(line, prefix) {
			return line
		}
	}
	return ""
}

