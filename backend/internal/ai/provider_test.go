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
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/skyfraze/backend/internal/ai"
)

// stub — поддельный провайдер: отдаёт то, что мы ему сказали, и записывает, что у
// него спросили.
type stub struct {
	server   *httptest.Server
	lastPath string
	lastBody map[string]any
}

func newStub(t *testing.T, handler func(w http.ResponseWriter, r *http.Request, s *stub)) *stub {
	t.Helper()
	s := &stub{}
	s.server = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		s.lastPath = r.URL.Path
		s.lastBody = nil
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
	if models[0].Title != "qwen2.5:7b (7.6B)" {
		t.Errorf("подпись модели: %q", models[0].Title)
	}
	if models[1].Tools {
		t.Errorf("модель без tools помечена умеющей: %+v", models[1])
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
