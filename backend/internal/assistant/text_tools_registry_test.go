package assistant

// text_tools_registry_test.go — страж текстового протокола (0.151.1).
//
// Файл внутренний (`package assistant`), потому что проверяет не поведение наружу, а
// согласованность двух списков, которые обязаны совпадать: `ToolDefs` (что предложено
// модели) и `knownToolNames` (что считается вызовом в текстовом протоколе).
//
// История ошибки. В 0.142.5 из-за расхождения этих списков помощник «не применял» правку
// главы: вызов `update_event_text` считался обычным JSON и оставался текстом. В 0.149.0
// добавили знания — и повторили ровно ту же ошибку: `save_knowledge` в списке не было.
// Живой прогон 0.151.0 на стенде показал сырой ```json в ответе и «сохранено» без знания.
// Поэтому теперь расхождение ловится тестом, а не человеком.

import (
	"strings"
	"testing"
)

// Каждый инструмент, который предлагается модели, обязан узнаваться текстовым протоколом.
func TestKnownToolNamesCoversToolDefs(t *testing.T) {
	defs := ToolDefs(
		Capabilities{Text: true, Images: true},
		true, true, true,
		[]string{"character"}, map[string]string{"character": "персонаж"},
	)
	if len(defs) == 0 {
		t.Fatal("ToolDefs пуст — проверять нечего")
	}
	for _, def := range defs {
		if !knownToolNames[def.Name] {
			t.Errorf("инструмент %q предлагается модели, но не считается вызовом в текстовом протоколе", def.Name)
		}
	}
}

// Живая форма от Qwen 9B (0.151.0): fenced `json` с МАССИВОМ вызовов и `arguments` объектом.
func TestParseTextToolCallsKnowsSaveKnowledge(t *testing.T) {
	content := "```json\n" +
		`[{"name": "save_knowledge", "arguments": {"entries": [{"title": "Канон", "body": "Драконы спят"}]}}]` +
		"\n```\n\nЗнание сохранено."
	cleaned, calls := ParseTextToolCalls(content)
	if len(calls) != 1 || calls[0].Name != ToolSaveKnowledge {
		t.Fatalf("вызов не распознан: %+v", calls)
	}
	if cleaned != "Знание сохранено." {
		t.Fatalf("служебный JSON остался в ответе: %q", cleaned)
	}
	if _, ok := calls[0].Arguments["entries"]; !ok {
		t.Fatalf("аргументы потерялись: %+v", calls[0].Arguments)
	}
}

// Объект-обёртка вместо массива (`{"name": …}` в корне ограды) — тоже вызов.
func TestParseTextToolCallsAcceptsSingleObjectWithArguments(t *testing.T) {
	content := "```\n" +
		`{"name": "list_knowledge", "arguments": {}}` +
		"\n```"
	cleaned, calls := ParseTextToolCalls(content)
	if len(calls) != 1 || calls[0].Name != ToolListKnowledge {
		t.Fatalf("одиночный вызов не распознан: %+v", calls)
	}
	if strings.TrimSpace(cleaned) != "" {
		t.Fatalf("после вызова остался текст: %q", cleaned)
	}
}
