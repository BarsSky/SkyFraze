package transfer

// asset_attach.go — привязать вложение к существующему кадру.
//
// Зачем это здесь, а не в помощнике. Источник правды проекта — CRDT-документ, и путь
// «правка → снапшот → проекция» один на всех: у импорта «в место» он уже описан и
// отлажен (живая комната впереди, снапшот при её отсутствии). Если бы помощник писал
// вложения своим способом, появился бы второй путь записи в документ — и рано или поздно
// он разошёлся бы с первым (ровно та причина, по которой создание кадров идёт через
// ImportMarkdownInto).
//
// Порядок важен: сначала файл сохраняется в проект (assets.Service), и только потом
// появляется привязка. Обратный порядок оставил бы в документе ссылку на файл, которого
// нет, — кадр показывал бы пустое место.

import (
	"context"
	"errors"
	"fmt"

	"github.com/google/uuid"

	"github.com/skyfraze/backend/internal/collab/yjs"
	"github.com/skyfraze/backend/internal/projects"
)

// ErrEventNotFound — кадра с таким идентификатором в проекте нет.
var ErrEventNotFound = errors.New("кадр не найден в этом проекте")

// AttachAssetToEvent привязывает вложение к кадру и, если попросили, делает его фоном.
//
// Возвращает предупреждение (пустое — всё в порядке): привязка сделана, но что-то на
// серверной стороне не доехало. Это не ошибка запроса — картинка уже в документе, и
// повторять привязку не нужно.
func (s *Service) AttachAssetToEvent(
	ctx context.Context, actorID, userID, projectID uuid.UUID,
	eventID, assetID string, asBackground bool,
) (string, error) {
	if err := s.proj.RequireEditor(ctx, userID, projectID); err != nil {
		if errors.Is(err, projects.ErrForbidden) {
			return "", ErrForbidden
		}
		return "", err
	}

	// Живая комната — главный путь: в ней документ, который редакторы видят сейчас.
	if s.live != nil {
		outcome, err := s.live.AttachAssetLive(ctx, projectID, actorID, eventID, assetID, asBackground)
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

	// Комнаты нет (никто не открывал проект): правим снапшот и перестраиваем проекцию.
	state, err := s.store.GetProjectEventState(ctx, projectID)
	if err != nil {
		return "", err
	}
	var raw []byte
	if state != nil {
		raw = state.YjsState
	}
	doc, err := yjs.FromState(raw)
	if err != nil {
		return "", err
	}
	// У проекта может не быть снапшота: тогда документ собираем из реляционных строк —
	// так же, как это делает импорт «в место».
	if doc.EventCount() == 0 {
		rows, err := s.store.ListEvents(ctx, projectID)
		if err != nil {
			return "", err
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
			return "", err
		}
	}

	found, err := doc.AttachAsset(eventID, assetID, asBackground)
	if err != nil {
		return "", err
	}
	if !found {
		return "", ErrEventNotFound
	}
	if _, err := s.store.SaveProjectEventStateServer(ctx, projectID, actorID, doc.EncodeState()); err != nil {
		// Снапшот не записался — привязки нет нигде: повтор запроса безопасен.
		return "", err
	}
	if err := s.projectDocument(ctx, projectID, actorID, doc); err != nil {
		return fmt.Sprintf("картинка привязана, но таблица событий не перестроена (%v) — "+
			"она обновится при следующем сохранении", err), nil
	}
	return "", nil
}
