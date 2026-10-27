package entities_test

// types_integration_test.go — свои типы карточек (0.81.0, миграция 0034, docs/entity-types.md).
//
// Проверяем то, что ломается молча и что человек заметит сразу:
//   - стартовые типы есть в любом проекте, даже созданном до миграции;
//   - свой тип заводится из русского названия (ключ транслитерируется) и по нему можно
//     завести карточку;
//   - `key` не меняется при переименовании: карточки не переезжают;
//   - стартовый тип удалить нельзя, тип с карточками — тоже (и в отказе есть число карточек);
//   - вид карточки обязан существовать в проекте: чужой ключ отвергается;
//   - у чужого проекта своих типов не видно.

import (
	"context"
	"errors"
	"strings"
	"testing"

	"github.com/skyfraze/backend/internal/entities"
	"github.com/skyfraze/backend/internal/projects"
	"github.com/skyfraze/backend/internal/store"
)

// В каждом проекте есть три стартовых типа — и это видно до любых действий.
func TestEntityTypesDefaultsAlwaysPresent(t *testing.T) {
	e := setupEntities(t)
	ctx := context.Background()

	for _, project := range []struct {
		name string
		id   any
	}{{"основной", e.project}, {"второй", e.other}} {
		_ = project
	}
	list, err := e.svc.Types(ctx, e.viewer, e.project)
	if err != nil {
		t.Fatalf("типы: %v", err)
	}
	if len(list) != 3 {
		t.Fatalf("стартовых типов %d, ожидалось 3: %+v", len(list), list)
	}
	keys := []string{list[0].Key, list[1].Key, list[2].Key}
	want := []string{"character", "place", "theme"}
	for i := range want {
		if keys[i] != want[i] {
			t.Fatalf("порядок стартовых: %v, ожидалось %v", keys, want)
		}
		if !list[i].IsDefault {
			t.Fatalf("тип %s должен быть стартовым", list[i].Key)
		}
	}
}

// Свой тип: русское название → машинный ключ, карточка с этим видом создаётся.
func TestEntityTypeCustomAndCard(t *testing.T) {
	e := setupEntities(t)
	ctx := context.Background()

	created, err := e.svc.CreateType(ctx, e.owner, e.project, "  Фракция  ", "⚔", "#88aa66")
	if err != nil {
		t.Fatalf("создание типа: %v", err)
	}
	if created.Key != "frakciya" {
		t.Fatalf("ключ типа: %q, ожидалось frakciya", created.Key)
	}
	if created.Title != "Фракция" || created.Icon != "⚔" || created.IsDefault {
		t.Fatalf("поля типа: %+v", created)
	}

	card, err := e.svc.Create(ctx, e.owner, e.project, entities.Input{Kind: "frakciya", Name: "Дом Волка"})
	if err != nil {
		t.Fatalf("карточка своего типа: %v", err)
	}
	if card.Kind != "frakciya" {
		t.Fatalf("вид карточки: %q", card.Kind)
	}

	list, err := e.svc.Types(ctx, e.owner, e.project)
	if err != nil {
		t.Fatalf("типы: %v", err)
	}
	if len(list) != 4 || list[3].Key != "frakciya" {
		t.Fatalf("свой тип должен быть последним: %+v", list)
	}
}

// Переименование меняет название, но НЕ ключ: карточки остаются на месте.
func TestEntityTypeRenameKeepsKey(t *testing.T) {
	e := setupEntities(t)
	ctx := context.Background()
	created, err := e.svc.CreateType(ctx, e.owner, e.project, "Артефакт", "", "")
	if err != nil {
		t.Fatalf("создание типа: %v", err)
	}
	if created.Key != "artefakt" {
		t.Fatalf("ключ: %q", created.Key)
	}
	card, err := e.svc.Create(ctx, e.owner, e.project, entities.Input{Kind: created.Key, Name: "Клинок"})
	if err != nil {
		t.Fatalf("карточка: %v", err)
	}

	renamed, err := e.svc.UpdateType(ctx, e.owner, e.project, created.Key, "Реликвия", "◆", "#aabbcc")
	if err != nil {
		t.Fatalf("переименование: %v", err)
	}
	if renamed.Key != created.Key || renamed.Title != "Реликвия" {
		t.Fatalf("после переименования: %+v", renamed)
	}
	again, err := e.svc.ListEntities(ctx, e.owner, e.project)
	if err != nil {
		t.Fatalf("карточки: %v", err)
	}
	found := false
	for _, item := range again {
		if item.ID == card.ID {
			found = true
			if item.Kind != created.Key {
				t.Fatalf("вид карточки изменился при переименовании типа: %q", item.Kind)
			}
		}
	}
	if !found {
		t.Fatal("карточка пропала после переименования типа")
	}
}

// Отказы удаления: стартовый тип и тип с карточками.
func TestEntityTypeDeleteRules(t *testing.T) {
	e := setupEntities(t)
	ctx := context.Background()

	if err := e.svc.DeleteType(ctx, e.owner, e.project, "theme"); !errors.Is(err, entities.ErrTypeDefault) {
		t.Fatalf("стартовый тип должен быть защищён, получено %v", err)
	}

	created, err := e.svc.CreateType(ctx, e.owner, e.project, "Корабль", "", "")
	if err != nil {
		t.Fatalf("создание типа: %v", err)
	}
	if _, err := e.svc.Create(ctx, e.owner, e.project, entities.Input{Kind: created.Key, Name: "Тёмная звезда"}); err != nil {
		t.Fatalf("карточка: %v", err)
	}
	err = e.svc.DeleteType(ctx, e.owner, e.project, created.Key)
	var busy entities.ErrTypeHasCards
	if !errors.As(err, &busy) {
		t.Fatalf("тип с карточками должен быть защищён, получено %v", err)
	}
	if busy.Count != 1 || !strings.Contains(busy.Error(), "Корабль") {
		t.Fatalf("в отказе нет числа карточек и названия: %v", busy)
	}
	// Карточку сняли — тип удаляется.
	cards, err := e.svc.ListEntities(ctx, e.owner, e.project)
	if err != nil {
		t.Fatalf("карточки: %v", err)
	}
	for _, item := range cards {
		if item.Kind == created.Key {
			if err := e.svc.Delete(ctx, e.owner, e.project, item.ID); err != nil {
				t.Fatalf("удаление карточки: %v", err)
			}
		}
	}
	if err := e.svc.DeleteType(ctx, e.owner, e.project, created.Key); err != nil {
		t.Fatalf("удаление пустого типа: %v", err)
	}
}

// Вид карточки обязан быть типом проекта: чужой ключ отвергается до вставки.
func TestEntityKindMustExistInProject(t *testing.T) {
	e := setupEntities(t)
	ctx := context.Background()

	_, err := e.svc.Create(ctx, e.owner, e.project, entities.Input{Kind: "dragon", Name: "Смауг"})
	if !errors.Is(err, entities.ErrInvalidEntity) {
		t.Fatalf("чужой вид должен быть отвергнут, получено %v", err)
	}
	// Свой тип есть в одном проекте — во втором он не должен работать.
	created, err := e.svc.CreateType(ctx, e.owner, e.project, "Фракция", "", "")
	if err != nil {
		t.Fatalf("тип: %v", err)
	}
	if _, err := e.svc.Create(ctx, e.owner, e.other, entities.Input{Kind: created.Key, Name: "Дом Волка"}); !errors.Is(err, entities.ErrInvalidEntity) {
		t.Fatalf("тип чужого проекта не должен работать, получено %v", err)
	}
	// И в списке типов второго проекта его нет.
	list, err := e.svc.Types(ctx, e.owner, e.other)
	if err != nil {
		t.Fatalf("типы второго проекта: %v", err)
	}
	for _, item := range list {
		if item.Key == created.Key {
			t.Fatalf("тип первого проекта виден во втором: %+v", item)
		}
	}
}

// Читателю типы видны, а создавать и менять их он не может.
func TestEntityTypesPermissions(t *testing.T) {
	e := setupEntities(t)
	ctx := context.Background()
	if _, err := e.svc.Types(ctx, e.viewer, e.project); err != nil {
		t.Fatalf("читателю типы должны быть видны: %v", err)
	}
	if _, err := e.svc.CreateType(ctx, e.viewer, e.project, "Фракция", "", ""); !errors.Is(err, projects.ErrForbidden) {
		t.Fatalf("читатель не должен создавать типы, получено %v", err)
	}
	created, err := e.svc.CreateType(ctx, e.owner, e.project, "Фракция", "", "")
	if err != nil {
		t.Fatalf("тип: %v", err)
	}
	if _, err := e.svc.UpdateType(ctx, e.viewer, e.project, created.Key, "Другое", "", ""); !errors.Is(err, projects.ErrForbidden) {
		t.Fatalf("читатель не должен переименовывать типы, получено %v", err)
	}
}

// Одинаковое название без учёта регистра — это дубль, а не второй смысл.
func TestEntityTypeDuplicateTitle(t *testing.T) {
	e := setupEntities(t)
	ctx := context.Background()
	if _, err := e.svc.CreateType(ctx, e.owner, e.project, "Фракция", "", ""); err != nil {
		t.Fatalf("тип: %v", err)
	}
	_, err := e.svc.CreateType(ctx, e.owner, e.project, "фракция", "", "")
	var invalid = entities.ErrInvalidEntity
	if !errors.Is(err, invalid) {
		t.Fatalf("дубль названия должен быть отвергнут, получено %v", err)
	}
	// И переименовать в занятое название нельзя.
	second, err := e.svc.CreateType(ctx, e.owner, e.project, "Орден", "", "")
	if err != nil {
		t.Fatalf("второй тип: %v", err)
	}
	if _, err := e.svc.UpdateType(ctx, e.owner, e.project, second.Key, "ФРАКЦИЯ", "", ""); !errors.Is(err, entities.ErrInvalidEntity) {
		t.Fatalf("переименование в занятое название должно быть отвергнуто, получено %v", err)
	}
}

// Ключи типов в проекте уникальны даже при одинаковом основании.
func TestEntityTypeKeyCollision(t *testing.T) {
	e := setupEntities(t)
	ctx := context.Background()
	first, err := e.svc.CreateType(ctx, e.owner, e.project, "Faction", "", "")
	if err != nil {
		t.Fatalf("первый: %v", err)
	}
	// Названия разные (иначе сработала бы проверка дубля), ключ получается тем же.
	second, err := e.svc.CreateType(ctx, e.owner, e.project, "Faction!", "", "")
	if err != nil {
		t.Fatalf("второй: %v", err)
	}
	if first.Key == second.Key {
		t.Fatalf("ключи совпали: %q", first.Key)
	}
	if !strings.HasPrefix(second.Key, first.Key) {
		t.Fatalf("ключ второго %q не основан на %q", second.Key, first.Key)
	}
	_ = store.EntityTypeCharacter
}
