package entities_test

// usage_integration_test.go — где карточка встречается, по проекции дерева (0.70.0).
//
// Проверяем то, ради чего серверная реализация существует: ответ не зависит от открытой
// вкладки (текст берётся из `events`), падежи находятся по алиасам, а «сирота» видна как ноль.

import (
	"context"
	"testing"

	"github.com/google/uuid"

	"github.com/skyfraze/backend/internal/entities"
	"github.com/skyfraze/backend/internal/store"
)

func TestUsageAndFrames(t *testing.T) {
	e := setupEntities(t)
	ctx := context.Background()

	aliases := []string{"Аня", "Анны"}
	anna, err := e.svc.Create(ctx, e.owner, e.project, entities.Input{
		Kind: "character", Name: "Анна", Aliases: &aliases,
	})
	if err != nil {
		t.Fatalf("карточка: %v", err)
	}
	orphan, err := e.svc.Create(ctx, e.owner, e.project, entities.Input{
		Kind: "theme", Name: "Письмо",
	})
	if err != nil {
		t.Fatalf("вторая карточка: %v", err)
	}
	// Текст кадров — в проекции дерева: это и есть источник для серверного поиска.
	rows := []store.Event{
		{ID: uuid.New(), ProjectID: e.project, Position: 0, Title: "Пролог", Body: "Анна вошла. История Анны."},
		{ID: uuid.New(), ProjectID: e.project, Position: 1, Title: "Развязка", Body: "Тишина."},
	}
	if err := e.st.ReplaceEventTree(ctx, e.project, e.owner, rows); err != nil {
		t.Fatalf("дерево: %v", err)
	}

	usage, err := e.svc.Usage(ctx, e.viewer, e.project)
	if err != nil {
		t.Fatalf("usage: %v", err)
	}
	if len(usage) != 2 {
		t.Fatalf("ожидались две строки: %+v", usage)
	}
	// Первая — Анна: один кадр, два упоминания (имя и падеж из алиасов).
	if usage[0].Entity.ID != anna.ID || usage[0].Frames != 1 || usage[0].Mentions != 2 {
		t.Fatalf("сводка по Анне: %+v", usage[0])
	}
	// «Сирота» внизу с нулями — её и надо увидеть.
	if usage[1].Entity.ID != orphan.ID || usage[1].Frames != 0 {
		t.Fatalf("сирота: %+v", usage[1])
	}

	frames, err := e.svc.Frames(ctx, e.viewer, e.project, anna.ID)
	if err != nil {
		t.Fatalf("frames: %v", err)
	}
	if len(frames) != 1 || frames[0].Title != "Пролог" {
		t.Fatalf("кадры Анны: %+v", frames)
	}
	if len(frames[0].Quotes) != 2 || frames[0].Quotes[0] != "Анна" || frames[0].Quotes[1] != "Анны" {
		t.Fatalf("цитаты: %+v", frames[0].Quotes)
	}
}

// Читатель видит использование карточек, посторонний — нет.
func TestUsagePermissions(t *testing.T) {
	e := setupEntities(t)
	ctx := context.Background()
	if _, err := e.svc.Usage(ctx, e.outsider, e.project); err == nil {
		t.Fatal("посторонний не должен читать связи проекта")
	}
	if _, err := e.svc.Usage(ctx, e.viewer, e.project); err != nil {
		t.Fatalf("читатель должен видеть: %v", err)
	}
}
