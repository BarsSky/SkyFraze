package projecttemplate

// template.go — перенос шаблона проекта между проектами и инсталляциями (0.85.0,
// docs/entity-types.md §3–4).
//
// «Шаблон» здесь — не текст, а УСТРОЙСТВО проекта: из чего он состоит и как себя ведёт. Переносим
// ровно то, что человек настраивал руками и что не является содержимым:
//
//   · типы карточек (ключ, название, цвет, значок, заготовка карточки);
//   · карточки-заготовки (имя, алиасы, описание) — по выбору: «в этой серии те же герои»;
//   · роль и указания ИИ-помощника, режим генерации, стиль иллюстраций.
//
// НЕ переносим: кадры и их текст (это содержимое — для него есть архив), участников и права,
// оценки/просмотры/публикацию, историю версий.
//
// Правила применения — такие, чтобы перенос не был лотереей:
//
//   · СЛИЯНИЕ, а не замена: тип с тем же ключом обновляется, остальные добавляются; карточка с
//     занятым именем пропускается и попадает в отчёт;
//   · ничего не удаляется: шаблон не умеет убирать типы, карточки или настройки. «Применил
//     шаблон, и часть настроек исчезла» — это уже не перенос, а тихая потеря;
//   · идемпотентность: повторное применение того же шаблона ничего не меняет и говорит «всё уже
//     на месте» (проверяется тестом).
//
// Настройки уведомлений проекта в шаблон не входят: в приложении их пока нет (уведомления — это
// очередь писем о замечаниях на уровне установки), и переносить пустое поле значило бы обещать
// то, чего нет.

import (
	"context"
	"errors"
	"fmt"
	"strings"

	"github.com/google/uuid"

	"github.com/skyfraze/backend/internal/entities"
	"github.com/skyfraze/backend/internal/projects"
	"github.com/skyfraze/backend/internal/store"
)

// TemplateVersion — версия формата шаблона. Как у архива: поле позволяет менять структуру, не
// ломая старые файлы. Неизвестная версия — отказ, а не «попробуем разобрать».
const TemplateVersion = 1

// maxCardsInTemplate — потолок карточек-заготовок в шаблоне. Двадцать героев серии — уже много;
// тысяча означала бы, что в шаблон случайно положили весь проект.
const maxCardsInTemplate = 500

var (
	// ErrBadTemplate — шаблон не разобран или не той версии.
	ErrBadTemplate = errors.New("шаблон не подходит")
	// ErrForbidden — применять шаблон может только владелец.
	ErrForbidden = errors.New("шаблон проекта меняет только владелец")
	// ErrNotFound — проекта нет.
	ErrNotFound = errors.New("проект не найден")
)

// Template — файл шаблона (JSON).
type Template struct {
	Version     int          `json:"version"`
	EntityTypes []TypeRecord `json:"entity_types"`
	Cards       []CardRecord `json:"cards,omitempty"`
	// AI — роль и указания помощника. Указатель, чтобы «настроек в шаблоне нет» отличалось от
	// «настройки есть, но пустые»: пустые значения затёрли бы роль проекта, куда шаблон приехал.
	AI *AISettings `json:"ai,omitempty"`
}

// TypeRecord — тип карточки в шаблоне.
type TypeRecord struct {
	Key          string                   `json:"key"`
	Title        string                   `json:"title"`
	Color        string                   `json:"color,omitempty"`
	Icon         string                   `json:"icon,omitempty"`
	CardTemplate store.EntityCardTemplate `json:"card_template,omitempty"`
}

// CardRecord — карточка-заготовка в шаблоне. Идентификатор не переносим: в новом проекте карточка
// опознаётся по имени, как и при импорте архива.
type CardRecord struct {
	Kind        string   `json:"kind"`
	Name        string   `json:"name"`
	Aliases     []string `json:"aliases,omitempty"`
	Description string   `json:"description,omitempty"`
	Color       string   `json:"color,omitempty"`
}

// AISettings — роль, указания и режим генерации помощника.
type AISettings struct {
	Role          string `json:"role"`
	Instructions  string `json:"instructions"`
	Enabled       bool   `json:"enabled"`
	Generation    string `json:"generation"`
	ImageStyle    string `json:"image_style"`
	ImageNegative string `json:"image_negative,omitempty"`
}

// Skipped — что не перенеслось и почему: отчёт без причин бесполезен.
type Skipped struct {
	Name   string `json:"name"`
	Reason string `json:"reason"`
}

// Report — отчёт применения: человек должен видеть, что произошло, а не «ок».
type Report struct {
	TypesAdded   int       `json:"types_added"`
	TypesUpdated int       `json:"types_updated"`
	TypesSkipped []Skipped `json:"types_skipped,omitempty"`
	CardsAdded   int       `json:"cards_added"`
	CardsSkipped []Skipped `json:"cards_skipped,omitempty"`
	AIUpdated    bool      `json:"ai_updated"`
	// Changed — сколько всего изменилось. Ноль означает «всё уже на месте» — это и есть
	// идемпотентность, видимая человеку.
	Changed int `json:"changed"`
	// Message — готовая строка для интерфейса: формулировки в одном месте, а не в трёх.
	Message string `json:"message"`
}

// Service — перенос шаблона.
type Service struct {
	store *store.Store
	proj  *projects.Service
	ent   *entities.Service
}

// New собирает сервис. Зависимости — те же, что у остальных подсистем проекта: настройки живут в
// store, права считает projects, карточки создаёт entities (их проверки не дублируем).
func New(s *store.Store, proj *projects.Service, ent *entities.Service) *Service {
	return &Service{store: s, proj: proj, ent: ent}
}

// Export собирает шаблон из проекта. Читает редактор и выше: роль помощника и указания — это
// настройки, а не содержимое, и читателю они не нужны.
//
// `withCards=false` — шаблон без карточек: архив переносит карточки своим путём, и дублировать их
// в template.json значило бы импортировать дважды.
func (s *Service) Export(ctx context.Context, userID, projectID uuid.UUID, withCards bool) (*Template, error) {
	if err := s.proj.RequireEditor(ctx, userID, projectID); err != nil {
		return nil, mapError(err)
	}
	return s.Build(ctx, projectID, withCards)
}

// Build собирает шаблон без проверки прав: им пользуются экспорт архива и создание проекта по
// образцу, где права уже проверены вызывающим.
func (s *Service) Build(ctx context.Context, projectID uuid.UUID, withCards bool) (*Template, error) {
	if err := s.store.EnsureEntityTypes(ctx, projectID); err != nil {
		return nil, err
	}
	types, err := s.store.ListEntityTypes(ctx, projectID)
	if err != nil {
		return nil, err
	}
	out := &Template{Version: TemplateVersion, EntityTypes: make([]TypeRecord, 0, len(types))}
	for _, item := range types {
		out.EntityTypes = append(out.EntityTypes, TypeRecord{
			Key: item.Key, Title: item.Title, Color: item.Color, Icon: item.Icon,
			CardTemplate: item.CardTemplate,
		})
	}
	if withCards {
		list, err := s.store.ListEntities(ctx, projectID)
		if err != nil {
			return nil, err
		}
		out.Cards = make([]CardRecord, 0, len(list))
		for _, item := range list {
			out.Cards = append(out.Cards, CardRecord{
				Kind: item.Kind, Name: item.Name, Aliases: item.Aliases,
				Description: item.Description, Color: item.Color,
			})
		}
	}
	settings, err := s.store.AISettingsForProject(ctx, projectID)
	if err != nil {
		return nil, err
	}
	out.AI = &AISettings{
		Role: settings.Role, Instructions: settings.Instructions, Enabled: settings.Enabled,
		Generation: settings.Generation, ImageStyle: settings.ImageStyle,
		ImageNegative: settings.ImageNegative,
	}
	return out, nil
}

// Apply применяет шаблон к проекту. Только владелец: шаблон меняет настройки проекта целиком.
func (s *Service) Apply(ctx context.Context, userID, projectID uuid.UUID, t *Template) (*Report, error) {
	role, err := s.proj.Role(ctx, userID, projectID)
	if err != nil {
		return nil, mapError(err)
	}
	if role != store.RoleOwner {
		return nil, ErrForbidden
	}
	return s.ApplyAs(ctx, userID, projectID, t)
}

// CreateFrom создаёт проект и применяет к нему шаблон одной операцией (0.85.0).
//
// Почему одной ручкой, а не «создай проект, потом примени шаблон»: между двумя запросами
// появляется пустой проект, если второй не дошёл, — а человек видел одно действие «создать по
// образцу». Неудача применения убирает только что созданный пустой проект: в нём ещё нет ни
// кадра, ни файла, и удалять там нечего.
func (s *Service) CreateFrom(
	ctx context.Context, userID uuid.UUID, title, description string, t *Template,
) (*store.Project, *Report, error) {
	title = strings.TrimSpace(title)
	if title == "" {
		title = "Новый проект"
	}
	p, err := s.proj.Create(ctx, userID, title, description)
	if err != nil {
		return nil, nil, mapError(err)
	}
	report, err := s.ApplyAs(ctx, userID, p.ID, t)
	if err != nil {
		_ = s.store.DeleteProject(ctx, p.ID)
		return nil, nil, err
	}
	return p, report, nil
}

// ApplyAs применяет шаблон без проверки роли: вызывающий уже знает, что человек — владелец
// (создание проекта по шаблону, импорт архива).
func (s *Service) ApplyAs(ctx context.Context, userID, projectID uuid.UUID, t *Template) (*Report, error) {
	if t == nil {
		return nil, fmt.Errorf("%w: пустой шаблон", ErrBadTemplate)
	}
	if t.Version != 0 && t.Version != TemplateVersion {
		return nil, fmt.Errorf("%w: версия шаблона %d, поддерживается %d", ErrBadTemplate, t.Version, TemplateVersion)
	}
	if len(t.Cards) > maxCardsInTemplate {
		return nil, fmt.Errorf("%w: карточек в шаблоне %d, предел %d", ErrBadTemplate, len(t.Cards), maxCardsInTemplate)
	}
	if err := s.store.EnsureEntityTypes(ctx, projectID); err != nil {
		return nil, err
	}
	report := &Report{}

	if err := s.applyTypes(ctx, projectID, t.EntityTypes, report); err != nil {
		return nil, err
	}
	if err := s.applyCards(ctx, userID, projectID, t.Cards, report); err != nil {
		return nil, err
	}
	aiChanged, err := s.applyAI(ctx, userID, projectID, t.AI)
	if err != nil {
		return nil, err
	}
	report.AIUpdated = aiChanged

	report.Changed = report.TypesAdded + report.TypesUpdated + report.CardsAdded
	if report.AIUpdated {
		report.Changed++
	}
	report.Message = describe(report)
	return report, nil
}

// applyTypes — слияние типов: тот же ключ обновляется, новый добавляется, лимит соблюдается.
func (s *Service) applyTypes(ctx context.Context, projectID uuid.UUID, records []TypeRecord, report *Report) error {
	if len(records) == 0 {
		return nil
	}
	const maxTypes = 24
	for _, record := range records {
		key := strings.TrimSpace(record.Key)
		title := strings.TrimSpace(record.Title)
		if title == "" {
			title = key
		}
		if !store.ValidEntityKindKey(key) {
			report.TypesSkipped = append(report.TypesSkipped, Skipped{
				Name: title, Reason: "ключ типа недопустим: строчная латиница, цифры, дефис",
			})
			continue
		}
		existing, err := s.store.EntityTypeByKey(ctx, projectID, key)
		if err != nil && !errors.Is(err, store.ErrNotFound) {
			return err
		}
		if existing == nil {
			all, err := s.store.ListEntityTypes(ctx, projectID)
			if err != nil {
				return err
			}
			if len(all) >= maxTypes {
				report.TypesSkipped = append(report.TypesSkipped, Skipped{
					Name: title, Reason: fmt.Sprintf("в проекте уже %d типов — предел", maxTypes),
				})
				continue
			}
			if _, err := s.store.UpsertEntityType(ctx, store.EntityType{
				ProjectID: projectID, Key: key, Title: title,
				Color: record.Color, Icon: record.Icon, CardTemplate: record.CardTemplate,
			}); err != nil {
				report.TypesSkipped = append(report.TypesSkipped, Skipped{Name: title, Reason: err.Error()})
				continue
			}
			report.TypesAdded++
			continue
		}
		same := existing.Title == title && existing.Color == record.Color &&
			existing.Icon == record.Icon && existing.CardTemplate.Same(record.CardTemplate)
		if same {
			continue
		}
		if _, err := s.store.UpsertEntityType(ctx, store.EntityType{
			ProjectID: projectID, Key: key, Title: title,
			Color: record.Color, Icon: record.Icon, IsDefault: existing.IsDefault,
			CardTemplate: record.CardTemplate,
		}); err != nil {
			report.TypesSkipped = append(report.TypesSkipped, Skipped{Name: title, Reason: err.Error()})
			continue
		}
		report.TypesUpdated++
	}
	return nil
}

// applyCards — карточки по имени: занятое имя пропускаем и говорим об этом. Ничего не удаляем.
func (s *Service) applyCards(
	ctx context.Context, userID, projectID uuid.UUID, records []CardRecord, report *Report,
) error {
	if len(records) == 0 {
		return nil
	}
	// Типы проекта — один раз: иначе «вид не заведён» проверялся бы запросом на карточку.
	if err := s.store.EnsureEntityTypes(ctx, projectID); err != nil {
		return err
	}
	types, err := s.store.ListEntityTypes(ctx, projectID)
	if err != nil {
		return err
	}
	known := make(map[string]bool, len(types))
	for _, item := range types {
		known[item.Key] = true
	}
	for _, record := range records {
		name := strings.TrimSpace(record.Name)
		if name == "" {
			continue
		}
		kind := strings.TrimSpace(record.Kind)
		if kind == "" {
			kind = store.EntityTypeCharacter
		}
		if !known[kind] {
			report.CardsSkipped = append(report.CardsSkipped, Skipped{
				Name: name, Reason: fmt.Sprintf("вид «%s» не заведён в проекте", kind),
			})
			continue
		}
		aliases := record.Aliases
		description := record.Description
		color := record.Color
		if _, err := s.ent.Create(ctx, userID, projectID, entities.Input{
			Kind: kind, Name: name, Aliases: &aliases, Description: &description, Color: &color,
		}); err != nil {
			reason := "не удалось создать"
			if errors.Is(err, entities.ErrEntityExists) {
				reason = "карточка с таким именем уже есть"
			} else if errors.Is(err, entities.ErrInvalidEntity) {
				reason = err.Error()
			}
			report.CardsSkipped = append(report.CardsSkipped, Skipped{Name: name, Reason: reason})
			continue
		}
		report.CardsAdded++
	}
	return nil
}

// applyAI переносит настройки помощника. Пустой раздел шаблона НЕ затирает настройки проекта:
// «поля нет» и «поле пустое» — разные вещи.
func (s *Service) applyAI(ctx context.Context, by, projectID uuid.UUID, ai *AISettings) (bool, error) {
	if ai == nil {
		return false, nil
	}
	current, err := s.store.AISettingsForProject(ctx, projectID)
	if err != nil {
		return false, err
	}
	generation := strings.TrimSpace(ai.Generation)
	if generation == "" {
		generation = current.Generation
	}
	if generation == "" {
		generation = store.GenerationAuto
	}
	if !store.ValidGeneration(generation) {
		generation = store.GenerationAuto
	}
	same := current.Role == ai.Role && current.Instructions == ai.Instructions &&
		current.Enabled == ai.Enabled && current.Generation == generation &&
		current.ImageStyle == ai.ImageStyle && current.ImageNegative == ai.ImageNegative
	if same {
		return false, nil
	}
	if _, err := s.store.SaveAISettings(
		ctx, projectID, by, ai.Role, ai.Instructions, ai.Enabled, generation, ai.ImageStyle,
		ai.ImageNegative,
	); err != nil {
		return false, err
	}
	return true, nil
}

// describe собирает строку отчёта: то, что человек читает после «применить шаблон».
func describe(r *Report) string {
	if r.Changed == 0 {
		parts := []string{"всё уже на месте"}
		if len(r.TypesSkipped) > 0 || len(r.CardsSkipped) > 0 {
			parts = append(parts, fmt.Sprintf("пропущено: %d типов, %d карточек",
				len(r.TypesSkipped), len(r.CardsSkipped)))
		}
		return strings.Join(parts, ", ")
	}
	var parts []string
	if r.TypesAdded > 0 {
		parts = append(parts, fmt.Sprintf("типов добавлено: %d", r.TypesAdded))
	}
	if r.TypesUpdated > 0 {
		parts = append(parts, fmt.Sprintf("типов обновлено: %d", r.TypesUpdated))
	}
	if r.CardsAdded > 0 {
		parts = append(parts, fmt.Sprintf("карточек добавлено: %d", r.CardsAdded))
	}
	if r.AIUpdated {
		parts = append(parts, "настройки помощника обновлены")
	}
	if len(r.CardsSkipped) > 0 {
		parts = append(parts, fmt.Sprintf("карточек пропущено: %d", len(r.CardsSkipped)))
	}
	if len(r.TypesSkipped) > 0 {
		parts = append(parts, fmt.Sprintf("типов пропущено: %d", len(r.TypesSkipped)))
	}
	return strings.Join(parts, ", ")
}

// mapError переводит ошибки прав/поиска в ошибки пакета, чтобы обработчик отвечал кодами.
func mapError(err error) error {
	switch {
	case err == nil:
		return nil
	case errors.Is(err, projects.ErrForbidden):
		return ErrForbidden
	case errors.Is(err, projects.ErrNotFound), errors.Is(err, store.ErrNotFound):
		return ErrNotFound
	default:
		return err
	}
}
