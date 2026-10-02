package assistant

// text_tools.go — разбор вызовов инструментов, написанных ТЕКСТОМ.
//
// Зачем это нужно, если есть native tool-calls. Инструменты умеют не все модели и не
// все тарифы: у части бесплатных моделей в списке возможностей нет `tools`, а часть
// отвечает так только на «правильных» провайдерах. Без текстового пути половина
// доступных моделей оказалась бы «не умеет менять проект», хотя на деле умеет —
// просто пишет вызов в ответе.
//
// Формат нарочно один и явный:
//
//	```skyfraze-tools
//	[{"name": "create_chapter", "arguments": {"title": "Пролог", "body_md": "..."}}]
//	```
//
// Разбирается он так же, как native: тот же список инструментов, те же проверки
// аргументов. Разница только в том, откуда взят JSON, поэтому и опасности новой нет:
// выполнять по-прежнему может только тот инструмент, который есть в реестре.
//
// Блок УБИРАЕТСЯ из видимого ответа: человеку показывается текст, а не служебный JSON.

import (
	"encoding/json"
	"fmt"
	"strings"

	"github.com/skyfraze/backend/internal/ai"
)

// textToolsFence — имя языка у блока. Сравнивается без учёта регистра: модели пишут
// и `skyfraze-tools`, и `SkyFraze-Tools`.
const textToolsFence = "skyfraze-tools"

// toolBlock — найденный блок: где он целиком и где его содержимое.
type toolBlock struct {
	start     int // начало ограждения ```
	bodyStart int
	bodyEnd   int
	end       int // сразу за закрывающим ```
}

// ParseTextToolCalls вынимает вызовы из текста ответа и возвращает текст без них.
//
// Два случая, и оба встречаются на живых локальных моделях:
//
//  1. блок ```skyfraze-tools``` — формат, которому мы учим модель в правилах;
//  2. «голый» JSON в ответе — так отвечает, например, gemma4 через Ollama-подобный
//     сервер: `[{"type":"function","function":{"name":"create_chapter",…}}]` текстом.
//     Принимаем его, только если среди вызовов есть ХОТЯ БЫ ОДИН известный инструмент:
//     иначе любой JSON-ответ модели (а это бывает и просто данными) превращался бы в
//     попытку что-то создать.
//
// Ошибку разбора не возвращаем намеренно: сломанный JSON — это не «сбой сервера», а
// ответ модели, и человек должен увидеть её текст, а не пятисотую ошибку. Поэтому
// неразобранный блок просто остаётся в тексте (его видно), а вызовов нет.
func ParseTextToolCalls(content string) (string, []ai.ToolCall) {
	block, ok := findToolBlock(content)
	if !ok {
		return parseLooseToolCalls(content)
	}
	calls := decodeTextCalls(content[block.bodyStart:block.bodyEnd])
	if len(calls) == 0 {
		return content, nil
	}
	cleaned := strings.TrimSpace(content[:block.start] + content[block.end:])
	return cleaned, calls
}

// parseLooseToolCalls разбирает ответ, целиком состоящий из JSON-вызовов.
//
// Хвосты вида `<end_of_turn>` и `<|im_end|>` отрезаем: локальные модели дописывают их
// в текст ответа, и из-за одного такого хвоста JSON перестал бы разбираться.
func parseLooseToolCalls(content string) (string, []ai.ToolCall) {
	trimmed := trimSpecialTokens(strings.TrimSpace(content))
	if !strings.HasPrefix(trimmed, "[") && !strings.HasPrefix(trimmed, "{") {
		return content, nil
	}
	calls := decodeTextCalls(trimmed)
	if !hasKnownTool(calls) {
		return content, nil
	}
	return "", calls
}

// trimSpecialTokens убирает служебные токены локальных моделей по краям ответа.
func trimSpecialTokens(s string) string {
	for _, token := range []string{"<end_of_turn>", "<|im_end|>", "<|eot_id|>", "<|end|>", "</s>"} {
		s = strings.ReplaceAll(s, token, "")
	}
	return strings.TrimSpace(s)
}

// hasKnownTool — есть ли среди вызовов инструмент, который мы действительно умеем
// выполнять. Это и есть защита от «JSON-ответа, который не вызов».
func hasKnownTool(calls []ai.ToolCall) bool {
	for _, call := range calls {
		switch call.Name {
		case ToolListEvents, ToolReadEvent, ToolCreateChapter, ToolCreateSub:
			return true
		}
	}
	return false
}

// findToolBlock ищет блок ```skyfraze-tools … ```.
//
// Ищем по ограждениям, а не по приведённому к нижнему регистру тексту: приведение
// регистра меняет длину части не-ASCII символов, и позиции в такой строке уже не
// совпадают с исходной (а текст события — русский, то есть почти всегда не-ASCII).
func findToolBlock(content string) (toolBlock, bool) {
	searchFrom := 0
	for {
		rel := strings.Index(content[searchFrom:], "```")
		if rel < 0 {
			return toolBlock{}, false
		}
		start := searchFrom + rel
		lineEnd := strings.IndexByte(content[start+3:], '\n')
		if lineEnd < 0 {
			return toolBlock{}, false
		}
		lang := strings.TrimSpace(content[start+3 : start+3+lineEnd])
		bodyStart := start + 3 + lineEnd + 1
		if !strings.EqualFold(lang, textToolsFence) {
			// Не наш блок: продолжаем со следующего ограждения, иначе закрывающие
			// ``` обычного листинга сбивали бы поиск.
			searchFrom = bodyStart
			continue
		}
		closeRel := strings.Index(content[bodyStart:], "```")
		if closeRel < 0 {
			return toolBlock{}, false
		}
		return toolBlock{
			start:     start,
			bodyStart: bodyStart,
			bodyEnd:   bodyStart + closeRel,
			end:       bodyStart + closeRel + 3,
		}, true
	}
}

// textCallEnvelope — два вида ответа: массив вызовов или объект с полем calls.
type textCallEnvelope struct {
	Calls []textCall `json:"calls"`
}

type textCall struct {
	Name string `json:"name"`
	// Tool — второй возможный ключ имени: модели путают name/tool/function.
	Tool string `json:"tool"`
	// Function — форма как у OpenAI: {"function":{"name":...,"arguments":...}}.
	Function *struct {
		Name      string          `json:"name"`
		Arguments json.RawMessage `json:"arguments"`
	} `json:"function"`
	// Arguments — объект или строка с JSON внутри.
	Arguments json.RawMessage `json:"arguments"`
}

// decodeTextCalls разбирает содержимое блока: массив вызовов или {"calls": [...]}.
func decodeTextCalls(raw string) []ai.ToolCall {
	trimmed := strings.TrimSpace(raw)
	if trimmed == "" {
		return nil
	}
	var calls []textCall
	if strings.HasPrefix(trimmed, "[") {
		if err := json.Unmarshal([]byte(trimmed), &calls); err != nil {
			return nil
		}
	} else {
		var envelope textCallEnvelope
		if err := json.Unmarshal([]byte(trimmed), &envelope); err != nil {
			return nil
		}
		calls = envelope.Calls
	}

	out := make([]ai.ToolCall, 0, len(calls))
	for i, call := range calls {
		name := firstNonEmpty(call.Name, call.Tool)
		args := call.Arguments
		if call.Function != nil {
			name = firstNonEmpty(name, call.Function.Name)
			if len(call.Function.Arguments) > 0 {
				args = call.Function.Arguments
			}
		}
		if strings.TrimSpace(name) == "" {
			continue
		}
		out = append(out, ai.ToolCall{
			// Идентификатор синтетический: у текстового вызова его нет, а
			// протоколу tool-сообщений он нужен — по нему модель понимает, на
			// какой вызов пришёл результат.
			ID:        fmt.Sprintf("text-%d-%s", i, name),
			Name:      strings.TrimSpace(name),
			Arguments: decodeArguments(args),
		})
	}
	return out
}

// decodeArguments приводит аргументы к объекту: они приходят и объектом, и строкой
// с JSON внутри (вторая форма — почти норма у текстовых вызовов).
func decodeArguments(raw json.RawMessage) map[string]any {
	if len(raw) == 0 {
		return map[string]any{}
	}
	var obj map[string]any
	if err := json.Unmarshal(raw, &obj); err == nil {
		return obj
	}
	var str string
	if err := json.Unmarshal(raw, &str); err == nil {
		inner := map[string]any{}
		if err := json.Unmarshal([]byte(str), &inner); err == nil {
			return inner
		}
	}
	return map[string]any{"_raw": string(raw)}
}

func firstNonEmpty(values ...string) string {
	for _, v := range values {
		if strings.TrimSpace(v) != "" {
			return v
		}
	}
	return ""
}
