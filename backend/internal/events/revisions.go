package events

// revisions.go — история версий проекта (миграция 0016).
//
// Зачем. До этого у проекта был ОДИН снапшот, и он перезаписывался: всё, что было до,
// жило только в памяти живой комнаты. Ни CRDT, ни копии этого не заменяют — CRDT сливает
// правки и не отменяет их, а копии снимаются раз в сутки и лежат файлами.
//
// Три вещи, которые здесь решаются и которые легко сделать неправильно:
//
//  1. **Когда снимать автоснимок.** Не на каждую правку (тогда «история» превратится в
//     ленту нажатий клавиш) и не по расписанию (тогда версия «в 3:00» бесполезна). Берём
//     троттлинг по времени: не чаще одного автоснимка в интервал, и только если содержимое
//     изменилось (сверка контрольной суммы).
//  2. **Восстановление — это правка, а не замена файла.** В Yjs нельзя подменить документ:
//     клиент с более новыми правками пришлёт их обратно. Поэтому документ приводится к
//     целевому состоянию обычными операциями (см. yjs.Doc.Restore) и уходит клиентам
//     обычным апдейтом.
//  3. **Удержание.** Снапшот каталога промптов — 361 КБ; «снимок раз в 5 минут без
//     удержания» за неделю дал бы гигабайты. Предел по количеству и по объёму считается
//     при каждой вставке (store.TrimProjectRevisions).

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"time"

	"github.com/google/uuid"

	"github.com/skyfraze/backend/internal/collab/yjs"
	"github.com/skyfraze/backend/internal/projects"
	"github.com/skyfraze/backend/internal/store"
)

// RevisionPolicy — как часто снимать автоснимки и сколько версий держать.
type RevisionPolicy struct {
	// Interval — минимальный промежуток между автоснимками одного проекта.
	Interval time.Duration
	// Keep — сколько версий хранить на проект (0 — без предела по количеству).
	Keep int
	// MaxBytes — предел суммы снапшотов версий на проект (0 — без предела).
	MaxBytes int64
}

// DefaultRevisionPolicy — значения по умолчанию: раз в 5 минут, 100 версий, 32 МиБ.
//
// Пять минут — компромисс: чаще не нужно (человек не пишет быстрее, чем успевает
// заметить «верни как было пять минут назад»), реже — теряется смысл «часа назад».
func DefaultRevisionPolicy() RevisionPolicy {
	return RevisionPolicy{Interval: 5 * time.Minute, Keep: 100, MaxBytes: 32 << 20}
}

// UseRevisionPolicy заменяет настройки истории версий (main читает их из окружения).
func (s *Service) UseRevisionPolicy(p RevisionPolicy) {
	if p.Interval <= 0 {
		p.Interval = DefaultRevisionPolicy().Interval
	}
	s.revisions = p
}

// LiveRestore — приведение документа живой комнаты к состоянию версии (реализует хаб).
//
// Интерфейс, а не прямая зависимость: events не должен тащить транспорт, как и transfer
// (см. transfer.LiveDoc). Второй результат — «комната сделала работу»; false означает
// «комнаты нет, правь снапшот сам».
type LiveRestore interface {
	// RestoreLive приводит документ живой комнаты к версии. handled=false — комнаты нет,
	// и вызывающий правит снапшот сам.
	RestoreLive(ctx context.Context, projectID, by uuid.UUID, target []yjs.EventFull) (yjs.RestoreResult, bool, error)
	// LiveState — текущее состояние документа комнаты (пусто — комнаты нет). Нужно
	// ручной версии: снимать надо то, что видят редакторы сейчас, а не прошлый снапшот.
	LiveState(ctx context.Context, projectID uuid.UUID) []byte
}

// UseLiveRestore подключает живые комнаты для восстановления версий.
func (s *Service) UseLiveRestore(live LiveRestore) { s.liveRestore = live }

// MaybeSaveRevision снимает автоснимок, если пришло время.
//
// Вызывается из живой комнаты после успешного сохранения снапшота: состояние уже
// закодировано, и второе кодирование того же документа было бы лишней работой.
func (s *Service) MaybeSaveRevision(ctx context.Context, projectID, by uuid.UUID, state []byte) {
	if len(state) == 0 || s.revisions.Interval <= 0 {
		return
	}
	last, err := s.store.LastProjectRevision(ctx, projectID)
	if err != nil && !errors.Is(err, store.ErrNotFound) {
		return
	}
	checksum := revisionChecksum(state)
	if last != nil {
		if time.Since(last.CreatedAt) < s.revisions.Interval {
			return
		}
		// Содержимое не изменилось с прошлой версии — вторая копия ничего не добавит.
		if last.Checksum == checksum {
			return
		}
	}
	s.saveRevision(ctx, projectID, by, state, store.RevisionAuto, "")
}

// SaveRevision — ручная версия («Сохранить версию»): снимается всегда, без троттлинга.
func (s *Service) SaveRevision(
	ctx context.Context, userID, projectID uuid.UUID, label string,
) (*store.ProjectRevision, error) {
	if err := s.proj.RequireEditor(ctx, userID, projectID); err != nil {
		return nil, err
	}
	state, err := s.currentState(ctx, projectID)
	if err != nil {
		return nil, err
	}
	if len(state) == 0 {
		return nil, errors.New("в проекте пока нет документа — сохранять нечего")
	}
	rev, err := s.store.CreateProjectRevision(ctx, store.ProjectRevision{
		ProjectID: projectID, Events: countEvents(state),
		Checksum: revisionChecksum(state), Kind: store.RevisionManual,
		Label: label, CreatedBy: &userID,
	}, state)
	if err != nil {
		return nil, err
	}
	s.trimRevisions(ctx, projectID)
	return rev, nil
}

// saveRevision — общая вставка версии (авто и ручная идут одним путём).
func (s *Service) saveRevision(
	ctx context.Context, projectID, by uuid.UUID, state []byte, kind, label string,
) {
	var createdBy *uuid.UUID
	if by != uuid.Nil {
		createdBy = &by
	}
	if _, err := s.store.CreateProjectRevision(ctx, store.ProjectRevision{
		ProjectID: projectID, Events: countEvents(state),
		Checksum: revisionChecksum(state), Kind: kind, Label: label, CreatedBy: createdBy,
	}, state); err != nil {
		// История версий — не критичный путь: сбой её записи не должен ломать сохранение
		// проекта, поэтому здесь только лог.
		s.logger.Warn("events: версия не сохранена", "project", projectID, "err", err)
		return
	}
	s.trimRevisions(ctx, projectID)
}

func (s *Service) trimRevisions(ctx context.Context, projectID uuid.UUID) {
	policy := s.revisions
	if policy.Keep <= 0 && policy.MaxBytes <= 0 {
		return
	}
	if err := s.store.TrimProjectRevisions(ctx, projectID, policy.Keep, policy.MaxBytes); err != nil {
		s.logger.Warn("events: удержание версий не сработало", "project", projectID, "err", err)
	}
}

// ListRevisions — версии проекта без снапшотов (viewer+: историю видит любой участник,
// кто читает проект; менять её может только редактор).
func (s *Service) ListRevisions(
	ctx context.Context, userID, projectID uuid.UUID, limit int,
) ([]store.ProjectRevision, error) {
	if err := s.proj.RequireViewer(ctx, userID, projectID); err != nil {
		return nil, err
	}
	return s.store.ListProjectRevisions(ctx, projectID, limit)
}

// RevisionPreview — что было в версии: дерево кадров и счётчики.
//
// Предпросмотр считается разбором снапшота: показывать «восстановить?» без того, что
// именно вернётся, — значит просить нажать кнопку вслепую.
type RevisionPreview struct {
	Revision store.ProjectRevision `json:"version"`
	// Frames — кадры в порядке отображения: уровень, заголовок, дата, длина текста.
	Frames []RevisionFrame `json:"frames"`
	// Chars — сколько всего знаков текста в версии (объём, а не число кадров).
	Chars int `json:"chars"`
}

// RevisionFrame — один кадр в предпросмотре.
type RevisionFrame struct {
	ID    uuid.UUID `json:"id"`
	Depth int       `json:"depth"`
	Title string    `json:"title"`
	Date  string    `json:"date,omitempty"`
	Chars int       `json:"chars"`
}

// RevisionPreview отдаёт дерево версии.
func (s *Service) RevisionPreview(
	ctx context.Context, userID, projectID, revisionID uuid.UUID,
) (*RevisionPreview, error) {
	if err := s.proj.RequireViewer(ctx, userID, projectID); err != nil {
		return nil, err
	}
	rev, state, err := s.store.ProjectRevisionByID(ctx, projectID, revisionID)
	if err != nil {
		return nil, err
	}
	doc, err := yjs.FromState(state)
	if err != nil {
		return nil, fmt.Errorf("версия не читается: %w", err)
	}
	frames, chars := previewFrames(doc.EventsFull())
	return &RevisionPreview{Revision: rev, Frames: frames, Chars: chars}, nil
}

// previewFrames переводит кадры документа в дерево предпросмотра.
func previewFrames(events []yjs.EventFull) ([]RevisionFrame, int) {
	byID := make(map[string]yjs.EventFull, len(events))
	for _, event := range events {
		byID[event.ID] = event
	}
	depthOf := func(event yjs.EventFull) int {
		level := 0
		cur := event
		for cur.ParentID != "" && level < 64 {
			next, ok := byID[cur.ParentID]
			if !ok {
				break
			}
			level++
			cur = next
		}
		return level
	}
	out := make([]RevisionFrame, 0, len(events))
	chars := 0
	for _, event := range events {
		frame := RevisionFrame{Depth: depthOf(event), Title: event.Title, Date: event.EventDate}
		if id, err := uuid.Parse(event.ID); err == nil {
			frame.ID = id
		}
		frame.Chars = len([]rune(event.Body))
		chars += frame.Chars
		out = append(out, frame)
	}
	return out, chars
}

// DeleteRevision удаляет версию (editor+): история — часть проекта, а не личная закладка.
func (s *Service) DeleteRevision(ctx context.Context, userID, projectID, revisionID uuid.UUID) error {
	if err := s.proj.RequireEditor(ctx, userID, projectID); err != nil {
		return err
	}
	return s.store.DeleteProjectRevision(ctx, projectID, revisionID)
}

// RestoreOutcome — что вернулось при восстановлении версии.
type RestoreOutcome struct {
	Removed int    `json:"removed"`
	Added   int    `json:"added"`
	Updated int    `json:"updated"`
	Moved   int    `json:"moved"`
	Warning string `json:"warning,omitempty"`
}

// RestoreRevision приводит проект к состоянию версии.
//
// Права: editor+ (восстановление меняет проект). Восстановление — обычная правка, поэтому
// открытые вкладки видят результат сразу, без перезагрузки.
func (s *Service) RestoreRevision(
	ctx context.Context, actorID, userID, projectID, revisionID uuid.UUID,
) (*RestoreOutcome, error) {
	if err := s.proj.RequireEditor(ctx, userID, projectID); err != nil {
		return nil, err
	}
	_, state, err := s.store.ProjectRevisionByID(ctx, projectID, revisionID)
	if err != nil {
		return nil, err
	}
	source, err := yjs.FromState(state)
	if err != nil {
		return nil, fmt.Errorf("версия не читается: %w", err)
	}
	target := source.EventsFull()
	if len(target) == 0 {
		return nil, errors.New("в этой версии нет кадров — восстанавливать нечего")
	}
	if actorID == uuid.Nil {
		actorID = userID
	}

	// 1. Живая комната — главный путь: там документ, который видят редакторы.
	if s.liveRestore != nil {
		result, handled, err := s.liveRestore.RestoreLive(ctx, projectID, actorID, target)
		if err != nil {
			return nil, err
		}
		if handled {
			return outcomeOf(result, ""), nil
		}
	}

	// 2. Комнаты нет: правим снапшот и перестраиваем проекцию — как это делает импорт.
	doc, err := s.currentDocument(ctx, projectID)
	if err != nil {
		return nil, err
	}
	result, err := doc.Restore(target)
	if err != nil {
		return nil, err
	}
	if !result.Changed() {
		return outcomeOf(result, "проект уже в этом состоянии — менять нечего"), nil
	}
	if _, err := s.store.SaveProjectEventStateServer(ctx, projectID, actorID, doc.EncodeState()); err != nil {
		return nil, err
	}
	warning := ""
	if err := s.projectFromDoc(ctx, projectID, actorID, doc); err != nil {
		warning = "текст восстановлен, но таблица событий не перестроена (%v) — " +
			"она обновится при следующем сохранении"
		warning = fmt.Sprintf(warning, err)
	}
	return outcomeOf(result, warning), nil
}

// currentState — текущее состояние документа проекта: из комнаты, если она есть, иначе
// из снапшота (или собранное из проекции, если снапшота нет вовсе).
func (s *Service) currentState(ctx context.Context, projectID uuid.UUID) ([]byte, error) {
	if s.liveRestore != nil {
		if live := s.liveRestore.LiveState(ctx, projectID); len(live) > 0 {
			return live, nil
		}
	}
	doc, err := s.currentDocument(ctx, projectID)
	if err != nil {
		return nil, err
	}
	if doc.EventCount() == 0 {
		return nil, nil
	}
	return doc.EncodeState(), nil
}

// currentDocument — документ проекта из снапшота, а при его отсутствии из проекции.
func (s *Service) currentDocument(ctx context.Context, projectID uuid.UUID) (*yjs.Doc, error) {
	st, err := s.store.GetProjectEventState(ctx, projectID)
	if err != nil {
		return nil, err
	}
	var raw []byte
	if st != nil {
		raw = st.YjsState
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
	seeds := make([]yjs.EventSeed, 0, len(rows))
	for _, row := range rows {
		seed := yjs.EventSeed{ID: row.ID.String(), Title: row.Title, Body: row.Body}
		if row.ParentID != nil {
			seed.ParentID = row.ParentID.String()
		}
		if row.EventDate != nil {
			seed.EventDate = row.EventDate.Format("2006-01-02")
		}
		seeds = append(seeds, seed)
	}
	if err := doc.SeedEvents(seeds); err != nil {
		return nil, err
	}
	return doc, nil
}

// projectFromDoc перестраивает таблицу событий из документа.
func (s *Service) projectFromDoc(ctx context.Context, projectID, by uuid.UUID, doc *yjs.Doc) error {
	nodes := make([]NodeInput, 0)
	for _, event := range doc.Events() {
		id, err := uuid.Parse(event.ID)
		if err != nil {
			continue
		}
		node := NodeInput{
			ID: id, Position: event.Position, Title: event.Title, Body: event.Body,
		}
		if event.ParentID != "" {
			if parent, err := uuid.Parse(event.ParentID); err == nil {
				node.ParentID = &parent
			}
		}
		if event.EventDate != "" {
			if date, err := time.Parse("2006-01-02", event.EventDate); err == nil {
				node.EventDate = EventDatePatch{Value: &date, Set: true}
			}
		}
		nodes = append(nodes, node)
	}
	return s.ProjectTreeServer(ctx, projectID, by, nodes)
}

// outcomeOf переводит результат документа в ответ для интерфейса.
func outcomeOf(result yjs.RestoreResult, warning string) *RestoreOutcome {
	return &RestoreOutcome{
		Removed: result.Removed, Added: result.Added, Updated: result.Updated,
		Moved: result.Moved, Warning: warning,
	}
}

// revisionChecksum — короткий отпечаток снапшота: нужен, чтобы автоснимок не плодил
// версии, когда содержимое не менялось.
func revisionChecksum(state []byte) string {
	sum := sha256.Sum256(state)
	return hex.EncodeToString(sum[:16])
}

// countEvents — сколько кадров в снапшоте (для списка версий, без полного разбора).
func countEvents(state []byte) int {
	doc, err := yjs.FromState(state)
	if err != nil {
		return 0
	}
	return doc.EventCount()
}

// ErrForbiddenRevision — проект чужой или прав нет (общая ошибка projects.ErrForbidden).
var ErrForbiddenRevision = projects.ErrForbidden
