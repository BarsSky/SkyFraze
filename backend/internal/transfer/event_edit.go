package transfer

// event_edit.go — перезапись текста и удаление существующего кадра.
//
// Зачем здесь, а не в помощнике. Ровно по той же причине, что и `AttachAssetToEvent`:
// источник правды проекта — CRDT-документ, и путь «правка → снапшот → проекция» должен
// быть один. Второй путь записи в документ рано или поздно разошёлся бы с первым, а
// расхождение здесь означало бы: в открытых вкладках текст новый, в базе старый (или
// наоборот), и «пропавшую» правку никто бы не объяснил.
//
// Кто вызывает. Помощник — по подтверждению человека (`ai_changes`, миграция 0015). Само
// по себе это не ограничение безопасности (права проверяются ниже, `RequireEditor`), а
// ограничение ответственности: правка чужого текста должна быть решением человека.

import (
	"context"
	"errors"
	"fmt"
	"strings"

	"github.com/google/uuid"

	"github.com/skyfraze/backend/internal/collab/yjs"
	"github.com/skyfraze/backend/internal/projects"
)

// serverDocument собирает документ проекта для правки без живой комнаты.
//
// Если снапшота нет (проект ни разу не сохранялся комнатой), документ собирается из
// реляционных строк — так же, как это делает импорт «в место». Иначе правка упала бы на
// проекте, который выглядит обычным: строки в `events` есть, снапшота нет.
func (s *Service) serverDocument(ctx context.Context, projectID uuid.UUID) (*yjs.Doc, error) {
	state, err := s.store.GetProjectEventState(ctx, projectID)
	if err != nil {
		return nil, err
	}
	var raw []byte
	if state != nil {
		raw = state.YjsState
	}
	doc, err := yjs.FromState(raw)
	if err != nil {
		return nil, err
	}
	if doc.EventCount() > 0 {
		return doc, nil
	}
	rows, err := s.store.ListEvents(ctx, projectID)
	if err != nil {
		return nil, err
	}
	legacy := make([]yjs.EventSeed, 0, len(rows))
	for _, row := range rows {
		seed := yjs.EventSeed{ID: row.ID.String(), Title: row.Title, Body: row.Body}
		if row.ParentID != nil {
			seed.ParentID = row.ParentID.String()
		}
		if row.EventDate != nil {
			seed.EventDate = row.EventDate.Format("2006-01-02")
		}
		legacy = append(legacy, seed)
	}
	if err := doc.SeedEvents(legacy); err != nil {
		return nil, err
	}
	return doc, nil
}

// UpdateEventText переписывает заголовок и/или текст кадра.
//
// `title`/`body` — указатели: nil означает «не трогать». Возвращает предупреждение
// (пустое — всё доехало): правка уже в документе, но что-то на серверной стороне не
// обновилось. Повторять запрос в этом случае нельзя — правка применится дважды.
func (s *Service) UpdateEventText(
	ctx context.Context, actorID, userID, projectID uuid.UUID,
	eventID string, title, body *string,
) (string, error) {
	if err := s.proj.RequireEditor(ctx, userID, projectID); err != nil {
		if errors.Is(err, projects.ErrForbidden) {
			return "", ErrForbidden
		}
		return "", err
	}
	if title == nil && body == nil {
		return "", errors.New("нечего менять: не задан ни заголовок, ни текст")
	}

	// Живая комната — главный путь: в ней документ, который редакторы видят сейчас.
	if s.live != nil {
		outcome, err := s.live.SetEventTextLive(ctx, projectID, actorID, eventID, title, body)
		if err != nil {
			return "", err
		}
		switch {
		case outcome.RoomLoading:
			return "", ErrMarkdownBusy
		case outcome.Handled && !outcome.Found:
			return "", ErrEventNotFound
		case outcome.Handled:
			return outcome.Warning, nil
		}
	}

	// Комнаты нет: правим снапшот и перестраиваем проекцию.
	doc, err := s.serverDocument(ctx, projectID)
	if err != nil {
		return "", err
	}
	found, err := doc.SetEventText(eventID, title, body)
	if err != nil {
		return "", err
	}
	if !found {
		return "", ErrEventNotFound
	}
	if _, err := s.store.SaveProjectEventStateServer(ctx, projectID, actorID, doc.EncodeState()); err != nil {
		// Снапшот не записался — правки нет нигде: повтор запроса безопасен.
		return "", err
	}
	if err := s.projectDocument(ctx, projectID, actorID, doc); err != nil {
		return fmt.Sprintf("текст изменён, но таблица событий не перестроена (%v) — "+
			"она обновится при следующем сохранении", err), nil
	}
	return "", nil
}

// DeleteEvent удаляет кадр проекта и возвращает его снимок.
//
// Детей у кадра быть не должно: удалить главу вместе с под-событиями — это одно нажатие,
// которое уносит больше, чем человек видит на экране. Поэтому отказ с объяснением, а не
// молчаливое удаление поддерева.
//
// Снимок возвращается наружу, а не пишется здесь: «что делать со снимком» — решение того,
// кто удаляет (сейчас — предложение помощника, ai_changes.frame). Документ же обязан
// отдать его вместе с удалением, иначе отменить удаление будет нечем.
func (s *Service) DeleteEvent(
	ctx context.Context, actorID, userID, projectID uuid.UUID, eventID string,
) (string, *yjs.RemovedEvent, error) {
	if err := s.proj.RequireEditor(ctx, userID, projectID); err != nil {
		if errors.Is(err, projects.ErrForbidden) {
			return "", nil, ErrForbidden
		}
		return "", nil, err
	}

	// Детей проверяем по проекции: она отстаёт от документа не больше чем на период
	// сохранения комнаты (5 с), а удаление — осознанное действие человека, не гонка.
	id, err := uuid.Parse(eventID)
	if err != nil {
		return "", nil, ErrEventNotFound
	}
	rows, err := s.store.ListEvents(ctx, projectID)
	if err != nil {
		return "", nil, err
	}
	for _, row := range rows {
		if row.ParentID != nil && *row.ParentID == id {
			return "", nil, ErrEventHasChildren
		}
	}

	if s.live != nil {
		gone, outcome, err := s.live.DeleteEventLive(ctx, projectID, actorID, eventID)
		if err != nil {
			return "", nil, err
		}
		switch {
		case outcome.RoomLoading:
			return "", nil, ErrMarkdownBusy
		case outcome.Handled && !outcome.Found:
			return "", nil, ErrEventNotFound
		case outcome.Handled:
			return outcome.Warning, gone, nil
		}
	}

	doc, err := s.serverDocument(ctx, projectID)
	if err != nil {
		return "", nil, err
	}
	gone, err := doc.DeleteEvent(eventID)
	if err != nil {
		return "", nil, err
	}
	if gone == nil {
		return "", nil, ErrEventNotFound
	}
	if _, err := s.store.SaveProjectEventStateServer(ctx, projectID, actorID, doc.EncodeState()); err != nil {
		return "", nil, err
	}
	if err := s.projectDocument(ctx, projectID, actorID, doc); err != nil {
		return fmt.Sprintf("кадр удалён, но таблица событий не перестроена (%v) — "+
			"она обновится при следующем сохранении", err), gone, nil
	}
	return "", gone, nil
}

// ReviveEvent возвращает удалённый кадр на прежнее место — отмена удаления.
//
// Обратная операция к DeleteEvent, и по той же причине живёт здесь: возврат кадра — это
// обычная правка документа, а не второй путь записи в базу. Вставка идёт снимком
// (yjs.RemovedEvent): идентификатор, родитель, порядок, дата, вложения, фон и created_at
// восстанавливаются как были — иначе «вернуть» значило бы «создать похожий кадр».
func (s *Service) ReviveEvent(
	ctx context.Context, actorID, userID, projectID uuid.UUID, removed yjs.RemovedEvent,
) (string, yjs.ReviveResult, error) {
	var result yjs.ReviveResult
	if err := s.proj.RequireEditor(ctx, userID, projectID); err != nil {
		if errors.Is(err, projects.ErrForbidden) {
			return "", result, ErrForbidden
		}
		return "", result, err
	}
	if strings.TrimSpace(removed.ID) == "" {
		return "", result, ErrEventNotFound
	}

	if s.live != nil {
		revived, outcome, err := s.live.ReviveEventLive(ctx, projectID, actorID, removed)
		if err != nil {
			return "", revived, err
		}
		switch {
		case outcome.RoomLoading:
			return "", revived, ErrMarkdownBusy
		case outcome.Handled && !outcome.Found:
			// Кадр уже есть: возвращать нечего. Это не ошибка человека, но и не успех —
			// говорим словами, чтобы он не искал «куда же он вернулся».
			return "", revived, ErrEventExists
		case outcome.Handled:
			if revived.Orphan {
				return orphanWarning, revived, nil
			}
			return outcome.Warning, revived, nil
		}
	}

	doc, err := s.serverDocument(ctx, projectID)
	if err != nil {
		return "", result, err
	}
	revived, err := doc.ReviveEvent(removed)
	if err != nil {
		return "", revived, err
	}
	if !revived.Inserted {
		return "", revived, ErrEventExists
	}
	if _, err := s.store.SaveProjectEventStateServer(ctx, projectID, actorID, doc.EncodeState()); err != nil {
		return "", revived, err
	}
	if err := s.projectDocument(ctx, projectID, actorID, doc); err != nil {
		return fmt.Sprintf("кадр возвращён, но таблица событий не перестроена (%v) — "+
			"она обновится при следующем сохранении", err), revived, nil
	}
	if revived.Orphan {
		return orphanWarning, revived, nil
	}
	return "", revived, nil
}

// ErrEventExists — кадр с таким идентификатором уже есть в документе.
var ErrEventExists = errors.New("кадр уже существует")

// orphanWarning — честный текст для случая «родителя удалили, кадр вернулся наверх».
const orphanWarning = "кадр вернулся главой верхнего уровня: его родителя к этому моменту " +
	"уже удалили — поставьте кадр в нужное место в дереве"

// ErrEventHasChildren — у кадра есть под-события: удалять вместе с ними нельзя.
var ErrEventHasChildren = errors.New("у кадра есть под-события")

// ReplaceSpanChecked заменяет фрагмент текста кадра, сверив его с ожидаемым.
//
// Зачем отдельный метод, а не ReplaceEventSpan «как есть». Правка по замечанию к фрагменту
// делается по предложению ассистента: между «предложил» и «применили» человек мог править
// этот же абзац. Проверка идёт по тексту фрагмента (не по времени — часы разные), и в живой
// комнате сверка с заменой идут под одной блокировкой документа: иначе между «проверили» и
// «заменили» в комнате успевают напечатать.
//
// Несовпадение текста — `yjs.ErrSpanChanged`: вызывающий превращает его в «предложение
// устарело», а не в 500.
func (s *Service) ReplaceSpanChecked(
	ctx context.Context, actorID, userID, projectID uuid.UUID,
	eventID, field string, start, end []byte, expect, replacement string,
) (string, []byte, []byte, error) {
	if err := s.proj.RequireEditor(ctx, userID, projectID); err != nil {
		if errors.Is(err, projects.ErrForbidden) {
			return "", nil, nil, ErrForbidden
		}
		return "", nil, nil, err
	}

	// Живая комната — главный путь: сверка и замена в одном шаге по документу, который
	// редакторы видят сейчас.
	if s.live != nil {
		outcome, newStart, newEnd, err := s.live.ReplaceEventSpanCheckedLive(ctx, projectID, actorID,
			eventID, field, start, end, expect, replacement)
		if err != nil {
			return "", nil, nil, err
		}
		switch {
		case outcome.RoomLoading:
			return "", nil, nil, ErrMarkdownBusy
		case outcome.Handled && !outcome.Found:
			return "", nil, nil, ErrEventNotFound
		case outcome.Handled:
			return outcome.Warning, newStart, newEnd, nil
		}
	}

	// Комнаты нет: правим снапшот и перестраиваем проекцию.
	doc, err := s.serverDocument(ctx, projectID)
	if err != nil {
		return "", nil, nil, err
	}
	span, ok := doc.ResolveSpan(eventID, field, start, end)
	if !ok {
		return "", nil, nil, ErrEventNotFound
	}
	text, ok := doc.SpanText(eventID, field, span)
	if !ok {
		return "", nil, nil, ErrEventNotFound
	}
	if text != expect {
		return "", nil, nil, yjs.ErrSpanChanged
	}
	found, err := doc.ReplaceEventSpan(eventID, field, span.From, span.To, replacement)
	if err != nil {
		return "", nil, nil, err
	}
	if !found {
		return "", nil, nil, ErrEventNotFound
	}
	// Якорь на НОВЫЙ текст: прежний после Delete+Insert либо схлопнулся, либо перестал
	// разрешаться (измерено в docs/fragment-comments.md §4), и «Вернуть» по нему не сработает.
	newStart, newEnd, _ := doc.AnchorSpan(eventID, field, span.From,
		span.From+yjs.UTF16Len(replacement))
	if _, err := s.store.SaveProjectEventStateServer(ctx, projectID, actorID, doc.EncodeState()); err != nil {
		return "", nil, nil, err
	}
	if err := s.projectDocument(ctx, projectID, actorID, doc); err != nil {
		return fmt.Sprintf("фрагмент изменён, но таблица событий не перестроена (%v) — "+
			"она обновится при следующем сохранении", err), newStart, newEnd, nil
	}
	return "", newStart, newEnd, nil
}

// SpanText читает текущий текст фрагмента по якорю (viewer+).
//
// Нужно помощнику: прежде чем предлагать правку фрагмента, надо показать человеку «было».
// Живая комната — свежий документ; без неё читаем снапшот (он отстаёт до 5 с, и это
// нормально: предложение всё равно проверится по тексту при применении).
func (s *Service) SpanText(
	ctx context.Context, userID, projectID uuid.UUID, eventID, field string, start, end []byte,
) (string, bool, error) {
	if err := s.proj.RequireViewer(ctx, userID, projectID); err != nil {
		if errors.Is(err, projects.ErrForbidden) {
			return "", false, ErrForbidden
		}
		return "", false, err
	}
	if s.live != nil {
		if doc := s.live.DocForRead(ctx, projectID); doc != nil {
			span, ok := doc.ResolveSpan(eventID, field, start, end)
			if !ok {
				return "", false, nil
			}
			text, ok := doc.SpanText(eventID, field, span)
			return text, ok, nil
		}
	}
	doc, err := s.serverDocument(ctx, projectID)
	if err != nil {
		return "", false, err
	}
	span, ok := doc.ResolveSpan(eventID, field, start, end)
	if !ok {
		return "", false, nil
	}
	text, ok := doc.SpanText(eventID, field, span)
	return text, ok, nil
}
