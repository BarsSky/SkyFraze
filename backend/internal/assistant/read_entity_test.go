// read_entity — «где появляется Анна»: кадры и цитаты для помощника (0.70.0).

package assistant

import (
	"context"
	"strings"
	"testing"

	"github.com/google/uuid"

	"github.com/skyfraze/backend/internal/ai"
	"github.com/skyfraze/backend/internal/entities"
	"github.com/skyfraze/backend/internal/store"
)

func callReadEntity(name string) ai.ToolCall {
	args := map[string]any{}
	if name != "" {
		args["name"] = name
	}
	return ai.ToolCall{ID: "1", Name: ToolReadEntity, Arguments: args}
}

func worldWith(frames ...entities.EntityFrame) fakeWorld {
	return fakeWorld{
		list: []store.ProjectEntity{
			{ID: uuid.New(), Kind: "character", Name: "Анна", Aliases: []string{"Аня"}},
		},
		frames: frames,
	}
}

func TestReadEntityReturnsFrames(t *testing.T) {
	svc := &Service{}
	svc.UseEntities(worldWith(
		entities.EntityFrame{FrameID: "f1", Title: "Пролог", Quotes: []string{"Анна", "Анны"}},
		entities.EntityFrame{FrameID: "f2", Title: "Развязка", Quotes: []string{"Ане"}},
	))
	result := svc.execute(context.Background(), uuid.Nil, uuid.New(), uuid.New(),
		callReadEntity("Анна"), Capabilities{Text: true})
	if !result.report.OK {
		t.Fatalf("отказ: %+v", result.report)
	}
	payload := result.payload.(map[string]any)
	rows := payload["frames"].([]map[string]any)
	if len(rows) != 2 {
		t.Fatalf("ожидались два кадра: %+v", rows)
	}
	if rows[0]["title"] != "Пролог" || rows[0]["event_id"] != "f1" {
		t.Fatalf("кадр потерял поля: %+v", rows[0])
	}
	// Сводка для промпта: модель читает текст лучше, чем вложенный JSON.
	summary, _ := payload["summary"].(string)
	if !strings.Contains(summary, "Пролог — Анна, Анны") {
		t.Fatalf("сводка: %q", summary)
	}
}

// Имя сравнивается без учёта регистра: модель может написать «анна».
func TestReadEntityNameCaseInsensitive(t *testing.T) {
	svc := &Service{}
	svc.UseEntities(worldWith(
		entities.EntityFrame{FrameID: "f1", Title: "Пролог", Quotes: []string{"Анна"}},
	))
	result := svc.execute(context.Background(), uuid.Nil, uuid.New(), uuid.New(),
		callReadEntity("анна"), Capabilities{Text: true})
	if !result.report.OK {
		t.Fatalf("отказ на другом регистре: %+v", result.report)
	}
}

// Карточка без упоминаний — не ошибка: модель получает пустоту и подсказку про алиас.
func TestReadEntityWithoutMentions(t *testing.T) {
	svc := &Service{}
	svc.UseEntities(worldWith())
	result := svc.execute(context.Background(), uuid.Nil, uuid.New(), uuid.New(),
		callReadEntity("Анна"), Capabilities{Text: true})
	if !result.report.OK {
		t.Fatalf("пустой ответ — не отказ: %+v", result.report)
	}
	payload := result.payload.(map[string]any)
	if rows := payload["frames"].([]any); len(rows) != 0 {
		t.Fatalf("ожидался пустой список: %+v", rows)
	}
	if note, _ := payload["note"].(string); !strings.Contains(note, "алиас") {
		t.Fatalf("нет подсказки про алиас: %q", note)
	}
}

// Несуществующее имя — отказ с просьбой взять имя из list_entities, а не молчаливая пустота:
// иначе модель решит, что карточка есть, но нигде не встречается.
func TestReadEntityUnknownName(t *testing.T) {
	svc := &Service{}
	svc.UseEntities(worldWith())
	result := svc.execute(context.Background(), uuid.Nil, uuid.New(), uuid.New(),
		callReadEntity("Сторож"), Capabilities{Text: true})
	if result.report.OK {
		t.Fatal("ожидался отказ по несуществующей карточке")
	}
	if !strings.Contains(result.report.Error, "list_entities") {
		t.Fatalf("отказ без подсказки: %q", result.report.Error)
	}
}

// Без имени инструмент не догадывается — просит имя.
func TestReadEntityRequiresName(t *testing.T) {
	svc := &Service{}
	svc.UseEntities(worldWith())
	result := svc.execute(context.Background(), uuid.Nil, uuid.New(), uuid.New(),
		callReadEntity(""), Capabilities{Text: true})
	if result.report.OK {
		t.Fatal("ожидался отказ без имени")
	}
}

// Без подключённых карточек инструмент не выполняется.
func TestReadEntityWithoutWorld(t *testing.T) {
	svc := &Service{}
	result := svc.execute(context.Background(), uuid.Nil, uuid.New(), uuid.New(),
		callReadEntity("Анна"), Capabilities{Text: true})
	if result.report.OK {
		t.Fatal("ожидался отказ без карточек мира")
	}
}
