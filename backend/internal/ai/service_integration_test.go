package ai_test

// service_integration_test.go — ключи пользователей и ручки ИИ-помощника на настоящей
// базе (нужна Postgres, TEST_DATABASE_URL).
//
// Проверяем ровно те обещания, которые важны человеку и эксплуатации:
//   * ключ лежит ТОЛЬКО шифрованным и наружу не отдаётся;
//   * неверный ключ не сохраняется (иначе «подключено» означало бы «не работает»);
//   * свой ключ имеет приоритет над ключом стенда;
//   * без ключа шифрования функция своих ключей честно выключена.

import (
	"bytes"
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

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"

	"github.com/skyfraze/backend/internal/ai"
	"github.com/skyfraze/backend/internal/auth"
	"github.com/skyfraze/backend/internal/platform/testdb"
	"github.com/skyfraze/backend/internal/store"
)

const aiRoutesSecret = "test-secret-ai"

// aiTestEnv — окружение теста: база, сервис и адрес заглушки провайдера.
type aiTestEnv struct {
	store *store.Store
	svc   *ai.Service
	user  uuid.UUID
	stub  string
}

func (e *aiTestEnv) provider() ai.Provider {
	return ai.Provider{
		ID: "groq", Title: "Groq", Kind: ai.KindOpenAI, BaseURL: e.stub,
		KeyEnv: "GROQ_API_KEY", FreeByDefault: true,
	}
}

func aiEnv(t *testing.T) *aiTestEnv {
	t.Helper()
	pool := testdb.Setup(t, "ai")
	testdb.Truncate(t, pool,
		"ai_messages", "ai_conversations", "ai_user_keys",
		"project_ratings", "project_views", "registration_requests", "app_settings",
		"project_event_state", "sessions", "invitations", "event_assets", "assets",
		"events", "team_memberships", "projects", "users")

	st := store.New(pool)
	logger := slog.New(slog.NewTextHandler(io.Discard, nil))
	svc := ai.New(st, ai.Config{Enabled: true, SecretKey: testSecret(), MaxToolCalls: 10}, nil, logger)

	// Провайдер — заглушка на localhost: тест не должен ходить в интернет.
	stub := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "Bearer good-key" {
			w.WriteHeader(http.StatusUnauthorized)
			_, _ = w.Write([]byte(`{"error":{"message":"invalid api key"}}`))
			return
		}
		_, _ = w.Write([]byte(`{"data":[{"id":"llama-3.3-70b","supported_parameters":["tools"],
			"pricing":{"prompt":"0","completion":"0"}}]}`))
	}))
	t.Cleanup(stub.Close)

	env := &aiTestEnv{store: st, svc: svc, stub: stub.URL}
	svc.UseProviders([]ai.Provider{env.provider()})

	user, err := st.CreateUser(context.Background(), "author@example.com", "hash", "Автор")
	if err != nil {
		t.Fatalf("пользователь: %v", err)
	}
	env.user = user.ID
	return env
}

// testSecret — ключ шифрования для тестов (32 байта в hex).
func testSecret() string { return hex.EncodeToString(bytes.Repeat([]byte{7}, 32)) }

func TestSetKeyStoresCiphertextOnly(t *testing.T) {
	e := aiEnv(t)
	ctx := context.Background()

	if err := e.svc.SetKey(ctx, e.user, "groq", "good-key"); err != nil {
		t.Fatalf("сохранение ключа: %v", err)
	}
	data, err := e.store.AIKeyCiphertext(ctx, e.user, "groq")
	if err != nil {
		t.Fatalf("чтение шифртекста: %v", err)
	}
	if strings.Contains(string(data), "good-key") {
		t.Fatal("ключ лежит в базе открытым текстом")
	}
	cipher, err := ai.NewCipher(testSecret())
	if err != nil {
		t.Fatalf("шифр: %v", err)
	}
	back, err := cipher.Decrypt(data)
	if err != nil || back != "good-key" {
		t.Fatalf("ключ не расшифровался обратно: %q (%v)", back, err)
	}

	// Провайдер виден как подключённый, но самого ключа в ответе нет.
	providers, err := e.svc.Providers(ctx, e.user)
	if err != nil {
		t.Fatalf("провайдеры: %v", err)
	}
	if len(providers) != 1 || !providers[0].HasKey || providers[0].KeyRequired {
		t.Fatalf("провайдер без ключа: %+v", providers)
	}
	raw, _ := json.Marshal(providers)
	if strings.Contains(string(raw), "good-key") {
		t.Fatal("ключ утёк в список провайдеров")
	}

	// Модели по своему ключу.
	models, err := e.svc.Models(ctx, e.user, "groq")
	if err != nil {
		t.Fatalf("модели: %v", err)
	}
	if len(models) != 1 || !models[0].Free || !models[0].Tools {
		t.Fatalf("модели: %+v", models)
	}

	// Удалили ключ — провайдер снова «нужен ключ».
	if err := e.svc.DeleteKey(ctx, e.user, "groq"); err != nil {
		t.Fatalf("удаление ключа: %v", err)
	}
	if _, err := e.svc.Models(ctx, e.user, "groq"); !errors.Is(err, ai.ErrNoKey) {
		t.Fatalf("без ключа ожидалась ошибка ErrNoKey, получено: %v", err)
	}
}

func TestSetKeyRejectsBadKey(t *testing.T) {
	e := aiEnv(t)
	ctx := context.Background()

	err := e.svc.SetKey(ctx, e.user, "groq", "bad-key")
	if err == nil || !strings.Contains(err.Error(), "отверг") {
		t.Fatalf("ожидался отказ «ключ отвергнут», получено: %v", err)
	}
	// Ничего не сохранили: «подключено» не должно означать «не работает».
	if _, err := e.store.AIKeyCiphertext(ctx, e.user, "groq"); !errors.Is(err, store.ErrNotFound) {
		t.Fatalf("неверный ключ всё-таки сохранился: %v", err)
	}
}

func TestSetKeyValidation(t *testing.T) {
	e := aiEnv(t)
	ctx := context.Background()

	if err := e.svc.SetKey(ctx, e.user, "unknown", "k"); err == nil {
		t.Error("неизвестный провайдер принят")
	}
	if err := e.svc.SetKey(ctx, e.user, "groq", "   "); err == nil {
		t.Error("пустой ключ принят")
	}
	// Локальной модели ключ не нужен — и говорить об этом надо, а не сохранять мусор.
	e.svc.UseProviders([]ai.Provider{{ID: "ollama", Title: "Ollama", Kind: ai.KindOllama, BaseURL: "http://127.0.0.1:1"}})
	if err := e.svc.SetKey(ctx, e.user, "ollama", "k"); err == nil {
		t.Error("локальному провайдеру приняли ключ")
	}
}

// Без AI_SECRET_KEY функция своих ключей выключена целиком: хранить ключи в открытом
// виде нельзя, а «временный ключ на диске» — то же самое, только незаметно.
func TestKeysDisabledWithoutCipher(t *testing.T) {
	e := aiEnv(t)
	logger := slog.New(slog.NewTextHandler(io.Discard, nil))
	svc := ai.New(e.store, ai.Config{Enabled: true}, nil, logger)
	svc.UseProviders([]ai.Provider{e.provider()})

	if svc.KeysReady() {
		t.Fatal("сервис считает ключи доступными без ключа шифрования")
	}
	if err := svc.SetKey(context.Background(), e.user, "groq", "k"); !errors.Is(err, ai.ErrNoCipher) {
		t.Fatalf("ожидалась ошибка ErrNoCipher, получено: %v", err)
	}
}

// Ключ стенда работает без ключа пользователя; интерфейс видит, что ключ общий.
func TestStandKeyUsedWhenUserHasNone(t *testing.T) {
	e := aiEnv(t)
	ctx := context.Background()

	stand := ai.New(e.store, ai.Config{Enabled: true, SecretKey: testSecret()},
		map[string]string{"GROQ_API_KEY": "good-key"}, slog.New(slog.NewTextHandler(io.Discard, nil)))
	stand.UseProviders([]ai.Provider{e.provider()})

	providers, err := stand.Providers(ctx, e.user)
	if err != nil {
		t.Fatalf("провайдеры: %v", err)
	}
	if !providers[0].HasKey || !providers[0].StandKey || providers[0].KeyRequired {
		t.Fatalf("ключ стенда не учтён: %+v", providers[0])
	}
	if _, err := stand.Models(ctx, e.user, "groq"); err != nil {
		t.Fatalf("модели по ключу стенда: %v", err)
	}
}

// ---------- HTTP ----------

func aiRouter(svc *ai.Service) http.Handler {
	authSvc := auth.New(nil, aiRoutesSecret)
	h := ai.NewHandler(svc, slog.New(slog.NewTextHandler(io.Discard, nil)))
	r := chi.NewRouter()
	r.Route("/api/ai", func(r chi.Router) {
		r.Use(authSvc.WithUser)
		h.Routes(r)
	})
	return r
}

func doAI(t *testing.T, h http.Handler, method, path string, user uuid.UUID, body string) *httptest.ResponseRecorder {
	t.Helper()
	token, err := auth.IssueAccess(aiRoutesSecret, user)
	if err != nil {
		t.Fatalf("токен: %v", err)
	}
	var reader io.Reader
	if body != "" {
		reader = strings.NewReader(body)
	}
	req := httptest.NewRequest(method, path, reader)
	req.Header.Set("Authorization", "Bearer "+token)
	if body != "" {
		req.Header.Set("Content-Type", "application/json")
	}
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	return rec
}

func TestAIHTTPContract(t *testing.T) {
	e := aiEnv(t)
	h := aiRouter(e.svc)

	// config: провайдеры и флаги.
	rec := doAI(t, h, http.MethodGet, "/api/ai/config", e.user, "")
	if rec.Code != http.StatusOK {
		t.Fatalf("config: код %d, тело %s", rec.Code, rec.Body.String())
	}
	var cfg struct {
		Enabled   bool `json:"enabled"`
		KeysReady bool `json:"keys_ready"`
		Providers []struct {
			ID        string `json:"id"`
			HasKey    bool   `json:"has_key"`
			KeyNeeded bool   `json:"key_required"`
		} `json:"providers"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &cfg); err != nil {
		t.Fatalf("config json: %v", err)
	}
	if !cfg.Enabled || !cfg.KeysReady {
		t.Errorf("config: %+v", cfg)
	}
	if len(cfg.Providers) != 1 || cfg.Providers[0].ID != "groq" || !cfg.Providers[0].KeyNeeded {
		t.Errorf("провайдеры: %+v", cfg.Providers)
	}

	// неверный ключ — понятная ошибка, ключ не сохраняется.
	rec = doAI(t, h, http.MethodPost, "/api/ai/keys", e.user, `{"provider":"groq","key":"bad-key"}`)
	if rec.Code != http.StatusBadRequest || !strings.Contains(rec.Body.String(), "отверг") {
		t.Fatalf("неверный ключ: код %d, тело %s", rec.Code, rec.Body.String())
	}

	// верный ключ сохраняется, и в ответе его нет.
	rec = doAI(t, h, http.MethodPost, "/api/ai/keys", e.user, `{"provider":"groq","key":"good-key"}`)
	if rec.Code != http.StatusOK {
		t.Fatalf("сохранение ключа: код %d, тело %s", rec.Code, rec.Body.String())
	}
	if strings.Contains(rec.Body.String(), "good-key") {
		t.Error("ключ вернулся в ответе")
	}

	// модели по провайдеру.
	rec = doAI(t, h, http.MethodGet, "/api/ai/models?provider=groq", e.user, "")
	if rec.Code != http.StatusOK || !strings.Contains(rec.Body.String(), "llama-3.3-70b") {
		t.Fatalf("модели: код %d, тело %s", rec.Code, rec.Body.String())
	}
	// без указания провайдера — 400, а не «показать всё».
	if rec := doAI(t, h, http.MethodGet, "/api/ai/models", e.user, ""); rec.Code != http.StatusBadRequest {
		t.Errorf("модели без провайдера: код %d", rec.Code)
	}

	// удаление ключа.
	if rec := doAI(t, h, http.MethodDelete, "/api/ai/keys/groq", e.user, ""); rec.Code != http.StatusNoContent {
		t.Fatalf("удаление ключа: код %d, тело %s", rec.Code, rec.Body.String())
	}
	if rec := doAI(t, h, http.MethodGet, "/api/ai/models?provider=groq", e.user, ""); rec.Code != http.StatusPreconditionRequired {
		t.Errorf("модели без ключа: код %d, тело %s", rec.Code, rec.Body.String())
	}
}

// Выключенный помощник не должен выглядеть работающим: config говорит «выключен»,
// остальное честно отказывает.
func TestAIDisabled(t *testing.T) {
	e := aiEnv(t)
	svc := ai.New(e.store, ai.Config{Enabled: false}, nil, slog.New(slog.NewTextHandler(io.Discard, nil)))
	h := aiRouter(svc)

	rec := doAI(t, h, http.MethodGet, "/api/ai/config", e.user, "")
	if rec.Code != http.StatusOK || !strings.Contains(rec.Body.String(), `"enabled":false`) {
		t.Fatalf("config выключенного помощника: код %d, тело %s", rec.Code, rec.Body.String())
	}
	if rec := doAI(t, h, http.MethodGet, "/api/ai/models?provider=groq", e.user, ""); rec.Code != http.StatusBadRequest {
		t.Errorf("модели при выключенном помощнике: код %d", rec.Code)
	}
}
