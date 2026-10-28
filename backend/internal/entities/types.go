package entities

// types.go — свои типы карточек (0.81.0, docs/entity-types.md, миграция 0034).
//
// Решения, которые видно в поведении:
//
//   * «Персонаж», «Место», «Тема» остаются стартовыми — их можно ПЕРЕИМЕНОВАТЬ, но не удалить:
//     карточки, экспорт и помощник рассчитывают на эти три ключа;
//   * машинный ключ выводится из названия один раз и дальше не меняется: на него ссылаются
//     карточки, и переименование не должно их перекладывать. Поэтому «Фракция» → key `frakciya`,
//     а переименование в «Дома» меняет только название;
//   * удалить тип с карточками нельзя — сначала переведите их. Каскад потерял бы классификацию
//     молча, а это данные, которые человек расставлял руками;
//   * лимит 24 типа на проект: дальше это не классификация, а свалка, и выпадающий список
//     перестаёт читаться.

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"unicode/utf8"

	"github.com/google/uuid"

	"github.com/skyfraze/backend/internal/store"
)

const (
	maxTypeTitleRunes  = 40
	maxTypeIconRunes   = 8
	maxTypesPerProject = 24

	// Заготовка карточки (0.85.0): описание с подстановкой {{name}} и типичные алиасы.
	maxTemplateDescRunes    = 2000
	maxTemplateAliases      = 12
	maxTemplateAliasRunes   = 60
	maxTemplateAliasesBytes = 12
)

// ErrTypeNotFound — типа нет в проекте.
var ErrTypeNotFound = errors.New("тип карточки не найден")

// ErrTypeDefault — стартовый тип удалить нельзя.
var ErrTypeDefault = errors.New("стартовый тип удалить нельзя — его можно переименовать")

// ErrTypeHasCards — у типа есть карточки; отдаём и число, чтобы объяснить человеку.
type ErrTypeHasCards struct {
	Title string
	Count int
}

func (e ErrTypeHasCards) Error() string {
	return fmt.Sprintf("в типе «%s» %d карточек: сначала переведите их в другой тип", e.Title, e.Count)
}

// Types — типы карточек проекта (читает любой участник).
//
// Стартовые типы досоздаются при чтении: проект мог быть создан до появления типов, а пустой
// список видов не дал бы завести ни одной карточки.
func (s *Service) Types(ctx context.Context, userID, projectID uuid.UUID) ([]store.EntityType, error) {
	if err := s.proj.RequireViewer(ctx, userID, projectID); err != nil {
		return nil, err
	}
	if err := s.store.EnsureEntityTypes(ctx, projectID); err != nil {
		return nil, err
	}
	return s.store.ListEntityTypes(ctx, projectID)
}

// CreateType заводит свой тип карточки (редактор и выше). Заготовка карточки — необязательна:
// вызовы без неё читаются как «тип без заготовки» и остаются валидными.
func (s *Service) CreateType(
	ctx context.Context, userID, projectID uuid.UUID, title, icon, color string,
	templates ...store.EntityCardTemplate,
) (*store.EntityType, error) {
	if err := s.proj.RequireEditor(ctx, userID, projectID); err != nil {
		return nil, err
	}
	title = strings.TrimSpace(title)
	if title == "" || utf8.RuneCountInString(title) > maxTypeTitleRunes {
		return nil, fmt.Errorf("%w: название типа от 1 до %d знаков", ErrInvalidEntity, maxTypeTitleRunes)
	}
	icon = strings.TrimSpace(icon)
	if utf8.RuneCountInString(icon) > maxTypeIconRunes {
		return nil, fmt.Errorf("%w: значок типа не длиннее %d знаков", ErrInvalidEntity, maxTypeIconRunes)
	}
	color = strings.TrimSpace(color)
	if color != "" && !validColor(color) {
		return nil, fmt.Errorf("%w: цвет в виде #rrggbb", ErrInvalidEntity)
	}
	template, err := normalizeCardTemplate(templates)
	if err != nil {
		return nil, err
	}
	if err := s.store.EnsureEntityTypes(ctx, projectID); err != nil {
		return nil, err
	}
	existing, err := s.store.ListEntityTypes(ctx, projectID)
	if err != nil {
		return nil, err
	}
	if len(existing) >= maxTypesPerProject {
		return nil, fmt.Errorf("%w: типов уже %d — больше не нужно", ErrInvalidEntity, maxTypesPerProject)
	}
	// Одинаковое название без учёта регистра — почти всегда двойной клик, а не второй смысл.
	for _, item := range existing {
		if strings.EqualFold(item.Title, title) {
			return nil, fmt.Errorf("%w: тип «%s» уже есть в проекте", ErrInvalidEntity, item.Title)
		}
	}
	key := uniqueTypeKey(slugifyType(title), existing)
	return s.store.CreateEntityType(ctx, store.EntityType{
		ProjectID: projectID, Key: key, Title: title, Color: color, Icon: icon,
		CardTemplate: template,
	})
}

// UpdateType переименовывает тип, меняет цвет, значок и заготовку карточки. Ключ не меняется.
func (s *Service) UpdateType(
	ctx context.Context, userID, projectID uuid.UUID, key, title, icon, color string,
	templates ...store.EntityCardTemplate,
) (*store.EntityType, error) {
	if err := s.proj.RequireEditor(ctx, userID, projectID); err != nil {
		return nil, err
	}
	// Та же причина, что у удаления: переименование «Персонажа» в проекте, созданном до 0034,
	// должно работать, а не отвечать «тип не найден».
	if err := s.store.EnsureEntityTypes(ctx, projectID); err != nil {
		return nil, err
	}
	current, err := s.store.EntityTypeByKey(ctx, projectID, key)
	if err != nil {
		if errors.Is(err, store.ErrNotFound) {
			return nil, ErrTypeNotFound
		}
		return nil, err
	}
	title = strings.TrimSpace(title)
	if title == "" || utf8.RuneCountInString(title) > maxTypeTitleRunes {
		return nil, fmt.Errorf("%w: название типа от 1 до %d знаков", ErrInvalidEntity, maxTypeTitleRunes)
	}
	icon = strings.TrimSpace(icon)
	if utf8.RuneCountInString(icon) > maxTypeIconRunes {
		return nil, fmt.Errorf("%w: значок типа не длиннее %d знаков", ErrInvalidEntity, maxTypeIconRunes)
	}
	color = strings.TrimSpace(color)
	if color != "" && !validColor(color) {
		return nil, fmt.Errorf("%w: цвет в виде #rrggbb", ErrInvalidEntity)
	}
	template, err := normalizeCardTemplate(templates)
	if err != nil {
		return nil, err
	}
	all, err := s.store.ListEntityTypes(ctx, projectID)
	if err != nil {
		return nil, err
	}
	for _, item := range all {
		if item.Key != current.Key && strings.EqualFold(item.Title, title) {
			return nil, fmt.Errorf("%w: тип «%s» уже есть в проекте", ErrInvalidEntity, item.Title)
		}
	}
	return s.store.UpdateEntityType(ctx, projectID, current.Key, title, color, icon, template)
}

// normalizeCardTemplate чистит и проверяет заготовку карточки.
//
// Пустая заготовка — нормальный случай (у большинства типов её нет). Ограничения — те же, что у
// полей карточки: заготовка не должна обещать больше, чем форма умеет показать.
func normalizeCardTemplate(given []store.EntityCardTemplate) (store.EntityCardTemplate, error) {
	if len(given) == 0 {
		return store.EntityCardTemplate{}, nil
	}
	raw := given[0]
	description := strings.TrimSpace(raw.Description)
	if utf8.RuneCountInString(description) > maxTemplateDescRunes {
		return store.EntityCardTemplate{}, fmt.Errorf(
			"%w: заготовка описания не длиннее %d знаков", ErrInvalidEntity, maxTemplateDescRunes)
	}
	aliases := make([]string, 0, len(raw.Aliases))
	seen := make(map[string]bool, len(raw.Aliases))
	for _, alias := range raw.Aliases {
		alias = strings.TrimSpace(alias)
		if alias == "" {
			continue
		}
		if utf8.RuneCountInString(alias) > maxTemplateAliasRunes {
			return store.EntityCardTemplate{}, fmt.Errorf(
				"%w: алиас в заготовке не длиннее %d знаков", ErrInvalidEntity, maxTemplateAliasRunes)
		}
		lower := strings.ToLower(alias)
		if seen[lower] {
			continue
		}
		seen[lower] = true
		aliases = append(aliases, alias)
	}
	if len(aliases) > maxTemplateAliases {
		aliases = aliases[:maxTemplateAliases]
	}
	return store.EntityCardTemplate{Description: description, Aliases: aliases}, nil
}

// DeleteType удаляет свой тип. Стартовые и типы с карточками — отказ со словами.
func (s *Service) DeleteType(ctx context.Context, userID, projectID uuid.UUID, key string) error {
	if err := s.proj.RequireEditor(ctx, userID, projectID); err != nil {
		return err
	}
	// Стартовые типы досоздаются и здесь: проект мог быть создан до миграции 0034, и без этого
	// попытка удалить «Тему» отвечала бы «тип не найден» вместо «стартовый удалить нельзя».
	if err := s.store.EnsureEntityTypes(ctx, projectID); err != nil {
		return err
	}
	current, err := s.store.EntityTypeByKey(ctx, projectID, key)
	if err != nil {
		if errors.Is(err, store.ErrNotFound) {
			return ErrTypeNotFound
		}
		return err
	}
	if current.IsDefault {
		return ErrTypeDefault
	}
	count, err := s.store.CountEntitiesOfKind(ctx, projectID, current.Key)
	if err != nil {
		return err
	}
	if count > 0 {
		return ErrTypeHasCards{Title: current.Title, Count: count}
	}
	if err := s.store.DeleteEntityType(ctx, projectID, current.Key); err != nil {
		if errors.Is(err, store.ErrEntityTypeInUse) {
			return ErrTypeHasCards{Title: current.Title, Count: count}
		}
		return err
	}
	return nil
}

// typeExists проверяет, что вид карточки есть в проекте: им пользуется создание карточки.
func (s *Service) typeExists(ctx context.Context, projectID uuid.UUID, key string) error {
	if err := s.store.EnsureEntityTypes(ctx, projectID); err != nil {
		return err
	}
	if _, err := s.store.EntityTypeByKey(ctx, projectID, key); err != nil {
		if errors.Is(err, store.ErrNotFound) {
			return fmt.Errorf("%w: вид «%s» не заведён в проекте", ErrInvalidEntity, key)
		}
		return err
	}
	return nil
}

// slugifyType переводит название в машинный ключ.
//
// Транслитерация, а не «просто латиница»: типы называют по-русски («Фракция», «Артефакты»), и
// без таблицы ключ оказывался бы пустым. Таблица короткая намеренно — только то, что реально
// встречается в названиях; остальные буквы отбрасываются.
func slugifyType(title string) string {
	table := map[rune]string{
		'а': "a", 'б': "b", 'в': "v", 'г': "g", 'д': "d", 'е': "e", 'ё': "e",
		'ж': "zh", 'з': "z", 'и': "i", 'й': "y", 'к': "k", 'л': "l", 'м': "m",
		'н': "n", 'о': "o", 'п': "p", 'р': "r", 'с': "s", 'т': "t", 'у': "u",
		'ф': "f", 'х': "h", 'ц': "c", 'ч': "ch", 'ш': "sh", 'щ': "sch", 'ъ': "",
		'ы': "y", 'ь': "", 'э': "e", 'ю': "yu", 'я': "ya",
	}
	var out strings.Builder
	for _, r := range strings.ToLower(title) {
		switch {
		case r >= 'a' && r <= 'z', r >= '0' && r <= '9':
			out.WriteRune(r)
		case r == ' ' || r == '-' || r == '_':
			out.WriteRune('-')
		default:
			if latin, ok := table[r]; ok {
				out.WriteString(latin)
			}
		}
	}
	slug := strings.Trim(out.String(), "-")
	for strings.Contains(slug, "--") {
		slug = strings.ReplaceAll(slug, "--", "-")
	}
	if slug == "" || slug[0] < 'a' || slug[0] > 'z' {
		slug = "type-" + slug
	}
	if len(slug) > 32 {
		slug = slug[:32]
	}
	return slug
}

// uniqueTypeKey добавляет -2, -3… если ключ занят.
func uniqueTypeKey(base string, existing []store.EntityType) string {
	taken := make(map[string]bool, len(existing))
	for _, item := range existing {
		taken[item.Key] = true
	}
	if !taken[base] {
		return base
	}
	for n := 2; n < 100; n++ {
		suffix := fmt.Sprintf("-%d", n)
		candidate := base
		if len(candidate)+len(suffix) > 32 {
			candidate = candidate[:32-len(suffix)]
		}
		candidate += suffix
		if !taken[candidate] {
			return candidate
		}
	}
	return base + "-x"
}
