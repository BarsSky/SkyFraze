package assistant_test

// Тесты помощника: инструменты действительно меняют проект, и меняют его правильно.
//
// Что здесь проверяется и почему именно так. Помощник — единственное место, где
// внешний сервис (модель) просит что-то сделать с проектом, поэтому проверять надо не
// «вызвался ли код», а инварианты:
//
//   - созданный кадр есть И в таблице событий (его видят лента, выгрузка, перенос),
//     И в CRDT-документе (его видят открытые вкладки) — иначе получилось бы «видно
//     только мне и только сейчас»;
//   - без согласия человека текст проекта НЕ уходит провайдеру (проверяем счётчиком
//     запросов к заглушке, а не только текстом ошибки);
//   - права те же, что у правки событий: читатель не создаёт главы;
//   - лимит вызовов соблюдается, а не «предупреждается»;
//   - модель, которая инструментов не умеет и пишет вызов текстом, работает так же.

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"

	"github.com/skyfraze/backend/internal/ai"
	"github.com/skyfraze/backend/internal/assets"
	"github.com/skyfraze/backend/internal/assistant"
	"github.com/skyfraze/backend/internal/auth"
	"github.com/skyfraze/backend/internal/collab/yjs"
	"github.com/skyfraze/backend/internal/platform/testdb"
	"github.com/skyfraze/backend/internal/projects"
	"github.com/skyfraze/backend/internal/storage"
	"github.com/skyfraze/backend/internal/store"
	"github.com/skyfraze/backend/internal/transfer"
)

// testSecret — секрет подписи токенов в тестах (тот же приём, что у тестов импорта).
const testSecret = "assistant-test-secret"

// stubKeyEnv — переменная окружения, из которой заглушка берёт «ключ стенда».
const stubKeyEnv = "STUB_API_KEY"

// ============================ заглушка провайдера ============================

// imageURLForTests — адрес заглушки генератора изображений для текущего теста.
// Пусто — генерации нет: так проверяется и честное «картинки недоступны».
var imageURLForTests string

// stubProvider — «провайдер модели» на localhost: отвечает заранее заготовленными
// ответами и записывает, что у него спросили. Никакой сети в тестах нет.
type stubProvider struct {
	mu       sync.Mutex
	replies  []ai.Reply
	requests []stubRequest
	server   *httptest.Server
	// raw — тело последнего запроса как есть: нужен там, где важно, ЧТО именно ушло
	// провайдеру (картинки уходят частями контента, и разбирать их в структуру ради
	// проверки незачем).
	raw string
}

type stubRequest struct {
	Model    string `json:"model"`
	Stream   bool   `json:"stream"`
	Messages []struct {
		Role    string `json:"role"`
		Content string `json:"content"`
	} `json:"messages"`
	Tools []struct {
		Function struct {
			Name string `json:"name"`
		} `json:"function"`
	} `json:"tools"`
}

func newStub(t *testing.T, replies ...ai.Reply) *stubProvider {
	t.Helper()
	stub := &stubProvider{replies: replies}
	mux := http.NewServeMux()
	mux.HandleFunc("/models", func(w http.ResponseWriter, r *http.Request) {
		writeStubJSON(w, map[string]any{"data": []map[string]any{
			{"id": "stub-1", "name": "Заглушка", "supported_parameters": []string{"tools"}},
			// Зрячая модель: провайдер сам говорит, что принимает картинки. Нужна,
			// чтобы проверять приложенные изображения (см. stream/tokens тесты).
			{
				"id": "stub-vision", "name": "Зрячая заглушка",
				"supported_parameters": []string{"tools"},
				"architecture":         map[string]any{"input_modalities": []string{"text", "image"}},
			},
		}})
	})
	mux.HandleFunc("/chat/completions", func(w http.ResponseWriter, r *http.Request) {
		raw, _ := io.ReadAll(r.Body)
		var req stubRequest
		_ = json.Unmarshal(raw, &req)
		stub.setRaw(string(raw))
		reply := stub.record(req)
		if req.Stream {
			writeStubOpenAIStream(w, reply)
			return
		}
		message := map[string]any{"role": "assistant", "content": reply.Content}
		if len(reply.ToolCalls) > 0 {
			calls := make([]map[string]any, 0, len(reply.ToolCalls))
			for _, call := range reply.ToolCalls {
				args, _ := json.Marshal(call.Arguments)
				calls = append(calls, map[string]any{
					"id": call.ID, "type": "function",
					"function": map[string]any{"name": call.Name, "arguments": string(args)},
				})
			}
			message["tool_calls"] = calls
		}
		writeStubJSON(w, map[string]any{
			"model":   "stub-1",
			"choices": []map[string]any{{"message": message, "finish_reason": "stop"}},
			"usage":   map[string]int{"prompt_tokens": reply.TokensIn, "completion_tokens": reply.TokensOut},
		})
	})
	// Тот же сервер отвечает и по-олламовски: так проверяется, что локальная модель
	// (KindOllama) идёт своим API и согласия не требует.
	mux.HandleFunc("/api/tags", func(w http.ResponseWriter, r *http.Request) {
		writeStubJSON(w, map[string]any{"models": []map[string]any{
			{"name": "stub-1", "model": "stub-1", "capabilities": []string{"tools"}},
			// Облачная модель у того же «локального» провайдера: нужна, чтобы
			// проверять согласие по МОДЕЛИ, а не по провайдеру.
			{"name": "cloud-1:cloud", "model": "cloud-1:cloud",
				"remote_host": "https://ollama.com:443", "capabilities": []string{"tools"}},
		}})
	})
	mux.HandleFunc("/api/chat", func(w http.ResponseWriter, r *http.Request) {
		raw, _ := io.ReadAll(r.Body)
		var req stubRequest
		_ = json.Unmarshal(raw, &req)
		stub.setRaw(string(raw))
		reply := stub.record(req)
		if req.Stream {
			writeStubOllamaStream(w, reply)
			return
		}
		message := map[string]any{"role": "assistant", "content": reply.Content}
		if len(reply.ToolCalls) > 0 {
			calls := make([]map[string]any, 0, len(reply.ToolCalls))
			for _, call := range reply.ToolCalls {
				calls = append(calls, map[string]any{
					"function": map[string]any{"name": call.Name, "arguments": call.Arguments},
				})
			}
			message["tool_calls"] = calls
		}
		writeStubJSON(w, map[string]any{
			"model": "stub-1", "message": message,
			"prompt_eval_count": reply.TokensIn, "eval_count": reply.TokensOut,
		})
	})
	stub.server = httptest.NewServer(mux)
	t.Cleanup(stub.server.Close)
	return stub
}

// record записывает запрос и отдаёт следующий заготовленный ответ.
func (s *stubProvider) record(req stubRequest) ai.Reply {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.requests = append(s.requests, req)
	if len(s.replies) == 0 {
		return ai.Reply{Content: "Больше сказать нечего.", Model: "stub-1"}
	}
	reply := s.replies[0]
	s.replies = s.replies[1:]
	return reply
}

func (s *stubProvider) setReplies(replies ...ai.Reply) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.replies = replies
}

func (s *stubProvider) setRaw(raw string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.raw = raw
}

// lastRaw — тело последнего запроса к провайдеру как есть: картинки уходят частями
// контента, и проверять их удобнее по тому, что реально было отправлено.
func (s *stubProvider) lastRaw() string {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.raw
}

func (s *stubProvider) calls() int {
	s.mu.Lock()
	defer s.mu.Unlock()
	return len(s.requests)
}

func (s *stubProvider) lastRequest() stubRequest {
	s.mu.Lock()
	defer s.mu.Unlock()
	if len(s.requests) == 0 {
		return stubRequest{}
	}
	return s.requests[len(s.requests)-1]
}

// firstRequest — первый запрос за сообщение: в нём видно, с чего модель начинала
// (правила, дерево проекта, инструменты), а в последнем уже лежат результаты вызовов.
func (s *stubProvider) firstRequest() stubRequest {
	s.mu.Lock()
	defer s.mu.Unlock()
	if len(s.requests) == 0 {
		return stubRequest{}
	}
	return s.requests[0]
}

func writeStubJSON(w http.ResponseWriter, body any) {
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(body)
}

// writeStubOllamaStream отдаёт ответ потоком так, как это делает Ollama: по строке
// JSON на кусок текста, последняя строка с done и счётчиками.
//
// Текст режем пополам НАМЕРЕННО: если бы он уходил одним куском, тест не отличил бы
// настоящий поток от «подождали и отдали целиком».
func writeStubOllamaStream(w http.ResponseWriter, reply ai.Reply) {
	w.Header().Set("Content-Type", "application/x-ndjson")
	flusher, _ := w.(http.Flusher)
	write := func(line map[string]any) {
		_ = json.NewEncoder(w).Encode(line)
		if flusher != nil {
			flusher.Flush()
		}
	}
	for _, piece := range splitInHalf(reply.Content) {
		write(map[string]any{
			"model": "stub-1", "done": false,
			"message": map[string]any{"role": "assistant", "content": piece},
		})
	}
	message := map[string]any{"role": "assistant", "content": ""}
	if len(reply.ToolCalls) > 0 {
		calls := make([]map[string]any, 0, len(reply.ToolCalls))
		for _, call := range reply.ToolCalls {
			calls = append(calls, map[string]any{
				"function": map[string]any{"name": call.Name, "arguments": call.Arguments},
			})
		}
		message["tool_calls"] = calls
	}
	write(map[string]any{
		"model": "stub-1", "done": true, "message": message,
		"prompt_eval_count": reply.TokensIn, "eval_count": reply.TokensOut,
	})
}

// writeStubOpenAIStream отдаёт ответ потоком в формате OpenAI: события SSE, причём
// имя вызова инструмента и его аргументы приходят РАЗНЫМИ событиями — так же, как у
// настоящих провайдеров, и так же проверяется склейка на нашей стороне.
func writeStubOpenAIStream(w http.ResponseWriter, reply ai.Reply) {
	w.Header().Set("Content-Type", "text/event-stream")
	flusher, _ := w.(http.Flusher)
	write := func(chunk map[string]any) {
		raw, _ := json.Marshal(chunk)
		fmt.Fprintf(w, "data: %s\n\n", raw)
		if flusher != nil {
			flusher.Flush()
		}
	}
	for _, piece := range splitInHalf(reply.Content) {
		write(map[string]any{
			"model":   "stub-1",
			"choices": []map[string]any{{"delta": map[string]any{"content": piece}}},
		})
	}
	for index, call := range reply.ToolCalls {
		write(map[string]any{
			"choices": []map[string]any{{"delta": map[string]any{"tool_calls": []map[string]any{{
				"index": index, "id": call.ID, "type": "function",
				"function": map[string]any{"name": call.Name},
			}}}}},
		})
		args, _ := json.Marshal(call.Arguments)
		write(map[string]any{
			"choices": []map[string]any{{"delta": map[string]any{"tool_calls": []map[string]any{{
				"index": index, "function": map[string]any{"arguments": string(args)},
			}}}}},
		})
	}
	write(map[string]any{
		"model":   "stub-1",
		"choices": []map[string]any{},
		"usage":   map[string]int{"prompt_tokens": reply.TokensIn, "completion_tokens": reply.TokensOut},
	})
	fmt.Fprint(w, "data: [DONE]\n\n")
	if flusher != nil {
		flusher.Flush()
	}
}

// splitInHalf режет текст на две части (по границе рун, а не байт — иначе кириллица
// развалилась бы на недопустимые символы).
func splitInHalf(text string) []string {
	runes := []rune(text)
	if len(runes) < 2 {
		if len(runes) == 0 {
			return nil
		}
		return []string{text}
	}
	mid := len(runes) / 2
	return []string{string(runes[:mid]), string(runes[mid:])}
}

// ============================ окружение теста ============================

type env struct {
	st     *store.Store
	proj   *projects.Service
	models *ai.Service
	asst   *assistant.Service
	stub   *stubProvider
}

func setup(t *testing.T, replies ...ai.Reply) *env {
	t.Helper()
	pool := testdb.Setup(t, "assistant")
	testdb.Truncate(t, pool,
		"ai_messages", "ai_conversations", "ai_consents", "ai_user_keys", "project_ai_settings",
		"project_ratings", "project_views", "registration_requests", "app_settings",
		"project_event_state", "sessions", "invitations", "event_assets", "assets",
		"events", "team_memberships", "projects", "users")
	// Строку агента после чистки users возвращает сам Truncate: на неё ссылаются
	// created_by созданных им событий и участие в проекте.

	obj, err := storage.NewLocal(t.TempDir())
	if err != nil {
		t.Fatalf("storage: %v", err)
	}
	st := store.New(pool)
	proj := projects.New(st)
	assetsSvc := assets.New(st, obj, proj)
	transferSvc := transfer.New(st, obj, proj)
	transferSvc.UseFileStore(assetsSvc)

	stub := newStub(t, replies...)
	// Ключ шифрования задан: согласия и ключи живут в базе, и без него проверять
	// было бы нечего. Ключ стенда для заглушки — чтобы проверки не упирались в «нужен
	// ключ»: это отдельное состояние, и оно проверяется в тестах самого пакета ai.
	models := ai.New(st, ai.Config{
		Enabled: true, SecretKey: strings.Repeat("ab", 32),
		DefaultModel: "stub:stub-1", TimeoutSeconds: 10,
		// Генератор изображений — только если тест его подставил (см. image_tool_integration_test.go).
		ImageURL: imageURLForTests, ImageTimeoutSeconds: 10, ImageModel: "stub-sd", ImageAutoLoad: true,
	}, map[string]string{stubKeyEnv: "stub-stand-key"}, testLogger())
	models.UseProviders([]ai.Provider{
		{
			ID: "stub", Title: "Заглушка", Kind: ai.KindOpenAI,
			BaseURL: stub.server.URL, KeyEnv: stubKeyEnv, Note: "тестовая заглушка",
		},
		{
			ID: "ollama", Title: "Локальная модель", Kind: ai.KindOllama,
			BaseURL: stub.server.URL, Note: "локальная заглушка",
		},
	})

	asst := assistant.New(st, models, proj, transferSvc, 10, testLogger())
	// Иллюстрации помощника ложатся вложениями проекта — как в бою (см. main.go).
	asst.UseAssets(assetsSvc)
	return &env{st: st, proj: proj, models: models, asst: asst, stub: stub}
}

func testLogger() *slog.Logger {
	return slog.New(slog.NewTextHandler(io.Discard, nil))
}

func (e *env) user(t *testing.T, email string) uuid.UUID {
	t.Helper()
	u, err := e.st.CreateUser(context.Background(), email, "hash", email)
	if err != nil {
		t.Fatalf("create user: %v", err)
	}
	return u.ID
}

// seedProject заводит проект с главой и под-событием и даёт согласие на отправку
// текста заглушке: иначе каждый тест начинался бы с одной и той же подготовки.
func (e *env) seedProject(t *testing.T, owner uuid.UUID) (uuid.UUID, uuid.UUID, uuid.UUID) {
	t.Helper()
	ctx := context.Background()
	p, err := e.proj.Create(ctx, owner, "Планета АнуВаар", "описание")
	if err != nil {
		t.Fatalf("create project: %v", err)
	}
	chapter, child := uuid.New(), uuid.New()
	if err := e.st.ReplaceEventTree(ctx, p.ID, owner, []store.Event{
		{ID: chapter, ProjectID: p.ID, Position: 0, Depth: 0, Title: "Глава 1", Body: "текст главы"},
		{ID: child, ProjectID: p.ID, ParentID: &chapter, Position: 1, Depth: 1, Title: "Под-событие", Body: "текст"},
	}); err != nil {
		t.Fatalf("events: %v", err)
	}
	if err := e.st.SetAIConsent(ctx, owner, "stub"); err != nil {
		t.Fatalf("consent: %v", err)
	}
	return p.ID, chapter, child
}

// event находит событие по заголовку.
func (e *env) event(t *testing.T, projectID uuid.UUID, title string) (store.Event, bool) {
	t.Helper()
	rows, err := e.st.ListEvents(context.Background(), projectID)
	if err != nil {
		t.Fatalf("events: %v", err)
	}
	for _, row := range rows {
		if row.Title == title {
			return row, true
		}
	}
	return store.Event{}, false
}

// docEvents читает события из CRDT-снапшота проекта.
func (e *env) docEvents(t *testing.T, projectID uuid.UUID) []yjs.Event {
	t.Helper()
	state, err := e.st.GetProjectEventState(context.Background(), projectID)
	if err != nil || state == nil {
		t.Fatalf("снапшот: %v", err)
	}
	doc, err := yjs.FromState(state.YjsState)
	if err != nil {
		t.Fatalf("снапшот не читается: %v", err)
	}
	return doc.Events()
}

// createCall — вызов инструмента создания кадра, как его вернула бы модель.
func createCall(name string, args map[string]any) ai.ToolCall {
	return ai.ToolCall{ID: "call-" + name, Name: name, Arguments: args}
}

// ============================ создание главы ============================

// Главный инвариант: глава, созданная помощником, есть и в таблице событий, и в
// CRDT-документе — то есть её видят и лента с выгрузкой, и открытая вкладка.
func TestSendCreatesChapterInProjectionAndDocument(t *testing.T) {
	e := setup(t,
		ai.Reply{ToolCalls: []ai.ToolCall{createCall(assistant.ToolCreateChapter, map[string]any{
			"title":   "Пролог",
			"body_md": "## Как всё начиналось\n\nТекст **пролога**.",
			"date":    "2024-05-17",
		})}},
		ai.Reply{Content: "Создал главу «Пролог»."},
	)
	ctx := context.Background()
	owner := e.user(t, "owner@example.com")
	projectID, _, _ := e.seedProject(t, owner)

	turn, err := e.asst.Send(ctx, owner, projectID, uuid.Nil, "stub:stub-1", "Добавь главу «Пролог»")
	if err != nil {
		t.Fatalf("send: %v", err)
	}
	if turn.Answer != "Создал главу «Пролог»." {
		t.Fatalf("ответ модели: %q", turn.Answer)
	}
	if len(turn.Changes) != 1 || turn.Changes[0].Action != "created_chapter" {
		t.Fatalf("изменения: %+v", turn.Changes)
	}

	// Таблица событий (её читают лента, выгрузка и перенос).
	row, ok := e.event(t, projectID, "Пролог")
	if !ok {
		t.Fatalf("главы нет в таблице событий")
	}
	if row.ParentID != nil {
		t.Errorf("глава должна быть верхнего уровня, а родитель %v", row.ParentID)
	}
	if !strings.Contains(row.Body, "Как всё начиналось") {
		t.Errorf("текст главы не доехал: %q", row.Body)
	}
	if row.EventDate == nil || row.EventDate.Format("2006-01-02") != "2024-05-17" {
		t.Errorf("дата не доехала: %v", row.EventDate)
	}
	if turn.Changes[0].ID != row.ID {
		t.Errorf("помощник отчитался о другом идентификаторе: %v и %v", turn.Changes[0].ID, row.ID)
	}

	// CRDT-документ (его видят открытые вкладки).
	found := false
	for _, event := range e.docEvents(t, projectID) {
		if event.ID == row.ID.String() {
			found = true
			if event.Title != "Пролог" {
				t.Errorf("заголовок в документе: %q", event.Title)
			}
		}
	}
	if !found {
		t.Fatalf("созданной главы нет в CRDT-документе проекта")
	}

	// История беседы: вопрос, ход модели с вызовом, результат и ответ.
	conversations, err := e.st.ListAIConversations(ctx, projectID, owner)
	if err != nil || len(conversations) != 1 {
		t.Fatalf("беседа: %v (%d)", err, len(conversations))
	}
	if conversations[0].Title == "" {
		t.Errorf("заголовок беседы не поставлен по первому вопросу")
	}
	messages, err := e.st.ListAIMessages(ctx, conversations[0].ID, 50)
	if err != nil {
		t.Fatalf("сообщения: %v", err)
	}
	roles := make([]string, 0, len(messages))
	for _, m := range messages {
		roles = append(roles, m.Role)
	}
	want := []string{"user", "assistant", "tool", "assistant"}
	if strings.Join(roles, ",") != strings.Join(want, ",") {
		t.Fatalf("роли в истории: %v, ожидалось %v", roles, want)
	}
	if !strings.Contains(messages[len(messages)-1].Content, "Пролог") {
		t.Errorf("последний ответ модели: %q", messages[len(messages)-1].Content)
	}
	// В историю записано, что именно сделал инструмент: по ней разбирают «почему
	// создалась не та глава».
	if !strings.Contains(string(messages[2].ToolResults), "created") {
		t.Errorf("результат инструмента в истории: %s", messages[2].ToolResults)
	}

	// Запрос к модели: правила, оглавление проекта и инструменты. Смотрим ПЕРВЫЙ
	// запрос: в последнем уже лежат результаты вызовов, а не вопрос человека.
	req := e.stub.firstRequest()
	if len(req.Tools) != 4 {
		t.Errorf("модели передано инструментов %d, ожидалось 4", len(req.Tools))
	}
	if !strings.Contains(req.Messages[0].Content, "Глава 1") {
		t.Errorf("в контексте нет дерева проекта: %q", req.Messages[0].Content)
	}
	if req.Messages[0].Role != "system" || req.Messages[len(req.Messages)-1].Content != "Добавь главу «Пролог»" {
		t.Errorf("состав запроса: %+v", req.Messages)
	}
}

// Под-событие встаёт внутрь названной главы: идентификатор модель берёт из list_events.
func TestSendCreatesSubEventInsideChapter(t *testing.T) {
	e := setup(t)
	ctx := context.Background()
	owner := e.user(t, "owner@example.com")
	projectID, chapter, _ := e.seedProject(t, owner)

	e.stub.setReplies(
		ai.Reply{ToolCalls: []ai.ToolCall{createCall(assistant.ToolListEvents, map[string]any{})}},
		ai.Reply{ToolCalls: []ai.ToolCall{createCall(assistant.ToolCreateSub, map[string]any{
			"parent_id": chapter.String(),
			"title":     "Внутри главы",
			"body_md":   "Текст под-события.",
		})}},
		ai.Reply{Content: "Готово."},
	)

	turn, err := e.asst.Send(ctx, owner, projectID, uuid.Nil, "stub:stub-1", "Добавь под-событие в главу 1")
	if err != nil {
		t.Fatalf("send: %v", err)
	}
	if len(turn.Changes) != 1 || turn.Changes[0].Action != "created_sub_event" {
		t.Fatalf("изменения: %+v", turn.Changes)
	}
	row, ok := e.event(t, projectID, "Внутри главы")
	if !ok {
		t.Fatalf("под-события нет в таблице событий")
	}
	if row.ParentID == nil || *row.ParentID != chapter {
		t.Fatalf("под-событие не под главой: %v", row.ParentID)
	}
	if row.Depth != 1 {
		t.Errorf("уровень под-события %d, ожидался 1", row.Depth)
	}
	// Первый вызов был чтением: в отчёте он есть, но изменений не добавил.
	if len(turn.Calls) != 2 || !turn.Calls[0].OK || turn.Calls[0].Name != assistant.ToolListEvents {
		t.Errorf("отчёт о вызовах: %+v", turn.Calls)
	}
}

// ============================ согласие ============================

// Без согласия текст проекта НЕ уходит провайдеру: проверяем счётчиком запросов к
// заглушке, а не только текстом ошибки.
func TestSendWithoutConsentSendsNothing(t *testing.T) {
	e := setup(t, ai.Reply{Content: "не должно случиться"})
	ctx := context.Background()
	owner := e.user(t, "owner@example.com")
	p, err := e.proj.Create(ctx, owner, "Приватный план", "")
	if err != nil {
		t.Fatalf("проект: %v", err)
	}

	_, err = e.asst.Send(ctx, owner, p.ID, uuid.Nil, "stub:stub-1", "Создай главу")
	if !errors.Is(err, assistant.ErrConsent) {
		t.Fatalf("ожидалось требование согласия, получено %v", err)
	}
	if e.stub.calls() != 0 {
		t.Fatalf("без согласия ушло %d запросов к провайдеру, ожидалось 0", e.stub.calls())
	}
	// Вопрос без согласия тоже не записываем: беседа не должна начинаться с отказа.
	conversations, err := e.st.ListAIConversations(ctx, p.ID, owner)
	if err != nil {
		t.Fatalf("беседы: %v", err)
	}
	if len(conversations) != 0 {
		t.Fatalf("беседа создана несмотря на отказ: %d", len(conversations))
	}
}

// Локальная модель согласия не требует: текст никуда не уходит.
func TestSendLocalModelNeedsNoConsent(t *testing.T) {
	e := setup(t, ai.Reply{Content: "Локально и без разрешения."})
	ctx := context.Background()
	owner := e.user(t, "owner@example.com")
	p, err := e.proj.Create(ctx, owner, "Локальный план", "")
	if err != nil {
		t.Fatalf("проект: %v", err)
	}
	// Тот же адрес, но провайдер помечен локальным (Ollama): согласие не нужно и
	// ключ не нужен, потому что текст проекта никуда не уходит.
	turn, err := e.asst.Send(ctx, owner, p.ID, uuid.Nil, "ollama:stub-1", "Привет")
	if err != nil {
		t.Fatalf("send: %v", err)
	}
	if turn.Answer != "Локально и без разрешения." {
		t.Fatalf("ответ: %q", turn.Answer)
	}
}

// Облачная модель у «локального» провайдера согласия ТРЕБУЕТ.
//
// У Ollama рядом с локальными живут облачные модели (`…:cloud`), которые считаются на
// ollama.com. Провайдер один и тот же, поэтому решение о согласии обязано приниматься
// по конкретной модели — иначе текст проекта ушёл бы наружу молча.
func TestSendCloudModelRequiresConsent(t *testing.T) {
	e := setup(t, ai.Reply{Content: "не должно случиться"})
	ctx := context.Background()
	owner := e.user(t, "owner@example.com")
	p, err := e.proj.Create(ctx, owner, "План с облачной моделью", "")
	if err != nil {
		t.Fatalf("проект: %v", err)
	}

	_, err = e.asst.Send(ctx, owner, p.ID, uuid.Nil, "ollama:cloud-1:cloud", "Создай главу")
	if !errors.Is(err, assistant.ErrConsent) {
		t.Fatalf("облачная модель должна требовать согласия, получено %v", err)
	}
	if !strings.Contains(err.Error(), "облачная") {
		t.Errorf("в отказе не сказано, что модель облачная: %v", err)
	}
	if e.stub.calls() != 0 {
		t.Fatalf("до согласия ушло %d запросов к провайдеру, ожидалось 0", e.stub.calls())
	}

	// Согласие выдали — та же модель работает, а локальная по-прежнему не спрашивает.
	if err := e.st.SetAIConsent(ctx, owner, "ollama"); err != nil {
		t.Fatalf("consent: %v", err)
	}
	if _, err := e.asst.Send(ctx, owner, p.ID, uuid.Nil, "ollama:cloud-1:cloud", "Создай главу"); err != nil {
		t.Fatalf("после согласия: %v", err)
	}
}

// Читатель не создаёт кадры: права те же, что у правки событий.
func TestSendForbiddenForViewer(t *testing.T) {
	e := setup(t, ai.Reply{Content: "не должно случиться"})
	ctx := context.Background()
	owner := e.user(t, "owner@example.com")
	viewer := e.user(t, "viewer@example.com")
	projectID, _, _ := e.seedProject(t, owner)
	if err := e.st.SetAIConsent(ctx, viewer, "stub"); err != nil {
		t.Fatalf("consent: %v", err)
	}
	if err := e.st.AddMembership(ctx, projectID, viewer, store.RoleViewer); err != nil {
		t.Fatalf("membership: %v", err)
	}

	_, err := e.asst.Send(ctx, viewer, projectID, uuid.Nil, "stub:stub-1", "Создай главу")
	if !errors.Is(err, assistant.ErrForbidden) {
		t.Fatalf("ожидался отказ в правах, получено %v", err)
	}
	if e.stub.calls() != 0 {
		t.Fatalf("читатель всё-таки отправил запрос провайдеру")
	}
}

// ============================ отказы и лимиты ============================

// Кадр на последнем уровне: помощник отказывает и объясняет модели почему, а проект
// остаётся нетронутым.
func TestSendRefusesTooDeepParent(t *testing.T) {
	e := setup(t)
	ctx := context.Background()
	owner := e.user(t, "owner@example.com")
	projectID, chapter, child := e.seedProject(t, owner)

	// Достраиваем ветку до максимальной глубины (0 — глава, 4 — предел). Дерево
	// записывается целиком: ReplaceEventTree меняет проект на переданный набор, и
	// промежуточные узлы терять нельзя — иначе у ребёнка не окажется родителя.
	tree := []store.Event{
		{ID: chapter, ProjectID: projectID, Position: 0, Depth: 0, Title: "Глава 1", Body: "текст"},
		{ID: child, ProjectID: projectID, ParentID: &chapter, Position: 0, Depth: 1, Title: "Под-событие", Body: "текст"},
	}
	node := child
	for depth := 2; depth <= 4; depth++ {
		next := uuid.New()
		parent := node
		tree = append(tree, store.Event{
			ID: next, ProjectID: projectID, ParentID: &parent,
			Position: 0, Depth: int16(depth), Title: fmt.Sprintf("Уровень %d", depth), Body: "текст",
		})
		node = next
	}
	if err := e.st.ReplaceEventTree(ctx, projectID, owner, tree); err != nil {
		t.Fatalf("дерево: %v", err)
	}

	e.stub.setReplies(
		ai.Reply{ToolCalls: []ai.ToolCall{createCall(assistant.ToolCreateSub, map[string]any{
			"parent_id": node.String(), "title": "Слишком глубоко",
		})}},
		ai.Reply{Content: "Не получилось: уровень уже последний."},
	)

	turn, err := e.asst.Send(ctx, owner, projectID, uuid.Nil, "stub:stub-1", "Вложи ещё один кадр")
	if err != nil {
		t.Fatalf("send: %v", err)
	}
	if len(turn.Changes) != 0 {
		t.Fatalf("кадр создан на последнем уровне: %+v", turn.Changes)
	}
	if len(turn.Calls) != 1 || turn.Calls[0].OK {
		t.Fatalf("отчёт о вызове: %+v", turn.Calls)
	}
	if _, ok := e.event(t, projectID, "Слишком глубоко"); ok {
		t.Fatalf("кадр всё-таки создан")
	}
	// Модель получила объяснение и может исправиться.
	if !strings.Contains(turn.Calls[0].Error, "последнем уровне") {
		t.Errorf("объяснение отказа: %q", turn.Calls[0].Error)
	}
}

// Выдуманный идентификатор родителя — отказ с подсказкой, а не кадр в корне проекта.
func TestSendRefusesUnknownParent(t *testing.T) {
	e := setup(t)
	ctx := context.Background()
	owner := e.user(t, "owner@example.com")
	projectID, _, _ := e.seedProject(t, owner)

	e.stub.setReplies(
		ai.Reply{ToolCalls: []ai.ToolCall{createCall(assistant.ToolCreateSub, map[string]any{
			"parent_id": uuid.New().String(), "title": "Никуда",
		})}},
		ai.Reply{Content: "Не нашёл такую главу."},
	)

	turn, err := e.asst.Send(ctx, owner, projectID, uuid.Nil, "stub:stub-1", "Вложи кадр")
	if err != nil {
		t.Fatalf("send: %v", err)
	}
	if len(turn.Changes) != 0 {
		t.Fatalf("создан кадр с несуществующим родителем: %+v", turn.Changes)
	}
	if !strings.Contains(turn.Calls[0].Error, "list_events") {
		t.Errorf("подсказка в отказе: %q", turn.Calls[0].Error)
	}
}

// Лимит вызовов соблюдается: лишний вызов не выполняется, но модель об этом узнаёт.
func TestSendRespectsToolCallLimit(t *testing.T) {
	e := setup(t)
	ctx := context.Background()
	owner := e.user(t, "owner@example.com")
	projectID, _, _ := e.seedProject(t, owner)

	calls := make([]ai.ToolCall, 0, 3)
	for i := 1; i <= 3; i++ {
		call := createCall(assistant.ToolCreateChapter, map[string]any{
			"title": fmt.Sprintf("Глава %d", i),
		})
		call.ID = fmt.Sprintf("call-%d", i)
		calls = append(calls, call)
	}
	e.stub.setReplies(
		ai.Reply{ToolCalls: calls},
		ai.Reply{Content: "Создал одну главу: лимит."},
	)

	// Лимит в один вызов за сообщение — так проверка не зависит от значения по умолчанию.
	e.asst.SetLimits(assistant.Limits{
		MaxToolCalls: 1, MaxRounds: 2, MaxTitleChars: 200, MaxBodyChars: 20000,
		MaxEventsInPrompt: 200, MaxHistory: 20,
	})

	turn, err := e.asst.Send(ctx, owner, projectID, uuid.Nil, "stub:stub-1", "Создай три главы")
	if err != nil {
		t.Fatalf("send: %v", err)
	}
	if len(turn.Changes) != 1 {
		t.Fatalf("создано %d глав, ожидалась 1 (лимит)", len(turn.Changes))
	}
	if len(turn.Calls) != 3 {
		t.Fatalf("отчётов о вызовах %d, ожидалось 3", len(turn.Calls))
	}
	refused := 0
	for _, call := range turn.Calls {
		if !call.OK {
			refused++
		}
	}
	if refused != 2 {
		t.Fatalf("отказано %d вызовов, ожидалось 2", refused)
	}
	if _, ok := e.event(t, projectID, "Глава 2"); ok {
		t.Errorf("глава сверх лимита всё-таки создана")
	}
}

// ============================ текстовый протокол ============================

// Модель без инструментов пишет вызов блоком ```skyfraze-tools — он выполняется так
// же, а служебный JSON не показывается человеку.
func TestSendUnderstandsTextToolCalls(t *testing.T) {
	body := "```skyfraze-tools\n" +
		`[{"name":"create_chapter","arguments":{"title":"Глава из текста","body_md":"Текст."}}]` +
		"\n```"
	e := setup(t,
		ai.Reply{Content: "Сейчас создам.\n\n" + body},
		ai.Reply{Content: "Глава создана."},
	)
	ctx := context.Background()
	owner := e.user(t, "owner@example.com")
	projectID, _, _ := e.seedProject(t, owner)

	turn, err := e.asst.Send(ctx, owner, projectID, uuid.Nil, "stub:stub-1", "Добавь главу")
	if err != nil {
		t.Fatalf("send: %v", err)
	}
	if len(turn.Changes) != 1 || turn.Changes[0].Title != "Глава из текста" {
		t.Fatalf("изменения: %+v", turn.Changes)
	}
	if _, ok := e.event(t, projectID, "Глава из текста"); !ok {
		t.Fatalf("глава из текстового вызова не создана")
	}
	if turn.Answer != "Глава создана." {
		t.Errorf("ответ человеку: %q", turn.Answer)
	}
	// В истории остался текст без служебного блока.
	messages, err := e.st.ListAIMessages(ctx, turn.ConversationID, 50)
	if err != nil {
		t.Fatalf("сообщения: %v", err)
	}
	for _, m := range messages {
		if strings.Contains(m.Content, "skyfraze-tools") || strings.Contains(m.Content, `"arguments"`) {
			t.Errorf("служебный блок попал в историю: %q", m.Content)
		}
	}
}

// Незнакомый инструмент не выполняется: модель получает ошибку, проект не меняется.
func TestSendUnknownToolIsReported(t *testing.T) {
	e := setup(t,
		ai.Reply{ToolCalls: []ai.ToolCall{createCall("delete_project", map[string]any{})}},
		ai.Reply{Content: "Так не умею."},
	)
	ctx := context.Background()
	owner := e.user(t, "owner@example.com")
	projectID, _, _ := e.seedProject(t, owner)

	turn, err := e.asst.Send(ctx, owner, projectID, uuid.Nil, "stub:stub-1", "Удали проект")
	if err != nil {
		t.Fatalf("send: %v", err)
	}
	if len(turn.Changes) != 0 || len(turn.Calls) != 1 || turn.Calls[0].OK {
		t.Fatalf("незнакомый инструмент: %+v / %+v", turn.Changes, turn.Calls)
	}
	if _, err := e.proj.Get(ctx, owner, projectID); err != nil {
		t.Fatalf("проект пострадал: %v", err)
	}
}

// ============================ HTTP-контракт ============================

// Ручки помощника под проектом: без согласия — 409 с признаком согласия, читателю —
// 403, пустое сообщение — 400. По этим кодам интерфейс решает, что показать.
func TestAssistantHTTPContract(t *testing.T) {
	e := setup(t, ai.Reply{Content: "Ответ."})
	ctx := context.Background()
	owner := e.user(t, "owner@example.com")
	viewer := e.user(t, "viewer@example.com")
	projectID, _, _ := e.seedProject(t, owner)
	if err := e.st.SetAIConsent(ctx, viewer, "stub"); err != nil {
		t.Fatalf("consent: %v", err)
	}
	if err := e.st.AddMembership(ctx, projectID, viewer, store.RoleViewer); err != nil {
		t.Fatalf("membership: %v", err)
	}
	router := assistantRouter(e)

	post := func(path, body string, user uuid.UUID) *httptest.ResponseRecorder {
		t.Helper()
		token, err := auth.IssueAccess(testSecret, user)
		if err != nil {
			t.Fatalf("token: %v", err)
		}
		req := httptest.NewRequest(http.MethodPost, path, strings.NewReader(body))
		req.Header.Set("Content-Type", "application/json")
		req.Header.Set("Authorization", "Bearer "+token)
		rec := httptest.NewRecorder()
		router.ServeHTTP(rec, req)
		return rec
	}
	messages := "/api/projects/" + projectID.String() + "/ai/conversations/new/messages"

	// Успешный вопрос: в ответе есть и текст, и изменения, и идентификатор беседы.
	rec := post(messages, `{"text":"Как дела?","model":"stub:stub-1"}`, owner)
	if rec.Code != http.StatusOK {
		t.Fatalf("код %d, тело %s", rec.Code, rec.Body.String())
	}
	var turn struct {
		ConversationID uuid.UUID `json:"conversation_id"`
		Answer         string    `json:"answer"`
		Changes        []any     `json:"changes"`
		Calls          []any     `json:"calls"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &turn); err != nil {
		t.Fatalf("json: %v (%s)", err, rec.Body.String())
	}
	if turn.ConversationID == uuid.Nil || turn.Answer != "Ответ." {
		t.Fatalf("ответ: %+v", turn)
	}
	if turn.Changes == nil || turn.Calls == nil {
		t.Errorf("changes и calls должны приходить пустыми списками, а не null")
	}

	// Пустое сообщение — 400, а не поход к модели.
	if rec := post(messages, `{"text":"   ","model":"stub:stub-1"}`, owner); rec.Code != http.StatusBadRequest {
		t.Fatalf("пустое сообщение: код %d, тело %s", rec.Code, rec.Body.String())
	}

	// Читатель: 403.
	if rec := post(messages, `{"text":"Создай главу","model":"stub:stub-1"}`, viewer); rec.Code != http.StatusForbidden {
		t.Fatalf("читатель: код %d, тело %s", rec.Code, rec.Body.String())
	}

	// Без согласия: 409 и признак, по которому интерфейс показывает вопрос.
	stranger := e.user(t, "stranger@example.com")
	if err := e.st.AddMembership(ctx, projectID, stranger, store.RoleEditor); err != nil {
		t.Fatalf("membership: %v", err)
	}
	rec = post(messages, `{"text":"Создай главу","model":"stub:stub-1"}`, stranger)
	if rec.Code != http.StatusConflict || !strings.Contains(rec.Body.String(), "consent_required") {
		t.Fatalf("без согласия: код %d, тело %s", rec.Code, rec.Body.String())
	}
	// Согласие дали — тот же запрос проходит.
	rec = post("/api/ai/consent", `{"provider":"stub"}`, stranger)
	if rec.Code != http.StatusOK {
		t.Fatalf("согласие: код %d, тело %s", rec.Code, rec.Body.String())
	}
	if rec := post(messages, `{"text":"Создай главу","model":"stub:stub-1"}`, stranger); rec.Code != http.StatusOK {
		t.Fatalf("после согласия: код %d, тело %s", rec.Code, rec.Body.String())
	}

	// Посторонний (не участник проекта) не получает ничего: ни списка бесед, ни
	// права завести беседу в чужом проекте. Раньше список отвечал 200 — «беседы-то
	// свои», но 200 на чужом проекте и есть та дырка, через которую перебирают
	// идентификаторы.
	outsider := e.user(t, "outsider@example.com")
	get := func(path string, user uuid.UUID) *httptest.ResponseRecorder {
		t.Helper()
		token, err := auth.IssueAccess(testSecret, user)
		if err != nil {
			t.Fatalf("token: %v", err)
		}
		req := httptest.NewRequest(http.MethodGet, path, nil)
		req.Header.Set("Authorization", "Bearer "+token)
		rec := httptest.NewRecorder()
		router.ServeHTTP(rec, req)
		return rec
	}
	conversations := "/api/projects/" + projectID.String() + "/ai/conversations"
	if rec := get(conversations, outsider); rec.Code != http.StatusForbidden {
		t.Fatalf("список бесед чужого проекта: код %d, тело %s", rec.Code, rec.Body.String())
	}
	if rec := post(conversations, `{"title":"Чужая беседа"}`, outsider); rec.Code != http.StatusForbidden {
		t.Fatalf("создание беседы в чужом проекте: код %d, тело %s", rec.Code, rec.Body.String())
	}
	// Участник проекта список видит.
	if rec := get(conversations, owner); rec.Code != http.StatusOK {
		t.Fatalf("свой проект: код %d, тело %s", rec.Code, rec.Body.String())
	}
}

// assistantRouter собирает роутер с теми же путями и той же проверкой входа, что в
// main.go: без chi URL-параметров и auth-мидлвари проверять контракт бессмысленно.
func assistantRouter(e *env) http.Handler {
	authSvc := auth.New(nil, testSecret)
	r := chi.NewRouter()
	r.Route("/api/ai", func(r chi.Router) {
		r.Use(authSvc.WithUser)
		ai.NewHandler(e.models, testLogger()).Routes(r)
	})
	h := assistant.NewHandler(e.asst, testLogger())
	r.Route("/api/projects/{id}", func(r chi.Router) {
		r.Use(authSvc.WithUser)
		h.Routes(r)
	})
	return r
}

// ============================ агент как соавтор ============================

// Правки агента подписаны АГЕНТОМ, а не человеком, который нажал «спросить».
//
// В этом весь смысл отдельной записи агента в users: иначе в истории правок стоял бы
// владелец проекта, который эту главу не писал, а помощник остался бы как бы ни при чём.
func TestSendAttributesEditsToAgent(t *testing.T) {
	e := setup(t,
		ai.Reply{ToolCalls: []ai.ToolCall{createCall(assistant.ToolCreateChapter, map[string]any{
			"title": "Пролог", "body_md": "текст",
		})}},
		ai.Reply{Content: "Готово."},
	)
	ctx := context.Background()
	owner := e.user(t, "owner@example.com")
	projectID, _, _ := e.seedProject(t, owner)

	if _, err := e.asst.Send(ctx, owner, projectID, uuid.Nil, "stub:stub-1", "Добавь главу"); err != nil {
		t.Fatalf("send: %v", err)
	}
	row, ok := e.event(t, projectID, "Пролог")
	if !ok {
		t.Fatalf("главы нет в таблице событий")
	}
	if row.CreatedBy == nil || *row.CreatedBy != ai.AgentUserID {
		t.Fatalf("автор правки %v, ожидался агент %v", row.CreatedBy, ai.AgentUserID)
	}
	if row.UpdatedBy == nil || *row.UpdatedBy != ai.AgentUserID {
		t.Fatalf("последний редактор %v, ожидался агент %v", row.UpdatedBy, ai.AgentUserID)
	}
}

// Роль и указания владельца уходят модели, а агент становится участником проекта.
func TestProjectSettingsRoleMembershipAndPrompt(t *testing.T) {
	e := setup(t, ai.Reply{Content: "Хорошо."})
	ctx := context.Background()
	owner := e.user(t, "owner@example.com")
	projectID, _, _ := e.seedProject(t, owner)

	settings, err := e.asst.SaveProjectSettings(ctx, owner, projectID, "chronicler", "Пиши сдержанно.", true, store.GenerationAuto, "")
	if err != nil {
		t.Fatalf("сохранение настроек: %v", err)
	}
	if settings.RoleTitle != "Летописец" || !settings.CanEdit || !settings.Member {
		t.Fatalf("настройки агента: %+v", settings)
	}
	if settings.AgentName != ai.AgentName || settings.AgentID != ai.AgentUserID {
		t.Fatalf("имя агента потерялось: %+v", settings)
	}

	// Агент — соавтор: строка участия с правом писать, но не распоряжаться проектом.
	membership, err := e.st.GetMembership(ctx, projectID, ai.AgentUserID)
	if err != nil {
		t.Fatalf("агент не стал участником: %v", err)
	}
	if membership.Role != store.RoleEditor {
		t.Fatalf("роль агента в проекте %q, ожидалась editor", membership.Role)
	}

	// Указания и имя доехали до запроса к модели.
	if _, err := e.asst.Send(ctx, owner, projectID, uuid.Nil, "stub:stub-1", "Что дальше?"); err != nil {
		t.Fatalf("send: %v", err)
	}
	prompt := e.stub.firstRequest().Messages[0].Content
	for _, want := range []string{ai.AgentName, "Летописец", "Пиши сдержанно."} {
		if !strings.Contains(prompt, want) {
			t.Errorf("в правилах для модели нет %q:\n%s", want, prompt)
		}
	}
}

// Роль и поведение агента меняет только владелец: это его проект и его решение.
func TestProjectSettingsOwnerOnly(t *testing.T) {
	e := setup(t)
	ctx := context.Background()
	owner := e.user(t, "owner@example.com")
	editor := e.user(t, "editor@example.com")
	projectID, _, _ := e.seedProject(t, owner)
	if err := e.st.SetAIConsent(ctx, editor, "stub"); err != nil {
		t.Fatalf("consent: %v", err)
	}
	if err := e.st.AddMembership(ctx, projectID, editor, store.RoleEditor); err != nil {
		t.Fatalf("membership: %v", err)
	}

	if _, err := e.asst.SaveProjectSettings(ctx, editor, projectID, "editor", "", true, store.GenerationAuto, ""); !errors.Is(err, assistant.ErrForbidden) {
		t.Fatalf("редактор не должен менять роль агента, получено %v", err)
	}
	// Читать настройки участник может — и видит, что менять их не вправе.
	settings, err := e.asst.ProjectSettings(ctx, editor, projectID)
	if err != nil {
		t.Fatalf("чтение настроек: %v", err)
	}
	if settings.CanEdit {
		t.Fatalf("редактору нельзя показывать право менять роль агента")
	}
	// Неизвестная роль — понятный отказ, а не «сохранили что попало».
	if _, err := e.asst.SaveProjectSettings(ctx, owner, projectID, "придумать-всё", "", true, store.GenerationAuto, ""); err == nil {
		t.Fatalf("неизвестная роль должна отвергаться")
	}
}

// Выключенный в проекте агент не пишет: ноль запросов к модели.
func TestSendRefusesWhenAgentDisabledInProject(t *testing.T) {
	e := setup(t, ai.Reply{Content: "не должно случиться"})
	ctx := context.Background()
	owner := e.user(t, "owner@example.com")
	projectID, _, _ := e.seedProject(t, owner)

	if _, err := e.asst.SaveProjectSettings(ctx, owner, projectID, "", "", false, store.GenerationAuto, ""); err != nil {
		t.Fatalf("выключение агента: %v", err)
	}
	_, err := e.asst.Send(ctx, owner, projectID, uuid.Nil, "stub:stub-1", "Создай главу")
	if !errors.Is(err, assistant.ErrProjectDisabled) {
		t.Fatalf("ожидался отказ «агент выключен в проекте», получено %v", err)
	}
	if e.stub.calls() != 0 {
		t.Fatalf("выключенный агент всё-таки спросил модель")
	}
}
