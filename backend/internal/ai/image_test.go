package ai_test

// image_test.go — генератор изображений (A1111-совместимый сервер).
//
// Всё на заглушке: настоящая генерация требует видеокарты и минут времени, а проверяем
// мы свой код — как спрашиваем список моделей, как собираем запрос, как разбираем ответ
// и что говорим человеку, когда генератор выключен. Заглушка отдаёт ту же форму ответа,
// что Automatic1111: base64-картинку и поле `info` со фактическими параметрами.

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/skyfraze/backend/internal/ai"
)

// tinyPNGBytes — настоящий PNG 1×1: генератор возвращает именно байты картинки.
var tinyPNGBytes = []byte{
	0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 0x00, 0x00, 0x00, 0x0D, 0x49, 0x48, 0x44, 0x52,
	0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x06, 0x00, 0x00, 0x00, 0x1F, 0x15, 0xC4,
	0x89, 0x00, 0x00, 0x00, 0x0D, 0x49, 0x44, 0x41, 0x54, 0x78, 0xDA, 0x63, 0xFC, 0xCF, 0xC0, 0xF0,
	0x1F, 0x00, 0x05, 0x00, 0x01, 0xFF, 0xAB, 0xCE, 0x36, 0x89, 0x00, 0x00, 0x00, 0x00, 0x49, 0x45,
	0x4E, 0x44, 0xAE, 0x42, 0x60, 0x82,
}

// newImageService собирает сервис ИИ с генератором по указанному адресу.
func newImageService(t *testing.T, imageURL string) *ai.Service {
	t.Helper()
	svc := ai.New(nil, ai.Config{
		Enabled:             true,
		ImageURL:            imageURL,
		ImageTimeoutSeconds: 5,
		ImageSteps:          12,
	}, nil, slog.New(slog.NewTextHandler(io.Discard, nil)))
	return svc
}

// a1111Stub — поддельный A1111: список моделей и генерация.
func a1111Stub(t *testing.T, generate func(w http.ResponseWriter, body map[string]any)) (*httptest.Server, *map[string]any) {
	t.Helper()
	last := map[string]any{}
	mux := http.NewServeMux()
	mux.HandleFunc("/sdapi/v1/sd-models", func(w http.ResponseWriter, r *http.Request) {
		_ = json.NewEncoder(w).Encode([]map[string]any{
			{"title": "sd_xl_base_1.0.safetensors", "model_name": "sd_xl_base_1.0"},
			{"title": "dreamshaper_8.safetensors", "model_name": "dreamshaper_8"},
		})
	})
	mux.HandleFunc("/sdapi/v1/txt2img", func(w http.ResponseWriter, r *http.Request) {
		var body map[string]any
		_ = json.NewDecoder(r.Body).Decode(&body)
		for k, v := range body {
			last[k] = v
		}
		generate(w, body)
	})
	server := httptest.NewServer(mux)
	t.Cleanup(server.Close)
	return server, &last
}

func TestImageGeneratorReportsModels(t *testing.T) {
	server, _ := a1111Stub(t, func(w http.ResponseWriter, _ map[string]any) {})
	svc := newImageService(t, server.URL)

	available, note := svc.ImageStatus(context.Background())
	if !available {
		t.Fatalf("генератор должен быть доступен: %s", note)
	}
	if !strings.Contains(note, "2") {
		t.Errorf("в пояснении нет числа моделей: %q", note)
	}
	models := svc.ImageModels(context.Background())
	if len(models) != 2 || models[0] != "sd_xl_base_1.0" {
		t.Errorf("модели: %+v", models)
	}
}

func TestImageGeneratorNotConfigured(t *testing.T) {
	svc := newImageService(t, "")
	available, note := svc.ImageStatus(context.Background())
	if available {
		t.Error("без адреса генерация недоступна")
	}
	// Пояснение должно говорить, ЧЕГО не хватает: «не настроено» и «не отвечает» —
	// разные вещи, и человеку нужно знать, что чинить.
	if !strings.Contains(note, "не настроен") {
		t.Errorf("пояснение: %q", note)
	}
	if _, ok := svc.ImageGenerator(); ok {
		t.Error("без адреса клиента быть не должно")
	}
}

func TestImageGeneratorUnavailable(t *testing.T) {
	// Адрес задан, но сервер не отвечает: это ЧАСТОЕ состояние (генератор выключен),
	// и оно не должно выглядеть как «всё хорошо».
	svc := newImageService(t, "http://127.0.0.1:1")
	available, note := svc.ImageStatus(context.Background())
	if available {
		t.Error("недоступный генератор не может считаться готовым")
	}
	if !strings.Contains(note, "не отвечает") {
		t.Errorf("пояснение: %q", note)
	}
}

func TestImageGenerateBuildsRequestAndParsesAnswer(t *testing.T) {
	server, last := a1111Stub(t, func(w http.ResponseWriter, _ map[string]any) {
		_ = json.NewEncoder(w).Encode(map[string]any{
			"images": []string{base64.StdEncoding.EncodeToString(tinyPNGBytes)},
			"info":   `{"seed": 4242, "sd_model_checkpoint": "dreamshaper_8"}`,
		})
	})
	svc := newImageService(t, server.URL)
	gen, ok := svc.ImageGenerator()
	if !ok {
		t.Fatal("клиент должен быть")
	}

	result, err := gen.Generate(context.Background(), ai.ImageRequest{
		Prompt:   "маяк на скале, акварель",
		Negative: "текст, водяные знаки",
		Width:    1024,
		Height:   576,
		Steps:    12,
	})
	if err != nil {
		t.Fatalf("генерация: %v", err)
	}
	if string(result.Data) != string(tinyPNGBytes) {
		t.Error("байты картинки не совпали с тем, что отдал генератор")
	}
	// Формат определяем по байтам, а не «на веру»: сервер может отдавать JPEG.
	if result.MediaType != "image/png" {
		t.Errorf("формат: %q", result.MediaType)
	}
	// Зерно и чекпойнт берём из info — по ним иллюстрацию можно повторить.
	if result.Seed != 4242 || result.Model != "dreamshaper_8" {
		t.Errorf("параметры генерации: seed=%d model=%q", result.Seed, result.Model)
	}

	// Запрос ушёл в форме A1111: промпт, негатив, размеры и шаги.
	if (*last)["prompt"] != "маяк на скале, акварель" {
		t.Errorf("промпт: %v", (*last)["prompt"])
	}
	if (*last)["negative_prompt"] != "текст, водяные знаки" {
		t.Errorf("негативный промпт: %v", (*last)["negative_prompt"])
	}
	if (*last)["width"] != float64(1024) || (*last)["height"] != float64(576) {
		t.Errorf("размеры: %v×%v", (*last)["width"], (*last)["height"])
	}
	if (*last)["steps"] != float64(12) {
		t.Errorf("шаги: %v", (*last)["steps"])
	}
	if (*last)["batch_size"] != float64(1) {
		t.Errorf("пачка должна быть из одной картинки: %v", (*last)["batch_size"])
	}
}

func TestImageGenerateClampsSize(t *testing.T) {
	// Слишком большой размер — это минуты ожидания и риск таймаута: ограничиваем.
	server, last := a1111Stub(t, func(w http.ResponseWriter, _ map[string]any) {
		_ = json.NewEncoder(w).Encode(map[string]any{
			"images": []string{base64.StdEncoding.EncodeToString(tinyPNGBytes)},
		})
	})
	svc := newImageService(t, server.URL)
	gen, _ := svc.ImageGenerator()
	if _, err := gen.Generate(context.Background(), ai.ImageRequest{
		Prompt: "очень большая картинка", Width: 9999, Height: 9999,
	}); err != nil {
		t.Fatalf("генерация: %v", err)
	}
	if (*last)["width"] != float64(2048) || (*last)["height"] != float64(2048) {
		t.Errorf("размер не ограничен: %v×%v", (*last)["width"], (*last)["height"])
	}
}

func TestImageGenerateReportsServerError(t *testing.T) {
	// Ошибка генератора должна доходить словами, а не «не получилось»: у A1111 в теле
	// бывает причина (нет модели, кончилась память).
	server, _ := a1111Stub(t, func(w http.ResponseWriter, _ map[string]any) {
		w.WriteHeader(http.StatusInternalServerError)
		_, _ = w.Write([]byte(`{"detail":"CUDA out of memory"}`))
	})
	svc := newImageService(t, server.URL)
	gen, _ := svc.ImageGenerator()
	_, err := gen.Generate(context.Background(), ai.ImageRequest{Prompt: "маяк"})
	if err == nil {
		t.Fatal("ошибка сервера должна вернуться ошибкой")
	}
	if !errors.Is(err, ai.ErrImageUnavailable) {
		t.Errorf("ожидалась ErrImageUnavailable, получено: %v", err)
	}
	if !strings.Contains(err.Error(), "CUDA out of memory") {
		t.Errorf("причина от сервера потерялась: %v", err)
	}
}

func TestImageGenerateWithoutPicture(t *testing.T) {
	// Сервер ответил 200, но картинки нет: это тоже отказ, а не «пустой успех».
	server, _ := a1111Stub(t, func(w http.ResponseWriter, _ map[string]any) {
		_ = json.NewEncoder(w).Encode(map[string]any{"images": []string{}, "detail": "no model loaded"})
	})
	svc := newImageService(t, server.URL)
	gen, _ := svc.ImageGenerator()
	if _, err := gen.Generate(context.Background(), ai.ImageRequest{Prompt: "маяк"}); err == nil {
		t.Fatal("пустой ответ должен быть ошибкой")
	}
}

func TestImageStatusIsCached(t *testing.T) {
	// Проверка доступности кэшируется: иначе каждое открытие окна помощника ждало бы
	// ответа выключенного генератора (таймаут — секунды).
	var calls int
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls++
		_ = json.NewEncoder(w).Encode([]map[string]any{})
	}))
	t.Cleanup(server.Close)
	svc := newImageService(t, server.URL)

	for i := 0; i < 3; i++ {
		svc.ImageStatus(context.Background())
	}
	if calls != 1 {
		t.Errorf("запросов к генератору: %d, ожидался 1 (остальные — из кэша)", calls)
	}
	// Список моделей берётся из того же ответа, а не новым запросом.
	svc.ImageModels(context.Background())
	if calls != 1 {
		t.Errorf("список моделей сходил в сеть ещё раз: %d", calls)
	}
	_ = time.Second
}
