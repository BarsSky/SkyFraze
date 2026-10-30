package collab

// adopt.go — слепая комната доливает к себе документ из базы (0.140.3).
//
// Что было. Комната загружает документ из снапшота один раз, в `ensureDoc`. Если в этот
// момент снапшота в базе ещё нет (проект только что создан, а главу пишет помощник или
// REST-путь), комната остаётся пустой — и это не «проект пуст», а незнание. Дальше:
//
//   - правки клиентов приходят дельтами и ссылаются на структуры, которых в документе
//     комнаты нет: Yjs принимает их без ошибки и держит в очереди, поэтому и ack уходил
//     (клиент считал правку сохранённой), и текст в серверном документе не появлялся;
//   - тик комнаты писал в базу пустое состояние и пустую проекцию — так в CI пропала глава,
//     созданная помощником, после перезагрузки страницы (одна потеря на много прогонов).
//
// Что теперь. Пока комната слепа (`blind()`), она:
//   1) перед любой записью и перед приёмом правки доливает к себе документ из базы
//      (`adoptBase`) — слияние Yjs идемпотентно, поэтому это безопасно повторять;
//   2) не пишет в базу, если после доливки всё ещё пуста (значит, база держит кадры только
//      в таблице, а комната их не видела) — писать пустоту поверх нельзя.
//
// Почему не «засеять документ из таблицы». Строки таблицы дают те же id кадров, но другие
// структуры CRDT: у каждого клиента своя копия, и правки перестают сливаться (две ветки на
// один документ). Поэтому единственный источник, который можно безопасно доливать, — тот же
// снапшот, который получили клиенты.

import (
	"context"
	"log/slog"

	"github.com/skyfraze/backend/internal/collab/yjs"
	"github.com/skyfraze/backend/internal/events"
)

// adoptBase доливает в документ комнаты состояние из базы, если комната его не видела.
//
// Возвращает true, если после доливки в документе появились кадры. Ошибку не возвращает:
// неудача доливки не должна ломать обработку правки — она лишь оставляет комнату слепой,
// а запись в базу в этом состоянии запрещена отдельно.
func (r *Room) adoptBase(ctx context.Context, ev *events.Service, logger *slog.Logger) bool {
	if !r.blind() {
		return r.hasEvents()
	}
	state, err := ev.YjsStateServer(ctx, r.projectID)
	if err != nil {
		logger.Warn("collab: cannot read base snapshot", "project", r.projectID, "err", err)
		return false
	}
	if len(state) == 0 {
		return false
	}
	base, err := yjs.FromState(state)
	if err != nil {
		logger.Warn("collab: base snapshot unreadable", "project", r.projectID, "err", err)
		return false
	}
	if base.EventCount() == 0 {
		return false
	}

	r.docMu.Lock()
	if r.doc == nil {
		r.docMu.Unlock()
		return false
	}
	before := r.doc.StateVector()
	if err := r.doc.Apply(state); err != nil {
		r.docMu.Unlock()
		logger.Warn("collab: base snapshot merge failed", "project", r.projectID, "err", err)
		return false
	}
	merged := r.doc.EventCount()
	// Комната теперь видела эти кадры: иначе защита от записи пустоты включалась бы вечно.
	r.loadedEvents = merged
	r.migratedEvents = merged
	r.dirty = true
	update, diffErr := r.doc.Diff(before)
	r.docMu.Unlock()

	if diffErr == nil && len(update) > 0 {
		// Вкладки получают недостающее состояние. У кого-то оно уже есть — повторное
		// применение Yjs-апдейта безвредно.
		r.broadcast(nil, update)
	}
	if merged > 0 {
		// Логируем только успешную доливку: у проекта, где кадры живут лишь в таблице
		// (импорт без CRDT), комната остаётся слепой до состояния от клиента, и запись
		// «проверила, доливать нечего» каждые 5 секунд была бы шумом.
		logger.Warn("collab: blind room adopted base document", "project", r.projectID, "events", merged)
	}
	return merged > 0
}

// hasEvents — есть ли у комнаты кадры в документе.
func (r *Room) hasEvents() bool {
	r.docMu.Lock()
	defer r.docMu.Unlock()
	return r.doc != nil && r.doc.EventCount() > 0
}
