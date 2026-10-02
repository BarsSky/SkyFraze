package ai_test

// stream_test.go — потоковый ответ провайдера.
//
// Проверяем ровно то, что нельзя увидеть в обычном Chat: куски текста приходят по мере
// генерации и в правильном порядке, вызовы инструментов собираются из ЧАСТЕЙ (у
// OpenAI-совместимых серверов имя и аргументы приезжают разными событиями), а сбой
// посреди потока не превращается в тихий короткий ответ.

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/skyfraze/backend/internal/ai"
)

func TestOpenAIChatStreamAssemblesDeltasAndToolCalls(t *testing.T) {
	s := newStub(t, func(w http.ResponseWriter, r *http.Request, st *stub) {
		if stream, _ := st.lastBody["stream"].(bool); !stream {
			t.Errorf("потоковый запрос должен уходить со stream=true, тело: %v", st.lastBody)
		}
		if got := r.Header.Get("Accept"); !strings.Contains(got, "text/event-stream") {
			t.Errorf("Accept: %q", got)
		}
		w.Header().Set("Content-Type", "text/event-stream")
		// Текст — тремя событиями; вызов инструмента — двумя (имя, потом аргументы),
		// как это делают настоящие OpenAI-совместимые серверы.
		events := []string{
			`{"model":"m1","choices":[{"delta":{"content":"Гла"}}]}`,
			`{"choices":[{"delta":{"content":"ва "}}]}`,
			`{"choices":[{"delta":{"content":"готова."}}]}`,
			`{"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call-1","type":"function","function":{"name":"create_chapter"}}]}}]}`,
			`{"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{\"title\""}}]}}]}`,
			`{"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":":\"Пролог\"}"}}]}}]}`,
			`{"choices":[],"usage":{"prompt_tokens":21,"completion_tokens":9}}`,
		}
		for _, event := range events {
			fmt.Fprintf(w, "data: %s\n\n", event)
		}
		fmt.Fprint(w, ": ping\n\n") // комментарий-«пинг» не должен ломать разбор
		fmt.Fprint(w, "data: [DONE]\n\n")
	})

	client, _ := ai.NewClient(s.provider(ai.KindOpenAI, "groq"), "k", 5*time.Second)
	var pieces []string
	reply, err := client.(ai.Streamer).ChatStream(context.Background(), ai.Request{Model: "m1"},
		func(text string) error {
			pieces = append(pieces, text)
			return nil
		})
	if err != nil {
		t.Fatalf("поток: %v", err)
	}
	if got := strings.Join(pieces, ""); got != "Глава готова." {
		t.Errorf("куски текста: %q", got)
	}
	if len(pieces) != 3 {
		t.Errorf("ожидалось 3 куска, пришло %d: %v", len(pieces), pieces)
	}
	if reply.Content != "Глава готова." {
		t.Errorf("собранный ответ: %q", reply.Content)
	}
	if reply.Model != "m1" {
		t.Errorf("модель: %q", reply.Model)
	}
	if reply.TokensIn != 21 || reply.TokensOut != 9 {
		t.Errorf("счётчики: %d/%d", reply.TokensIn, reply.TokensOut)
	}
	if len(reply.ToolCalls) != 1 {
		t.Fatalf("вызовы инструментов: %+v", reply.ToolCalls)
	}
	call := reply.ToolCalls[0]
	if call.Name != "create_chapter" || call.ID != "call-1" {
		t.Errorf("вызов: %+v", call)
	}
	if got, _ := call.Arguments["title"].(string); got != "Пролог" {
		t.Errorf("аргументы вызова: %+v", call.Arguments)
	}
}

func TestOllamaChatStreamReadsLinesAndCounts(t *testing.T) {
	s := newStub(t, func(w http.ResponseWriter, r *http.Request, st *stub) {
		if stream, _ := st.lastBody["stream"].(bool); !stream {
			t.Errorf("потоковый запрос должен уходить со stream=true, тело: %v", st.lastBody)
		}
		w.Header().Set("Content-Type", "application/x-ndjson")
		lines := []map[string]any{
			{"model": "local-1", "message": map[string]any{"role": "assistant", "content": "Так "}, "done": false},
			{"model": "local-1", "message": map[string]any{"role": "assistant", "content": "начинается"}, "done": false},
			{"model": "local-1", "message": map[string]any{"role": "assistant", "content": " история."}, "done": false},
			{"model": "local-1", "message": map[string]any{"role": "assistant", "content": ""}, "done": true,
				"prompt_eval_count": 31, "eval_count": 12},
		}
		for _, line := range lines {
			raw, _ := json.Marshal(line)
			fmt.Fprintf(w, "%s\n", raw)
		}
	})

	client, _ := ai.NewClient(s.provider(ai.KindOllama, "ollama"), "", 5*time.Second)
	var pieces []string
	reply, err := client.(ai.Streamer).ChatStream(context.Background(), ai.Request{Model: "local-1"},
		func(text string) error {
			pieces = append(pieces, text)
			return nil
		})
	if err != nil {
		t.Fatalf("поток: %v", err)
	}
	if got := strings.Join(pieces, ""); got != "Так начинается история." {
		t.Errorf("куски текста: %q", got)
	}
	if reply.Content != "Так начинается история." {
		t.Errorf("собранный ответ: %q", reply.Content)
	}
	if reply.TokensIn != 31 || reply.TokensOut != 12 {
		t.Errorf("счётчики из последней строки: %d/%d", reply.TokensIn, reply.TokensOut)
	}
}

func TestOllamaChatStreamCollectsToolCalls(t *testing.T) {
	s := newStub(t, func(w http.ResponseWriter, r *http.Request, _ *stub) {
		lines := []map[string]any{
			{"model": "local-1", "message": map[string]any{"role": "assistant", "content": "",
				"tool_calls": []map[string]any{{"function": map[string]any{
					"name": "create_chapter", "arguments": map[string]any{"title": "Пролог"},
				}}}}, "done": true, "prompt_eval_count": 5, "eval_count": 3},
		}
		for _, line := range lines {
			raw, _ := json.Marshal(line)
			fmt.Fprintf(w, "%s\n", raw)
		}
	})

	client, _ := ai.NewClient(s.provider(ai.KindOllama, "ollama"), "", 5*time.Second)
	reply, err := client.(ai.Streamer).ChatStream(context.Background(), ai.Request{Model: "local-1"}, nil)
	if err != nil {
		t.Fatalf("поток: %v", err)
	}
	if len(reply.ToolCalls) != 1 || reply.ToolCalls[0].Name != "create_chapter" {
		t.Fatalf("вызовы инструментов: %+v", reply.ToolCalls)
	}
	if got, _ := reply.ToolCalls[0].Arguments["title"].(string); got != "Пролог" {
		t.Errorf("аргументы вызова: %+v", reply.ToolCalls[0].Arguments)
	}
}

// Сбой посреди потока — ошибка, а не «короткий ответ»: иначе человек видел бы
// оборванную фразу и не знал бы, что она оборвана.
func TestChatStreamReportsMidStreamFailure(t *testing.T) {
	s := newStub(t, func(w http.ResponseWriter, r *http.Request, _ *stub) {
		w.Header().Set("Content-Type", "application/x-ndjson")
		fmt.Fprint(w, `{"model":"local-1","message":{"role":"assistant","content":"Начал"},"done":false}`+"\n")
		fmt.Fprint(w, `{"error":"model runner has unexpectedly stopped"}`+"\n")
	})

	client, _ := ai.NewClient(s.provider(ai.KindOllama, "ollama"), "", 5*time.Second)
	var got strings.Builder
	_, err := client.(ai.Streamer).ChatStream(context.Background(), ai.Request{Model: "local-1"},
		func(text string) error {
			got.WriteString(text)
			return nil
		})
	if err == nil {
		t.Fatal("обрыв посреди потока должен быть ошибкой")
	}
	if !strings.Contains(err.Error(), "model runner") {
		t.Errorf("текст ошибки: %v", err)
	}
	if got.String() != "Начал" {
		t.Errorf("куски до сбоя должны были прийти: %q", got.String())
	}
}

// Ошибка из onText прекращает генерацию и не превращается в ошибку провайдера: так
// работает «стоп» — человеку больше некуда писать.
func TestChatStreamStopsOnCallbackError(t *testing.T) {
	stop := fmt.Errorf("клиент ушёл")
	s := newStub(t, func(w http.ResponseWriter, r *http.Request, _ *stub) {
		w.Header().Set("Content-Type", "application/x-ndjson")
		flusher, _ := w.(http.Flusher)
		for i := 0; i < 5; i++ {
			fmt.Fprintf(w, `{"model":"local-1","message":{"role":"assistant","content":"кусок"},"done":false}`+"\n")
			if flusher != nil {
				flusher.Flush()
			}
		}
		fmt.Fprint(w, `{"model":"local-1","message":{"role":"assistant","content":""},"done":true}`+"\n")
	})

	client, _ := ai.NewClient(s.provider(ai.KindOllama, "ollama"), "", 5*time.Second)
	calls := 0
	_, err := client.(ai.Streamer).ChatStream(context.Background(), ai.Request{Model: "local-1"},
		func(string) error {
			calls++
			return stop
		})
	if err == nil {
		t.Fatal("ошибка из onText должна остановить поток")
	}
	if calls != 1 {
		t.Errorf("после ошибки чтение должно прекратиться, кусков обработано: %d", calls)
	}
}

// Отмена контекста — это «стоп», а не сбой: вызывающий должен уметь отличить одно от
// другого (иначе остановка ответа выглядела бы как ошибка провайдера).
func TestChatStreamCancelKeepsContextError(t *testing.T) {
	release := make(chan struct{})
	s := newStub(t, func(w http.ResponseWriter, r *http.Request, _ *stub) {
		w.Header().Set("Content-Type", "application/x-ndjson")
		flusher, _ := w.(http.Flusher)
		fmt.Fprint(w, `{"model":"local-1","message":{"role":"assistant","content":"Начал"},"done":false}`+"\n")
		if flusher != nil {
			flusher.Flush()
		}
		<-release
	})

	client, _ := ai.NewClient(s.provider(ai.KindOllama, "ollama"), "", 30*time.Second)
	ctx, cancel := context.WithCancel(context.Background())
	defer func() {
		close(release)
		s.server.Close()
	}()
	_, err := client.(ai.Streamer).ChatStream(ctx, ai.Request{Model: "local-1"}, func(string) error {
		cancel() // человек нажал «стоп» после первого куска
		return nil
	})
	if err == nil {
		t.Fatal("отмена должна вернуть ошибку")
	}
	if !strings.Contains(err.Error(), "context canceled") {
		t.Errorf("ожидалась отмена контекста, получено: %v", err)
	}
}
