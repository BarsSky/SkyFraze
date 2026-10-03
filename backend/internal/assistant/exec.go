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
	"strings"

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
	ctx context.Context, actorID, userID, projectID uuid.UUID, call ai.ToolCall, caps Capabilities,
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
	case ToolGenerateImage:
		return s.toolGenerateImage(ctx, actorID, userID, projectID, call, caps)
	default:
		return refusedCall(call, fmt.Sprintf("%v: %s", ErrUnknownTool, call.Name))
	}
}

// toolGenerateImage рисует иллюстрацию к кадру и привязывает её к нему.
//
// Порядок здесь неслучаен: сначала картинка, потом привязка. Файл, который никто не
// привязал, — это просто файл в проекте (его видно в списке вложений, и ничего не
// сломано), а привязка к несуществующему файлу показывала бы пустое место в кадре.
//
// Промпт собирает СЕРВЕР: стиль проекта и негативный промпт стенда дописываются к тому,
// что попросила модель. Иначе каждая иллюстрация была бы в своей манере, а модель
// изобретала бы стиль заново на каждый запрос.
func (s *Service) toolGenerateImage(
	ctx context.Context, actorID, userID, projectID uuid.UUID, call ai.ToolCall, caps Capabilities,
) toolResult {
	if !caps.Images || !ImageToolAvailable {
		return refusedCall(call, "генерация иллюстраций недоступна: "+caps.ImageNote)
	}
	if s.assets == nil {
		return refusedCall(call, "генерация иллюстраций недоступна: сервер не настроен на сохранение файлов")
	}
	args, err := ParseGenerate(call.Arguments, s.limits)
	if err != nil {
		return refusedCall(call, err.Error())
	}

	// Кадр должен существовать в ЭТОМ проекте: рисовать «в никуда» нельзя, а проверять
	// существование по документу модель не может — она видит только то, что ей отдали.
	event, ok := s.findEvent(ctx, projectID, args.EventID)
	if !ok {
		return refusedCall(call, "кадр не найден в этом проекте: возьми event_id из list_events")
	}

	generator, ok := s.models.ImageGenerator()
	if !ok {
		return refusedCall(call, "генератор изображений не настроен на стенде")
	}
	prompt := args.Prompt
	if style := strings.TrimSpace(caps.ImageStyle); style != "" {
		prompt = fmt.Sprintf("%s. Стиль: %s", prompt, style)
	}
	// Контекст кадра помогает иллюстрации соответствовать тексту: модель картинок не
	// видит ни проект, ни главу.
	prompt = fmt.Sprintf("%s. Иллюстрация к кадру «%s».", prompt, event.Title)

	result, err := generator.Generate(ctx, ai.ImageRequest{
		Prompt:   prompt,
		Negative: s.models.DefaultImageNegative(),
		Steps:    s.models.DefaultImageSteps(),
	})
	if err != nil {
		// Ошибка генератора — не ошибка конвейера: модель должна увидеть причину и
		// сказать о ней человеку, а не повторять вызов наугад.
		return refusedCall(call, "не удалось нарисовать: "+err.Error())
	}

	filename := fmt.Sprintf("иллюстрация-%s%s", shortID(args.EventID), extensionFor(result.MediaType))
	// Агент — соавтор проекта, и файл должен быть подписан ИМ, а не человеком, который
	// нажал «спросить». Строку участия обычно создаёт сохранение настроек агента, но
	// владелец мог их ни разу не открывать, а хранилище пускает только участников
	// проекта. Поэтому участие обеспечиваем здесь — тем же правом, что и настройки:
	// редактор (пишет текст, но не распоряжается проектом).
	if err := s.store.AddMembership(ctx, projectID, ai.AgentUserID, store.RoleEditor); err != nil {
		s.logger.Warn("ai: не удалось закрепить агента в проекте", "project", projectID, "err", err)
	}
	asset, err := s.assets.StoreGenerated(ctx, actorID, projectID, filename, result.MediaType, result.Data)
	if err != nil {
		return refusedCall(call, "картинка нарисована, но не сохранилась в проект: "+err.Error())
	}

	warning, err := s.inserter.AttachAssetToEvent(ctx, actorID, userID, projectID,
		args.EventID.String(), asset.ID.String(), args.AsBackground)
	if err != nil {
		return refusedCall(call, "картинка сохранена, но не привязалась к кадру: "+err.Error())
	}
	if warning != "" {
		s.logger.Warn("ai: иллюстрация привязана с предупреждением", "project", projectID, "err", warning)
	}

	report := Call{
		Name: call.Name, OK: true,
		Detail: fmt.Sprintf("нарисовал иллюстрацию к кадру «%s» (%s)", event.Title, humanSize(len(result.Data))),
	}
	return toolResult{
		call:   call,
		report: report,
		payload: map[string]any{
			"ok":       true,
			"event_id": args.EventID.String(),
			"asset_id": asset.ID.String(),
			"filename": asset.Filename,
			"warning":  warning,
		},
		change: &Change{
			Action: ChangeImageCreated,
			ID:     event.ID,
			Title:  event.Title,
		},
	}
}

// findEvent ищет кадр в проекции проекта.
func (s *Service) findEvent(ctx context.Context, projectID, eventID uuid.UUID) (store.Event, bool) {
	list, err := s.store.ListEvents(ctx, projectID)
	if err != nil {
		return store.Event{}, false
	}
	for _, event := range list {
		if event.ID == eventID {
			return event, true
		}
	}
	return store.Event{}, false
}

// shortID — первые 8 символов идентификатора: имя файла должно быть узнаваемым, а не
// тридцать шесть знаков дефисов.
func shortID(id uuid.UUID) string {
	raw := id.String()
	if len(raw) < 8 {
		return raw
	}
	return raw[:8]
}

// extensionFor — расширение по формату картинки: сервер генератора может отдавать и PNG,
// и JPEG, и имя файла должно этому соответствовать.
func extensionFor(mediaType string) string {
	switch mediaType {
	case "image/jpeg":
		return ".jpg"
	case "image/webp":
		return ".webp"
	default:
		return ".png"
	}
}

// humanSize — размер человеческими словами (в подписи для человека).
func humanSize(bytes int) string {
	if bytes < 1024 {
		return fmt.Sprintf("%d Б", bytes)
	}
	return fmt.Sprintf("%.1f МБ", float64(bytes)/(1024*1024))
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
