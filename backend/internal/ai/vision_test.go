package ai_test

// vision_test.go — картинки к сообщению: кто их видит и как они уходят провайдеру.
//
// Проверяем три вещи, каждая из которых может сломаться незаметно:
//   - признак «модель видит картинки» берётся из метаданных провайдера, а при их
//     отсутствии — из имени модели (иначе кнопка «приложить» не появилась бы ни у Groq,
//     ни у OpenAI, где про модальности в API ничего нет);
//   - данные уходят в ТОМ ВИДЕ, который ждёт конкретный провайдер: Ollama — чистый
//     base64, OpenAI-совместимые — data URL внутри части контента;
//   - мусор вместо картинки отвергается нами, а не провайдером.

import (
	"context"
	"encoding/json"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/skyfraze/backend/internal/ai"
)

// tinyPNG — настоящая картинка 1×1 (не «abc»): проверяем формат так, как его увидит
// провайдер.
const tinyPNG = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg=="

func TestOllamaReportsVisionFromCapabilities(t *testing.T) {
	s := newStub(t, func(w http.ResponseWriter, r *http.Request, _ *stub) {
		writeJSONBody(t, w, map[string]any{"models": []map[string]any{
			{"name": "зрячая:latest", "model": "зрячая:latest", "capabilities": []string{"tools", "vision"}},
			{"name": "слепая:latest", "model": "слепая:latest", "capabilities": []string{"tools"}},
			// Пустой список возможностей — «не знаем»: считаем, что не видит (обещать
			// зрение и молча потерять картинку хуже, чем не показать кнопку).
			{"name": "молчун:latest", "model": "молчун:latest"},
		}})
	})
	client, _ := ai.NewClient(s.provider(ai.KindOllama, "ollama"), "", 5*time.Second)
	models, err := client.ListModels(context.Background())
	if err != nil {
		t.Fatalf("список моделей: %v", err)
	}
	byID := map[string]bool{}
	for _, m := range models {
		byID[m.ID] = m.Vision
	}
	if !byID["зрячая:latest"] {
		t.Error("модель с возможностью vision должна считаться зрячей")
	}
	if byID["слепая:latest"] || byID["молчун:latest"] {
		t.Error("модель без метаданных не должна считаться зрячей")
	}
}

func TestOpenAIReportsVisionFromModalitiesAndName(t *testing.T) {
	s := newStub(t, func(w http.ResponseWriter, r *http.Request, _ *stub) {
		writeJSONBody(t, w, map[string]any{"data": []map[string]any{
			{"id": "какая-то-модель", "architecture": map[string]any{"input_modalities": []string{"text", "image"}}},
			{"id": "текстовая-модель", "architecture": map[string]any{"input_modalities": []string{"text"}}},
			// Метаданных нет вовсе (так отвечают Groq и OpenAI): решает имя.
			{"id": "qwen2.5-vl-7b"},
			{"id": "обычная-модель"},
		}})
	})
	client, _ := ai.NewClient(s.provider(ai.KindOpenAI, "groq"), "k", 5*time.Second)
	models, err := client.ListModels(context.Background())
	if err != nil {
		t.Fatalf("список моделей: %v", err)
	}
	got := map[string]bool{}
	for _, m := range models {
		got[m.ID] = m.Vision
	}
	if !got["какая-то-модель"] {
		t.Error("модальность image должна означать зрение")
	}
	if !got["qwen2.5-vl-7b"] {
		t.Error("имя модели с «-vl» должно означать зрение")
	}
	if got["текстовая-модель"] || got["обычная-модель"] {
		t.Error("модель без признаков зрения не должна считаться зрячей")
	}
}

func TestOllamaSendsImageAsRawBase64(t *testing.T) {
	s := newStub(t, func(w http.ResponseWriter, r *http.Request, _ *stub) {
		writeJSONBody(t, w, map[string]any{
			"model":   "зрячая:latest",
			"message": map[string]any{"role": "assistant", "content": "Вижу маяк."},
		})
	})
	client, _ := ai.NewClient(s.provider(ai.KindOllama, "ollama"), "", 5*time.Second)
	if _, err := client.Chat(context.Background(), ai.Request{
		Model:    "зрячая:latest",
		Messages: []ai.Message{{Role: "user", Content: "Что на картинке?", Images: []string{tinyPNG}}},
	}); err != nil {
		t.Fatalf("чат: %v", err)
	}

	raw, _ := json.Marshal(s.lastBody["messages"])
	var messages []struct {
		Images []string `json:"images"`
	}
	if err := json.Unmarshal(raw, &messages); err != nil {
		t.Fatalf("разбор запроса: %v", err)
	}
	if len(messages) != 1 || len(messages[0].Images) != 1 {
		t.Fatalf("картинка не ушла в запрос: %+v", messages)
	}
	// Ollama ждёт чистый base64: data-заголовок его сломает.
	if strings.HasPrefix(messages[0].Images[0], "data:") {
		t.Errorf("Ollama получила data URL вместо base64: %.30s", messages[0].Images[0])
	}
	if !strings.HasPrefix(messages[0].Images[0], "iVBORw0KGgo") {
		t.Errorf("не те данные: %.30s", messages[0].Images[0])
	}
}

func TestOpenAISendsImageAsContentParts(t *testing.T) {
	s := newStub(t, func(w http.ResponseWriter, r *http.Request, _ *stub) {
		writeJSONBody(t, w, map[string]any{
			"model":   "зрячая",
			"choices": []map[string]any{{"message": map[string]any{"role": "assistant", "content": "Вижу."}}},
		})
	})
	client, _ := ai.NewClient(s.provider(ai.KindOpenAI, "groq"), "k", 5*time.Second)
	if _, err := client.Chat(context.Background(), ai.Request{
		Model:    "зрячая",
		Messages: []ai.Message{{Role: "user", Content: "Что на картинке?", Images: []string{tinyPNG}}},
	}); err != nil {
		t.Fatalf("чат: %v", err)
	}

	raw, _ := json.Marshal(s.lastBody["messages"])
	var messages []struct {
		Content []struct {
			Type     string `json:"type"`
			Text     string `json:"text"`
			ImageURL struct {
				URL string `json:"url"`
			} `json:"image_url"`
		} `json:"content"`
	}
	if err := json.Unmarshal(raw, &messages); err != nil {
		t.Fatalf("контент не массив частей: %v (%s)", err, string(raw))
	}
	if len(messages) != 1 || len(messages[0].Content) != 2 {
		t.Fatalf("части контента: %+v", messages)
	}
	if messages[0].Content[0].Type != "text" || messages[0].Content[1].Type != "image_url" {
		t.Errorf("порядок частей: %+v", messages[0].Content)
	}
	// OpenAI-совместимые ждут data URL целиком.
	if messages[0].Content[1].ImageURL.URL != tinyPNG {
		t.Errorf("картинка ушла не как data URL: %.40s", messages[0].Content[1].ImageURL.URL)
	}
}

func TestOpenAIWithoutImagesKeepsPlainStringContent(t *testing.T) {
	// Сообщение без картинок обязано остаться строкой: часть серверов массив частей не
	// принимает, и ломать им обычный чат незачем.
	s := newStub(t, func(w http.ResponseWriter, r *http.Request, _ *stub) {
		writeJSONBody(t, w, map[string]any{
			"choices": []map[string]any{{"message": map[string]any{"role": "assistant", "content": "Ок"}}},
		})
	})
	client, _ := ai.NewClient(s.provider(ai.KindOpenAI, "groq"), "k", 5*time.Second)
	if _, err := client.Chat(context.Background(), ai.Request{
		Model:    "обычная",
		Messages: []ai.Message{{Role: "user", Content: "Привет"}},
	}); err != nil {
		t.Fatalf("чат: %v", err)
	}
	raw, _ := json.Marshal(s.lastBody["messages"])
	if !strings.Contains(string(raw), `"content":"Привет"`) {
		t.Errorf("контент без картинок должен быть строкой: %s", string(raw))
	}
}

func TestValidateImages(t *testing.T) {
	if err := ai.ValidateImages(nil); err != nil {
		t.Fatalf("без картинок: %v", err)
	}
	if err := ai.ValidateImages([]string{tinyPNG}); err != nil {
		t.Fatalf("нормальная картинка отвергнута: %v", err)
	}
	tooMany := []string{tinyPNG, tinyPNG, tinyPNG, tinyPNG}
	if err := ai.ValidateImages(tooMany); err == nil {
		t.Error("четыре картинки должны быть отвергнуты")
	}
	cases := map[string]string{
		"не data URL":     "iVBORw0KGgo=",
		"svg":             "data:image/svg+xml;base64,PHN2Zy8+",
		"пустая":          "data:image/png;base64,",
		"не base64":       "data:image/png;base64,????",
		"не base64 вовсе": "data:image/png,abc",
	}
	for name, image := range cases {
		if err := ai.ValidateImages([]string{image}); err == nil {
			t.Errorf("%s: должно быть отвергнуто", name)
		}
	}
	// Слишком большая: проверяем на пределе, а не «на глаз».
	huge := "data:image/png;base64," + strings.Repeat("A", ai.MaxImageDataURLLen)
	if err := ai.ValidateImages([]string{huge}); err == nil {
		t.Error("картинка больше предела должна быть отвергнута")
	}
}

// writeJSONBody отдаёт тело ответа заглушки как JSON.
func writeJSONBody(t *testing.T, w http.ResponseWriter, body any) {
	t.Helper()
	w.Header().Set("Content-Type", "application/json")
	if err := json.NewEncoder(w).Encode(body); err != nil {
		t.Errorf("ответ заглушки: %v", err)
	}
}
