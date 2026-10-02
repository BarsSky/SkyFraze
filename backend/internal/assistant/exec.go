package assistant

// exec.go — выполнение инструментов, которые попросила модель.
//
// Ключевое решение: инструменты НЕ трогают документ напрямую. Создание кадра идёт
// через `transfer.ImportMarkdownInto` — тот же путь, что у импорта Markdown «в место».
// Почему так, а не «взять документ и вставить событие»:
//
//   - источник правды проекта — CRDT-документ живой комнаты. Вставка мимо комнаты
//     была бы затёрта ближайшим сохранением, а редакторы не увидели бы кадр вообще;
//   - импорт уже проверяет права, глубину дерева, пишет снапшот и перестраивает
//     проекцию событий — повторять эту логику здесь значило бы завести вторую,
//     которая рано или поздно разойдётся с первой;
//   - вложения, даты и порядок вставки уже описаны там же (`InsertPlace`).
//
// Отсюда и вид проверок в этом файле: перед вставкой мы проверяем только то, чего
// импорт знать не может, — что идентификаторы, названные моделью, существуют в этом
// проекте. Существование проверяется по проекции: она отстаёт от документа не больше
// чем на период сохранения комнаты (5 секунд), а кадр, созданный в этом же ответе,
// модель трогать не должна — ей для этого не хватит идентификатора.

import (
	"context"
	"errors"
	"fmt"

	"github.com/google/uuid"

	"github.com/skyfraze/backend/internal/ai"
	"github.com/skyfraze/backend/internal/events"
	"github.com/skyfraze/backend/internal/store"
	"github.com/skyfraze/backend/internal/transfer"
)

// toolResult — итог одного вызова: что вернуть модели, что показать человеку и что
// изменилось в проекте.
type toolResult struct {
	call    ai.ToolCall
	report  Call
	payload any
	change  *Change
}

// refusedCall — вызов, который не выполнялся (кончился лимит изменений).
func refusedCall(call ai.ToolCall, reason string) toolResult {
	return toolResult{
		call:    call,
		report:  Call{Name: call.Name, OK: false, Error: reason},
		payload: map[string]any{"error": reason},
	}
}

// execute выполняет один вызов. Ошибки НЕ возвращаются наружу: почти все они —
// про неверные аргументы, и модели нужно их увидеть, чтобы исправиться. Наружу уходит
// только то, что ломает весь ответ (ошибка провайдера, отказ в правах).
//
// actorID — от чьего имени создаётся кадр (агент: он автор правок), userID — чьими
// правами (человек, нажавший «спросить»).
func (s *Service) execute(
	ctx context.Context, actorID, userID, projectID uuid.UUID, call ai.ToolCall,
) toolResult {
	switch call.Name {
	case ToolListEvents:
		return s.toolListEvents(ctx, projectID, call)
	case ToolReadEvent:
		return s.toolReadEvent(ctx, projectID, call)
	case ToolCreateChapter:
		return s.toolCreate(ctx, actorID, userID, projectID, call, false)
	case ToolCreateSub:
		return s.toolCreate(ctx, actorID, userID, projectID, call, true)
	default:
		return refusedCall(call, fmt.Sprintf("%v: %s", ErrUnknownTool, call.Name))
	}
}

// toolListEvents отдаёт дерево проекта.
func (s *Service) toolListEvents(ctx context.Context, projectID uuid.UUID, call ai.ToolCall) toolResult {
	list, err := s.store.ListEvents(ctx, projectID)
	if err != nil {
		return refusedCall(call, "не удалось прочитать дерево проекта: "+err.Error())
	}
	return toolResult{
		call: call,
		report: Call{Name: call.Name, OK: true,
			Detail: fmt.Sprintf("прочитал дерево: %d кадр(ов)", len(list))},
		payload: map[string]any{"events": treeRows(list)},
	}
}

// toolReadEvent отдаёт текст одного кадра.
func (s *Service) toolReadEvent(ctx context.Context, projectID uuid.UUID, call ai.ToolCall) toolResult {
	id, err := ParseEventID(call.Arguments)
	if err != nil {
		return refusedCall(call, err.Error())
	}
	list, err := s.store.ListEvents(ctx, projectID)
	if err != nil {
		return refusedCall(call, "не удалось прочитать проект: "+err.Error())
	}
	for _, e := range list {
		if e.ID != id {
			continue
		}
		payload := map[string]any{
			"id": e.ID.String(), "title": e.Title, "body_md": e.Body, "depth": e.Depth,
		}
		if e.EventDate != nil {
			payload["date"] = e.EventDate.Format("2006-01-02")
		}
		return toolResult{
			call:    call,
			report:  Call{Name: call.Name, OK: true, Detail: "прочитал кадр «" + e.Title + "»"},
			payload: payload,
		}
	}
	return refusedCall(call, "кадр не найден в этом проекте: "+id.String()+
		" — возьмите идентификатор из list_events")
}

// toolCreate создаёт главу или под-событие.
func (s *Service) toolCreate(
	ctx context.Context, actorID, userID, projectID uuid.UUID, call ai.ToolCall, sub bool,
) toolResult {
	args, err := ParseCreate(call.Arguments, s.limits)
	if err != nil {
		return refusedCall(call, err.Error())
	}
	switch {
	case !sub && args.ParentID != nil:
		return refusedCall(call, "create_chapter создаёт главу верхнего уровня: "+
			"parent_id не нужен, для вложенного кадра используйте create_sub_event")
	case sub && args.ParentID == nil:
		return refusedCall(call, "create_sub_event требует parent_id — идентификатор главы из list_events")
	}

	list, err := s.store.ListEvents(ctx, projectID)
	if err != nil {
		return refusedCall(call, "не удалось прочитать проект: "+err.Error())
	}
	byID := make(map[uuid.UUID]store.Event, len(list))
	for _, e := range list {
		byID[e.ID] = e
	}
	if args.ParentID != nil {
		parent, ok := byID[*args.ParentID]
		if !ok {
			return refusedCall(call, "не нашёл кадр-родитель "+args.ParentID.String()+
				" в этом проекте — возьмите идентификатор из list_events")
		}
		// Глубину проверяем и здесь: импорт откажет сам, но его отказ — про «кусок не
		// влезает», а модели полезнее знать, что дело именно в уровне родителя.
		if int(parent.Depth) >= events.MaxDepth {
			return refusedCall(call, "«"+parent.Title+"» уже на последнем уровне: "+
				depthLimitError().Error()+"; создайте кадр рядом, а не внутри")
		}
	}
	if args.AfterID != nil {
		if _, ok := byID[*args.AfterID]; !ok {
			return refusedCall(call, "не нашёл кадр для after_id "+args.AfterID.String()+
				" — возьмите идентификатор из list_events")
		}
	}

	event := transfer.ParsedMarkdownEvent{Title: args.Title, Body: args.Body, Depth: 0}
	if !args.Date.IsZero() {
		date := args.Date
		event.Date = &date
	}
	parsed := &transfer.ParsedMarkdown{
		Events: []transfer.ParsedMarkdownEvent{event},
		Stats:  transfer.MarkdownStats{Events: 1, Chars: len([]rune(args.Body))},
	}
	result, err := s.inserter.ImportMarkdownIntoAs(ctx, actorID, userID, projectID, parsed, transfer.InsertPlace{
		ParentID: args.ParentID,
		AfterID:  args.AfterID,
	})
	if err != nil {
		return refusedCall(call, createErrorText(err))
	}
	if len(result.Created) == 0 {
		return refusedCall(call, "кадр не создан: сервер не подтвердил вставку")
	}
	created := result.Created[0]

	action := "created_chapter"
	what := "создал главу"
	if sub {
		action = "created_sub_event"
		what = "создал под-событие"
	}
	detail := fmt.Sprintf("%s «%s»", what, created.Title)
	payload := map[string]any{
		"created": map[string]any{"id": created.ID.String(), "title": created.Title},
		"note":    "кадр уже в проекте: его видят все, у кого проект открыт",
	}
	if result.Warning != "" {
		// Серверная копия отстала: кадр есть, но повторять вызов нельзя — иначе
		// появится второй такой же. Модель должна это знать.
		payload["warning"] = result.Warning
		detail += " (с предупреждением)"
	}
	return toolResult{
		call:    call,
		report:  Call{Name: call.Name, OK: true, Detail: detail},
		payload: payload,
		change: &Change{
			Action: action, ID: created.ID, Title: created.Title, Parent: args.ParentID,
		},
	}
}

// createErrorText переводит отказы импорта в текст, понятный и модели, и человеку.
func createErrorText(err error) string {
	switch {
	case errors.Is(err, transfer.ErrMarkdownTooDeep):
		return "кадр не помещается по глубине: " + depthLimitError().Error()
	case errors.Is(err, transfer.ErrMarkdownBusy):
		return "проект сейчас загружается сервером — повторите через пару секунд"
	case errors.Is(err, transfer.ErrForbidden):
		return "нет прав на изменение этого проекта"
	case errors.Is(err, store.ErrNotFound):
		return "проект или место вставки не найдены"
	default:
		return err.Error()
	}
}
