package assistant_test

// image_tool_integration_test.go — инструмент генерации иллюстраций целиком.
//
// Проверяем весь путь: модель просит нарисовать → сервер рисует (заглушка генератора) →
// картинка сохраняется вложением проекта → привязывается к кадру в документе → человек
// видит это отдельным изменением. Именно эту цепочку нельзя проверить по частям: она
// ломается на стыках (промпт со стилем, имя файла, привязка не к тому кадру).

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/google/uuid"
	"github.com/skyfraze/backend/internal/ai"
	"github.com/skyfraze/backend/internal/assistant"
	"github.com/skyfraze/backend/internal/collab/yjs"
	"github.com/skyfraze/backend/internal/store"
)

// tinyPNGForTool — настоящая картинка 1×1 (base64 проверенной картинки, а не «похожие
// байты»): сервер пережимает изображения и проверяет их формат, поэтому подделка
// обернулась бы предупреждением «png: invalid checksum» и необработанным файлом.
var tinyPNGForTool, _ = base64.StdEncoding.DecodeString(
	"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==")

// stubGenerator — заглушка A1111-совместимого генератора: список моделей и картинка.
// Записывает промпт, который ушёл: стиль проекта должен доехать до генератора.
func stubGenerator(t *testing.T) (*httptest.Server, *string) {
	t.Helper()
	var lastPrompt string
	mux := http.NewServeMux()
	mux.HandleFunc("/sdapi/v1/sd-models", func(w http.ResponseWriter, r *http.Request) {
		_ = json.NewEncoder(w).Encode([]map[string]any{{"model_name": "stub-sd"}})
	})
	mux.HandleFunc("/sdapi/v1/txt2img", func(w http.ResponseWriter, r *http.Request) {
		var body map[string]any
		_ = json.NewDecoder(r.Body).Decode(&body)
		if prompt, ok := body["prompt"].(string); ok {
			lastPrompt = prompt
		}
		_ = json.NewEncoder(w).Encode(map[string]any{
			"images": []string{base64.StdEncoding.EncodeToString(tinyPNGForTool)},
			"info":   `{"seed": 7, "sd_model_checkpoint": "stub-sd"}`,
		})
	})
	server := httptest.NewServer(mux)
	t.Cleanup(server.Close)
	return server, &lastPrompt
}

func TestGenerateImageToolCreatesAssetAndAttaches(t *testing.T) {
	generator, lastPrompt := stubGenerator(t)
	imageURLForTests = generator.URL
	t.Cleanup(func() { imageURLForTests = "" })

	e := setup(t,
		// Модель просит иллюстрацию к главе…
		ai.Reply{ToolCalls: []ai.ToolCall{createCall(assistant.ToolGenerateImage, map[string]any{
			"event_id": "ПОДСТАВИМ", "prompt": "смотритель у маяка, шторм",
		})}},
		// …и после выполнения говорит словами, что сделала.
		ai.Reply{Content: "Нарисовал иллюстрацию к «Прологу»."},
	)
	ctx := context.Background()
	owner := e.user(t, "owner@example.com")
	projectID, chapter, _ := e.seedProject(t, owner)

	// Стиль проекта дописывает сервер — задаём его заранее.
	if _, err := e.st.SaveAISettings(ctx, projectID, owner, "", "", true,
		store.GenerationBoth, "акварель, тёплый свет"); err != nil {
		t.Fatalf("настройки: %v", err)
	}
	// Идентификатор кадра модель берёт из list_events; в тесте подставляем его прямо в
	// ответ — так проверяется выполнение, а не разговор модели с самой собой.
	e.stub.setReplies(
		ai.Reply{ToolCalls: []ai.ToolCall{createCall(assistant.ToolGenerateImage, map[string]any{
			"event_id": chapter.String(), "prompt": "смотритель у маяка, шторм",
		})}},
		ai.Reply{Content: "Нарисовал иллюстрацию к «Прологу»."},
	)

	turn, err := e.asst.Send(ctx, owner, projectID, uuid.Nil, "stub:stub-1", "Нарисуй иллюстрацию к главе 1")
	if err != nil {
		t.Fatalf("вопрос: %v", err)
	}

	// Модель увидела результат вызова как успешный.
	if len(turn.Calls) != 1 || !turn.Calls[0].OK {
		t.Fatalf("вызовы: %+v", turn.Calls)
	}
	// Человеку — отдельное изменение: «иллюстрация к главе», а не строка в тексте.
	if len(turn.Changes) != 1 || turn.Changes[0].Action != assistant.ChangeImageCreated {
		t.Fatalf("изменения: %+v", turn.Changes)
	}
	if turn.Changes[0].ID != chapter {
		t.Errorf("изменение указывает не на тот кадр: %s", turn.Changes[0].ID)
	}

	// Промпт ушёл со стилем проекта и заголовком кадра: модель картинок проекта не видит.
	prompt := *lastPrompt
	if !strings.Contains(prompt, "смотритель у маяка") ||
		!strings.Contains(prompt, "акварель, тёплый свет") ||
		!strings.Contains(prompt, "Глава 1") {
		t.Errorf("промпт генератора: %q", prompt)
	}

	// Картинка лежит в проекте вложением.
	assets, err := e.st.ListAssets(ctx, projectID)
	if err != nil {
		t.Fatalf("вложения: %v", err)
	}
	if len(assets) != 1 {
		t.Fatalf("вложений %d, ожидалось одно", len(assets))
	}
	// И привязана к кадру в документе.
	state, err := e.st.GetProjectEventState(ctx, projectID)
	if err != nil || state == nil {
		t.Fatalf("снапшот: %v", err)
	}
	doc, err := yjs.FromState(state.YjsState)
	if err != nil {
		t.Fatalf("документ: %v", err)
	}
	if usage := doc.AssetUsage(assets[0].ID.String()); usage != 1 {
		t.Fatalf("вложение не привязано к кадру: использование %d", usage)
	}
	for _, event := range doc.Events() {
		if event.ID == chapter.String() && event.Background != assets[0].ID.String() {
			t.Errorf("кадр не получил иллюстрацию фоном: %+v", event)
		}
	}
}

// Без генератора инструмент не предлагается вовсе: модель не должна знать о том, чего
// сервер не сделает.
func TestGenerateImageToolNotOfferedWithoutGenerator(t *testing.T) {
	e := setup(t, ai.Reply{Content: "Ответ."})
	ctx := context.Background()
	owner := e.user(t, "owner@example.com")
	projectID, _, _ := e.seedProject(t, owner)

	settings, err := e.asst.ProjectSettings(ctx, owner, projectID)
	if err != nil {
		t.Fatalf("настройки: %v", err)
	}
	if settings.Capabilities.Images {
		t.Fatal("без генератора картинки не могут быть доступны")
	}
	if !strings.Contains(settings.Capabilities.ImageNote, "не настроен") {
		t.Errorf("причина: %q", settings.Capabilities.ImageNote)
	}
	// И попытка всё равно отвергается словами, а не падением.
	_, err = e.asst.Send(ctx, owner, projectID, uuid.Nil, "stub:stub-1", "Нарисуй")
	if err != nil {
		t.Fatalf("обычный вопрос без картинок должен работать: %v", err)
	}
	// Запрос с вызовом инструмента иллюстраций моделью получен быть не может: его нет в
	// списке (см. tools_test). А прямой вызов отвергается понятной ошибкой.
	e.stub.setReplies(ai.Reply{ToolCalls: []ai.ToolCall{createCall(assistant.ToolGenerateImage, map[string]any{
		"event_id": uuid.Nil.String(), "prompt": "маяк",
	})}}, ai.Reply{Content: "—"})
	turn, err := e.asst.Send(ctx, owner, projectID, uuid.Nil, "stub:stub-1", "Нарисуй маяк")
	if err != nil {
		t.Fatalf("вопрос: %v", err)
	}
	if len(turn.Calls) != 1 || turn.Calls[0].OK {
		t.Fatalf("вызов должен быть отвергнут: %+v", turn.Calls)
	}
	if !strings.Contains(turn.Calls[0].Error, "недоступна") {
		t.Errorf("причина отказа: %q", turn.Calls[0].Error)
	}
}
