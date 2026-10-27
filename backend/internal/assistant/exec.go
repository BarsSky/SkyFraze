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
//
// change и proposal взаимоисключающие: создание кадра — это изменение проекта (оно уже
// случилось), а правка существующего — предложение (случится, когда человек подтвердит).
type toolResult struct {
	call     ai.ToolCall
	report   Call
	payload  any
	change   *Change
	proposal *store.AIChange
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
	case ToolUpdateText:
		return s.toolUpdateText(ctx, userID, projectID, call)
	case ToolDeleteEvent:
		return s.toolDeleteEvent(ctx, userID, projectID, call)
	case ToolReadComments:
		return s.toolReadComments(ctx, userID, projectID, call)
	case ToolListEntities:
		return s.toolListEntities(ctx, userID, projectID, call)
	case ToolReadEntity:
		return s.toolReadEntity(ctx, userID, projectID, call)
	case ToolProposeFragmentEdit:
		return s.toolProposeFragmentEdit(ctx, userID, projectID, call)
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

// toolUpdateText предлагает переписать кадр.
//
// Инструмент НЕ правит текст: он сохраняет предложение со снимком «до» и «после»
// (store.CreateAIChange), а применяет его человек в окне помощника. Так «перепиши вторую
// главу» не может случиться само — и это не осторожность ради осторожности: отменить
// молчаливую перезапись чужого текста было бы нечем.
func (s *Service) toolUpdateText(
	ctx context.Context, userID, projectID uuid.UUID, call ai.ToolCall,
) toolResult {
	if s.editor == nil {
		return refusedCall(call, "правка существующих кадров недоступна на этом стенде")
	}
	args, err := ParseUpdate(call.Arguments, s.limits)
	if err != nil {
		return refusedCall(call, err.Error())
	}
	event, ok := s.findEvent(ctx, projectID, args.EventID)
	if !ok {
		return refusedCall(call, "кадр не найден в этом проекте: возьмите идентификатор из list_events")
	}
	// Предложение без изменений — не предложение, а шум в окне: модель просит
	// «переписать» тем же текстом, который уже есть.
	sameTitle := args.Title == nil || *args.Title == event.Title
	sameBody := args.Body == nil || *args.Body == event.Body
	if sameTitle && sameBody {
		return refusedCall(call, "предлагать нечего: текст и заголовок уже такие — "+
			"передайте то, что должно измениться")
	}

	change, err := s.store.CreateAIChange(ctx, store.AIChange{
		ProjectID: projectID, UserID: userID,
		Kind: store.AIChangeUpdateText, EventID: event.ID, EventTitle: event.Title,
		OldTitle: event.Title, OldBody: event.Body,
		NewTitle: pickText(args.Title, event.Title),
		NewBody:  pickText(args.Body, event.Body),
	})
	if err != nil {
		return refusedCall(call, "не удалось сохранить предложение: "+err.Error())
	}
	s.logger.Info("ai: предложена правка кадра",
		"project", projectID, "user", userID, "event", event.ID, "change", change.ID)

	return toolResult{
		call: call,
		report: Call{Name: call.Name, OK: true,
			Detail: "предложил " + proposalTitle(store.AIChangeUpdateText, event.Title)},
		payload: map[string]any{
			"proposal_id": change.ID.String(),
			"event_id":    event.ID.String(),
			"status":      "ждёт подтверждения человеком",
			"note":        proposalNote(store.AIChangeUpdateText),
		},
		proposal: change,
	}
}

// toolDeleteEvent предлагает удалить кадр.
func (s *Service) toolDeleteEvent(
	ctx context.Context, userID, projectID uuid.UUID, call ai.ToolCall,
) toolResult {
	if s.editor == nil {
		return refusedCall(call, "удаление кадров недоступно на этом стенде")
	}
	eventID, _, err := ParseDelete(call.Arguments, s.limits)
	if err != nil {
		return refusedCall(call, err.Error())
	}
	event, ok := s.findEvent(ctx, projectID, eventID)
	if !ok {
		return refusedCall(call, "кадр не найден в этом проекте: возьмите идентификатор из list_events")
	}
	// Детей проверяем ДО предложения: предлагать то, что сервер заведомо не применит, —
	// значит показать человеку кнопку, которая не работает.
	list, err := s.store.ListEvents(ctx, projectID)
	if err != nil {
		return refusedCall(call, "не удалось прочитать проект: "+err.Error())
	}
	for _, row := range list {
		if row.ParentID != nil && *row.ParentID == event.ID {
			return refusedCall(call, "у кадра «"+event.Title+"» есть под-события: "+
				"удалять главу вместе с детьми нельзя — предложи сначала удалить их по одному")
		}
	}

	change, err := s.store.CreateAIChange(ctx, store.AIChange{
		ProjectID: projectID, UserID: userID,
		Kind: store.AIChangeDeleteEvent, EventID: event.ID, EventTitle: event.Title,
		OldTitle: event.Title, OldBody: event.Body,
	})
	if err != nil {
		return refusedCall(call, "не удалось сохранить предложение: "+err.Error())
	}
	s.logger.Info("ai: предложено удаление кадра",
		"project", projectID, "user", userID, "event", event.ID, "change", change.ID)

	return toolResult{
		call: call,
		report: Call{Name: call.Name, OK: true,
			Detail: "предложил " + proposalTitle(store.AIChangeDeleteEvent, event.Title)},
		payload: map[string]any{
			"proposal_id": change.ID.String(),
			"event_id":    event.ID.String(),
			"status":      "ждёт подтверждения человеком",
			"note":        proposalNote(store.AIChangeDeleteEvent),
		},
		proposal: change,
	}
}

// toolReadComments отдаёт модели обсуждение кадра.
//
// Зачем инструмент. Без него помощник видит только текст и не знает, что просят исправить:
// «здесь провал в логике» относится к конкретным двум строкам, и угадывать их по описанию —
// ровно тот случай, когда модель перепишет не то. Лимит — 20 последних сообщений: читать
// всю переписку под кадром модели не нужно, а контекст она занимает.
func (s *Service) toolReadComments(
	ctx context.Context, userID, projectID uuid.UUID, call ai.ToolCall,
) toolResult {
	if s.comments == nil {
		return refusedCall(call, "обсуждение кадров недоступно на этом стенде")
	}
	rawID := argString(call.Arguments, "id")
	eventID, err := uuid.Parse(rawID)
	if err != nil {
		return refusedCall(call, "нужен идентификатор кадра из list_events")
	}
	list, err := s.comments.ListComments(ctx, userID, projectID, eventID, 20)
	if err != nil {
		return refusedCall(call, "не удалось прочитать обсуждение: "+err.Error())
	}
	if len(list) == 0 {
		return toolResult{
			call:   call,
			report: Call{Name: call.Name, OK: true, Detail: "в кадре нет замечаний"},
			payload: map[string]any{
				"comments": []any{},
				"note":     "обсуждения в этом кадре нет — правку фрагмента по замечанию предложить нельзя",
			},
		}
	}
	rows := make([]map[string]any, 0, len(list))
	lines := make([]string, 0, len(list))
	for _, comment := range list {
		if comment.Deleted {
			continue
		}
		row := map[string]any{
			"comment_id": comment.ID.String(),
			"author":     comment.AuthorName,
			"body":       comment.Body,
		}
		line := "#" + comment.ID.String() + " " + comment.AuthorName + ": " + comment.Body
		if anchor, aerr := s.comments.CommentAnchor(ctx, userID, projectID, comment.ID); aerr == nil && anchor != nil {
			row["quote"] = anchor.Quote
			line += " (о фрагменте: «" + anchor.Quote + "»)"
		}
		rows = append(rows, row)
		lines = append(lines, line)
	}
	return toolResult{
		call:   call,
		report: Call{Name: call.Name, OK: true, Detail: "прочитал замечания: " + fmt.Sprint(len(rows))},
		payload: map[string]any{
			"comments": rows,
			"note": "правку фрагмента предлагай по идентификатору замечания (propose_fragment_edit); " +
				"замечание к кадру целиком правится через update_event_text",
		},
	}
}

// toolProposeFragmentEdit предлагает заменить фрагмент, к которому относится замечание.
//
// Почему по замечанию, а не «где захотел». Свободная правка произвольного куска — это уже
// update_event_text целиком, и модель, которой разрешено менять любой фрагмент, рано или
// поздно перепишет не тот абзац. Привязка к замечанию даёт границы: меняется ровно то, о чём
// человек написал, и ровно на то, что он подтвердит.
//
// «Фрагмент уже другой» — отказ, а не тихое предложение: если текст изменился, человек
// должен увидеть замечание заново, а не подтверждать правку по устаревшему «было».
func (s *Service) toolProposeFragmentEdit(
	ctx context.Context, userID, projectID uuid.UUID, call ai.ToolCall,
) toolResult {
	if s.editor == nil || s.comments == nil {
		return refusedCall(call, "правка фрагмента недоступна на этом стенде")
	}
	args, err := ParseFragmentEdit(call.Arguments, s.limits)
	if err != nil {
		return refusedCall(call, err.Error())
	}
	comment, err := s.comments.CommentByID(ctx, userID, projectID, args.CommentID)
	if err != nil {
		return refusedCall(call, "замечание не найдено в этом проекте: возьмите идентификатор из read_comments")
	}
	anchor, err := s.comments.CommentAnchor(ctx, userID, projectID, args.CommentID)
	if err != nil {
		return refusedCall(call, "не удалось прочитать якорь замечания: "+err.Error())
	}
	if anchor == nil {
		return refusedCall(call, "это замечание к кадру целиком, а не к фрагменту: "+
			"правь кадр через update_event_text")
	}
	span, ok, err := s.editor.SpanText(ctx, userID, projectID, comment.EventID.String(), anchor.Field,
		anchor.Start, anchor.End)
	if err != nil {
		return refusedCall(call, "не удалось прочитать фрагмент: "+err.Error())
	}
	if !ok {
		return refusedCall(call, "фрагмент больше не находится в тексте (его удалили или переписали): "+
			"предложи человеку новое замечание к нужному месту")
	}
	if span == args.Replacement {
		return refusedCall(call, "предлагать нечего: фрагмент уже такой")
	}
	event, found := s.findEvent(ctx, projectID, comment.EventID)
	title := ""
	if found {
		title = event.Title
	}
	change, err := s.store.CreateAIChange(ctx, store.AIChange{
		ProjectID: projectID, UserID: userID,
		Kind: store.AIChangeUpdateSpan, EventID: comment.EventID, EventTitle: title,
		CommentID: &comment.ID, AnchorStart: anchor.Start, AnchorEnd: anchor.End,
		OldSpan: span, NewSpan: args.Replacement,
	})
	if err != nil {
		return refusedCall(call, "не удалось сохранить предложение: "+err.Error())
	}
	s.logger.Info("ai: предложена правка фрагмента",
		"project", projectID, "user", userID, "event", comment.EventID,
		"comment", comment.ID, "change", change.ID)

	return toolResult{
		call: call,
		report: Call{Name: call.Name, OK: true,
			Detail: "предложил правку фрагмента"},
		payload: map[string]any{
			"proposal_id": change.ID.String(),
			"event_id":    comment.EventID.String(),
			"comment_id":  comment.ID.String(),
			"old_span":    span,
			"new_span":    args.Replacement,
			"status":      "ждёт подтверждения человеком",
			"note":        proposalNote(store.AIChangeUpdateSpan),
		},
		proposal: change,
	}
}

// pickText — новое значение, если оно задано, иначе прежнее.
func pickText(next *string, current string) string {
	if next == nil {
		return current
	}
	return *next
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
// toolListEntities отдаёт модели карточки мира проекта: персонажи, места, темы.
//
// Зачем это модели. У неё есть текст кадров, но нет единого имени персонажа: в одной главе
// она напишет «Анна», в другой «Аня», и упоминания в тексте перестанут сходиться с
// карточками. Список карточек — это словарь проекта, и он дешевле, чем любые догадки.
//
// Только чтение: создание карточек — не правка одного кадра, а изменение связей во всём
// проекте, и такое решение остаётся за человеком (docs/entity-links.md §4).
func (s *Service) toolListEntities(
	ctx context.Context, userID, projectID uuid.UUID, call ai.ToolCall,
) toolResult {
	if s.world == nil {
		return refusedCall(call, "карточки мира недоступны на этом стенде")
	}
	list, err := s.world.ListEntities(ctx, userID, projectID)
	if err != nil {
		return refusedCall(call, "не удалось прочитать карточки мира: "+err.Error())
	}
	if len(list) == 0 {
		return toolResult{
			call:   call,
			report: Call{Name: call.Name, OK: true, Detail: "карточек мира нет"},
			payload: map[string]any{
				"entities": []any{},
				"note": "в проекте пока нет карточек персонажей, мест и тем — " +
					"называй героев так, как они названы в кадре, и не выдумывай новые карточки",
			},
		}
	}
	rows := make([]map[string]any, 0, len(list))
	lines := make([]string, 0, len(list))
	for _, entity := range list {
		row := map[string]any{
			"kind":        entity.Kind,
			"name":        entity.Name,
			"description": entity.Description,
		}
		line := kindLabel(entity.Kind) + " «" + entity.Name + "»"
		if len(entity.Aliases) > 0 {
			row["aliases"] = entity.Aliases
			line += " (также: " + strings.Join(entity.Aliases, ", ") + ")"
		}
		if entity.Description != "" {
			line += " — " + entity.Description
		}
		rows = append(rows, row)
		lines = append(lines, line)
	}
	return toolResult{
		call:   call,
		report: Call{Name: call.Name, OK: true, Detail: fmt.Sprintf("карточек: %d", len(rows))},
		payload: map[string]any{
			"entities": rows,
			// Строки для промпта: модель читает текст лучше, чем вложенный JSON.
			"summary": strings.Join(lines, "\n"),
		},
	}
}

// toolReadEntity отвечает на «где появляется Анна»: кадры и цитаты.
//
// Почему это ценно именно помощнику. Читая текст кадра за кадром, модель не видит линию героя;
// список кадров с цитатами даёт ей структуру, по которой можно дописать сцену, не повторяя
// то, что уже было. Имя берём из list_entities — по идентификатору модель ошибалась бы чаще.
func (s *Service) toolReadEntity(
	ctx context.Context, userID, projectID uuid.UUID, call ai.ToolCall,
) toolResult {
	if s.world == nil {
		return refusedCall(call, "карточки мира недоступны на этом стенде")
	}
	name := strings.TrimSpace(argString(call.Arguments, "name"))
	if name == "" {
		return refusedCall(call, "нужно имя карточки из list_entities")
	}
	list, err := s.world.ListEntities(ctx, userID, projectID)
	if err != nil {
		return refusedCall(call, "не удалось прочитать карточки мира: "+err.Error())
	}
	var target *store.ProjectEntity
	for i := range list {
		if strings.EqualFold(list[i].Name, name) {
			target = &list[i]
			break
		}
	}
	if target == nil {
		return refusedCall(call, fmt.Sprintf(
			"карточки «%s» нет в проекте: возьми имя из list_entities", name))
	}
	frames, err := s.world.Frames(ctx, userID, projectID, target.ID)
	if err != nil {
		return refusedCall(call, "не удалось найти упоминания: "+err.Error())
	}
	if len(frames) == 0 {
		return toolResult{
			call:   call,
			report: Call{Name: call.Name, OK: true, Detail: "упоминаний нет"},
			payload: map[string]any{
				"entity": map[string]any{"name": target.Name, "kind": target.Kind},
				"frames": []any{},
				"note": "карточка в тексте ни разу не названа — упоминаний нет; " +
					"если её знают под другим именем, добавь алиас в карточке",
			},
		}
	}
	rows := make([]map[string]any, 0, len(frames))
	lines := make([]string, 0, len(frames))
	for _, frame := range frames {
		rows = append(rows, map[string]any{
			"event_id": frame.FrameID,
			"title":    frame.Title,
			"quotes":   frame.Quotes,
		})
		lines = append(lines, fmt.Sprintf("%s — %s", frame.Title, strings.Join(frame.Quotes, ", ")))
	}
	return toolResult{
		call: call,
		report: Call{
			Name: call.Name, OK: true,
			Detail: fmt.Sprintf("кадров: %d", len(rows)),
		},
		payload: map[string]any{
			"entity":  map[string]any{"name": target.Name, "kind": target.Kind},
			"frames":  rows,
			"summary": strings.Join(lines, "; "),
		},
	}
}

// kindLabel — вид сущности по-русски (в базе и в API — английские имена).
func kindLabel(kind string) string {
	switch kind {
	case "character":
		return "персонаж"
	case "place":
		return "место"
	case "theme":
		return "тема"
	default:
		return "сущность"
	}
}

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
