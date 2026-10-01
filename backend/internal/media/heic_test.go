package media

// heic_test.go — разбор HEIC (формат айфонов).
//
// Проверяем то, что важно для хранения и для показа: HEIC превращается в обычную
// картинку (иначе браузер его не покажет), поворот из файла применяется один раз, а
// без конвертера сервер честно сообщает, что разобрать нечем.
//
// Настоящего libheif в среде теста может не быть, поэтому конвертер подменяется:
// проверяем НАШ путь (вызов, нормализация ориентации, дальнейшее пережатие), а сам
// libheif — чужая ответственность. Живая проверка с настоящим `heif-convert` —
// отдельно, на стенде с собранным образом.

import (
	"bytes"
	"context"
	"errors"
	"image"
	"strings"
	"testing"

	"github.com/KarpelesLab/gowebp"

	"github.com/skyfraze/backend/internal/platform/testimage"
)

// fakeHEICConverter отдаёт заранее заготовленный JPEG: так тест не зависит от libheif.
func fakeHEICConverter(t *testing.T, photo []byte) func(context.Context, []byte) ([]byte, error) {
	t.Helper()
	return func(_ context.Context, data []byte) ([]byte, error) {
		// Проверяем, что до конвертера дошли именно байты файла.
		if len(data) == 0 {
			return nil, errors.New("пустой вход")
		}
		return photo, nil
	}
}

func TestIsHEIC(t *testing.T) {
	for _, mime := range []string{"image/heic", "image/heif", "IMAGE/HEIC", "image/heic-sequence"} {
		if !IsHEIC(mime) {
			t.Errorf("%s должен считаться HEIC", mime)
		}
	}
	for _, mime := range []string{"image/jpeg", "image/png", ""} {
		if IsHEIC(mime) {
			t.Errorf("%s не HEIC", mime)
		}
	}
	for _, name := range []string{"IMG_1234.HEIC", "снимок.heif"} {
		if !IsHEICName(name) {
			t.Errorf("%s должен считаться HEIC по имени", name)
		}
	}
	if IsHEICName("снимок.jpg") {
		t.Error("jpg не HEIC")
	}
}

// HEIC превращается в WebP: имя становится .webp, размеры — от развёрнутой картинки.
func TestRecompressHEIC(t *testing.T) {
	UseHEICConverter(fakeHEICConverter(t, testimage.JPEG(t, testimage.Photo(1600, 1200), 95)))
	defer ResetHEICConverter()
	if !HEICAvailable() {
		t.Fatal("с подключённым конвертером HEIC обязан считаться доступным")
	}

	result, err := Recompress(context.Background(), "IMG_1234.heic", "image/heic", []byte("heic-байты"))
	if err != nil {
		t.Fatalf("пережатие HEIC: %v", err)
	}
	if !result.Changed {
		t.Fatal("HEIC обязан превратиться в webp")
	}
	if result.Mime != WebpMime || result.Filename != "IMG_1234.webp" {
		t.Errorf("тип и имя: %q, %q", result.Mime, result.Filename)
	}
	if result.Width != 1600 || result.Height != 1200 {
		t.Errorf("размеры: %dx%d", result.Width, result.Height)
	}
	decoded, err := gowebp.Decode(bytes.NewReader(result.Data))
	if err != nil {
		t.Fatalf("результат не читается как webp: %v", err)
	}
	if decoded.Bounds().Dx() != 1600 || decoded.Bounds().Dy() != 1200 {
		t.Errorf("в файле %dx%d", decoded.Bounds().Dx(), decoded.Bounds().Dy())
	}
}

// libheif применяет поворот из файла сам, а тег в JPEG может остаться исходным:
// если его не обнулить, мы развернём картинку второй раз.
func TestRecompressHEICNormalizesOrientation(t *testing.T) {
	photo := testimage.JPEG(t, testimage.Photo(400, 300), 92)
	// Конвертер «отдаёт» JPEG с тегом 6 — так ведёт себя heif-convert на снимке,
	// снятом боком: пиксели уже развёрнуты, тег остался.
	UseHEICConverter(fakeHEICConverter(t, withExifOrientation(t, photo, 6, false)))
	defer ResetHEICConverter()

	result, err := Recompress(context.Background(), "боком.heic", "image/heic", []byte("heic"))
	if err != nil {
		t.Fatalf("пережатие: %v", err)
	}
	// Тег 6 развернул бы 400×300 в 300×400; правильно — оставить 400×300.
	if result.Width != 400 || result.Height != 300 {
		t.Errorf("размеры %dx%d: поворот применён дважды", result.Width, result.Height)
	}
}

// Без конвертера пережатие обязано вернуть ошибку: вызывающий по ней отказывает
// (хранить HEIC как есть нельзя — браузер его не покажет).
func TestRecompressHEICWithoutConverter(t *testing.T) {
	ResetHEICConverter()
	if HEICAvailable() {
		t.Skip("в среде есть настоящий heif-convert — проверять нечего")
	}
	if _, err := Recompress(context.Background(), "IMG.heic", "image/heic", []byte("heic")); !errors.Is(err, ErrHEICUnavailable) {
		t.Fatalf("ожидалась ошибка «нет конвертера», получено: %v", err)
	}
}

// Битый HEIC: конвертер падает — ошибка, а не «оставим как есть».
func TestRecompressHEICConverterFails(t *testing.T) {
	UseHEICConverter(func(context.Context, []byte) ([]byte, error) {
		return nil, errors.New("heif-convert: не удалось разобрать")
	})
	defer ResetHEICConverter()

	_, err := Recompress(context.Background(), "битый.heic", "image/heic", []byte("мусор"))
	if err == nil || !strings.Contains(err.Error(), "HEIC") {
		t.Fatalf("ожидалась ошибка преобразования, получено: %v", err)
	}
}

// JPEG без HEIC не трогаем: конвертер не должен вызываться для обычных картинок.
func TestRecompressJPEGDoesNotUseHEICConverter(t *testing.T) {
	called := false
	UseHEICConverter(func(context.Context, []byte) ([]byte, error) {
		called = true
		return nil, errors.New("не должны сюда попасть")
	})
	defer ResetHEICConverter()

	source := testimage.JPEG(t, testimage.Photo(600, 400), 92)
	if _, err := Recompress(context.Background(), "фото.jpg", "image/jpeg", source); err != nil {
		t.Fatalf("пережатие jpeg: %v", err)
	}
	if called {
		t.Error("для jpeg конвертер HEIC вызываться не должен")
	}
}

// Нормализация ориентации: значение тега становится 1, байты на входе не портятся.
func TestNormalizeJpegOrientation(t *testing.T) {
	photo := testimage.JPEG(t, testimage.Photo(30, 20), 90)
	tagged := withExifOrientation(t, photo, 6, false)
	before := append([]byte(nil), tagged...)

	normalized := normalizeJpegOrientation(tagged)
	if bytes.Equal(normalized, tagged) {
		t.Fatal("тег не обнулён")
	}
	if !bytes.Equal(tagged, before) {
		t.Error("входные байты изменены")
	}
	if got := exifOrientation(normalized); got != 1 {
		t.Errorf("после нормализации ориентация %d, ожидалась 1", got)
	}
	// Картинка при этом остаётся валидным JPEG.
	if _, _, err := image.DecodeConfig(bytes.NewReader(normalized)); err != nil {
		t.Errorf("после нормализации JPEG не читается: %v", err)
	}
}
