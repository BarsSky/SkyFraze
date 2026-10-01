package media_test

// Пережатие картинок: PNG → lossless WebP, JPEG → lossy WebP с ограничением
// стороны. Проверяем то, что важно для хранения и для показа: файл меньше,
// картинка читается, размеры не больше предела, а «не картинка» и «уже маленькая»
// остаются как были.

import (
	"bytes"
	"context"
	"image"
	"testing"

	"github.com/KarpelesLab/gowebp"

	"github.com/skyfraze/backend/internal/media"
	"github.com/skyfraze/backend/internal/platform/testimage"
)

// decodeWebp читает результат тем же кодеком: доказательство, что файл валиден и
// того же размера, что обещали.
func decodeWebp(t *testing.T, data []byte) image.Image {
	t.Helper()
	img, err := gowebp.Decode(bytes.NewReader(data))
	if err != nil {
		t.Fatalf("результат не читается как webp: %v", err)
	}
	return img
}

func TestRecompressJPEG(t *testing.T) {
	img := testimage.Photo(1200, 800)
	source := testimage.JPEG(t, img, 92)

	result, err := media.Recompress(context.Background(), "фото.jpg", "image/jpeg", source)
	if err != nil {
		t.Fatalf("пережатие: %v", err)
	}
	if !result.Changed {
		t.Fatalf("ожидалось пережатие, файл остался %d байт", len(source))
	}
	if len(result.Data) >= len(source) {
		t.Errorf("файл не уменьшился: было %d, стало %d", len(source), len(result.Data))
	}
	// Числа видны в выводе теста: по ним понятно, сколько даёт пережатие на
	// реалистичной картинке.
	t.Logf("JPEG %d байт → WebP %d байт (%.2fx)", len(source), len(result.Data),
		float64(len(source))/float64(len(result.Data)))
	if result.Mime != media.WebpMime || result.Filename != "фото.webp" {
		t.Errorf("тип и имя результата: %q, %q", result.Mime, result.Filename)
	}
	if result.Width != 1200 || result.Height != 800 {
		t.Errorf("размеры: %dx%d", result.Width, result.Height)
	}
	decoded := decodeWebp(t, result.Data)
	if got := decoded.Bounds().Dx(); got != result.Width {
		t.Errorf("декодированная ширина %d, ожидалась %d", got, result.Width)
	}

	// Кодировщик детерминирован: одинаковый вход даёт одинаковые байты, иначе
	// дедупликация по хешу не работала бы (две загрузки одного фото — один файл).
	again, err := media.Recompress(context.Background(), "фото.jpg", "image/jpeg", source)
	if err != nil {
		t.Fatalf("повторное пережатие: %v", err)
	}
	if !bytes.Equal(again.Data, result.Data) {
		t.Error("пережатие одного и того же файла дало разные байты")
	}
}

func TestRecompressPNGKeepsQuality(t *testing.T) {
	img := testimage.Photo(400, 300)
	source := testimage.PNG(t, img)

	result, err := media.Recompress(context.Background(), "схема.png", "image/png", source)
	if err != nil {
		t.Fatalf("пережатие: %v", err)
	}
	if !result.Changed {
		t.Skipf("PNG не стал меньше (%d байт) — проверять нечего", len(source))
	}
	t.Logf("PNG %d байт → WebP %d байт (%.2fx)", len(source), len(result.Data),
		float64(len(source))/float64(len(result.Data)))
	// Lossless: пиксель в пиксель, включая альфу.
	decoded := decodeWebp(t, result.Data)
	if decoded.Bounds() != img.Bounds() {
		t.Fatalf("размеры изменились: %v → %v", img.Bounds(), decoded.Bounds())
	}
	for _, point := range []image.Point{{0, 0}, {199, 150}, {399, 299}} {
		wantR, wantG, wantB, wantA := img.At(point.X, point.Y).RGBA()
		gotR, gotG, gotB, gotA := decoded.At(point.X, point.Y).RGBA()
		if wantR != gotR || wantG != gotG || wantB != gotB || wantA != gotA {
			t.Fatalf("PNG потерял пиксель %v: %v,%v,%v,%v → %v,%v,%v,%v",
				point, wantR, wantG, wantB, wantA, gotR, gotG, gotB, gotA)
		}
	}
}

func TestRecompressDownscalesBigImages(t *testing.T) {
	// 4000×3000 — как снимок с телефона: длинная сторона больше предела.
	img := testimage.Photo(4000, 3000)
	source := testimage.JPEG(t, img, 85)

	result, err := media.Recompress(context.Background(), "снимок.jpeg", "image/jpeg", source)
	if err != nil {
		t.Fatalf("пережатие: %v", err)
	}
	if !result.Changed {
		t.Fatal("большая картинка не пережата")
	}
	if result.Width != media.MaxSide {
		t.Fatalf("длинная сторона %d, ожидалась %d", result.Width, media.MaxSide)
	}
	if result.Height != 3000*media.MaxSide/4000 {
		t.Errorf("вторая сторона %d", result.Height)
	}
	t.Logf("снимок %d×%d: %d байт → %d байт (%.2fx)",
		img.Bounds().Dx(), img.Bounds().Dy(), len(source), len(result.Data),
		float64(len(source))/float64(len(result.Data)))
	if len(result.Data) >= len(source)/2 {
		t.Errorf("после уменьшения файл %d байт из %d — мало выигрыша", len(result.Data), len(source))
	}
}

func TestRecompressKeepsSmallAndForeignFiles(t *testing.T) {
	cases := []struct {
		name     string
		filename string
		mime     string
		data     []byte
	}{
		{"svg — вектор, не растровая картинка", "схема.svg", "image/svg+xml", []byte("<svg/>")},
		{"pdf не картинка", "документ.pdf", "application/pdf", []byte("%PDF-1.7")},
		{"чужой формат не декодируем", "файл.gif", "image/gif", []byte("GIF89a")},
		{"битые байты под видом jpeg", "сломанный.jpg", "image/jpeg", []byte("не картинка вовсе")},
	}
	for _, c := range cases {
		result, err := media.Recompress(context.Background(), c.filename, c.mime, c.data)
		if err != nil && c.mime != "image/jpeg" {
			t.Errorf("%s: неожиданная ошибка: %v", c.name, err)
		}
		if result.Changed {
			t.Errorf("%s: файл пережат, хотя не должен", c.name)
		}
		if !bytes.Equal(result.Data, c.data) || result.Mime != c.mime || result.Filename != c.filename {
			t.Errorf("%s: исходные данные изменились: %+v", c.name, result)
		}
	}

	// Картинка, которая и так крошечная: пережатие может дать файл больше — тогда
	// возвращаем исходник.
	tiny := testimage.JPEG(t, testimage.Photo(16, 16), 60)
	result, err := media.Recompress(context.Background(), "точка.jpg", "image/jpeg", tiny)
	if err != nil {
		t.Fatalf("пережатие: %v", err)
	}
	if result.Changed && len(result.Data) >= len(tiny) {
		t.Errorf("вернули «пережатый» файл больше исходного: %d → %d", len(tiny), len(result.Data))
	}
}

func TestRecompressible(t *testing.T) {
	cases := []struct {
		mime string
		size int64
		want bool
	}{
		{"image/jpeg", 1024, true},
		{"image/png", 1024, true},
		{"image/webp", 1024, false},
		{"image/svg+xml", 1024, false},
		{"application/pdf", 1024, false},
		{"image/jpeg", media.MaxSourceBytes + 1, false},
		{"image/jpeg", 0, false},
	}
	for _, c := range cases {
		if got := media.Recompressible(c.mime, c.size); got != c.want {
			t.Errorf("Recompressible(%q, %d) = %v, ожидалось %v", c.mime, c.size, got, c.want)
		}
	}
}
