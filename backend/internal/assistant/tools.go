package assistant

// tools.go — инструменты, которые помощник отдаёт модели, и разбор их аргументов.
//
// Зачем инструменты, а не «просто попросить модель написать главу». Свободный текст
// модель пишет как хочет, и превращать его в события пришлось бы догадками (разбор
// заголовков, отступов, «вот тут, наверное, глава»). Инструмент — это узкий контракт:
// модель называет, ЧТО сделать, и передаёт параметры, а решение «создавать» принимает
// сервер. Только так можно поставить лимит на число изменений и честно показать
// человеку, что именно изменилось.
//
// Первый набор — только чтение и создание:
//
//	list_events       — дерево проекта: id, заголовок, уровень (контекст модели)
//	read_event        — текст одного кадра (чтобы дописать, а не начинать заново)
//	create_chapter    — глава верхнего уровня
//	create_sub_event  — под-событие внутри главы
//
// Удаления, перезаписи и перемещения здесь намеренно нет: сначала должно работать
// предсказуемое создание (docs/ai-assistant.md, «Что не берём»).
//
// Параметры описаны в форме OpenAI (`tools: [{type:"function", function:{...}}]`):
// это фактический стандарт, его понимают и облачные провайдеры, и Ollama.

import (
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/google/uuid"

	"github.com/skyfraze/backend/internal/ai"
)

// Имена инструментов. Константами, а не строками по месту: имя приходит от модели, и
// опечатка в одном месте означала бы «инструмент не найден» вместо понятной ошибки.
const (
	ToolListEvents    = "list_events"
	ToolReadEvent     = "read_event"
	ToolCreateChapter = "create_chapter"
	ToolCreateSub     = "create_sub_event"
)

// ErrUnknownTool — модель попросила инструмент, которого нет. Это не падение сервера:
// ответ уходит модели как результат вызова, и она может исправиться.
var ErrUnknownTool = errors.New("неизвестный инструмент")

// ToolDefs — описания инструментов для запроса к модели.
func ToolDefs() []ai.ToolDef {
	return []ai.ToolDef{
		{
			Name: ToolListEvents,
			Description: "Показать дерево событий проекта: идентификатор, уровень, заголовок и дату каждого кадра. " +
				"Вызывай, если нужно понять структуру проекта или найти идентификатор главы.",
			Parameters: map[string]any{
				"type":       "object",
				"properties": map[string]any{},
			},
		},
		{
			Name: ToolReadEvent,
			Description: "Прочитать текст одного кадра (Markdown) по его идентификатору: " +
				"нужно, чтобы дописать главу, а не начинать её заново.",
			Parameters: map[string]any{
				"type": "object",
				"properties": map[string]any{
					"id": map[string]any{"type": "string", "description": "Идентификатор события из list_events"},
				},
				"required": []string{"id"},
			},
		},
		{
			Name: ToolCreateChapter,
			Description: "Создать главу верхнего уровня (новый кадр истории) с описанием в Markdown. " +
				"Если не указать after_id, глава встанет в конец.",
			Parameters: map[string]any{
				"type": "object",
				"properties": map[string]any{
					"title":    map[string]any{"type": "string", "description": "Заголовок главы, одна строка"},
					"body_md":  map[string]any{"type": "string", "description": "Текст главы в Markdown"},
					"date":     map[string]any{"type": "string", "description": "Дата кадра в виде ГГГГ-ММ-ДД (необязательно)"},
					"after_id": map[string]any{"type": "string", "description": "Идентификатор события, ПОСЛЕ которого поставить главу (необязательно)"},
				},
				"required": []string{"title"},
			},
		},
		{
			Name: ToolCreateSub,
			Description: "Создать под-событие внутри существующей главы (вложенный кадр) с описанием в Markdown. " +
				"Нужен идентификатор родителя из list_events.",
			Parameters: map[string]any{
				"type": "object",
				"properties": map[string]any{
					"parent_id": map[string]any{"type": "string", "description": "Идентификатор главы, внутри которой создать кадр"},
					"title":     map[string]any{"type": "string", "description": "Заголовок кадра, одна строка"},
					"body_md":   map[string]any{"type": "string", "description": "Текст кадра в Markdown"},
					"date":      map[string]any{"type": "string", "description": "Дата кадра в виде ГГГГ-ММ-ДД (необязательно)"},
					"after_id":  map[string]any{"type": "string", "description": "Идентификатор соседа, ПОСЛЕ которого поставить кадр (необязательно)"},
				},
				"required": []string{"parent_id", "title"},
			},
		},
	}
}

// CreateArgs — разобранные и проверенные аргументы создания кадра.
type CreateArgs struct {
	// Title — заголовок (обязателен, одна строка).
	Title string
	// Body — текст в Markdown (может быть пустым: пустой кадр тоже кадр).
	Body string
	// ParentID — nil для главы верхнего уровня.
	ParentID *uuid.UUID
	AfterID  *uuid.UUID
	// Date — дата кадра (нулевая — не задана).
	Date time.Time
}

// TooLongError — аргумент длиннее предела. Отдельный тип, потому что это не «модель
// ошиблась в контракте», а защита: текст на мегабайт в базе и в CRDT нам не нужен.
type TooLongError struct {
	Field string
	Limit int
}

func (e TooLongError) Error() string {
	return fmt.Sprintf("поле %s длиннее предела (%d символов)", e.Field, e.Limit)
}

// Limits — пределы на то, что модель может прислать и сделать за одно сообщение.
type Limits struct {
	// MaxToolCalls — сколько вызовов выполнить за одно сообщение человека.
	MaxToolCalls int
	// MaxRounds — сколько раз сходить к модели, пока она вызывает инструменты.
	// Больше двух-трёх раундов на практике не нужно, а стоят они денег и времени.
	MaxRounds int
	// MaxTitleChars/MaxBodyChars — пределы на заголовок и текст кадра.
	MaxTitleChars int
	MaxBodyChars  int
	// MaxEventsInPrompt — сколько событий дерева уходит в запрос как контекст.
	MaxEventsInPrompt int
	// MaxHistory — сколько сообщений беседы отправлять модели.
	MaxHistory int
}

// DefaultLimits — пределы по умолчанию. Значения подобраны так, чтобы помощник был
// полезен и при этом не мог случайно залить проект текстом или истратить весь лимит
// провайдера за один вопрос.
func DefaultLimits(maxToolCalls int) Limits {
	if maxToolCalls <= 0 {
		maxToolCalls = 10
	}
	return Limits{
		MaxToolCalls:      maxToolCalls,
		MaxRounds:         3,
		MaxTitleChars:     200,
		MaxBodyChars:      20000,
		MaxEventsInPrompt: 200,
		MaxHistory:        20,
	}
}

// ParseCreate разбирает аргументы создания кадра. Проверки нарочно строгие: лучше
// вернуть модели понятную ошибку, чем создать кадр с мусором в заголовке.
func ParseCreate(args map[string]any, limits Limits) (CreateArgs, error) {
	var out CreateArgs
	title := argString(args, "title")
	if title == "" {
		return out, errors.New("не задан title — заголовок кадра обязателен")
	}
	if len([]rune(title)) > limits.MaxTitleChars {
		return out, TooLongError{Field: "title", Limit: limits.MaxTitleChars}
	}
	body := argString(args, "body_md")
	if len([]rune(body)) > limits.MaxBodyChars {
		return out, TooLongError{Field: "body_md", Limit: limits.MaxBodyChars}
	}
	out.Title = title
	out.Body = body

	if raw := argString(args, "parent_id"); raw != "" {
		id, err := uuid.Parse(raw)
		if err != nil {
			return out, fmt.Errorf("parent_id не похож на идентификатор: %q", raw)
		}
		out.ParentID = &id
	}
	if raw := argString(args, "after_id"); raw != "" {
		id, err := uuid.Parse(raw)
		if err != nil {
			return out, fmt.Errorf("after_id не похож на идентификатор: %q", raw)
		}
		out.AfterID = &id
	}
	if raw := argString(args, "date"); raw != "" {
		date, err := time.Parse("2006-01-02", raw)
		if err != nil {
			return out, fmt.Errorf("date не разобрана (нужен вид ГГГГ-ММ-ДД): %q", raw)
		}
		out.Date = date
	}
	return out, nil
}

// ParseEventID достаёт идентификатор события из аргументов read_event.
func ParseEventID(args map[string]any) (uuid.UUID, error) {
	raw := argString(args, "id")
	if raw == "" {
		return uuid.Nil, errors.New("не задан id события")
	}
	id, err := uuid.Parse(raw)
	if err != nil {
		return uuid.Nil, fmt.Errorf("id не похож на идентификатор: %q", raw)
	}
	return id, nil
}

// argString читает строковый аргумент терпимо: модели присылают то строку, то число,
// то null, и отказ из-за формата был бы отказом на ровном месте.
func argString(args map[string]any, name string) string {
	value, ok := args[name]
	if !ok || value == nil {
		return ""
	}
	switch v := value.(type) {
	case string:
		return strings.TrimSpace(v)
	case float64:
		// Числа приходят из JSON именно так (дата, год, «5-я глава»).
		return strings.TrimSpace(trimFloat(v))
	case bool:
		if v {
			return "true"
		}
		return "false"
	default:
		return strings.TrimSpace(fmt.Sprint(v))
	}
}

// trimFloat печатает число без хвоста «.0»: «2024» вместо «2024.0».
func trimFloat(v float64) string {
	if v == float64(int64(v)) {
		return fmt.Sprintf("%d", int64(v))
	}
	return fmt.Sprintf("%g", v)
}
