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

// DeleteEvent удаляет кадр проекта.
//
// Детей у кадра быть не должно: удалить главу вместе с под-событиями — это одно нажатие,
// которое уносит больше, чем человек видит на экране. Поэтому отказ с объяснением, а не
// молчаливое удаление поддерева.
func (s *Service) DeleteEvent(
	ctx context.Context, actorID, userID, projectID uuid.UUID, eventID string,
) (string, error) {
	if err := s.proj.RequireEditor(ctx, userID, projectID); err != nil {
		if errors.Is(err, projects.ErrForbidden) {
			return "", ErrForbidden
		}
		return "", err
	}

	// Детей проверяем по проекции: она отстаёт от документа не больше чем на период
	// сохранения комнаты (5 с), а удаление — осознанное действие человека, не гонка.
	id, err := uuid.Parse(eventID)
	if err != nil {
		return "", ErrEventNotFound
	}
	rows, err := s.store.ListEvents(ctx, projectID)
	if err != nil {
		return "", err
	}
	for _, row := range rows {
		if row.ParentID != nil && *row.ParentID == id {
			return "", ErrEventHasChildren
		}
	}

	if s.live != nil {
		outcome, err := s.live.DeleteEventLive(ctx, projectID, actorID, eventID)
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

	doc, err := s.serverDocument(ctx, projectID)
	if err != nil {
		return "", err
	}
	found, err := doc.DeleteEvent(eventID)
	if err != nil {
		return "", err
	}
	if !found {
		return "", ErrEventNotFound
	}
	if _, err := s.store.SaveProjectEventStateServer(ctx, projectID, actorID, doc.EncodeState()); err != nil {
		return "", err
	}
	if err := s.projectDocument(ctx, projectID, actorID, doc); err != nil {
		return fmt.Sprintf("кадр удалён, но таблица событий не перестроена (%v) — "+
			"она обновится при следующем сохранении", err), nil
	}
	return "", nil
}

// ErrEventHasChildren — у кадра есть под-события: удалять вместе с ними нельзя.
var ErrEventHasChildren = errors.New("у кадра есть под-события")
