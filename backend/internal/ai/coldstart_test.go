package ai_test

// coldstart_test.go — холодный старт и молчание сервера моделей (0.145.0).
//
// Зачем эти тесты. На стенде модель выгружается из памяти, когда её никто не спрашивает, и
// первый запрос после простоя поднимает её минутами. Общий предел на запрос (AI_TIMEOUT)
// такое ожидание рвал, и помощник «не отвечал» — при том что сервер работал нормально.
// Теперь у потока три разных предела: обычный запрос, ожидание первых байт (загрузка) и
// тишина уже в ответе. Здесь проверяется каждый.

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"sync/atomic"
	"testing"
	"time"

	"github.com/google/uuid"

	"github.com/skyfraze/backend/internal/ai"
)

// localProvider — свой сервер моделей: для него разрешён повтор при «модель загружается».
func localProvider(url string) ai.Provider {
	return ai.Provider{
		ID: "custom", Title: "Свой сервер", Kind: ai.KindOpenAI,
		BaseURL: url, Keyless: true, Local: true,
	}
}

// TestStreamSurvivesColdStart — сервер молчит дольше обычного предела, но укладывается в
// ожидание загрузки: ответ должен дойти.
func TestStreamSurvivesColdStart(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		// Модель поднимается: заголовки и тело придут только через 300 мс, а обычный
		// предел запроса в этом тесте — 100 мс.
		time.Sleep(300 * time.Millisecond)
		w.Header().Set("Content-Type", "text/event-stream")
		fmt.Fprint(w, `data: {"choices":[{"delta":{"content":"Готово."}}]}`+"\n\n")
		fmt.Fprint(w, "data: [DONE]\n\n")
	}))
	defer server.Close()

	client, err := ai.NewClientWithTimeouts(localProvider(server.URL), "", ai.Timeouts{
		Request: 100 * time.Millisecond, LoadWait: 5 * time.Second, Idle: 2 * time.Second,
	})
	if err != nil {
		t.Fatal(err)
	}
	reply, err := client.(ai.Streamer).ChatStream(context.Background(), ai.Request{Model: "m"}, nil)
	if err != nil {
		t.Fatalf("холодный старт не пережили: %v", err)
	}
	if reply.Content != "Готово." {
		t.Fatalf("ответ: %q", reply.Content)
	}
	if reply.FirstByteMS < 200 {
		t.Fatalf("ожидание первых байт не измерено: %d мс", reply.FirstByteMS)
	}
}

// TestStreamColdStartTimeoutIsLoadingError — сервер не начал отвечать за отведённое время.
// Это не «провайдер недоступен»: человеку надо сказать «модель загружается».
func TestStreamColdStartTimeoutIsLoadingError(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		time.Sleep(2 * time.Second)
		fmt.Fprint(w, "data: [DONE]\n\n")
	}))
	defer server.Close()

	client, _ := ai.NewClientWithTimeouts(localProvider(server.URL), "", ai.Timeouts{
		Request: 5 * time.Second, LoadWait: 150 * time.Millisecond, Idle: 5 * time.Second,
	})
	_, err := client.(ai.Streamer).ChatStream(context.Background(), ai.Request{Model: "m"}, nil)
	if !errors.Is(err, ai.ErrModelLoading) {
		t.Fatalf("ожидалась ошибка «модель загружается», получено: %v", err)
	}
}

// TestStreamStallAfterStart — сервер начал отвечать и замолчал: это обрыв, а не «стоп».
func TestStreamStallAfterStart(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/event-stream")
		w.WriteHeader(http.StatusOK)
		if f, ok := w.(http.Flusher); ok {
			f.Flush()
		}
		fmt.Fprint(w, `data: {"choices":[{"delta":{"content":"Начал"}}]}`+"\n\n")
		if f, ok := w.(http.Flusher); ok {
			f.Flush()
		}
		time.Sleep(2 * time.Second) // и тишина
	}))
	defer server.Close()

	client, _ := ai.NewClientWithTimeouts(localProvider(server.URL), "", ai.Timeouts{
		Request: 5 * time.Second, LoadWait: 2 * time.Second, Idle: 150 * time.Millisecond,
	})
	_, err := client.(ai.Streamer).ChatStream(context.Background(), ai.Request{Model: "m"}, nil)
	if err == nil {
		t.Fatal("молчание сервера должно быть ошибкой, а не «концом ответа»")
	}
	if !errors.Is(err, ai.ErrUnavailable) {
		t.Fatalf("ошибка: %v", err)
	}
}

// TestLoadingStatusIsModelLoading — 503 «model is loading» это ожидание, а не поломка.
func TestLoadingStatusIsModelLoading(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusServiceUnavailable)
		fmt.Fprint(w, `{"error":"model is loading, retry in 30s"}`)
	}))
	defer server.Close()

	client, _ := ai.NewClient(localProvider(server.URL), "", 5*time.Second)
	_, err := client.Chat(context.Background(), ai.Request{Model: "m"})
	if !errors.Is(err, ai.ErrModelLoading) {
		t.Fatalf("ожидалась ErrModelLoading, получено: %v", err)
	}
}

// TestServiceRetriesLoadingModel — сервис сам ждёт и повторяет, пока модель поднимается.
func TestServiceRetriesLoadingModel(t *testing.T) {
	var attempts int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if atomic.AddInt32(&attempts, 1) == 1 {
			w.WriteHeader(http.StatusServiceUnavailable)
			fmt.Fprint(w, `{"error":"model is loading"}`)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		fmt.Fprint(w, `{"model":"m","message":{"role":"assistant","content":"Дождались."},"eval_count":3}`)
	}))
	defer server.Close()

	service := ai.New(nil, ai.Config{
		Enabled: true, OllamaURL: server.URL, TimeoutSeconds: 5,
		LoadWaitSeconds: 30, StreamIdleSeconds: 5,
	}, nil, testLogger(t))
	service.UseProviders([]ai.Provider{{
		ID: "ollama", Title: "Локальная модель", Kind: ai.KindOllama,
		BaseURL: server.URL, Local: true,
	}})

	reply, err := service.Chat(context.Background(), uuid.Nil, "ollama", ai.Request{Model: "m"})
	if err != nil {
		t.Fatalf("повтор при загрузке не сработал: %v", err)
	}
	if reply.Content != "Дождались." {
		t.Fatalf("ответ: %q", reply.Content)
	}
	if got := atomic.LoadInt32(&attempts); got != 2 {
		t.Fatalf("попыток %d, ожидалось 2", got)
	}
}

// TestCloudProviderIsNotRetried — у облачного провайдера 503 значит «перегрузка»: повторять
// наугад нельзя.
func TestCloudProviderIsNotRetried(t *testing.T) {
	var attempts int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		atomic.AddInt32(&attempts, 1)
		w.WriteHeader(http.StatusServiceUnavailable)
		fmt.Fprint(w, `{"error":"model is loading"}`)
	}))
	defer server.Close()

	service := ai.New(nil, ai.Config{
		Enabled: true, TimeoutSeconds: 5, LoadWaitSeconds: 30, StreamIdleSeconds: 5,
	}, map[string]string{"GROQ_KEY": "k"}, testLogger(t))
	service.UseProviders([]ai.Provider{{
		ID: "groq", Title: "Groq", Kind: ai.KindOpenAI,
		BaseURL: server.URL, KeyEnv: "GROQ_KEY",
	}})

	_, err := service.Chat(context.Background(), uuid.Nil, "groq", ai.Request{Model: "m"})
	if !errors.Is(err, ai.ErrModelLoading) {
		t.Fatalf("ошибка: %v", err)
	}
	if got := atomic.LoadInt32(&attempts); got != 1 {
		t.Fatalf("облачный провайдер опрошен %d раз, ожидалась 1", got)
	}
}
