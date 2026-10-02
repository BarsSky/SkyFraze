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

// Описания инструментов — часть контракта с моделью: у каждого должна быть схема
// параметров, иначе провайдер отклонит запрос целиком.
func TestToolDefsAreWellFormed(t *testing.T) {
	defs := ToolDefs()
	if len(defs) != 4 {
		t.Fatalf("инструментов %d, ожидалось 4", len(defs))
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
	for _, want := range []string{ToolListEvents, ToolReadEvent, ToolCreateChapter, ToolCreateSub} {
		if !seen[want] {
			t.Fatalf("инструмент %s не объявлен", want)
		}
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
