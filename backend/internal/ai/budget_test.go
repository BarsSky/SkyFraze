package ai_test

// budget_test.go — предел ответа и «модель потратила его на рассуждения» (0.141.0).
//
// Почему это отдельные тесты. На стенде помощник «не мог ответить» на правку главы: клиент
// не присылал лимит ответа, «думающая» модель (gemma) тратила серверное умолчание на
// reasoning_content, и видимого текста не оставалось. Снаружи это «модель молчит» — без
// причины. Здесь проверяется и то, что лимит теперь уходит, и то, что пустой ответ с
// размышлениями превращается в понятную ошибку, а не в «Готово.» в истории.

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/skyfraze/backend/internal/ai"
)

// TestOpenAISendsMaxTokens — предел ответа уходит в теле запроса.
func TestOpenAISendsMaxTokens(t *testing.T) {
	s := newStub(t, func(w http.ResponseWriter, r *http.Request, st *stub) {
		if got, _ := st.lastBody["max_tokens"].(float64); got != 1024 {
			t.Errorf("max_tokens в теле: %v (тело: %v)", st.lastBody["max_tokens"], st.lastBody)
		}
		_, _ = w.Write([]byte(`{"model":"m1","choices":[{"message":{"role":"assistant","content":"Готово."},"finish_reason":"stop"}]}`))
	})
	client, err := ai.NewClient(s.provider(ai.KindOpenAI, "custom"), "k", 5*time.Second)
	if err != nil {
		t.Fatalf("клиент: %v", err)
	}
	if _, err := client.Chat(context.Background(), ai.Request{Model: "m1", MaxTokens: 1024}); err != nil {
		t.Fatalf("ответ: %v", err)
	}
}

// TestOpenAISkipsMaxTokensWhenUnset — без предела поле не отправляем: чужие серверы на
// незнакомое поле иногда отвечают ошибкой.
func TestOpenAISkipsMaxTokensWhenUnset(t *testing.T) {
	s := newStub(t, func(w http.ResponseWriter, r *http.Request, st *stub) {
		if _, ok := st.lastBody["max_tokens"]; ok {
			t.Errorf("max_tokens без лимита: %v", st.lastBody)
		}
		_, _ = w.Write([]byte(`{"choices":[{"message":{"content":"ok"},"finish_reason":"stop"}]}`))
	})
	client, _ := ai.NewClient(s.provider(ai.KindOpenAI, "custom"), "k", 5*time.Second)
	if _, err := client.Chat(context.Background(), ai.Request{Model: "m1"}); err != nil {
		t.Fatalf("ответ: %v", err)
	}
}

// warningText — то, что подставляет балансер вместо пустого ответа (см. живой стенд).
const warningText = "⚠️ Модель сгенерировала только размышления (501 симв.), видимого ответа нет " +
	"(finish_reason=length). Бюджет ответа израсходован на размышления: увеличьте max_tokens"

// TestOpenAIWarningBecomesActionableError — предупреждение сервера не должно становиться
// «ответом модели»: это ошибка с подсказкой, что увеличить.
func TestOpenAIWarningBecomesActionableError(t *testing.T) {
	s := newStub(t, func(w http.ResponseWriter, r *http.Request, _ *stub) {
		_, _ = fmt.Fprintf(w, `{"choices":[{"message":{"content":%q},"finish_reason":"length"}]}`, warningText)
	})
	client, _ := ai.NewClient(s.provider(ai.KindOpenAI, "custom"), "k", 5*time.Second)
	_, err := client.Chat(context.Background(), ai.Request{Model: "gemma", MaxTokens: 512})
	if !errors.Is(err, ai.ErrUnavailable) {
		t.Fatalf("ожидалась ошибка провайдера, получено: %v", err)
	}
	if !strings.Contains(err.Error(), "AI_MAX_OUTPUT_TOKENS") {
		t.Fatalf("в ошибке нет подсказки: %v", err)
	}
}

// TestOpenAITruncatedReplyBecomesError — finish_reason=length без текста и без инструмента:
// это тоже «бюджет кончился», а не пустой ответ.
func TestOpenAITruncatedReplyBecomesError(t *testing.T) {
	s := newStub(t, func(w http.ResponseWriter, r *http.Request, _ *stub) {
		_, _ = w.Write([]byte(`{"choices":[{"message":{"content":""},"finish_reason":"length"}]}`))
	})
	client, _ := ai.NewClient(s.provider(ai.KindOpenAI, "custom"), "k", 5*time.Second)
	_, err := client.Chat(context.Background(), ai.Request{Model: "gemma", MaxTokens: 256})
	if err == nil {
		t.Fatal("пустой ответ по лимиту принят за успех")
	}
	if !strings.Contains(err.Error(), "256") {
		t.Fatalf("в ошибке нет лимита: %v", err)
	}
}

// TestOpenAIStreamReasoningIsCountedAndNotShown — рассуждения не попадают в текст ответа,
// но их длина видна: по ней и понятно, куда ушёл бюджет.
func TestOpenAIStreamReasoningIsCountedAndNotShown(t *testing.T) {
	s := newStub(t, func(w http.ResponseWriter, r *http.Request, st *stub) {
		if got, _ := st.lastBody["max_tokens"].(float64); got != 700 {
			t.Errorf("max_tokens в потоке: %v", st.lastBody["max_tokens"])
		}
		w.Header().Set("Content-Type", "text/event-stream")
		fmt.Fprint(w, `data: {"choices":[{"delta":{"reasoning_content":"думаю про маяк"}}]}`+"\n\n")
		fmt.Fprint(w, `data: {"choices":[{"delta":{"content":"Готово."}}]}`+"\n\n")
		fmt.Fprint(w, `data: {"choices":[{"delta":{},"finish_reason":"stop"}]}`+"\n\n")
		fmt.Fprint(w, "data: [DONE]\n\n")
	})
	client, _ := ai.NewClient(s.provider(ai.KindOpenAI, "custom"), "k", 5*time.Second)
	var shown strings.Builder
	reply, err := client.(ai.Streamer).ChatStream(context.Background(),
		ai.Request{Model: "gemma", MaxTokens: 700}, func(text string) error {
			shown.WriteString(text)
			return nil
		})
	if err != nil {
		t.Fatalf("поток: %v", err)
	}
	if shown.String() != "Готово." {
		t.Fatalf("человеку показали %q", shown.String())
	}
	if reply.ReasoningLen != len([]rune("думаю про маяк")) {
		t.Fatalf("длина рассуждений: %d", reply.ReasoningLen)
	}
	if reply.FinishReason != "stop" {
		t.Fatalf("finish_reason: %q", reply.FinishReason)
	}
}

// TestOpenAIStreamWarningBecomesError — предупреждение балансера и в потоке не «ответ».
func TestOpenAIStreamWarningBecomesError(t *testing.T) {
	s := newStub(t, func(w http.ResponseWriter, r *http.Request, _ *stub) {
		w.Header().Set("Content-Type", "text/event-stream")
		fmt.Fprintf(w, "data: {\"choices\":[{\"delta\":{\"content\":%q}}]}\n\n", warningText)
		fmt.Fprint(w, `data: {"choices":[{"delta":{},"finish_reason":"length"}]}`+"\n\n")
		fmt.Fprint(w, "data: [DONE]\n\n")
	})
	client, _ := ai.NewClient(s.provider(ai.KindOpenAI, "custom"), "k", 5*time.Second)
	_, err := client.(ai.Streamer).ChatStream(context.Background(),
		ai.Request{Model: "gemma", MaxTokens: 128}, nil)
	if !errors.Is(err, ai.ErrUnavailable) {
		t.Fatalf("ожидалась ошибка провайдера, получено: %v", err)
	}
}

// TestOllamaSendsNumPredict — у Ollama тот же предел, только полем options.num_predict.
func TestOllamaSendsNumPredict(t *testing.T) {
	s := newStub(t, func(w http.ResponseWriter, r *http.Request, st *stub) {
		options, _ := st.lastBody["options"].(map[string]any)
		if got, _ := options["num_predict"].(float64); got != 900 {
			t.Errorf("options.num_predict: %v (тело: %v)", options, st.lastBody)
		}
		_, _ = w.Write([]byte(`{"model":"local","message":{"role":"assistant","content":"ok"},"done_reason":"stop"}`))
	})
	client, _ := ai.NewClient(s.provider(ai.KindOllama, "ollama"), "", 5*time.Second)
	if _, err := client.Chat(context.Background(), ai.Request{Model: "local", MaxTokens: 900}); err != nil {
		t.Fatalf("ответ: %v", err)
	}
}

// TestOpenAIStreamHidesProviderWarning — предупреждение балансера не показывается в потоке
// (0.142.1).
//
// Оно приходит обычным куском content, ДО того как станет известен finish_reason. Раньше
// человек видел «⚠️ Модель сгенерировала только размышления…» посреди ответа.
func TestOpenAIStreamHidesProviderWarning(t *testing.T) {
	s := newStub(t, func(w http.ResponseWriter, r *http.Request, _ *stub) {
		w.Header().Set("Content-Type", "text/event-stream")
		fmt.Fprintf(w, "data: {\"choices\":[{\"delta\":{\"content\":%q}}]}\n\n", warningText)
		fmt.Fprint(w, `data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"c1","type":"function","function":{"name":"read_event","arguments":"{}"}}]}}]}`+"\n\n")
		fmt.Fprint(w, `data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}]}`+"\n\n")
		fmt.Fprint(w, "data: [DONE]\n\n")
	})
	client, _ := ai.NewClient(s.provider(ai.KindOpenAI, "custom"), "k", 5*time.Second)
	var shown strings.Builder
	reply, err := client.(ai.Streamer).ChatStream(context.Background(),
		ai.Request{Model: "gemma", MaxTokens: 512}, func(text string) error {
			shown.WriteString(text)
			return nil
		})
	if err != nil {
		t.Fatalf("поток: %v", err)
	}
	if strings.Contains(shown.String(), "размышления") {
		t.Fatalf("человеку показали предупреждение сервера: %q", shown.String())
	}
	if reply.Content != "" {
		t.Fatalf("предупреждение осталось в ответе: %q", reply.Content)
	}
	if len(reply.ToolCalls) != 1 || reply.ToolCalls[0].Name != "read_event" {
		t.Fatalf("вызов потерян: %+v", reply.ToolCalls)
	}
}

// TestOpenAIStreamShortAnswerNotLost — придержанное начало показывается, если ответ короче
// подписи предупреждения (иначе «Да.» потерялось бы из-за фильтра).
func TestOpenAIStreamShortAnswerNotLost(t *testing.T) {
	s := newStub(t, func(w http.ResponseWriter, r *http.Request, _ *stub) {
		w.Header().Set("Content-Type", "text/event-stream")
		fmt.Fprint(w, `data: {"choices":[{"delta":{"content":"Да."}}]}`+"\n\n")
		fmt.Fprint(w, `data: {"choices":[{"delta":{},"finish_reason":"stop"}]}`+"\n\n")
		fmt.Fprint(w, "data: [DONE]\n\n")
	})
	client, _ := ai.NewClient(s.provider(ai.KindOpenAI, "custom"), "k", 5*time.Second)
	var shown strings.Builder
	reply, err := client.(ai.Streamer).ChatStream(context.Background(),
		ai.Request{Model: "gemma"}, func(text string) error {
			shown.WriteString(text)
			return nil
		})
	if err != nil {
		t.Fatalf("поток: %v", err)
	}
	if shown.String() != "Да." || reply.Content != "Да." {
		t.Fatalf("поток %q, ответ %q", shown.String(), reply.Content)
	}
}
