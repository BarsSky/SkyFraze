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
	if block, ok := findToolBlock(content); ok {
		calls := decodeTextCalls(content[block.bodyStart:block.bodyEnd])
		if len(calls) > 0 {
			return strings.TrimSpace(content[:block.start] + content[block.end:]), calls
		}
		// Блок наш, но внутри не вызов: пробуем другие блоки, а если их нет — оставляем
		// текст как есть (человек увидит, что ответил модель).
	}
	// Второй частый случай на живых моделях (0.141.1): вызов завёрнут в обычную ограду
	// ```json или ``` — так gemma отвечает, когда не может позвать инструмент нативно.
	if cleaned, calls, ok := parseFencedToolCalls(content); ok {
		return cleaned, calls
	}
	// Сырой шаблон модели: <|tool_call|>имя{аргументы} (0.142.4).
	if cleaned, calls := ParseAngleToolCalls(stripEmptyFences(content)); len(calls) > 0 {
		return cleaned, calls
	}
	if cleaned, calls := parseLooseToolCalls(stripEmptyFences(content)); len(calls) > 0 {
		return cleaned, calls
	}
	// Неразобранный (обрезанный) вызов не показываем человеку как текст ответа (0.142.7):
	// живая gemma выдавала «Предлагаю переписать…» и следом обрезанный JSON вызова — в таком
	// виде это мусор, а не ответ.
	return stripBrokenCallBlocks(stripEmptyFences(content)), nil
}

// stripEmptyFences убирает пустые ограды (0.141.1).
//
// Живая gemma на запрос правки главы вернула ровно «```json```» — пустой блок вместо
// вызова инструмента. Показывать это человеку как ответ модели нельзя: это не ответ.
// После очистки текст становится пустым, и вызывающий честно говорит, что ответа нет.
func stripEmptyFences(content string) string {
	cleaned := content
	for _, block := range fencedBlocks(content) {
		if strings.TrimSpace(content[block.bodyStart:block.bodyEnd]) != "" {
			continue
		}
		cleaned = strings.Replace(cleaned, content[block.start:block.end], "", 1)
	}
	return strings.TrimSpace(cleaned)
}

// fencedBlock — ограда ```lang … ``` с телом.
type fencedBlock struct {
	start     int
	bodyStart int
	bodyEnd   int
	end       int
}

// parseFencedToolCalls ищет вызовы в обычных оградах (```json, ```JSON, ``` без языка).
//
// Принимаем, только если внутри есть ХОТЯ БЫ ОДИН известный инструмент: иначе любой
// пример кода в ответе модели превращался бы в попытку что-то создать.
func parseFencedToolCalls(content string) (string, []ai.ToolCall, bool) {
	for _, block := range fencedBlocks(content) {
		calls := decodeTextCalls(content[block.bodyStart:block.bodyEnd])
		if !hasKnownTool(calls) {
			continue
		}
		return strings.TrimSpace(content[:block.start] + content[block.end:]), calls, true
	}
	return "", nil, false
}

// fencedBlocks перечисляет все ограды в тексте (без разбора языка).
//
// Позиции считаем по исходной строке, а не по приведённой к нижнему регистру: приведение
// регистра меняет длину не-ASCII символов, и позиции разъехались бы с текстом (он русский).
func fencedBlocks(content string) []fencedBlock {
	blocks := make([]fencedBlock, 0, 2)
	searchFrom := 0
	for {
		rel := strings.Index(content[searchFrom:], "```")
		if rel < 0 {
			return blocks
		}
		start := searchFrom + rel
		rest := content[start+3:]
		lineEnd := strings.IndexByte(rest, '\n')
		// Однострочная ограда (```json```): закрывающая идёт раньше перевода строки или её
		// нет вовсе. Живая gemma отвечает именно так, когда «не смогла» позвать инструмент.
		if firstClose := strings.Index(rest, "```"); firstClose >= 0 && (lineEnd < 0 || firstClose < lineEnd) {
			bodyStart := start + 3 + firstClose
			blocks = append(blocks, fencedBlock{
				start:     start,
				bodyStart: bodyStart,
				bodyEnd:   bodyStart,
				end:       bodyStart + 3,
			})
			searchFrom = bodyStart + 3
			continue
		}
		if lineEnd < 0 {
			return blocks
		}
		bodyStart := start + 3 + lineEnd + 1
		closeRel := strings.Index(content[bodyStart:], "```")
		if closeRel < 0 {
			return blocks
		}
		blocks = append(blocks, fencedBlock{
			start:     start,
			bodyStart: bodyStart,
			bodyEnd:   bodyStart + closeRel,
			end:       bodyStart + closeRel + 3,
		})
		searchFrom = bodyStart + closeRel + 3
	}
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
	for _, token := range []string{"<end_of_turn>", "<|end_of_turn|>", "<|im_end|>", "<|eot_id|>", "<|end|>", "</s>", "<|tool_call|>", "<|tool_call>"} {
		s = strings.ReplaceAll(s, token, "")
	}
	return strings.TrimSpace(s)
}

// knownToolNames — все инструменты, которые помощник умеет выполнять (0.142.5).
//
// Зачем список вообще: он защищает от «JSON-ответа, который не вызов» — модели иногда
// возвращают просто данные в виде JSON, и принимать их за попытку что-то изменить нельзя.
//
// Почему он был неверным: в списке стояли только четыре инструмента (чтение и создание),
// а инструменты правки добавились позже. Из-за этого вызов вида
// `[{"name":"update_event_text","arguments":{…}}]` считался «не вызовом» и оставался текстом
// в ответе — ровно так помощник «нормально не отрабатывал» правку главы на живом стенде.
var knownToolNames = map[string]bool{
	ToolListEvents:          true,
	ToolReadEvent:           true,
	ToolCreateChapter:       true,
	ToolCreateSub:           true,
	ToolUpdateText:          true,
	ToolUpdateDate:          true,
	ToolDeleteEvent:         true,
	ToolMoveEvent:           true,
	ToolGenerateImage:       true,
	ToolReadComments:        true,
	ToolProposeFragmentEdit: true,
	ToolListEntities:        true,
	ToolReadEntity:          true,
	ToolProposeEntities:     true,
}

// hasKnownTool — есть ли среди вызовов инструмент, который мы действительно умеем
// выполнять. Это и есть защита от «JSON-ответа, который не вызов».
func hasKnownTool(calls []ai.ToolCall) bool {
	for _, call := range calls {
		if knownToolNames[call.Name] {
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
	// Call — живой случай gemma (0.142.2): {"call":"read_event","args":{…}}.
	Call string `json:"call"`
	// Tool — второй возможный ключ имени: модели путают name/tool/function.
	Tool string `json:"tool"`
	// Function — форма как у OpenAI: {"function":{"name":...,"arguments":...}}.
	Function *struct {
		Name      string          `json:"name"`
		Arguments json.RawMessage `json:"arguments"`
	} `json:"function"`
	// Arguments — объект или строка с JSON внутри.
	Arguments json.RawMessage `json:"arguments"`
	// Args/Parameters/Input — другие имена того же поля: модели выбирают их свободно.
	Args       json.RawMessage `json:"args"`
	Parameters json.RawMessage `json:"parameters"`
	Input      json.RawMessage `json:"input"`
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
		name := firstNonEmpty(call.Name, call.Tool, call.Call)
		args := firstRaw(call.Arguments, call.Args, call.Parameters, call.Input)
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

// firstRaw — первые непустые аргументы (модели называют поле args, parameters, input…).
func firstRaw(values ...json.RawMessage) json.RawMessage {
	for _, raw := range values {
		if len(raw) > 0 && strings.TrimSpace(string(raw)) != "" {
			return raw
		}
	}
	return nil
}

func firstNonEmpty(values ...string) string {
	for _, v := range values {
		if strings.TrimSpace(v) != "" {
			return v
		}
	}
	return ""
}

// angleToolMarkers — служебные маркеры вызова у «сырых» шаблонов (0.142.4).
//
// Живая gemma отвечает так: `<|tool_call|>update_event_text{body_md: "…", event_id: "…"}` —
// имя и «почти JSON» в фигурных скобках. Ключи без кавычек, поэтому обычный разбор не
// срабатывает, и вызов оставался текстом в ответе.
var angleToolMarkers = []string{"<|tool_call|>", "<|tool_call>", "<tool_call|>"}

// ParseAngleToolCalls разбирает вызовы формата `<|tool_call|>имя{аргументы}`.
//
// Аргументы могут быть с ключами без кавычек — такой «JSON» чиним (quoteBareKeys) и, если он
// так и не разобрался, отдаём как `_raw`: валидация инструмента скажет человеку, чего не
// хватает, вместо тихой потери вызова.
func ParseAngleToolCalls(content string) (string, []ai.ToolCall) {
	var calls []ai.ToolCall
	rest := content
	for {
		pos, marker := indexAny(rest, angleToolMarkers)
		if pos < 0 {
			break
		}
		after := rest[pos+len(marker):]
		nameEnd := 0
		for nameEnd < len(after) {
			c := after[nameEnd]
			if (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9') || c == '_' {
				nameEnd++
				continue
			}
			break
		}
		name := after[:nameEnd]
		bodyStart := strings.IndexByte(after[nameEnd:], '{')
		if name == "" || bodyStart < 0 {
			return content, nil
		}
		bodyStart += nameEnd
		bodyEnd := matchBrace(after, bodyStart)
		if bodyEnd < 0 {
			return content, nil
		}
		args := decodeArguments(json.RawMessage(quoteBareKeys(after[bodyStart : bodyEnd+1])))
		calls = append(calls, ai.ToolCall{
			ID:        fmt.Sprintf("angle-%d-%s", len(calls), name),
			Name:      name,
			Arguments: args,
		})
		rest = rest[:pos] + rest[pos+len(marker)+bodyEnd+1:]
	}
	if len(calls) == 0 {
		return content, nil
	}
	return trimSpecialTokens(strings.TrimSpace(rest)), calls
}

// indexAny — где раньше всех встречается один из маркеров.
func indexAny(text string, markers []string) (int, string) {
	best, found := -1, ""
	for _, marker := range markers {
		if pos := strings.Index(text, marker); pos >= 0 && (best < 0 || pos < best) {
			best, found = pos, marker
		}
	}
	return best, found
}

// matchBrace находит закрывающую скобку для открытой в pos (с учётом строк и вложенности).
func matchBrace(text string, pos int) int {
	depth := 0
	inString := false
	escaped := false
	for i := pos; i < len(text); i++ {
		c := text[i]
		switch {
		case escaped:
			escaped = false
		case c == '\\' && inString:
			escaped = true
		case c == '"':
			inString = !inString
		case inString:
			// внутри строки скобки не считаем
		case c == '{':
			depth++
		case c == '}':
			depth--
			if depth == 0 {
				return i
			}
		}
	}
	return -1
}

// quoteBareKeys делает из «почти JSON» нормальный: `{body_md: "x"}` → `{"body_md": "x"}`.
//
// Модели пишут ключи без кавычек, и без этого шага аргументы вызова не разбирались бы вовсе.
func quoteBareKeys(raw string) string {
	var out strings.Builder
	inString := false
	for i := 0; i < len(raw); i++ {
		c := raw[i]
		if c == '"' && (i == 0 || raw[i-1] != '\\') {
			inString = !inString
			out.WriteByte(c)
			continue
		}
		if inString {
			out.WriteByte(c)
			continue
		}
		if (c == '{' || c == ',') && i+1 < len(raw) {
			out.WriteByte(c)
			j := i + 1
			for j < len(raw) && (raw[j] == ' ' || raw[j] == '\n' || raw[j] == '\t') {
				out.WriteByte(raw[j])
				j++
			}
			start := j
			for j < len(raw) && (raw[j] >= 'a' && raw[j] <= 'z' || raw[j] >= 'A' && raw[j] <= 'Z' || raw[j] == '_' || raw[j] >= '0' && raw[j] <= '9') {
				j++
			}
			if j > start {
				k := j
				for k < len(raw) && (raw[k] == ' ' || raw[k] == '\n' || raw[k] == '\t') {
					k++
				}
				if k < len(raw) && raw[k] == ':' {
					out.WriteByte('"')
					out.WriteString(raw[start:j])
					out.WriteByte('"')
					i = j - 1
					continue
				}
			}
			i = j - 1
			continue
		}
		out.WriteByte(c)
	}
	return out.String()
}

// stripBrokenCallBlocks убирает из текста недописанные блоки вызова инструмента (0.142.7).
//
// Режем только то, что явно начинается как вызов (в ограде или после маркера `<|tool_call|>`):
// обычный код в ответе модели остаётся.
func stripBrokenCallBlocks(content string) string {
	out := content
	for _, block := range fencedBlocks(out) {
		body := out[block.bodyStart:block.bodyEnd]
		if looksLikeCallBody(body) {
			return strings.TrimSpace(stripBrokenCallBlocks(out[:block.start]))
		}
	}
	// Недописанный вызов без ограды: всё, что после маркера, — служебное.
	if pos, marker := indexAny(out, angleToolMarkers); pos >= 0 {
		return strings.TrimSpace(stripBrokenCallBlocks(out[:pos] + out[pos+len(marker):]))
	}
	return out
}

// looksLikeCallBody — тело вызова, который НЕ ДОПИСАН: массив вызовов без закрытия.
//
// Обычный пример кода в ответе модели (объект, закрытый JSON) под это не подпадает: его видно
// человеку, и это правильно (0.142.7 и тест «чужие блоки»).
func looksLikeCallBody(body string) bool {
	trimmed := strings.TrimSpace(body)
	if !strings.HasPrefix(trimmed, "[{") {
		return false
	}
	if strings.HasSuffix(trimmed, "]}") || strings.HasSuffix(trimmed, "}]") {
		return false // закрытый массив — это не обрывок
	}
	for name := range knownToolNames {
		if strings.Contains(trimmed, `"`+name+`"`) {
			return true
		}
	}
	return false
}
