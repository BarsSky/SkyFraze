// Package testimage — картинки для тестов: реалистичная «фотография» и её
// кодирование в jpeg/png.
//
// Зачем общий помощник. Проверять пережатие на однотонном квадрате бессмысленно
// (любой формат справится), а на чистом шуме — наоборот, вредно: шум не сжимается
// ничем, и тест доказывал бы отсутствие структуры в картинке, а не работу кодека.
// Здесь картинка «как фотография»: крупные области, плавные переходы, мелкие
// детали и лёгкий шум — то, на чём видно и размер, и качество.
package testimage

import (
	"bytes"
	"image"
	"image/color"
	"image/jpeg"
	"image/png"
	"math"
	"testing"
)

// Photo рисует картинку заданного размера.
func Photo(width, height int) image.Image {
	img := image.NewNRGBA(image.Rect(0, 0, width, height))
	seed := uint32(2463534242)
	for y := 0; y < height; y++ {
		for x := 0; x < width; x++ {
			seed ^= seed << 13
			seed ^= seed >> 17
			seed ^= seed << 5
			noise := int(seed%16) - 8

			fx, fy := float64(x)/float64(width), float64(y)/float64(height)
			wave := 40 * math.Sin(fx*6) * math.Cos(fy*4)
			base := 120 + 80*(1-fy)
			if fy > 0.6 {
				base = 70 + 30*fx
			}
			dx, dy := fx-0.7, fy-0.25
			if dx*dx+dy*dy < 0.01 {
				base = 235
			}
			img.SetNRGBA(x, y, color.NRGBA{
				R: clamp(base + wave + float64(noise)),
				G: clamp(base + 20 + wave*0.6 + float64(noise)),
				B: clamp(200 - 60*fy + wave*0.3 + float64(noise)),
				A: 255,
			})
		}
	}
	return img
}

// JPEG кодирует картинку в jpeg заданного качества.
func JPEG(t testing.TB, img image.Image, quality int) []byte {
	t.Helper()
	var buf bytes.Buffer
	if err := jpeg.Encode(&buf, img, &jpeg.Options{Quality: quality}); err != nil {
		t.Fatalf("jpeg: %v", err)
	}
	return buf.Bytes()
}

// PNG кодирует картинку в png.
func PNG(t testing.TB, img image.Image) []byte {
	t.Helper()
	var buf bytes.Buffer
	if err := png.Encode(&buf, img); err != nil {
		t.Fatalf("png: %v", err)
	}
	return buf.Bytes()
}

// SmallPNG — настоящий (валидный) маленький PNG без testing.TB: нужен там, где
// фикстура задаётся пакетной переменной. Валидность важна: код пережатия пытается
// декодировать картинку, и «PNG» из случайных байтов давал бы предупреждение в лог
// на каждой загрузке.
func SmallPNG() []byte {
	var buf bytes.Buffer
	img := image.NewNRGBA(image.Rect(0, 0, 2, 2))
	for y := 0; y < 2; y++ {
		for x := 0; x < 2; x++ {
			img.SetNRGBA(x, y, color.NRGBA{R: 0x20, G: 0x80, B: 0xC0, A: 255})
		}
	}
	if err := png.Encode(&buf, img); err != nil {
		panic(err)
	}
	return buf.Bytes()
}

func clamp(value float64) uint8 {
	if value < 0 {
		return 0
	}
	if value > 255 {
		return 255
	}
	return uint8(value)
}
