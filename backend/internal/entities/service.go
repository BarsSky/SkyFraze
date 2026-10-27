package entities

// service.go — карточки сущностей проекта: персонажи, места, темы (docs/entity-links.md).
//
// Правила, которые живут здесь, а не в обработчиках, потому что их должно соблюдать и
// помощник, и импорт:
//   * вид — из закрытого набора (персонаж/место/тема), а не свободная строка: свободная
//     превращается в «персонаж», «Персонаж» и «char» через месяц;
//   * имя — единственное в проекте без учёта регистра (держит БД, проверяем и здесь, чтобы
//     отдать человеку понятный текст, а не 500);
//   * алиасы чистятся: без пустых, без дублей, без повтора самого имени, каждое ≤60 знаков,
//     не больше 20 штук. Иначе «Анна» и «анна» в алиасах дают двойную подсветку;
//   * писать может редактор и выше, читать — любой участник, включая читателя.

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"unicode/utf8"

	"github.com/google/uuid"

	"github.com/skyfraze/backend/internal/store"
)

// Ограничения карточек.
const (
	// minNameRunes — 2, а не 1: имя из одного знака («Я») находится в каждом предложении, и
	// упоминания от такой карточки — шум. Тот же предел у алиасов, и он же в поиске на клиенте
	// (frontend/src/collab/mentions.ts, MIN_ALIAS_LENGTH): правило должно быть одно.
	minNameRunes        = 2
	maxNameRunes        = 80
	minAliasRunes       = 2
	maxAliasRunes       = 60
	maxAliases          = 20
	maxDescriptionRunes = 600
	// maxLinkLabelRunes — подпись связи печатается на ребре графа и рядом с чипом: короткая.
	maxLinkLabelRunes = 40
	// maxLinksPerEntity — предел связей у одной карточки: больше двадцати уже не связь, а список.
	maxLinksPerEntity = 20
)

// Ошибки сервиса.
var (
	// ErrInvalidEntity — поля не подходят под правила (имя, вид, алиасы, описание).
	ErrInvalidEntity = errors.New("карточка заполнена неверно")
	// ErrEntityExists — имя занято в проекте.
	ErrEntityExists = store.ErrEntityExists
)

// ProjectAccess — права на проект (реализует projects.Service).
type ProjectAccess interface {
	RequireViewer(ctx context.Context, userID, projectID uuid.UUID) error
	RequireEditor(ctx context.Context, userID, projectID uuid.UUID) error
}

// Service — карточки сущностей проекта.
type Service struct {
	store *store.Store
	proj  ProjectAccess
}

func New(st *store.Store, proj ProjectAccess) *Service {
	return &Service{store: st, proj: proj}
}

// Input — что приходит от человека (создание или правка).
//
// Указатели ради «не прислали — не меняем»: правка одного имени не должна стирать описание
// и алиасы.
type Input struct {
	Kind        string
	Name        string
	Aliases     *[]string
	Description *string
	Color       *string
}

// ListEntities — карточки проекта (читает любой участник).
//
// Имя метода совпадает с тем, что нужно помощнику (assistant.EntityReader): одна и та же
// выборка с теми же правами, и второй обёртки для неё не нужно.
func (s *Service) ListEntities(
	ctx context.Context, userID, projectID uuid.UUID,
) ([]store.ProjectEntity, error) {
	if err := s.proj.RequireViewer(ctx, userID, projectID); err != nil {
		return nil, err
	}
	return s.store.ListEntities(ctx, projectID)
}

// Create — новая карточка (редактор и выше).
func (s *Service) Create(
	ctx context.Context, userID, projectID uuid.UUID, in Input,
) (*store.ProjectEntity, error) {
	if err := s.proj.RequireEditor(ctx, userID, projectID); err != nil {
		return nil, err
	}
	kind, ok := store.ParseEntityKind(strings.TrimSpace(in.Kind))
	if !ok {
		return nil, fmt.Errorf("%w: вид должен быть character, place или theme", ErrInvalidEntity)
	}
	name := strings.TrimSpace(in.Name)
	if utf8.RuneCountInString(name) < minNameRunes || utf8.RuneCountInString(name) > maxNameRunes {
		return nil, fmt.Errorf("%w: имя от %d до %d знаков", ErrInvalidEntity, minNameRunes, maxNameRunes)
	}
	aliases := []string{}
	if in.Aliases != nil {
		cleaned, err := CleanAliases(*in.Aliases, name)
		if err != nil {
			return nil, err
		}
		aliases = cleaned
	}
	description := ""
	if in.Description != nil {
		description = strings.TrimSpace(*in.Description)
		if utf8.RuneCountInString(description) > maxDescriptionRunes {
			return nil, fmt.Errorf("%w: описание не длиннее %d знаков", ErrInvalidEntity, maxDescriptionRunes)
		}
	}
	color := ""
	if in.Color != nil {
		color = strings.TrimSpace(*in.Color)
		if color != "" && !validColor(color) {
			return nil, fmt.Errorf("%w: цвет в виде #rrggbb", ErrInvalidEntity)
		}
	}
	return s.store.CreateEntity(ctx, store.ProjectEntity{
		ProjectID: projectID, Kind: string(kind), Name: name,
		Aliases: aliases, Description: description, Color: color,
		CreatedBy: &userID,
	})
}

// Update — правка карточки (редактор и выше).
func (s *Service) Update(
	ctx context.Context, userID, projectID, id uuid.UUID, in Input,
) (*store.ProjectEntity, error) {
	if err := s.proj.RequireEditor(ctx, userID, projectID); err != nil {
		return nil, err
	}
	upd := store.EntityUpdate{}
	if raw := strings.TrimSpace(in.Kind); raw != "" {
		kind, ok := store.ParseEntityKind(raw)
		if !ok {
			return nil, fmt.Errorf("%w: вид должен быть character, place или theme", ErrInvalidEntity)
		}
		value := string(kind)
		upd.Kind = &value
	}
	if raw := strings.TrimSpace(in.Name); raw != "" {
		if utf8.RuneCountInString(raw) > maxNameRunes {
			return nil, fmt.Errorf("%w: имя не длиннее %d знаков", ErrInvalidEntity, maxNameRunes)
		}
		upd.Name = &raw
	}
	if in.Description != nil {
		description := strings.TrimSpace(*in.Description)
		if utf8.RuneCountInString(description) > maxDescriptionRunes {
			return nil, fmt.Errorf("%w: описание не длиннее %d знаков", ErrInvalidEntity, maxDescriptionRunes)
		}
		upd.Description = &description
	}
	if in.Aliases != nil {
		// Имя для проверки «алиас не повторяет имя» берём текущее: оно могло не прийти в
		// этом запросе.
		name := strings.TrimSpace(in.Name)
		if name == "" {
			current, err := s.store.EntityByID(ctx, projectID, id)
			if err != nil {
				return nil, err
			}
			name = current.Name
		}
		cleaned, err := CleanAliases(*in.Aliases, name)
		if err != nil {
			return nil, err
		}
		upd.Aliases = &cleaned
	}
	if in.Color != nil {
		color := strings.TrimSpace(*in.Color)
		if color != "" && !validColor(color) {
			return nil, fmt.Errorf("%w: цвет в виде #rrggbb", ErrInvalidEntity)
		}
		upd.Color = &color
	}
	return s.store.UpdateEntity(ctx, projectID, id, upd)
}

// Delete — удаление карточки (редактор и выше).
func (s *Service) Delete(ctx context.Context, userID, projectID, id uuid.UUID) error {
	if err := s.proj.RequireEditor(ctx, userID, projectID); err != nil {
		return err
	}
	return s.store.DeleteEntity(ctx, projectID, id)
}

// Usage — где каждая карточка встречается в проекте (0.70.0).
//
// Считается по проекции дерева (`events`), а не по хранимым упоминаниям: текст кадров там уже
// есть, и выводить из него связи дешевле, чем поддерживать вторую таблицу с якорями и её
// синхронизацию. Заодно это работает без открытой вкладки — именно поэтому метод нужен
// помощнику, а не только интерфейсу.
func (s *Service) Usage(
	ctx context.Context, userID, projectID uuid.UUID,
) ([]EntityUsageRow, error) {
	if err := s.proj.RequireViewer(ctx, userID, projectID); err != nil {
		return nil, err
	}
	list, err := s.store.ListEntities(ctx, projectID)
	if err != nil {
		return nil, err
	}
	if len(list) == 0 {
		return nil, nil
	}
	events, err := s.store.ListEvents(ctx, projectID)
	if err != nil {
		return nil, err
	}
	frames := make([]TextFrame, 0, len(events))
	for _, e := range events {
		frames = append(frames, TextFrame{ID: e.ID.String(), Title: e.Title, Body: e.Body})
	}
	return Usage(frames, list), nil
}

// EntityFrames — кадры, где встречается одна карточка, с цитатами (для помощника).
//
// Порядок — как в проекции дерева (глубина, позиция): это тот же порядок, что человек видит в
// списке кадров, и он стабилен между вызовами.
type EntityFrame struct {
	FrameID string
	Title   string
	Quotes  []string
}

// Frames — кадры одной карточки по её имени.
func (s *Service) Frames(
	ctx context.Context, userID, projectID uuid.UUID, entityID uuid.UUID,
) ([]EntityFrame, error) {
	if err := s.proj.RequireViewer(ctx, userID, projectID); err != nil {
		return nil, err
	}
	entity, err := s.store.EntityByID(ctx, projectID, entityID)
	if err != nil {
		return nil, err
	}
	events, err := s.store.ListEvents(ctx, projectID)
	if err != nil {
		return nil, err
	}
	out := make([]EntityFrame, 0, 8)
	for _, e := range events {
		mentions := FrameMentions(
			TextFrame{ID: e.ID.String(), Title: e.Title, Body: e.Body},
			[]store.ProjectEntity{*entity},
		)
		if len(mentions) == 0 {
			continue
		}
		quotes := make([]string, 0, len(mentions))
		for _, mention := range mentions {
			quotes = append(quotes, mention.Quote)
		}
		out = append(out, EntityFrame{FrameID: e.ID.String(), Title: e.Title, Quotes: quotes})
	}
	return out, nil
}

// CleanAliases чистит список алиасов.
//
// Зачем: алиасы — это то, по чему ищутся упоминания. «Анна» в алиасах при имени «Анна» дала бы
// двойную связь на каждом упоминании, пустая строка — совпадение на каждом символе, а алиас из
// одного знака («Я») находился бы в каждом предложении. Дубли без учёта регистра схлопываем в
// первое написание. Слишком короткие — отказ, а не тихий пропуск: человек должен узнать, почему
// его алиас не работает.
func CleanAliases(raw []string, name string) ([]string, error) {
	nameKey := strings.ToLower(strings.TrimSpace(name))
	out := make([]string, 0, len(raw))
	seen := map[string]bool{}
	for _, alias := range raw {
		alias = strings.TrimSpace(alias)
		if alias == "" {
			continue
		}
		length := utf8.RuneCountInString(alias)
		if length < minAliasRunes {
			return nil, fmt.Errorf("%w: алиас короче %d знаков не ищется", ErrInvalidEntity, minAliasRunes)
		}
		if length > maxAliasRunes {
			return nil, fmt.Errorf("%w: алиас не длиннее %d знаков", ErrInvalidEntity, maxAliasRunes)
		}
		key := strings.ToLower(alias)
		if key == nameKey {
			continue
		}
		if seen[key] {
			continue
		}
		seen[key] = true
		out = append(out, alias)
		if len(out) > maxAliases {
			return nil, fmt.Errorf("%w: не больше %d алиасов", ErrInvalidEntity, maxAliases)
		}
	}
	return out, nil
}

// validColor — «#rrggbb»: цвет подсветки задаётся кодом, а не именем («золотой» CSS не знает).
func validColor(color string) bool {
	if len(color) != 7 || color[0] != '#' {
		return false
	}
	for _, ch := range color[1:] {
		isHex := (ch >= '0' && ch <= '9') || (ch >= 'a' && ch <= 'f') || (ch >= 'A' && ch <= 'F')
		if !isHex {
			return false
		}
	}
	return true
}

// Links — связи карточек проекта (читает любой участник).
func (s *Service) Links(
	ctx context.Context, userID, projectID uuid.UUID,
) ([]store.EntityLink, error) {
	if err := s.proj.RequireViewer(ctx, userID, projectID); err != nil {
		return nil, err
	}
	return s.store.ListEntityLinks(ctx, projectID)
}

// AddLink связывает две карточки (редактор и выше).
//
// Правила: подпись 1–40 знаков, связь не с самой собой, не больше maxLinksPerEntity связей у
// карточки. Сами карточки проверяет store — в том же запросе, чтобы нельзя было связать
// карточку чужого проекта.
func (s *Service) AddLink(
	ctx context.Context, userID, projectID, from, to uuid.UUID, label string,
) (*store.EntityLink, error) {
	if err := s.proj.RequireEditor(ctx, userID, projectID); err != nil {
		return nil, err
	}
	label = strings.TrimSpace(label)
	if label == "" || utf8.RuneCountInString(label) > maxLinkLabelRunes {
		return nil, fmt.Errorf("%w: подпись связи от 1 до %d знаков", ErrInvalidEntity, maxLinkLabelRunes)
	}
	if from == to {
		return nil, fmt.Errorf("%w: карточка не может быть связана сама с собой", ErrInvalidEntity)
	}
	count, err := s.store.CountEntityLinks(ctx, from)
	if err != nil {
		return nil, err
	}
	if count >= maxLinksPerEntity {
		return nil, fmt.Errorf("%w: у карточки уже %d связей — больше не нужно", ErrInvalidEntity, maxLinksPerEntity)
	}
	return s.store.AddEntityLink(ctx, store.EntityLink{
		ProjectID: projectID, FromEntity: from, ToEntity: to, Label: label, CreatedBy: &userID,
	})
}

// DeleteLink удаляет связь (редактор и выше).
func (s *Service) DeleteLink(ctx context.Context, userID, projectID, id uuid.UUID) error {
	if err := s.proj.RequireEditor(ctx, userID, projectID); err != nil {
		return err
	}
	return s.store.DeleteEntityLink(ctx, projectID, id)
}
