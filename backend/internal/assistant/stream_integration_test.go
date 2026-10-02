package assistant_test

// stream_integration_test.go — поток ответа помощника: события, обрыв, сохранение
// сказанного.
//
// Проверяем не «SSE отвечает 200», а то, ради чего поток и делался:
//   - текст приходит КУСКАМИ и складывается в тот же ответ, что лежит в истории;
//   - выполненный инструмент виден отдельным событием сразу, а не только в итоге;
//   - «стоп» (обрыв запроса) сохраняет сказанное, помечает ответ остановленным и НЕ
//     считается ошибкой помощника — иначе остановка выглядела бы как сбой;
//   - ошибка ДО первого события уходит обычным ответом с кодом: интерфейс по коду
//     показывает вопрос о согласии, а не красную плашку.

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/google/uuid"

	"github.com/skyfraze/backend/internal/ai"
	"github.com/skyfraze/backend/internal/assistant"
	"github.com/skyfraze/backend/internal/auth"
	"github.com/skyfraze/backend/internal/store"
)

// collector собирает события потока и умеет «сломаться» на нужном по счёту.
type collector struct {
	events []assistant.Event
	failAt int // на каком по счёту событии вернуть ошибку (0 — никогда)
}

func (c *collector) emit(event assistant.Event) error {
	c.events = append(c.events, event)
	if c.failAt > 0 && len(c.events) >= c.failAt {
		return errClientGone
	}
	return nil
}

func (c *collector) text() string {
	var out strings.Builder
	for _, event := range c.events {
		if event.Type == assistant.EventDelta {
			out.WriteString(event.Text)
		}
	}
	return out.String()
}

func (c *collector) types() []string {
	out := make([]string, 0, len(c.events))
	for _, event := range c.events {
		out = append(out, event.Type)
	}
	return out
}

// errClientGone — то, что вернул бы обработчик, если запись в соединение не удалась.
var errClientGone = errClientGoneError{}

type errClientGoneError struct{}

func (errClientGoneError) Error() string { return "соединение закрыто" }

func TestSendStreamEmitsDeltasCallsAndChanges(t *testing.T) {
	e := setup(t,
		ai.Reply{
			Content: "Сейчас добавлю главу.",
			ToolCalls: []ai.ToolCall{createCall(assistant.ToolCreateChapter, map[string]any{
				"title": "Пролог", "body_md": "Начало истории.",
			})},
		},
		ai.Reply{Content: "Готово: глава «Пролог» на месте."},
	)
	ctx := context.Background()
	owner := e.user(t, "owner@example.com")
	projectID, _, _ := e.seedProject(t, owner)

	events := &collector{}
	turn, err := e.asst.SendStream(ctx, owner, projectID, uuid.Nil, "stub:stub-1",
		"Добавь главу «Пролог»", events.emit)
	if err != nil {
		t.Fatalf("поток: %v", err)
	}

	// Текст обоих раундов уходит кусками; склейка обязана дать ровно то, что модель
	// сказала. Заглушка режет ответ пополам, поэтому один кусок здесь был бы признаком
	// того, что поток на самом деле ждёт ответ целиком.
	want := "Сейчас добавлю главу.Готово: глава «Пролог» на месте."
	if got := events.text(); got != want {
		t.Errorf("склеенный текст событий:\n%q\nожидалось:\n%q", got, want)
	}
	if turn.Answer != "Готово: глава «Пролог» на месте." {
		t.Errorf("ответ в итоге: %q", turn.Answer)
	}
	if turn.Stopped {
		t.Error("обычный ответ не может быть «остановленным»")
	}
	if len(turn.Calls) != 1 || turn.Calls[0].Name != assistant.ToolCreateChapter || !turn.Calls[0].OK {
		t.Fatalf("вызовы: %+v", turn.Calls)
	}
	if len(turn.Changes) != 1 || turn.Changes[0].Title != "Пролог" {
		t.Fatalf("изменения: %+v", turn.Changes)
	}

	// Порядок событий: беседа, потом текст, потом выполненный инструмент и изменение.
	kinds := events.types()
	if kinds[0] != assistant.EventStart {
		t.Errorf("первым должно идти событие о беседе: %v", kinds)
	}
	if events.events[0].ConversationID == "" {
		t.Error("в событии start должен быть идентификатор беседы")
	}
	if !hasKind(kinds, assistant.EventDelta) || !hasKind(kinds, assistant.EventCall) ||
		!hasKind(kinds, assistant.EventChange) {
		t.Errorf("в потоке нет событий текста/вызова/изменения: %v", kinds)
	}

	// Сказанное в потоке и в истории — одно и то же: иначе перезагрузка страницы
	// показала бы другой текст, чем человек только что видел.
	messages, err := e.st.ListAIMessages(ctx, turn.ConversationID, 50)
	if err != nil {
		t.Fatalf("история: %v", err)
	}
	last := messages[len(messages)-1]
	if last.Content != turn.Answer {
		t.Errorf("в истории %q, в ответе %q", last.Content, turn.Answer)
	}
	if last.Stopped {
		t.Error("обычный ответ не должен быть помечен остановленным")
	}
}

// «Стоп» — обрыв потока. Модель успела сказать половину: её надо сохранить, пометить
// остановленной и не превращать в ошибку помощника.
func TestSendStreamStopKeepsPartialAnswer(t *testing.T) {
	e := setup(t, ai.Reply{Content: "Первый абзац ответа."})
	ctx := context.Background()
	owner := e.user(t, "owner@example.com")
	projectID, _, _ := e.seedProject(t, owner)

	// Ломаемся на втором событии: первый кусок текста уже ушёл человеку.
	events := &collector{failAt: 2}
	turn, err := e.asst.SendStream(ctx, owner, projectID, uuid.Nil, "stub:stub-1",
		"Расскажи о проекте", events.emit)
	if err != nil {
		t.Fatalf("остановка не должна быть ошибкой: %v", err)
	}
	if !turn.Stopped {
		t.Error("итог должен быть помечен остановленным")
	}
	partial := events.text()
	if partial == "" {
		t.Fatal("человек успел увидеть текст — он должен быть в событиях")
	}
	if turn.Answer != partial {
		t.Errorf("сохранено %q, показано %q", turn.Answer, partial)
	}

	messages, err := e.st.ListAIMessages(ctx, turn.ConversationID, 50)
	if err != nil {
		t.Fatalf("история: %v", err)
	}
	last := messages[len(messages)-1]
	if !last.Stopped {
		t.Error("сообщение в истории должно быть помечено остановленным")
	}
	if last.Content != partial {
		t.Errorf("в истории %q, показано %q", last.Content, partial)
	}
	// Служебной приписки в тексте быть не должно: история уходит модели, и слово
	// «остановлено» выглядело бы для неё частью ответа.
	if strings.Contains(strings.ToLower(last.Content), "остановлен") {
		t.Errorf("пометка попала в текст ответа: %q", last.Content)
	}
	// Второго запроса к провайдеру быть не должно: генерацию остановили, а не
	// «спросили ещё раз, чтобы получить итог».
	if got := e.stub.calls(); got != 1 {
		t.Errorf("запросов к провайдеру: %d, ожидался 1", got)
	}
}

// HTTP-контракт потока: SSE-заголовки, события `delta`, итог событием `done`. И
// отдельно — ошибка ДО первого события: она уходит обычным JSON с кодом, иначе
// интерфейс не смог бы показать вопрос о согласии.
func TestStreamMessageHTTPContract(t *testing.T) {
	e := setup(t, ai.Reply{Content: "Ответ по кускам."})
	ctx := context.Background()
	owner := e.user(t, "owner@example.com")
	editor := e.user(t, "editor@example.com")
	projectID, _, _ := e.seedProject(t, owner)
	if err := e.st.AddMembership(ctx, projectID, editor, store.RoleEditor); err != nil {
		t.Fatalf("membership: %v", err)
	}
	router := assistantRouter(e)

	post := func(body string, user uuid.UUID) *httptest.ResponseRecorder {
		t.Helper()
		token, err := auth.IssueAccess(testSecret, user)
		if err != nil {
			t.Fatalf("token: %v", err)
		}
		req := httptest.NewRequest(http.MethodPost,
			"/api/projects/"+projectID.String()+"/ai/conversations/new/stream",
			strings.NewReader(body))
		req.Header.Set("Content-Type", "application/json")
		req.Header.Set("Authorization", "Bearer "+token)
		rec := httptest.NewRecorder()
		router.ServeHTTP(rec, req)
		return rec
	}

	rec := post(`{"text":"Расскажи","model":"stub:stub-1"}`, owner)
	if rec.Code != http.StatusOK {
		t.Fatalf("код %d, тело %s", rec.Code, rec.Body.String())
	}
	if ct := rec.Header().Get("Content-Type"); !strings.HasPrefix(ct, "text/event-stream") {
		t.Errorf("Content-Type: %q", ct)
	}
	// Поток не должен буферизоваться прокси: иначе он придёт целиком в конце.
	if got := rec.Header().Get("X-Accel-Buffering"); got != "no" {
		t.Errorf("X-Accel-Buffering: %q", got)
	}

	events := parseSSEBody(t, rec.Body.String())
	if len(events) == 0 {
		t.Fatal("в ответе нет событий")
	}
	if events[0].Type != assistant.EventStart || events[0].ConversationID == "" {
		t.Fatalf("первым должно идти событие о беседе: %+v", events[0])
	}
	var text strings.Builder
	var sawDone bool
	for _, event := range events {
		switch event.Type {
		case assistant.EventDelta:
			text.WriteString(event.Text)
		case assistant.EventDone:
			sawDone = true
			if event.Turn == nil || event.Turn.Answer != "Ответ по кускам." {
				t.Errorf("итог: %+v", event.Turn)
			}
		}
	}
	if text.String() != "Ответ по кускам." {
		t.Errorf("текст из событий: %q", text.String())
	}
	if !sawDone {
		t.Error("поток должен заканчиваться событием done")
	}
	// Кусков должно быть больше одного: так проверяется, что заглушка действительно
	// отдаёт поток, а не один готовый ответ.
	if countKind(events, assistant.EventDelta) < 2 {
		t.Errorf("ожидалось несколько кусков текста, событий: %+v", events)
	}

	// Без согласия: 409 с признаком — обычным JSON, а не событием в потоке.
	rec = post(`{"text":"Расскажи","model":"stub:stub-1"}`, editor)
	if rec.Code != http.StatusConflict {
		t.Fatalf("без согласия: код %d, тело %s", rec.Code, rec.Body.String())
	}
	if ct := rec.Header().Get("Content-Type"); !strings.HasPrefix(ct, "application/json") {
		t.Errorf("до первого события ошибка должна быть JSON: %q", ct)
	}
	var failure struct {
		ConsentRequired bool `json:"consent_required"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &failure); err != nil || !failure.ConsentRequired {
		t.Errorf("ответ без согласия: %s", rec.Body.String())
	}
}

// parseSSEBody разбирает тело ответа на события: строки `data: {...}` до пустой строки.
func parseSSEBody(t *testing.T, body string) []assistant.Event {
	t.Helper()
	out := []assistant.Event{}
	for _, line := range strings.Split(body, "\n") {
		line = strings.TrimRight(line, "\r")
		if !strings.HasPrefix(line, "data: ") {
			continue
		}
		var event assistant.Event
		if err := json.Unmarshal([]byte(strings.TrimPrefix(line, "data: ")), &event); err != nil {
			t.Fatalf("событие не разобралось: %v (%q)", err, line)
		}
		out = append(out, event)
	}
	return out
}

func countKind(events []assistant.Event, kind string) int {
	n := 0
	for _, event := range events {
		if event.Type == kind {
			n++
		}
	}
	return n
}

func hasKind(kinds []string, want string) bool {
	for _, kind := range kinds {
		if kind == want {
			return true
		}
	}
	return false
}
