package entities_test

// links_integration_test.go — связи карточек мира (миграция 0032).
//
// Проверяем правила, без которых связи превращаются в шум и дыру в правах: карточка не связана
// сама с собой, дубль не создаётся, оба конца — из ЭТОГО проекта, подпись ограничена, связей у
// карточки не больше двадцати, а удаление карточки уносит её связи.

import (
	"context"
	"errors"
	"testing"

	"github.com/skyfraze/backend/internal/entities"
	"github.com/skyfraze/backend/internal/store"
)

func TestEntityLinks(t *testing.T) {
	e := setupEntities(t)
	ctx := context.Background()

	anna, err := e.svc.Create(ctx, e.owner, e.project, entities.Input{Kind: "character", Name: "Аня"})
	if err != nil {
		t.Fatalf("Аня: %v", err)
	}
	earth, err := e.svc.Create(ctx, e.owner, e.project, entities.Input{Kind: "place", Name: "Земля"})
	if err != nil {
		t.Fatalf("Земля: %v", err)
	}

	link, err := e.svc.AddLink(ctx, e.owner, e.project, anna.ID, earth.ID, "живёт на")
	if err != nil {
		t.Fatalf("связь: %v", err)
	}
	if link.FromEntity != anna.ID || link.ToEntity != earth.ID || link.Label != "живёт на" {
		t.Fatalf("поля связи: %+v", link)
	}

	list, err := e.svc.Links(ctx, e.viewer, e.project)
	if err != nil {
		t.Fatalf("список: %v", err)
	}
	if len(list) != 1 || list[0].ID != link.ID {
		t.Fatalf("ожидалась одна связь: %+v", list)
	}

	// Дубль (с другим регистром подписи) — отказ, а не вторая строка.
	if _, err := e.svc.AddLink(ctx, e.owner, e.project, anna.ID, earth.ID, "Живёт на"); !errors.Is(err, store.ErrEntityLinkExists) {
		t.Fatalf("ожидался конфликт: %v", err)
	}
	// Сама с собой — отказ.
	if _, err := e.svc.AddLink(ctx, e.owner, e.project, anna.ID, anna.ID, "знает"); !errors.Is(err, entities.ErrInvalidEntity) {
		t.Fatalf("ожидался отказ по самосвязи: %v", err)
	}
	// Пустая и слишком длинная подпись — отказ.
	if _, err := e.svc.AddLink(ctx, e.owner, e.project, anna.ID, earth.ID, "   "); !errors.Is(err, entities.ErrInvalidEntity) {
		t.Fatalf("ожидался отказ по пустой подписи: %v", err)
	}
	long := make([]rune, 41)
	for i := range long {
		long[i] = 'а'
	}
	if _, err := e.svc.AddLink(ctx, e.owner, e.project, anna.ID, earth.ID, string(long)); !errors.Is(err, entities.ErrInvalidEntity) {
		t.Fatalf("ожидался отказ по длинной подписи: %v", err)
	}

	// Карточка ДРУГОГО проекта не связывается: иначе хватило бы угадать идентификатор.
	foreign, err := e.svc.Create(ctx, e.owner, e.other, entities.Input{Kind: "place", Name: "Луна"})
	if err != nil {
		t.Fatalf("Луна: %v", err)
	}
	if _, err := e.svc.AddLink(ctx, e.owner, e.project, anna.ID, foreign.ID, "летает на"); !errors.Is(err, store.ErrNotFound) {
		t.Fatalf("ожидался not found для чужой карточки: %v", err)
	}

	// Читатель видит связи, но не создаёт их.
	if _, err := e.svc.AddLink(ctx, e.viewer, e.project, earth.ID, anna.ID, "дом"); err == nil {
		t.Fatal("читатель не должен создавать связи")
	}

	// Удаление связи и удаление карточки уносит её связи.
	if err := e.svc.DeleteLink(ctx, e.owner, e.project, link.ID); err != nil {
		t.Fatalf("удаление связи: %v", err)
	}
	if list, err := e.svc.Links(ctx, e.owner, e.project); err != nil || len(list) != 0 {
		t.Fatalf("связи должны исчезнуть: %v %+v", err, list)
	}
	if _, err := e.svc.AddLink(ctx, e.owner, e.project, anna.ID, earth.ID, "живёт на"); err != nil {
		t.Fatalf("новая связь: %v", err)
	}
	if err := e.svc.Delete(ctx, e.owner, e.project, earth.ID); err != nil {
		t.Fatalf("удаление карточки: %v", err)
	}
	if list, err := e.svc.Links(ctx, e.owner, e.project); err != nil || len(list) != 0 {
		t.Fatalf("связи удалённой карточки должны исчезнуть: %v %+v", err, list)
	}
}

// Предел связей у карточки: двадцать — уже список, а не связь.
func TestEntityLinksLimit(t *testing.T) {
	e := setupEntities(t)
	ctx := context.Background()
	anna, err := e.svc.Create(ctx, e.owner, e.project, entities.Input{Kind: "character", Name: "Аня"})
	if err != nil {
		t.Fatalf("Аня: %v", err)
	}
	for i := 0; i < 20; i++ {
		other, err := e.svc.Create(ctx, e.owner, e.project, entities.Input{
			Kind: "theme", Name: "Тема " + string(rune('А'+i)),
		})
		if err != nil {
			t.Fatalf("тема %d: %v", i, err)
		}
		if _, err := e.svc.AddLink(ctx, e.owner, e.project, anna.ID, other.ID, "связана"); err != nil {
			t.Fatalf("связь %d: %v", i, err)
		}
	}
	extra, err := e.svc.Create(ctx, e.owner, e.project, entities.Input{Kind: "theme", Name: "Лишняя"})
	if err != nil {
		t.Fatalf("лишняя тема: %v", err)
	}
	if _, err := e.svc.AddLink(ctx, e.owner, e.project, anna.ID, extra.ID, "связана"); !errors.Is(err, entities.ErrInvalidEntity) {
		t.Fatalf("ожидался отказ по пределу: %v", err)
	}
}
