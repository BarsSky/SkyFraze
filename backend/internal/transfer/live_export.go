package transfer

// live_export.go — выгрузка «как видят редакторы» (0.138.0).
//
// Зачем. Текст проекта живёт в двух местах: в CRDT-документе живой комнаты (там его видят
// открытые вкладки) и в реляционной проекции таблицы `events` (её строит сервер из своего
// документа). Проекция обновляется тиком комнаты — раз в несколько секунд, — и пока она не
// обновилась, `/export.md`, книга и архив показывали ПРОШЛЫЙ текст. Именно это ловил ночной
// e2e: «маркеры DOCX не доехали до /export.md за 120 секунд», хотя в редакторе они были.
//
// Как решено. Если в этом процессе есть живая комната проекта, выгрузка берёт строки из её
// документа, а не из таблицы. Комнаты нет (никто не открывал проект, или он живёт в другом
// процессе) — работает прежний путь: проекция и снапшот базы.
//
// Почему не «просто обновлять проекцию чаще». Тик пишет ещё и снапшот, и таблицу целиком;
// частить им — платить за каждую букву. Читателю же нужно не «свежая таблица», а «тот текст,
// который сейчас в документе», — его и берём напрямую.

import (
	"context"

	"github.com/google/uuid"

	"github.com/skyfraze/backend/internal/collab/yjs"
	"github.com/skyfraze/backend/internal/store"
)

// LiveState — состояние документа живой комнаты проекта.
//
// Интерфейс, а не зависимость на транспорт: transfer не должен тащить websocket-хаб (так же
// устроены `LiveDoc` для импорта и `events.LiveRestore`). Пусто — комнаты нет.
type LiveState interface {
	LiveState(ctx context.Context, projectID uuid.UUID) []byte
}

// UseLiveState подключает живые комнаты к выгрузке.
func (s *Service) UseLiveState(live LiveState) { s.liveState = live }

// eventsFromLiveDoc — строки проекта из документа комнаты, в том же виде, в каком их ждёт
// сборка книги (`newStory` → `events.BuildTree`). Поля, которых нет в документе (автор,
// время), остаются пустыми: выгрузке они не нужны.
func eventsFromLiveDoc(state []byte, projectID uuid.UUID) ([]store.Event, bool) {
	if len(state) == 0 {
		return nil, false
	}
	doc, err := yjs.FromState(state)
	if err != nil {
		return nil, false
	}
	rows := doc.Events()
	if len(rows) == 0 {
		return nil, false
	}
	out := make([]store.Event, 0, len(rows))
	for _, row := range rows {
		id, err := uuid.Parse(row.ID)
		if err != nil {
			// Битая строка в документе не повод ронять выгрузку: пропускаем её.
			continue
		}
		var parent *uuid.UUID
		if row.ParentID != "" {
			if parsed, err := uuid.Parse(row.ParentID); err == nil {
				parent = &parsed
			}
		}
		out = append(out, store.Event{
			ID:        id,
			ProjectID: projectID,
			ParentID:  parent,
			Position:  row.Position,
			Title:     row.Title,
			Body:      row.Body,
		})
	}
	if len(out) == 0 {
		return nil, false
	}
	return out, true
}
