package assistant

// Юнит-тесты разбора: аргументы инструментов и текстовый протокол.
//
// Почему это отдельные тесты, а не часть интеграционных. Всё, что здесь проверяется, —
// чистая логика на границе с внешним миром: модель присылает то строку вместо числа,
// то вызов без кавычек, то блок с JSON внутри строки. Ошибка здесь стоит дорого
// (созданный кадр с мусором в заголовке или потерянный вызов), а воспроизводится
// одной строкой — база для этого не нужна.

import (
	"errors"
	"strings"
	"testing"

	"github.com/google/uuid"
)

func TestParseCreateValidatesTitle(t *testing.T) {
	limits := DefaultLimits(10)

	if _, err := ParseCreate(map[string]any{"body_md": "текст"}, limits); err == nil {
		t.Fatalf("без заголовка кадр создавать нельзя")
	}
	if _, err := ParseCreate(map[string]any{"title": "   "}, limits); err == nil {
		t.Fatalf("заголовок из пробелов — не заголовок")
	}
	// Заголовок в одну строку: переводы строк внутри сломали бы вид кадра в ленте.
	args, err := ParseCreate(map[string]any{"title": "  Пролог\n", "body_md": "текст"}, limits)
	if err != nil {
		t.Fatalf("разбор: %v", err)
	}
	if args.Title != "Пролог" {
		t.Fatalf("заголовок: %q", args.Title)
	}
	if args.ParentID != nil || args.AfterID != nil {
		t.Fatalf("лишние ссылки: %+v", args)
	}
}

func TestParseCreateLimitsBody(t *testing.T) {
	limits := DefaultLimits(10)
	long := strings.Repeat("я", limits.MaxBodyChars+1)
	_, err := ParseCreate(map[string]any{"title": "Глава", "body_md": long}, limits)
	var tooLong TooLongError
	if !errors.As(err, &tooLong) || tooLong.Field != "body_md" {
		t.Fatalf("ожидался отказ по длине текста, получено %v", err)
	}
	if _, err := ParseCreate(map[string]any{"title": strings.Repeat("я", limits.MaxTitleChars+1)}, limits); err == nil {
		t.Fatalf("слишком длинный заголовок должен отвергаться")
	}
}

func TestParseCreateReadsIDsAndDate(t *testing.T) {
	limits := DefaultLimits(10)
	parent, after := uuid.New(), uuid.New()
	args, err := ParseCreate(map[string]any{
		"title":     "Глава",
		"parent_id": parent.String(),
		"after_id":  after.String(),
		"date":      "2024-05-17",
	}, limits)
	if err != nil {
		t.Fatalf("разбор: %v", err)
	}
	if args.ParentID == nil || *args.ParentID != parent {
		t.Fatalf("parent_id: %v", args.ParentID)
	}
	if args.AfterID == nil || *args.AfterID != after {
		t.Fatalf("after_id: %v", args.AfterID)
	}
	if args.Date.Format("2006-01-02") != "2024-05-17" {
		t.Fatalf("дата: %v", args.Date)
	}

	// Мусор в идентификаторе и дате — понятная ошибка, а не «кадр в корне проекта».
	if _, err := ParseCreate(map[string]any{"title": "Г", "parent_id": "не-uuid"}, limits); err == nil {
		t.Fatalf("битый parent_id должен отвергаться")
	}
	if _, err := ParseCreate(map[string]any{"title": "Г", "date": "17.05.2024"}, limits); err == nil {
		t.Fatalf("битая дата должна отвергаться")
	}
}

func TestParseCreateToleratesLooseTypes(t *testing.T) {
	limits := DefaultLimits(10)
	// Числа и null приходят от моделей регулярно: «title» числом — не повод отказывать.
	args, err := ParseCreate(map[string]any{"title": "Глава 5", "date": nil, "after_id": ""}, limits)
	if err != nil {
		t.Fatalf("разбор: %v", err)
	}
	if args.Title != "Глава 5" || args.AfterID != nil || !args.Date.IsZero() {
		t.Fatalf("аргументы: %+v", args)
	}
	if got := argString(map[string]any{"n": float64(2024)}, "n"); got != "2024" {
		t.Fatalf("число печатается как %q, ожидалось 2024", got)
	}
}

func TestParseEventID(t *testing.T) {
	id := uuid.New()
	got, err := ParseEventID(map[string]any{"id": id.String()})
	if err != nil || got != id {
		t.Fatalf("разбор id: %v (%v)", got, err)
	}
	if _, err := ParseEventID(map[string]any{}); err == nil {
		t.Fatalf("без id инструмент читать нечего")
	}
	if _, err := ParseEventID(map[string]any{"id": "42"}); err == nil {
		t.Fatalf("не-uuid должен отвергаться")
	}
}

func TestParseTextToolCallsArrayForm(t *testing.T) {
	content := "Сейчас создам главу.\n\n```skyfraze-tools\n" +
		`[{"name":"create_chapter","arguments":{"title":"Пролог","body_md":"Текст."}}]` +
		"\n```\n"
	cleaned, calls := ParseTextToolCalls(content)
	if len(calls) != 1 || calls[0].Name != ToolCreateChapter {
		t.Fatalf("вызовы: %+v", calls)
	}
	if calls[0].Arguments["title"] != "Пролог" {
		t.Fatalf("аргументы: %+v", calls[0].Arguments)
	}
	if calls[0].ID == "" {
		t.Fatalf("у текстового вызова должен быть идентификатор для протокола")
	}
	if strings.Contains(cleaned, "skyfraze-tools") || strings.Contains(cleaned, "create_chapter") {
		t.Fatalf("служебный блок остался в тексте: %q", cleaned)
	}
	if cleaned != "Сейчас создам главу." {
		t.Fatalf("текст без блока: %q", cleaned)
	}
}

func TestParseTextToolCallsEnvelopeAndFunctionForm(t *testing.T) {
	// Форма «как у OpenAI»: имя в function.name, аргументы строкой с JSON внутри.
	content := "```skyfraze-tools\n" +
		`{"calls":[{"function":{"name":"create_chapter","arguments":"{\"title\":\"Из строки\"}"}}]}` +
		"\n```"
	_, calls := ParseTextToolCalls(content)
	if len(calls) != 1 || calls[0].Name != ToolCreateChapter {
		t.Fatalf("вызовы: %+v", calls)
	}
	if calls[0].Arguments["title"] != "Из строки" {
		t.Fatalf("аргументы из строки: %+v", calls[0].Arguments)
	}
}

func TestParseTextToolCallsKeepsBrokenJSON(t *testing.T) {
	// Сломанный JSON — это ответ модели, а не сбой сервера: текст должен доехать до
	// человека целиком, иначе он не поймёт, что модель пыталась сделать.
	content := "Вот вызов:\n\n```skyfraze-tools\n{это не json}\n```"
	cleaned, calls := ParseTextToolCalls(content)
	if len(calls) != 0 {
		t.Fatalf("из мусора не должно получаться вызовов: %+v", calls)
	}
	if cleaned != content {
		t.Fatalf("текст изменён: %q", cleaned)
	}
}

func TestParseTextToolCallsIgnoresOtherBlocks(t *testing.T) {
	content := "Пример кода:\n\n```json\n{\"name\":\"create_chapter\"}\n```\n\nИ всё."
	cleaned, calls := ParseTextToolCalls(content)
	if len(calls) != 0 {
		t.Fatalf("чужой блок не должен разбираться как вызовы: %+v", calls)
	}
	if cleaned != content {
		t.Fatalf("текст изменён: %q", cleaned)
	}
}

// Текст на русском перед блоком: границы ищутся по байтам исходной строки, и
// приведение регистра их бы сдвинуло (кириллица в UTF-8 — два байта, а верхний
// регистр бывает и другим по длине).
func TestParseTextToolCallsKeepsCyrillicTextIntact(t *testing.T) {
	prefix := "ЁЖИК ИЗ ДАЛЁКОГО СЕЛА написал: «Всё будет хорошо!»"
	content := prefix + "\n```skyfraze-tools\n" +
		`[{"name":"list_events","arguments":{}}]` + "\n```"
	cleaned, calls := ParseTextToolCalls(content)
	if len(calls) != 1 || calls[0].Name != ToolListEvents {
		t.Fatalf("вызовы: %+v", calls)
	}
	if cleaned != prefix {
		t.Fatalf("текст перед блоком испорчен: %q", cleaned)
	}
}

func TestParseTextToolCallsUnknownArgumentShape(t *testing.T) {
	// Аргументы не объект и не строка с JSON: отдаём как есть, а разбор аргументов
	// инструмента уже скажет модели, чего не хватает.
	content := "```skyfraze-tools\n[{\"name\":\"read_event\",\"arguments\":42}]\n```"
	_, calls := ParseTextToolCalls(content)
	if len(calls) != 1 {
		t.Fatalf("вызовы: %+v", calls)
	}
	if _, ok := calls[0].Arguments["_raw"]; !ok {
		t.Fatalf("неразобранные аргументы должны быть видны: %+v", calls[0].Arguments)
	}
}

// Голый JSON-вызов без ограждения: так отвечает, например, gemma4 через
// Ollama-подобный сервер — `tool_calls` он не отдаёт, а пишет вызов текстом.
func TestParseTextToolCallsLooseJSON(t *testing.T) {
	content := "[{\"call_id\": \"call_1\", \"type\": \"function\", \"function\": " +
		"{\"name\": \"create_chapter\", \"arguments\": \"{\\\"title\\\": \\\"Пролог\\\", " +
		"\\\"body_md\\\": \\\"так начинается история\\\"}\"}}]\n<end_of_turn>"
	cleaned, calls := ParseTextToolCalls(content)
	if len(calls) != 1 || calls[0].Name != ToolCreateChapter {
		t.Fatalf("вызовы: %+v", calls)
	}
	if calls[0].Arguments["title"] != "Пролог" || calls[0].Arguments["body_md"] != "так начинается история" {
		t.Fatalf("аргументы: %+v", calls[0].Arguments)
	}
	// Служебный JSON не показывается человеку — он уже превратился в действие.
	if cleaned != "" {
		t.Fatalf("текст ответа: %q", cleaned)
	}
}

// Голый JSON с НЕЗНАКОМЫМ инструментом вызовом не считается: иначе любой JSON-ответ
// модели (например, просто данные) превращался бы в попытку что-то создать.
func TestParseTextToolCallsLooseJSONNeedsKnownTool(t *testing.T) {
	content := `{"события": [{"title": "Пролог"}]}`
	cleaned, calls := ParseTextToolCalls(content)
	if len(calls) != 0 {
		t.Fatalf("JSON без известного инструмента разобран как вызов: %+v", calls)
	}
	if cleaned != content {
		t.Fatalf("текст изменён: %q", cleaned)
	}

	unknown := `[{"name": "delete_project", "arguments": {}}]`
	cleaned, calls = ParseTextToolCalls(unknown)
	if len(calls) != 0 || cleaned != unknown {
		t.Fatalf("незнакомый инструмент не должен разбираться: %+v / %q", calls, cleaned)
	}
}

// Описания инструментов — часть контракта с моделью: у каждого должна быть схема
// параметров, иначе провайдер отклонит запрос целиком.
// Набор зависит от возможностей: проверяем полный вариант («текст и картинки»), а
// урезанные — отдельным тестом ниже.
func TestToolDefsAreWellFormed(t *testing.T) {
	defs := ToolDefs(Capabilities{Text: true, Images: true}, true, true, true, nil, nil)
	// 16 = чтение дерева, кадра и абзацев кадра (read_event_paragraphs, 0.143.0), карточки
	// мира (list_entities и read_entity), предложение карточек (propose_entities), обсуждение
	// кадров, создание главы и под-события, предложение правки кадра, правка абзаца
	// (update_event_paragraph, 0.143.0), правка даты, перенос по дереву, правка фрагмента по
	// замечанию, удаление, иллюстрация.
	if len(defs) != 16 {
		t.Fatalf("инструментов %d, ожидалось 16", len(defs))
	}
	seen := map[string]bool{}
	for _, def := range defs {
		if def.Name == "" || def.Description == "" {
			t.Fatalf("инструмент без имени или описания: %+v", def)
		}
		if seen[def.Name] {
			t.Fatalf("инструмент %s объявлен дважды", def.Name)
		}
		seen[def.Name] = true
		if def.Parameters["type"] != "object" {
			t.Fatalf("схема %s должна быть объектом: %+v", def.Name, def.Parameters)
		}
	}
	for _, want := range []string{ToolListEvents, ToolReadEvent, ToolReadEventParagraphs, ToolCreateChapter, ToolCreateSub, ToolListEntities, ToolReadEntity, ToolProposeEntities, ToolUpdateParagraph} {
		if !seen[want] {
			t.Fatalf("инструмент %s не объявлен", want)
		}
	}
}

// Карточки мира не предлагаются, когда на стенде их нет: обещать инструмент, который
// отвечает «недоступно», хуже, чем не показывать его вовсе.
func TestToolDefsWithoutEntities(t *testing.T) {
	defs := ToolDefs(Capabilities{Text: true}, false, false, false, nil, nil)
	for _, def := range defs {
		if def.Name == ToolListEntities || def.Name == ToolProposeEntities {
			t.Fatalf("%s объявлен без подключённых карточек мира", def.Name)
		}
	}
}

// Предложение карточек требует и чтения, и записи: без записи применять нечего, поэтому
// инструмент не показывается вовсе — иначе модель пообещает то, чего стенд не сделает.
func TestToolDefsWithoutEntityWriter(t *testing.T) {
	defs := ToolDefs(Capabilities{Text: true}, true, true, false, nil, nil)
	seen := map[string]bool{}
	for _, def := range defs {
		seen[def.Name] = true
	}
	if seen[ToolProposeEntities] {
		t.Fatal("propose_entities объявлен без создания карточек")
	}
	if !seen[ToolListEntities] {
		t.Fatal("list_entities пропал: чтение карточек от записи не зависит")
	}
}

// defaultLimits не должен оставлять нулей: нулевой лимит вызовов означал бы помощника,
// который ничего не делает.
func TestDefaultLimitsAreSane(t *testing.T) {
	limits := DefaultLimits(0)
	if limits.MaxToolCalls <= 0 || limits.MaxRounds <= 0 || limits.MaxBodyChars <= 0 ||
		limits.MaxEventsInPrompt <= 0 || limits.MaxHistory <= 0 {
		t.Fatalf("пределы: %+v", limits)
	}
	if got := DefaultLimits(3); got.MaxToolCalls != 3 {
		t.Fatalf("переданный предел потерян: %+v", got)
	}
}

// TestParseTextToolCallsFencedJSON — вызов в обычной ограде ```json (0.141.1).
//
// Так gemma отвечает, когда не может позвать инструмент нативно: JSON-вызов текстом в
// блоке кода. Раньше такой ответ оставался текстом, и человек видел вызов инструмента
// вместо правки проекта.
func TestParseTextToolCallsFencedJSON(t *testing.T) {
	content := "Сейчас поправлю.\n\n```json\n" +
		`[{"name":"read_event","arguments":{"id":"e1"}}]` + "\n```\n"
	cleaned, calls := ParseTextToolCalls(content)
	if len(calls) != 1 || calls[0].Name != ToolReadEvent {
		t.Fatalf("вызовы: %+v", calls)
	}
	if cleaned != "Сейчас поправлю." {
		t.Fatalf("текст: %q", cleaned)
	}
}

// TestParseTextToolCallsEmptyFence — пустая ограда вместо ответа (0.141.1).
//
// Живой случай: на «поправь главу» модель вернула ровно «```json```». Это не ответ, и
// показывать его как текст модели нельзя — после очистки текста нет, и помощник честно
// сообщает, что ответа не было.
func TestParseTextToolCallsEmptyFence(t *testing.T) {
	cleaned, calls := ParseTextToolCalls("```json```")
	if len(calls) != 0 {
		t.Fatalf("вызовы: %+v", calls)
	}
	if cleaned != "" {
		t.Fatalf("пустая ограда осталась в ответе: %q", cleaned)
	}
}

// TestParseTextToolCallsGemmaCallArgs — живой формат gemma (0.142.2).
//
// Так модель ответила на «поправь орфографию первой главы»: вызов текстом, в ограде ```json,
// с ключами "call"/"args". Раньше такой ответ оставался текстом, и человек видел JSON вместо
// правки проекта.
func TestParseTextToolCallsGemmaCallArgs(t *testing.T) {
	content := "```json\n[\n  {\n    \"call\": \"read_event\",\n    \"args\": {\n      \"id\": \"17b25a13-1c32-4d15-838f-01da583b2f4a\"\n    }\n  }\n]\n```"
	cleaned, calls := ParseTextToolCalls(content)
	if len(calls) != 1 || calls[0].Name != ToolReadEvent {
		t.Fatalf("вызовы: %+v", calls)
	}
	if got, _ := calls[0].Arguments["id"].(string); got != "17b25a13-1c32-4d15-838f-01da583b2f4a" {
		t.Fatalf("аргументы: %+v", calls[0].Arguments)
	}
	if cleaned != "" {
		t.Fatalf("текст вызова остался в ответе: %q", cleaned)
	}
}

// TestStreamGateHidesFencedCall — ограда с вызовом не показывается человеку в потоке.
func TestStreamGateHidesFencedCall(t *testing.T) {
	var shown strings.Builder
	gate := newStreamGate(func(text string) error {
		shown.WriteString(text)
		return nil
	})
	for _, piece := range []string{"```json\n[{\"call\":\"read_event\"", ",\"args\":{}}]\n```"} {
		if err := gate.feed(piece); err != nil {
			t.Fatalf("поток: %v", err)
		}
	}
	if err := gate.finish(); err != nil {
		t.Fatalf("финал: %v", err)
	}
	if shown.Len() != 0 {
		t.Fatalf("человеку показали служебный блок: %q", shown.String())
	}
}

// TestParseAngleToolCalls — живой формат gemma <|tool_call|>имя{ключи без кавычек} (0.142.4).
//
// Именно так модель ответила на «поправь орфографию первой главы» после 0.142.3: вызов
// приезжал текстом, человек видел `<|tool_call|>update_event_text{body_md: …}` вместо правки.
func TestParseAngleToolCalls(t *testing.T) {
	content := "Готовлю правку.\n\n<|tool_call|>update_event_text{body_md: \"Демо-сцена: так лучше.\", event_id: \"17b25a13-1c32-4d15-838f-01da583b2f4a\"}<|end_of_turn|>"
	cleaned, calls := ParseTextToolCalls(content)
	if len(calls) != 1 || calls[0].Name != ToolUpdateText {
		t.Fatalf("вызовы: %+v", calls)
	}
	if got, _ := calls[0].Arguments["body_md"].(string); got != "Демо-сцена: так лучше." {
		t.Fatalf("аргументы: %+v", calls[0].Arguments)
	}
	if got, _ := calls[0].Arguments["event_id"].(string); got != "17b25a13-1c32-4d15-838f-01da583b2f4a" {
		t.Fatalf("id кадра: %+v", calls[0].Arguments)
	}
	if cleaned != "Готовлю правку." {
		t.Fatalf("текст: %q", cleaned)
	}
}

// TestParseTextToolCallsFencedEditCall — живой ответ gemma после прозы (0.142.5).
//
// Модель написала «Предлагаю переписать…» и приложила вызов инструмента правки в ограде
// ```json. Список «известных» инструментов в hasKnownTool был из четырёх штук, правки в нём не
// было — вызов считался «не вызовом» и оставался текстом, поэтому правка не применялась.
func TestParseTextToolCallsFencedEditCall(t *testing.T) {
	content := "Предлагаю переписать текст первой главы.\n\n```json\n" +
		`[{"name": "update_event_text", "arguments": {"id": "17b25a13-1c32-4d15-838f-01da583b2f4a", "body_md": "# Описание сцены"}}]` +
		"\n```"
	cleaned, calls := ParseTextToolCalls(content)
	if len(calls) != 1 || calls[0].Name != ToolUpdateText {
		t.Fatalf("вызовы: %+v", calls)
	}
	if got, _ := calls[0].Arguments["id"].(string); got != "17b25a13-1c32-4d15-838f-01da583b2f4a" {
		t.Fatalf("аргументы: %+v", calls[0].Arguments)
	}
	if cleaned != "Предлагаю переписать текст первой главы." {
		t.Fatalf("текст: %q", cleaned)
	}
}

// TestParseTextToolCallsUnknownFencedToolStaysText — незнакомый инструмент по-прежнему не вызов.
func TestParseTextToolCallsUnknownFencedToolStaysText(t *testing.T) {
	content := "```json\n[{\"name\": \"delete_everything\", \"arguments\": {}}]\n```"
	cleaned, calls := ParseTextToolCalls(content)
	if len(calls) != 0 {
		t.Fatalf("незнакомый инструмент принят за вызов: %+v", calls)
	}
	if !strings.Contains(cleaned, "delete_everything") {
		t.Fatalf("текст потерян: %q", cleaned)
	}
}

// TestParseTextToolCallsDropsTruncatedCall — обрезанный вызов не показывается как ответ (0.142.7).
//
// Живой случай: модель написала «Предлагаю переписать…» и следом — массив вызова, оборванный
// на середине строки. JSON не разбирается, вызова нет, и человек видел обломок JSON.
func TestParseTextToolCallsDropsTruncatedCall(t *testing.T) {
	content := "Предлагаю переписать текст главы.\n\n```json\n" +
		`[{"name": "update_event_text", "arguments": {"id": "17b25a13", "body_md": "# Описание` +
		"\n```"
	cleaned, calls := ParseTextToolCalls(content)
	if len(calls) != 0 {
		t.Fatalf("обрезанный вызов принят: %+v", calls)
	}
	if cleaned != "Предлагаю переписать текст главы." {
		t.Fatalf("в ответе остался обломок вызова: %q", cleaned)
	}
}

// TestParseTextToolCallsCallIDName — имя инструмента в поле id (0.142.9).
//
// Живой ответ gemma: `[{"id":"call_update_event_text","arguments":"{\"body_md\": …}"}]` —
// отдельного поля name нет, имя спрятано в id, аргументы строкой с JSON внутри.
func TestParseTextToolCallsCallIDName(t *testing.T) {
	content := `[{"id":"call_update_event_text","arguments":"{\"id\": \"17b25a13\", \"body_md\": \"Демо-сцена: так лучше.\"}"}]`
	cleaned, calls := ParseTextToolCalls(content)
	if len(calls) != 1 || calls[0].Name != ToolUpdateText {
		t.Fatalf("вызовы: %+v", calls)
	}
	if got, _ := calls[0].Arguments["body_md"].(string); got != "Демо-сцена: так лучше." {
		t.Fatalf("аргументы: %+v", calls[0].Arguments)
	}
	if cleaned != "" {
		t.Fatalf("вызов остался в тексте: %q", cleaned)
	}
}

// TestParseTextEditBlock — «текстовый канал» правки кадра (0.143.0).
//
// Маленькая модель не удерживает главу внутри JSON-строки (обрывает на середине). Поэтому
// новый текст кадра можно отдать блоком ```skyfraze-text id=<uuid> — без экранирования.
func TestParseTextEditBlock(t *testing.T) {
	content := "Переписал главу.\n\n```skyfraze-text id=17b25a13-1c32-4d15-838f-01da583b2f4a\n" +
		"# Описание сцены\n\nПервый абзац с правкой.\n\nВторой абзац.\n```"
	cleaned, calls := ParseTextToolCalls(content)
	if len(calls) != 1 || calls[0].Name != ToolUpdateText {
		t.Fatalf("вызовы: %+v", calls)
	}
	if got, _ := calls[0].Arguments["id"].(string); got != "17b25a13-1c32-4d15-838f-01da583b2f4a" {
		t.Fatalf("id кадра: %+v", calls[0].Arguments)
	}
	body, _ := calls[0].Arguments["body_md"].(string)
	if !strings.Contains(body, "Первый абзац с правкой.") || !strings.HasPrefix(body, "# Описание сцены") {
		t.Fatalf("текст кадра: %q", body)
	}
	if cleaned != "Переписал главу." {
		t.Fatalf("текст ответа: %q", cleaned)
	}
}

// TestParseTextEditBlockIDInBody — идентификатор первой строкой тела.
func TestParseTextEditBlockIDInBody(t *testing.T) {
	content := "```skyfraze-text\nid: 17b25a13-1c32-4d15-838f-01da583b2f4a\nНовый текст главы.\n```"
	_, calls := ParseTextToolCalls(content)
	if len(calls) != 1 {
		t.Fatalf("вызовы: %+v", calls)
	}
	if body, _ := calls[0].Arguments["body_md"].(string); body != "Новый текст главы." {
		t.Fatalf("текст: %q", body)
	}
}

// TestParseTextEditBlockWithoutID — без идентификатора блок не применяется, текст остаётся.
func TestParseTextEditBlockWithoutID(t *testing.T) {
	content := "```skyfraze-text\nНовый текст без кадра.\n```"
	cleaned, calls := ParseTextToolCalls(content)
	if len(calls) != 0 {
		t.Fatalf("без кадра вызов не строится: %+v", calls)
	}
	if !strings.Contains(cleaned, "Новый текст без кадра.") {
		t.Fatalf("текст потерян: %q", cleaned)
	}
}

// TestParseTextEditBlockTruncated — оборванный блок нового текста не показывается как ответ.
//
// Ровно тот случай, ради которого всё делалось: генерация останавливается на середине абзаца,
// закрывающей ограды нет. Человек должен увидеть прозу модели до блока, а не недоотданный текст
// главы с открытой оградой.
func TestParseTextEditBlockTruncated(t *testing.T) {
	content := "Предлагаю новую редакцию.\n\n```skyfraze-text id=17b25a13-1c32-4d15-838f-01da583b2f4a\n" +
		"Жил смотритель у маяка и не любил"
	cleaned, calls := ParseTextToolCalls(content)
	if len(calls) != 0 {
		t.Fatalf("оборванный блок не должен становиться вызовом: %+v", calls)
	}
	if cleaned != "Предлагаю новую редакцию." {
		t.Fatalf("текст ответа: %q", cleaned)
	}
}
