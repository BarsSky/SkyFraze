package assistant

// entities_test.go — инструмент list_entities: что модель видит про мир проекта (0.67.0).
//
// Проверяем ровно то, ради чего инструмент существует: модель получает ЕДИНЫЕ имена
// персонажей и мест с алиасами, а когда карточек нет — честную пустоту с подсказкой, а не
// выдуманный список. И то, что без подключённых карточек инструмент не выполняется вовсе.

import (
	"context"
	"strings"
	"testing"

	"github.com/google/uuid"

	"github.com/skyfraze/backend/internal/ai"
	"github.com/skyfraze/backend/internal/entities"
	"github.com/skyfraze/backend/internal/store"
)

// fakeWorld — карточки мира без базы: инструменты только читают, и им достаточно этого.
type fakeWorld struct {
	list   []store.ProjectEntity
	frames []entities.EntityFrame
}

func (f fakeWorld) ListEntities(
	_ context.Context, _, _ uuid.UUID,
) ([]store.ProjectEntity, error) {
	return f.list, nil
}

// Frames отдаёт заранее заданные кадры: тест проверяет разбор ответа, а не поиск по тексту
// (поиск проверяется в internal/entities/match_test.go своими случаями).
func (f fakeWorld) Frames(
	_ context.Context, _, _, _ uuid.UUID,
) ([]entities.EntityFrame, error) {
	return f.frames, nil
}

func callEntities() ai.ToolCall {
	return ai.ToolCall{ID: "1", Name: ToolListEntities, Arguments: map[string]any{}}
}

func TestListEntitiesTool(t *testing.T) {
	svc := &Service{}
	svc.UseEntities(fakeWorld{list: []store.ProjectEntity{
		{Kind: "character", Name: "Анна", Aliases: []string{"Аня", "Анны"}, Description: "Главная героиня"},
		{Kind: "place", Name: "Дом на холме"},
	}})

	result := svc.execute(context.Background(), uuid.Nil, uuid.New(), uuid.New(), callEntities(),
		Capabilities{Text: true})
	if !result.report.OK {
		t.Fatalf("инструмент отказал: %+v", result.report)
	}
	payload, ok := result.payload.(map[string]any)
	if !ok {
		t.Fatalf("payload не объект: %T", result.payload)
	}
	rows, ok := payload["entities"].([]map[string]any)
	if !ok || len(rows) != 2 {
		t.Fatalf("ожидались две карточки: %+v", payload["entities"])
	}
	if rows[0]["name"] != "Анна" || rows[0]["description"] != "Главная героиня" {
		t.Fatalf("поля карточки потерялись: %+v", rows[0])
	}
	// Строки для промпта: вид по-русски, алиасы в скобках — модель читает текст лучше JSON.
	summary, _ := payload["summary"].(string)
	if !strings.Contains(summary, "персонаж «Анна»") || !strings.Contains(summary, "также: Аня, Анны") {
		t.Fatalf("сводка для промпта: %q", summary)
	}
	if !strings.Contains(summary, "место «Дом на холме»") {
		t.Fatalf("сводка без места: %q", summary)
	}
}

// Пустой мир — это не ошибка: модель должна получить пустоту и подсказку, а не придумать
// себе персонажей «по аналогии».
func TestListEntitiesToolEmptyWorld(t *testing.T) {
	svc := &Service{}
	svc.UseEntities(fakeWorld{})
	result := svc.execute(context.Background(), uuid.Nil, uuid.New(), uuid.New(), callEntities(),
		Capabilities{Text: true})
	if !result.report.OK {
		t.Fatalf("пустой мир — не отказ: %+v", result.report)
	}
	payload := result.payload.(map[string]any)
	if rows := payload["entities"].([]any); len(rows) != 0 {
		t.Fatalf("ожидался пустой список: %+v", rows)
	}
	if note, _ := payload["note"].(string); !strings.Contains(note, "нет карточек") {
		t.Fatalf("нет подсказки про отсутствие карточек: %q", note)
	}
}

// Без подключённых карточек инструмент отказывает понятной фразой (а не паникой): стенд мог
// быть собран без сущностей, и это не повод ломать весь ответ помощника.
func TestListEntitiesToolWithoutWorld(t *testing.T) {
	svc := &Service{}
	result := svc.execute(context.Background(), uuid.Nil, uuid.New(), uuid.New(), callEntities(),
		Capabilities{Text: true})
	if result.report.OK {
		t.Fatal("ожидался отказ без подключённых карточек")
	}
	if !strings.Contains(result.report.Error, "недоступны") {
		t.Fatalf("отказ без объяснения: %q", result.report.Error)
	}
}
