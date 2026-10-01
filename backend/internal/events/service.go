package events

import (
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/google/uuid"

	"github.com/skyfraze/backend/internal/projects"
	"github.com/skyfraze/backend/internal/store"
)

// ErrForbidden — нет прав на запись (роль ниже editor).
var ErrForbidden = errors.New("forbidden")

// CreateInput — создание события (id можно задать клиентом: CRDT генерирует UUID).
type CreateInput struct {
	ID        uuid.UUID  `json:"id"`
	ParentID  *uuid.UUID `json:"parent_id"`
	Title     string     `json:"title"`
	Body      string     `json:"body"`
	EventDate *time.Time `json:"event_date"`
}

// ContentInput — частичное обновление содержимого (nil-поля не меняются).
type ContentInput struct {
	Title     *string    `json:"title"`
	Body      *string    `json:"body"`
	EventDate *time.Time `json:"event_date"`
}

// MoveInput — перенос события к другому родителю и/или на другую позицию.
type MoveInput struct {
	ParentID *uuid.UUID `json:"parent_id"`
	Position *int       `json:"position"`
}

type Service struct {
	store *store.Store
	proj  *projects.Service
}

func New(s *store.Store, proj *projects.Service) *Service {
	return &Service{store: s, proj: proj}
}

// GetYjsState — последний CRDT-снапшот проекта и его ревизия (чтение: viewer+).
func (s *Service) GetYjsState(ctx context.Context, userID, projectID uuid.UUID) ([]byte, int64, error) {
	if err := s.proj.RequireViewer(ctx, userID, projectID); err != nil {
		return nil, 0, err
	}
	st, err := s.store.GetProjectEventState(ctx, projectID)
	if err != nil {
		return nil, 0, err
	}
	if st == nil {
		return nil, 0, nil
	}
	return st.YjsState, st.Revision, nil
}

// YjsStateServer — снапшот проекта без проверки прав: он нужен серверу для
// собственных решений, а не человеку. Так удаление вложения узнаёт, прикреплён ли
// файл к кадрам, когда комнаты нет (см. collab.Hub.AssetUsage).
func (s *Service) YjsStateServer(ctx context.Context, projectID uuid.UUID) ([]byte, error) {
	st, err := s.store.GetProjectEventState(ctx, projectID)
	if err != nil {
		return nil, err
	}
	if st == nil {
		return nil, nil
	}
	return st.YjsState, nil
}

// SaveYjsState записывает снапшот. Нужны роль editor+ и актуальная базовая
// ревизия: при расхождении возвращается store.ErrRevisionConflict, клиент
// перечитывает состояние и повторяет (CRDT-merge не теряет правки).
func (s *Service) SaveYjsState(
	ctx context.Context, userID, projectID uuid.UUID, state []byte, baseRevision int64,
) (int64, error) {
	if err := s.proj.RequireEditor(ctx, userID, projectID); err != nil {
		return 0, err
	}
	return s.store.SaveProjectEventState(ctx, projectID, userID, state, baseRevision)
}

// CanEdit — может ли пользователь менять проект.
//
// Нужен хабу: апдейты от клиента применяются к серверному документу ТОЛЬКО от тех,
// кто вправе писать. Иначе наблюдатель обошёл бы проверку прав: REST-ручки его не
// пускают, а правка через CRDT-апдейт попала бы в снапшот и разошлась всем.
func (s *Service) CanEdit(ctx context.Context, userID, projectID uuid.UUID) bool {
	return s.proj.RequireEditor(ctx, userID, projectID) == nil
}

// SaveYjsStateServer — запись слитого состояния сервером (Фаза 3).
//
// В отличие от SaveYjsState базовая ревизия не проверяется: у серверного писателя
// нет конкурентов, он и есть автор снапшота. Права проверяет вызывающий: сюда
// попадает только то, что уже слито из апдейтов клиентов с правом записи.
func (s *Service) SaveYjsStateServer(
	ctx context.Context, projectID, by uuid.UUID, state []byte,
) (int64, error) {
	return s.store.SaveProjectEventStateServer(ctx, projectID, by, state)
}

// ProjectTreeServer — проекция дерева из серверного документа (Фаза 4).
//
// Правила те же, что у клиентской проекции (`SyncTree`): нормализация проверяет
// циклы, глубину и дубликаты id. Отличий два: базовая ревизия не проверяется
// (пишет сервер, конкурентов нет) и устаревший клиент сюда попасть не может —
// payload строится из слитого документа, а не из чужой локальной копии.
func (s *Service) ProjectTreeServer(ctx context.Context, projectID, by uuid.UUID, nodes []NodeInput) error {
	normalized, err := NormalizeTree(nodes)
	if err != nil {
		return err
	}
	rows := make([]store.Event, 0, len(normalized))
	for _, n := range normalized {
		rows = append(rows, store.Event{
			ID:        n.ID,
			ProjectID: projectID,
			ParentID:  n.ParentID,
			Position:  n.Position,
			Depth:     n.Depth,
			Title:     n.Title,
			Body:      n.Body,
			EventDate: n.EventDate.Value,
			// Даты из документа приходят всегда строкой «YYYY-MM-DD» или пустой —
			// значит поле авторитетно, и пустое значение здесь очищает дату.
			EventDateSet: true,
			CreatedBy:    &by,
			UpdatedBy:    &by,
		})
	}
	return s.store.ReplaceEventTree(ctx, projectID, by, rows)
}

// ListTree — дерево событий проекта (чтение: viewer+).
func (s *Service) ListTree(ctx context.Context, userID, projectID uuid.UUID) ([]TreeEvent, error) {
	if err := s.proj.RequireViewer(ctx, userID, projectID); err != nil {
		return nil, err
	}
	evs, err := s.store.ListEvents(ctx, projectID)
	if err != nil {
		return nil, err
	}
	return BuildTree(evs), nil
}

// CreateEvent — новое событие (запись: editor+). Родитель проверяется на
// существование в этом же проекте, глубина ограничена MaxDepth.
func (s *Service) CreateEvent(
	ctx context.Context, userID, projectID uuid.UUID, in CreateInput,
) (*store.Event, error) {
	if err := s.proj.RequireEditor(ctx, userID, projectID); err != nil {
		return nil, err
	}
	evs, err := s.store.ListEvents(ctx, projectID)
	if err != nil {
		return nil, err
	}

	var depth int16
	position := 0
	if in.ParentID != nil {
		parent := findEvent(evs, *in.ParentID)
		if parent == nil {
			return nil, fmt.Errorf("%w: родитель %s не найден в проекте", ErrValidation, *in.ParentID)
		}
		depth = parent.Depth + 1
		if int(depth) > MaxDepth {
			return nil, fmt.Errorf("%w: глубина %d превышает максимум %d", ErrValidation, depth, MaxDepth)
		}
	}
	for _, e := range evs {
		if sameParent(e.ParentID, in.ParentID) {
			position++
		}
	}

	id := in.ID
	if id == uuid.Nil {
		id = uuid.New()
	}
	e := &store.Event{
		ID:        id,
		ProjectID: projectID,
		ParentID:  in.ParentID,
		Position:  position,
		Depth:     depth,
		Title:     in.Title,
		Body:      in.Body,
		EventDate: in.EventDate,
		CreatedBy: &userID,
		UpdatedBy: &userID,
	}
	if err := s.store.CreateEvent(ctx, e); err != nil {
		return nil, err
	}
	return e, nil
}

// UpdateEvent — обновление содержимого (запись: editor+). Структуру меняет MoveEvent.
func (s *Service) UpdateEvent(
	ctx context.Context, userID, projectID, eventID uuid.UUID, in ContentInput,
) (*store.Event, error) {
	if err := s.proj.RequireEditor(ctx, userID, projectID); err != nil {
		return nil, err
	}
	current, err := s.store.GetEvent(ctx, projectID, eventID)
	if err != nil {
		return nil, err
	}
	title, body, eventDate := current.Title, current.Body, current.EventDate
	if in.Title != nil {
		title = *in.Title
	}
	if in.Body != nil {
		body = *in.Body
	}
	if in.EventDate != nil {
		eventDate = in.EventDate
	}
	if err := s.store.UpdateEventContent(ctx, projectID, eventID, title, body, eventDate, userID); err != nil {
		return nil, err
	}
	return s.store.GetEvent(ctx, projectID, eventID)
}

// MoveEvent переносит событие (запись: editor+): проверяет родителя, запрещает
// перенос в собственного потомка и пересчитывает глубину всего поддерева,
// а также переиндексовывает позиции в старой и новой группах соседей.
func (s *Service) MoveEvent(
	ctx context.Context, userID, projectID, eventID uuid.UUID, in MoveInput,
) (*store.Event, error) {
	if err := s.proj.RequireEditor(ctx, userID, projectID); err != nil {
		return nil, err
	}
	evs, err := s.store.ListEvents(ctx, projectID)
	if err != nil {
		return nil, err
	}
	target := findEvent(evs, eventID)
	if target == nil {
		return nil, store.ErrNotFound
	}

	depthByID := make(map[uuid.UUID]int16, len(evs))
	for _, e := range evs {
		depthByID[e.ID] = e.Depth
	}

	newDepth := int16(0)
	if in.ParentID != nil {
		if *in.ParentID == eventID {
			return nil, fmt.Errorf("%w: событие не может быть родителем самому себе", ErrValidation)
		}
		parent := findEvent(evs, *in.ParentID)
		if parent == nil {
			return nil, fmt.Errorf("%w: родитель %s не найден в проекте", ErrValidation, *in.ParentID)
		}
		if DescendantsIDs(evs, eventID)[*in.ParentID] {
			return nil, fmt.Errorf("%w: нельзя перенести событие в собственного потомка", ErrValidation)
		}
		newDepth = parent.Depth + 1
	}

	subtree := DescendantsIDs(evs, eventID)
	delta := int(newDepth) - int(target.Depth)
	maxDepth := int(target.Depth)
	for id := range subtree {
		if d := int(depthByID[id]); d > maxDepth {
			maxDepth = d
		}
	}
	if maxDepth+delta > MaxDepth {
		return nil, fmt.Errorf("%w: перенос превысит максимальную глубину %d", ErrValidation, MaxDepth)
	}

	// Порядок в новой группе соседей: вставляем событие на запрошенную позицию.
	newSiblings := make([]uuid.UUID, 0, len(evs))
	for _, e := range evs {
		if e.ID != eventID && sameParent(e.ParentID, in.ParentID) {
			newSiblings = append(newSiblings, e.ID)
		}
	}
	at := len(newSiblings)
	if in.Position != nil {
		at = *in.Position
		if at < 0 {
			at = 0
		}
		if at > len(newSiblings) {
			at = len(newSiblings)
		}
	}
	newSiblings = append(newSiblings, uuid.Nil)
	copy(newSiblings[at+1:], newSiblings[at:])
	newSiblings[at] = eventID

	sameGroup := sameParent(target.ParentID, in.ParentID)
	var oldSiblings []uuid.UUID
	if !sameGroup {
		oldSiblings = make([]uuid.UUID, 0, len(evs))
		for _, e := range evs {
			if e.ID != eventID && sameParent(e.ParentID, target.ParentID) {
				oldSiblings = append(oldSiblings, e.ID)
			}
		}
	} else {
		oldSiblings = nil // позиции уже пересчитаны в newSiblings
	}

	subtreeDepths := make(map[uuid.UUID]int16, len(subtree)+1)
	subtreeDepths[eventID] = newDepth
	for id := range subtree {
		subtreeDepths[id] = depthByID[id] + int16(delta)
	}

	if err := s.store.ApplyEventMove(ctx, store.EventMove{
		ProjectID:   projectID,
		ID:          eventID,
		ParentID:    in.ParentID,
		Position:    at,
		Depth:       newDepth,
		By:          userID,
		Subtree:     subtreeDepths,
		OldSiblings: oldSiblings,
		NewSiblings: newSiblings,
	}); err != nil {
		return nil, err
	}
	return s.store.GetEvent(ctx, projectID, eventID)
}

// DeleteEvent удаляет событие вместе с потомками (каскад FK) и переиндексовывает
// позиции оставшихся соседей. Возвращает число удалённых корневых записей.
func (s *Service) DeleteEvent(ctx context.Context, userID, projectID, eventID uuid.UUID) (int64, error) {
	if err := s.proj.RequireEditor(ctx, userID, projectID); err != nil {
		return 0, err
	}
	evs, err := s.store.ListEvents(ctx, projectID)
	if err != nil {
		return 0, err
	}
	target := findEvent(evs, eventID)
	if target == nil {
		return 0, store.ErrNotFound
	}
	descendants := DescendantsIDs(evs, eventID)
	removed, err := s.store.DeleteEvent(ctx, projectID, eventID)
	if err != nil {
		return 0, err
	}
	siblings := make([]uuid.UUID, 0, len(evs))
	for _, e := range evs {
		if e.ID == eventID || descendants[e.ID] {
			continue
		}
		if sameParent(e.ParentID, target.ParentID) {
			siblings = append(siblings, e.ID)
		}
	}
	if err := s.store.SetEventPositions(ctx, projectID, siblings); err != nil {
		return removed, err
	}
	return removed + int64(len(descendants)), nil
}

// SyncTree — идемпотентная синхронизация проекции дерева целиком (запись: editor+).
// Используется клиентом после локальных правок CRDT: сервер проверяет инварианты
// (циклы/глубина/чужой проект) и возвращает каноническое дерево.
//
// baseRevision — ревизия снапшота, которую клиент считал актуальной. Если она
// устарела (кто-то сохранил снапшот раньше), проекция не применяется и
// возвращается store.ErrRevisionConflict: иначе устаревший клиент удалил бы
// чужие события, которых нет в его локальном CRDT.
func (s *Service) SyncTree(
	ctx context.Context, userID, projectID uuid.UUID, nodes []NodeInput, baseRevision int64,
) ([]TreeEvent, error) {
	if err := s.proj.RequireEditor(ctx, userID, projectID); err != nil {
		return nil, err
	}
	normalized, err := NormalizeTree(nodes)
	if err != nil {
		return nil, err
	}
	rows := make([]store.Event, 0, len(normalized))
	for _, n := range normalized {
		rows = append(rows, store.Event{
			ID:        n.ID,
			ProjectID: projectID,
			ParentID:  n.ParentID,
			Position:  n.Position,
			Depth:     n.Depth,
			Title:     n.Title,
			Body:      n.Body,
			// Дата в проекции — «не пришла / очищена / значение» (см. EventDatePatch):
			// отсутствие поля не должно стирать дату, которую клиент не видел.
			EventDate:    n.EventDate.Value,
			EventDateSet: n.EventDate.Set,
			CreatedBy:    &userID,
			UpdatedBy:    &userID,
		})
	}
	if err := s.store.ReplaceEventTreeChecked(ctx, projectID, userID, rows, baseRevision); err != nil {
		return nil, err
	}
	return s.ListTree(ctx, userID, projectID)
}

func findEvent(evs []store.Event, id uuid.UUID) *store.Event {
	for i := range evs {
		if evs[i].ID == id {
			return &evs[i]
		}
	}
	return nil
}

func sameParent(a, b *uuid.UUID) bool {
	if a == nil && b == nil {
		return true
	}
	if a == nil || b == nil {
		return false
	}
	return *a == *b
}
