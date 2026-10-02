package ai_test

// provider_test.go — разбор ответов провайдеров и шифрование ключей.
//
// Всё на заглушках (httptest): настоящие модели в тестах не нужны и вредны — тест
// зависел бы от сети, денег и чужого сервиса. Проверяем наш код: как понимаем ответ
// «список моделей», как достаём вызовы инструментов, как отличаем бесплатную модель
// от платной и как ведём себя, когда провайдер отказал.

import (
	"context"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"

	"github.com/skyfraze/backend/internal/ai"
)

// testLogger — логгер в никуда: в тестах сообщения сервиса не нужны.
func testLogger(t *testing.T) *slog.Logger {
	t.Helper()
	return slog.New(slog.NewTextHandler(io.Discard, nil))
}

// stub — поддельный провайдер: отдаёт то, что мы ему сказали, и записывает, что у
// него спросили.
type stub struct {
	server   *httptest.Server
	lastPath string
	lastBody map[string]any
	// lastAuth — заголовок Authorization как он пришёл (пусто — заголовка не было).
	lastAuth string
}

func newStub(t *testing.T, handler func(w http.ResponseWriter, r *http.Request, s *stub)) *stub {
	t.Helper()
	s := &stub{}
	s.server = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		s.lastPath = r.URL.Path
		s.lastBody = nil
		s.lastAuth = r.Header.Get("Authorization")
		if r.Body != nil && r.Method == http.MethodPost {
			var body map[string]any
			_ = json.NewDecoder(r.Body).Decode(&body)
			s.lastBody = body
		}
		handler(w, r, s)
	}))
	t.Cleanup(s.server.Close)
	return s
}

func (s *stub) provider(kind ai.ProviderKind, id string) ai.Provider {
	return ai.Provider{ID: id, Title: id, Kind: kind, BaseURL: s.server.URL}
}

func TestOpenAIListsModelsAndDetectsFree(t *testing.T) {
	s := newStub(t, func(w http.ResponseWriter, r *http.Request, _ *stub) {
		if r.Header.Get("Authorization") != "Bearer secret-key" {
			w.WriteHeader(http.StatusUnauthorized)
			_, _ = w.Write([]byte(`{"error":{"message":"no key"}}`))
			return
		}
		_, _ = w.Write([]byte(`{"data":[
			{"id":"llama-3.3-70b","context_length":131072,"supported_parameters":["tools","temperature"],
			 "pricing":{"prompt":"0","completion":"0"}},
			{"id":"gpt-4o","context_length":128000,"pricing":{"prompt":"0.0000025","completion":"0.00001"}}
		]}`))
	})

	client, err := ai.NewClient(s.provider(ai.KindOpenAI, "openrouter"), "secret-key", 5*time.Second)
	if err != nil {
		t.Fatalf("клиент: %v", err)
	}
	models, err := client.ListModels(context.Background())
	if err != nil {
		t.Fatalf("список моделей: %v", err)
	}
	if len(models) != 2 {
		t.Fatalf("моделей %d, ожидалось 2", len(models))
	}
	free, paid := models[0], models[1]
	if !free.Free || free.Ref != "openrouter:llama-3.3-70b" || !free.Tools {
		t.Errorf("бесплатная модель разобрана неверно: %+v", free)
	}
	if free.ContextKB != 128 {
		t.Errorf("контекст: %d КБ, ожидалось 128", free.ContextKB)
	}
	if paid.Free {
		t.Errorf("платная модель помечена бесплатной: %+v", paid)
	}
}

// Модель без поддержки инструментов помечается: интерфейс предупредит, что она не
// сможет создавать главы.
func TestOpenAIMarksModelsWithoutTools(t *testing.T) {
	s := newStub(t, func(w http.ResponseWriter, _ *http.Request, _ *stub) {
		_, _ = w.Write([]byte(`{"data":[{"id":"plain","supported_parameters":["temperature"]}]}`))
	})
	client, _ := ai.NewClient(s.provider(ai.KindOpenAI, "groq"), "k", 5*time.Second)
	models, err := client.ListModels(context.Background())
	if err != nil {
		t.Fatalf("список: %v", err)
	}
	if len(models) != 1 || models[0].Tools {
		t.Errorf("модель без инструментов разобрана неверно: %+v", models)
	}
}

func TestOpenAIUnauthorizedAndUnavailable(t *testing.T) {
	s := newStub(t, func(w http.ResponseWriter, r *http.Request, _ *stub) {
		if strings.HasSuffix(r.URL.Path, "/models") {
			w.WriteHeader(http.StatusUnauthorized)
			_, _ = w.Write([]byte(`{"error":{"message":"invalid api key"}}`))
			return
		}
		w.WriteHeader(http.StatusInternalServerError)
		_, _ = w.Write([]byte(`{"error":{"message":"boom"}}`))
	})
	client, _ := ai.NewClient(s.provider(ai.KindOpenAI, "groq"), "bad", 5*time.Second)

	if _, err := client.ListModels(context.Background()); !errors.Is(err, ai.ErrUnauthorized) {
		t.Errorf("ожидалась ошибка «ключ отвергнут», получено: %v", err)
	}
	if _, err := client.Chat(context.Background(), ai.Request{Model: "m"}); !errors.Is(err, ai.ErrUnavailable) {
		t.Errorf("ожидалась ошибка «провайдер недоступен», получено: %v", err)
	}
}

// Инструменты: аргументы у OpenAI приходят строкой JSON, и мы обязаны их разобрать.
func TestOpenAIChatParsesToolCalls(t *testing.T) {
	s := newStub(t, func(w http.ResponseWriter, _ *http.Request, _ *stub) {
		_, _ = w.Write([]byte(`{"model":"llama-3.3-70b","choices":[{"message":{
			"role":"assistant","content":"Создаю главу.",
			"tool_calls":[{"id":"call_1","type":"function","function":{
				"name":"create_chapter","arguments":"{\"title\":\"Пролог\",\"body_md\":\"# Пролог\"}"}}]}}],
			"usage":{"prompt_tokens":100,"completion_tokens":20}}`))
	})
	client, _ := ai.NewClient(s.provider(ai.KindOpenAI, "groq"), "k", 5*time.Second)

	reply, err := client.Chat(context.Background(), ai.Request{
		Model:    "llama-3.3-70b",
		Messages: []ai.Message{{Role: "user", Content: "создай главу Пролог"}},
		Tools: []ai.ToolDef{{Name: "create_chapter", Description: "создать главу",
			Parameters: map[string]any{"type": "object"}}},
	})
	if err != nil {
		t.Fatalf("чат: %v", err)
	}
	if len(reply.ToolCalls) != 1 {
		t.Fatalf("вызовов инструментов %d, ожидался 1: %+v", len(reply.ToolCalls), reply)
	}
	call := reply.ToolCalls[0]
	if call.Name != "create_chapter" || call.Arguments["title"] != "Пролог" {
		t.Errorf("вызов разобран неверно: %+v", call)
	}
	if reply.TokensIn != 100 || reply.TokensOut != 20 {
		t.Errorf("счётчики токенов: %+v", reply)
	}
	// Инструменты уехали провайдеру — иначе он не смог бы их вызвать.
	tools, _ := s.lastBody["tools"].([]any)
	if len(tools) != 1 {
		t.Errorf("определения инструментов не переданы: %+v", s.lastBody)
	}
}

// Неразобранные аргументы не теряются: вызов остаётся, а валидация его отвергнет.
func TestOpenAIChatKeepsBrokenArguments(t *testing.T) {
	s := newStub(t, func(w http.ResponseWriter, _ *http.Request, _ *stub) {
		_, _ = w.Write([]byte(`{"choices":[{"message":{"role":"assistant","content":"",
			"tool_calls":[{"id":"c1","function":{"name":"create_chapter","arguments":"{сломано"}}]}}]}`))
	})
	client, _ := ai.NewClient(s.provider(ai.KindOpenAI, "groq"), "k", 5*time.Second)
	reply, err := client.Chat(context.Background(), ai.Request{Model: "m"})
	if err != nil {
		t.Fatalf("чат: %v", err)
	}
	if len(reply.ToolCalls) != 1 {
		t.Fatalf("вызов потерян: %+v", reply)
	}
	if _, ok := reply.ToolCalls[0].Arguments["_raw"]; !ok {
		t.Errorf("сломанные аргументы не сохранены: %+v", reply.ToolCalls[0].Arguments)
	}
}

func TestOllamaListsLocalModels(t *testing.T) {
	s := newStub(t, func(w http.ResponseWriter, r *http.Request, _ *stub) {
		if r.URL.Path != "/api/tags" {
			t.Errorf("неожиданный путь: %s", r.URL.Path)
		}
		_, _ = w.Write([]byte(`{"models":[
			{"name":"qwen2.5:7b","model":"qwen2.5:7b","size":4683087296,
			 "details":{"parameter_size":"7.6B"},"capabilities":["completion","tools"]},
			{"name":"llava:13b","model":"llava:13b","capabilities":["completion","vision"]}
		]}`))
	})
	// Локальному провайдеру ключ не нужен: NewClient его не требует.
	client, err := ai.NewClient(s.provider(ai.KindOllama, "ollama"), "", 5*time.Second)
	if err != nil {
		t.Fatalf("клиент: %v", err)
	}
	models, err := client.ListModels(context.Background())
	if err != nil {
		t.Fatalf("список: %v", err)
	}
	if len(models) != 2 {
		t.Fatalf("моделей %d", len(models))
	}
	if !models[0].Local || !models[0].Free || !models[0].Tools {
		t.Errorf("локальная модель разобрана неверно: %+v", models[0])
	}
	if models[0].Cloud {
		t.Errorf("локальная модель помечена облачной: %+v", models[0])
	}
	if models[0].Title != "qwen2.5:7b (7.6B)" {
		t.Errorf("подпись модели: %q", models[0].Title)
	}
	if models[1].Tools {
		t.Errorf("модель без tools помечена умеющей: %+v", models[1])
	}
}

// Облачные модели Ollama (`…:cloud`, `remote_host`) — НЕ локальные.
//
// Это не придирка к подписи. Провайдер один и тот же, а текст проекта у облачной
// модели уходит на ollama.com: если считать её локальной, чат отправил бы содержимое
// проекта, не спросив согласия, — ровно то, от чего согласие и защищает.
func TestOllamaCloudModelsAreNotLocal(t *testing.T) {
	s := newStub(t, func(w http.ResponseWriter, _ *http.Request, _ *stub) {
		_, _ = w.Write([]byte(`{"models":[
			{"name":"qwen3.5:cloud","model":"qwen3.5:cloud","size":346,
			 "remote_host":"https://ollama.com:443","capabilities":["tools"]},
			{"name":"custom-remote:latest","model":"custom-remote:latest","size":400,
			 "remote_host":"https://models.example.com","capabilities":["tools"]},
			{"name":"qwen2.5:7b","model":"qwen2.5:7b","capabilities":["tools"]}
		]}`))
	})
	client, _ := ai.NewClient(s.provider(ai.KindOllama, "ollama"), "", 5*time.Second)
	models, err := client.ListModels(context.Background())
	if err != nil {
		t.Fatalf("список: %v", err)
	}
	if len(models) != 3 {
		t.Fatalf("моделей %d, ожидалось 3", len(models))
	}
	if !models[0].Cloud || models[0].Local || models[0].Free {
		t.Errorf("облачная модель по суффиксу разобрана неверно: %+v", models[0])
	}
	if !strings.Contains(models[0].Title, "ollama.com") {
		t.Errorf("в подписи облачной модели нет хоста: %q", models[0].Title)
	}
	// Признак remote_host важнее суффикса имени: облачным бывает и сервер в локальной
	// сети, названный как угодно.
	if !models[1].Cloud || models[1].Local {
		t.Errorf("модель с remote_host не помечена облачной: %+v", models[1])
	}
	if models[2].Cloud || !models[2].Local {
		t.Errorf("локальная модель испорчена: %+v", models[2])
	}
	// Проверка по имени работает и без запроса к провайдеру: согласие спрашивается
	// до него.
	if !ai.IsCloudModelRef("glm-5.2:cloud") || ai.IsCloudModelRef("qwen2.5:7b") {
		t.Errorf("признак облачной модели по имени работает неверно")
	}
}

// Свой сервер моделей (llama.cpp, vLLM) ключа обычно не требует.
//
// Два правила, и оба проверены здесь: клиент не отказывается работать без ключа, и
// заголовок Authorization не отправляется пустым — часть серверов на «Bearer » с
// пустым значением отвечает 401, хотя без заголовка работала бы.
func TestOpenAIKeylessServerWithoutKey(t *testing.T) {
	s := newStub(t, func(w http.ResponseWriter, r *http.Request, _ *stub) {
		switch r.URL.Path {
		case "/models":
			_, _ = w.Write([]byte(`{"data":[{"id":"gemma-4-E4B-it-Q4_K_M"}]}`))
		case "/chat/completions":
			_, _ = w.Write([]byte(`{"model":"gemma-4-E4B-it-Q4_K_M","choices":[{"message":{
				"role":"assistant","content":"Привет"}}],"usage":{"prompt_tokens":5,"completion_tokens":2}}`))
		default:
			t.Errorf("неожиданный путь: %s", r.URL.Path)
		}
	})
	provider := s.provider(ai.KindOpenAI, "custom")
	provider.Keyless = true
	provider.Local = true

	client, err := ai.NewClient(provider, "", 5*time.Second)
	if err != nil {
		t.Fatalf("сервер без ключа: %v", err)
	}
	models, err := client.ListModels(context.Background())
	if err != nil || len(models) != 1 {
		t.Fatalf("список моделей: %v (%d)", err, len(models))
	}
	// Модель своего сервера — локальная: интерфейс по этому признаку говорит, что
	// текст проекта никуда не уходит.
	if !models[0].Local {
		t.Errorf("модель своего сервера не помечена локальной: %+v", models[0])
	}
	if s.lastAuth != "" {
		t.Errorf("ключ не задан, а заголовок отправлен: %q", s.lastAuth)
	}
	if _, err := client.Chat(context.Background(), ai.Request{
		Model: "gemma-4-E4B-it-Q4_K_M", Messages: []ai.Message{{Role: "user", Content: "привет"}},
	}); err != nil {
		t.Fatalf("чат без ключа: %v", err)
	}

	// Тот же сервер, но помеченный как требующий ключа: отказ ДО запроса, чтобы
	// человек видел «нужен ключ», а не 401 от чужого сервиса.
	strict := s.provider(ai.KindOpenAI, "groq")
	if _, err := ai.NewClient(strict, "", 5*time.Second); !errors.Is(err, ai.ErrNoKey) {
		t.Fatalf("провайдер с ключом должен требовать ключ, получено: %v", err)
	}
}

// Явный размер контекста для Ollama-подобного сервера.
//
// Без него llama.cpp-подобные серверы уходят в автоперезагрузку модели и отвечают
// «retry in 30s» на каждый запрос; с ним — обрабатывают сразу.
func TestOllamaSendsNumCtxOnlyWhenConfigured(t *testing.T) {
	s := newStub(t, func(w http.ResponseWriter, _ *http.Request, _ *stub) {
		_, _ = w.Write([]byte(`{"model":"gemma-4-E4B-it-Q4_K_M","message":{"role":"assistant","content":"Привет"}}`))
	})
	provider := s.provider(ai.KindOllama, "ollama")
	provider.NumCtx = 8192

	client, _ := ai.NewClient(provider, "", 5*time.Second)
	if _, err := client.Chat(context.Background(), ai.Request{
		Model: "gemma-4-E4B-it-Q4_K_M", Messages: []ai.Message{{Role: "user", Content: "привет"}},
		Temperature: 0.4,
	}); err != nil {
		t.Fatalf("чат: %v", err)
	}
	options, _ := s.lastBody["options"].(map[string]any)
	if options == nil || options["num_ctx"] != float64(8192) {
		t.Fatalf("num_ctx не передан: %+v", s.lastBody["options"])
	}
	if options["temperature"] != 0.4 {
		t.Errorf("температура потерялась: %+v", options)
	}

	// Не задан — поля нет вовсе: у настоящей Ollama свой разумный размер контекста,
	// и навязывать ей наше значение нельзя.
	plain := s.provider(ai.KindOllama, "ollama")
	plainClient, _ := ai.NewClient(plain, "", 5*time.Second)
	if _, err := plainClient.Chat(context.Background(), ai.Request{
		Model: "qwen2.5:7b", Messages: []ai.Message{{Role: "user", Content: "привет"}},
		Temperature: 0.4,
	}); err != nil {
		t.Fatalf("чат: %v", err)
	}
	options, _ = s.lastBody["options"].(map[string]any)
	if _, ok := options["num_ctx"]; ok {
		t.Fatalf("num_ctx передан без настройки: %+v", options)
	}
}

// Свой OpenAI-совместимый сервер: без ключа и без согласия, если админ сказал, что он
// локальный. Проверяем и обратное — по умолчанию он «чужой», и согласие нужно.
func TestProviderListCustomServerFlags(t *testing.T) {
	local := ai.ProviderList(ai.ProviderOptions{
		OpenAICompatURL: "http://host.docker.internal:18080/v1", OpenAICompatLocal: true,
	})
	if len(local) != 5 {
		t.Fatalf("провайдеров %d, ожидалось 5 (только свои серверы плюс размещённые)", len(local))
	}
	custom := local[0]
	if custom.ID != "custom" || !custom.Keyless || !custom.Local || custom.BaseURL != "http://host.docker.internal:18080/v1" {
		t.Fatalf("свой локальный сервер разобран неверно: %+v", custom)
	}

	remote := ai.ProviderList(ai.ProviderOptions{OpenAICompatURL: "https://gateway.example.com/v1"})
	if remote[0].Local {
		t.Errorf("сервер без пометки «локальный» не должен считаться своим: %+v", remote[0])
	}
	if !remote[0].Keyless {
		t.Errorf("свой сервер не должен требовать ключ: %+v", remote[0])
	}

	ollama := ai.ProviderList(ai.ProviderOptions{OllamaURL: "http://host.docker.internal:18080", OllamaNumCtx: 8192})
	if ollama[0].ID != "ollama" || ollama[0].NumCtx != 8192 {
		t.Fatalf("Ollama-провайдер: %+v", ollama[0])
	}
}

// Локальный провайдер не требует согласия: текст проекта остаётся у человека.
func TestLocalProviderNeedsNoConsent(t *testing.T) {
	// Хранилище намеренно nil: если бы решение о согласии шло в базу, тест упал бы —
	// а для своего сервера туда ходить незачем.
	svc := ai.New(nil, ai.Config{
		Enabled: true, OpenAICompatURL: "http://host.docker.internal:18080/v1", OpenAICompatLocal: true,
	}, nil, testLogger(t))

	if !svc.IsLocal("custom") {
		t.Fatalf("свой сервер должен считаться локальным")
	}
	allowed, err := svc.HasConsentFor(context.Background(), uuid.New(), "custom", "gemma-4-E4B-it-Q4_K_M")
	if err != nil || !allowed {
		t.Fatalf("для своего сервера согласие не нужно: %v (%v)", allowed, err)
	}
}

// Локальный сервер не запущен — самая частая причина, и текст ошибки должен говорить
// именно об этом.
func TestOllamaUnavailable(t *testing.T) {
	client, _ := ai.NewClient(ai.Provider{
		ID: "ollama", Title: "Ollama", Kind: ai.KindOllama, BaseURL: "http://127.0.0.1:1",
	}, "", 2*time.Second)
	_, err := client.ListModels(context.Background())
	if !errors.Is(err, ai.ErrUnavailable) {
		t.Fatalf("ожидалась ошибка доступности, получено: %v", err)
	}
	if !strings.Contains(err.Error(), "127.0.0.1:1") {
		t.Errorf("в ошибке нет адреса сервера: %v", err)
	}
}

func TestNewClientRequiresKeyForRemote(t *testing.T) {
	_, err := ai.NewClient(ai.Provider{ID: "groq", Kind: ai.KindOpenAI, BaseURL: "https://example.com"}, "", time.Second)
	if !errors.Is(err, ai.ErrNoKey) {
		t.Fatalf("ожидалась ошибка «нужен ключ», получено: %v", err)
	}
}

// ---------- шифрование ключей ----------

func TestCipherRoundTrip(t *testing.T) {
	secret := hex.EncodeToString(make([]byte, 32)) // 32 нулевых байта в hex
	cipher, err := ai.NewCipher(secret)
	if err != nil {
		t.Fatalf("шифр: %v", err)
	}
	plain := "gsk_очень-секретный-ключ"
	data, err := cipher.Encrypt(plain)
	if err != nil {
		t.Fatalf("шифрование: %v", err)
	}
	if strings.Contains(string(data), "секрет") {
		t.Fatal("ключ остался в открытом виде внутри шифртекста")
	}
	back, err := cipher.Decrypt(data)
	if err != nil {
		t.Fatalf("расшифровка: %v", err)
	}
	if back != plain {
		t.Errorf("ключ не совпал: %q", back)
	}
	// Два шифрования одного ключа дают разные байты (nonce разный) — иначе по базе
	// было бы видно, у кого одинаковые ключи.
	again, _ := cipher.Encrypt(plain)
	if string(again) == string(data) {
		t.Error("шифртексты совпали: nonce не случаен")
	}
}

func TestCipherRejectsBadSecret(t *testing.T) {
	if _, err := ai.NewCipher(""); !errors.Is(err, ai.ErrNoCipher) {
		t.Errorf("пустой ключ: %v", err)
	}
	if _, err := ai.NewCipher("короткий"); err == nil {
		t.Error("короткий ключ принят")
	}
	if _, err := ai.NewCipher(hex.EncodeToString(make([]byte, 16))); err == nil {
		t.Error("16 байт приняты: нужен AES-256")
	}
	// base64 того же размера принимается.
	if _, err := ai.NewCipher("AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA="); err != nil {
		t.Errorf("base64-ключ не принят: %v", err)
	}
}

func TestDecryptWithAnotherKeyFails(t *testing.T) {
	first, _ := ai.NewCipher(hex.EncodeToString(bytesRepeat(1, 32)))
	second, _ := ai.NewCipher(hex.EncodeToString(bytesRepeat(2, 32)))
	data, err := first.Encrypt("ключ")
	if err != nil {
		t.Fatalf("шифрование: %v", err)
	}
	if _, err := second.Decrypt(data); err == nil {
		t.Error("чужой ключ расшифровал шифртекст")
	}
}

func TestMaskKey(t *testing.T) {
	if got := ai.MaskKey("gsk_1234567890abcd"); got != "…abcd" {
		t.Errorf("маска: %q", got)
	}
	if got := ai.MaskKey("ab"); got != "…" {
		t.Errorf("короткий ключ: %q", got)
	}
}

func bytesRepeat(value byte, n int) []byte {
	out := make([]byte, n)
	for i := range out {
		out[i] = value
	}
	return out
}
