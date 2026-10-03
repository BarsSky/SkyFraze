//go:build liveimage

package ai_test

// image_live_test.go — живая проверка генератора: настоящий сервер, настоящая картинка.
//
// Под отдельным тегом (`liveimage`), а не обычным тестом, по двум причинам:
//   - в CI генератора нет и быть не может, а тест, который «пропускается, когда не
//     настроено», превращается в вечно зелёную галочку (ровно та ошибка, из-за которой
//     регрессия с регистрацией прожила релиз);
//   - загрузка модели на чужом стеке — это побочный эффект: обычный `go test ./...` не
//     должен трогать чужие сервисы.
//
// Запуск (адрес и модель задаются окружением):
//
//	SKYFRAZE_IMAGE_URL=http://127.0.0.1:18079 SKYFRAZE_IMAGE_MODEL=sd15-q4 \
//	  go test -tags liveimage ./internal/ai/ -run Live -v
//
// Проверяет три вещи, которые на заглушке не проверить: сервер отвечает, модель
// поднимается (если выгружена), картинка приходит настоящая и разбирается.

import (
	"context"
	"io"
	"log/slog"
	"os"
	"testing"
	"time"

	"github.com/skyfraze/backend/internal/ai"
)

func TestLiveImageGeneration(t *testing.T) {
	url := os.Getenv("SKYFRAZE_IMAGE_URL")
	if url == "" {
		t.Fatal("нет SKYFRAZE_IMAGE_URL — эта проверка запускается только вручную")
	}
	model := os.Getenv("SKYFRAZE_IMAGE_MODEL")
	svc := ai.New(nil, ai.Config{
		Enabled:             true,
		ImageURL:            url,
		ImageTimeoutSeconds: 300,
		ImageModel:          model,
		ImageSteps:          8,
		ImageAutoLoad:       true,
	}, nil, slog.New(slog.NewTextHandler(io.Discard, nil)))

	ctx := context.Background()
	available, note := svc.ImageStatus(ctx)
	t.Logf("генератор: доступен=%v, пояснение=%q", available, note)
	if !available {
		t.Fatalf("генератор недоступен: %s", note)
	}
	models := svc.ImageModels(ctx)
	t.Logf("модели: %v", models)
	if len(models) == 0 {
		t.Error("сервер не назвал ни одной модели")
	}

	gen, ok := svc.ImageGenerator()
	if !ok {
		t.Fatal("клиент генератора не собрался")
	}
	started := time.Now()
	result, err := gen.Generate(ctx, ai.ImageRequest{
		Prompt:   "маяк на скале у холодного моря, акварель, тёплый свет",
		Negative: "текст, водяные знаки",
		Width:    512,
		Height:   288,
	})
	if err != nil {
		t.Fatalf("генерация: %v", err)
	}
	t.Logf("картинка: %d байт, формат %s, модель %q, seed %d, за %s",
		len(result.Data), result.MediaType, result.Model, result.Seed, time.Since(started).Round(time.Millisecond))
	if len(result.Data) < 1000 {
		t.Errorf("подозрительно маленькая картинка: %d байт", len(result.Data))
	}
	if result.MediaType != "image/png" && result.MediaType != "image/jpeg" && result.MediaType != "image/webp" {
		t.Errorf("неизвестный формат: %q", result.MediaType)
	}
}
