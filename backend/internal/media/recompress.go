// Package media — приведение картинок к виду, который занимает меньше места.
//
// Зачем. Проект показывает картинки страницей: превью в кадре, галерея вложений,
// полноэкранный просмотр. Оригинал в 4–10 МБ для этого не нужен — экран не
// показывает больше, чем 2560 точек по длинной стороне, а вес файла при этом
// платит сервер. Поэтому картинки пережимаются в WebP: это тот же формат для
// браузера, но в разы компактнее JPEG и PNG.
//
// Правила нарочно разные для двух типов, и это важно понимать:
//
//   - **PNG → lossless WebP (VP8L).** Скриншоты, схемы и рисунки с текстом нельзя
//     пережимать с потерями: мелкий текст и резкие границы страдают первыми. VP8L
//     сохраняет пиксели байт в байт и всё равно меньше PNG (по замерам библиотеки —
//     на 13–23%), плюс сохраняется прозрачность;
//   - **JPEG → lossy WebP (VP8, q82).** Файл уже потерял часть деталей при съёмке
//     или первой съёмке, поэтому «без потерь» тут смысла не имеет. Плюс длинная
//     сторона обрезается до 2560 точек — для фотографий с телефона это часто
//     основной выигрыш. И снимок разворачивается по EXIF: телефон пишет «лежит
//     боком, показывать повернув», а Go-декодер этого не делает (orientation.go).
//
// Если после пережатия файл не стал меньше, возвращаем исходные байты как есть:
// смысла хранить «оптимизированную» версию, которая весит столько же, нет.
//
// Кодировщик — github.com/KarpelesLab/gowebp: чистый Go, без CGO и libwebp, поэтому
// сборка в alpine остаётся такой же, как была (см. backend/Dockerfile).
package media

import (
	"bytes"
	"fmt"
	"image"
	_ "image/jpeg" // декодирование исходников — из стандартной библиотеки
	_ "image/png"
	"path/filepath"
	"strings"

	"github.com/KarpelesLab/gowebp"
	xdraw "golang.org/x/image/draw"
)

// Настройки пережатия. Значения подобраны по замерам библиотеки (см. её README):
// lossy q75–q82 визуально неотличим на фотографиях (Y-PSNR 37–43 дБ), а Method 4 —
// рекомендованный компромисс скорости и размера.
const (
	// MaxSide — длинная сторона, до которой уменьшаем картинку. Экран не покажет
	// больше, а телефонные снимки приходят по 4000–6000 точек.
	MaxSide = 2560
	// MaxPixels — больше не декодируем вовсе: 40 мегапикселей — это сотни мегабайт
	// в памяти на время пережатия, и такие файлы лучше оставить как есть.
	MaxPixels = 40 << 20
	// MaxSourceBytes — предел исходника для пережатия. Ровно столько же, сколько
	// готовы держать в памяти на одну загрузку.
	MaxSourceBytes = 20 << 20

	JPEGQuality = 82
	LossyMethod = 4
)

// WebpMime — тип результата.
const WebpMime = "image/webp"

// Result — что стало с файлом. Changed=false означает «оставили как было» (не
// картинка, не умеем декодировать, не стало меньше) — вызывающий берёт исходные
// байты и имя.
type Result struct {
	Data     []byte
	Mime     string
	Filename string
	Width    int
	Height   int
	Changed  bool
}

// Recompressible сообщает, стоит ли вообще пытаться пережать файл такого типа.
// SVG, pdf, аудио и видео не трогаем: это не растровые картинки.
func Recompressible(mime string, size int64) bool {
	if size <= 0 || size > MaxSourceBytes {
		return false
	}
	return mime == "image/jpeg" || mime == "image/png"
}

// Recompress возвращает облегчённую версию картинки. Ошибка означает, что файл не
// удалось декодировать или закодировать: вызывающий обязан сохранить исходные байты
// (пережатие — улучшение, а не условие приёма файла).
func Recompress(filename, mime string, data []byte) (Result, error) {
	original := Result{Data: data, Mime: mime, Filename: filename}
	if !Recompressible(mime, int64(len(data))) {
		return original, nil
	}

	// Сначала только заголовок: так «слишком большая картинка» отсекается до
	// выделения памяти под пиксели.
	cfg, _, err := image.DecodeConfig(bytes.NewReader(data))
	if err != nil {
		return original, fmt.Errorf("заголовок картинки: %w", err)
	}
	if cfg.Width <= 0 || cfg.Height <= 0 {
		return original, fmt.Errorf("картинка без размера")
	}
	if cfg.Width*cfg.Height > MaxPixels {
		return original, nil
	}

	img, _, err := image.Decode(bytes.NewReader(data))
	if err != nil {
		return original, fmt.Errorf("декодирование картинки: %w", err)
	}
	width, height := cfg.Width, cfg.Height
	// JPEG разворачиваем по EXIF до всего остального: Go-декодер ориентацию не
	// применяет, а мы выбрасываем тег при кодировании (см. orientation.go).
	if mime == "image/jpeg" {
		if orientation := exifOrientation(data); orientation > 1 {
			img = applyOrientation(img, orientation)
			width, height = height, width
		}
	}
	img, width, height = fit(img, width, height)

	var out bytes.Buffer
	options := &gowebp.Options{}
	if mime == "image/jpeg" {
		// JPEG уже с потерями — пережимаем с потерями, но с запасом по качеству.
		options = &gowebp.Options{Lossy: true, Quality: JPEGQuality, Method: LossyMethod}
	}
	if err := gowebp.Encode(&out, img, options); err != nil {
		return original, fmt.Errorf("кодирование webp: %w", err)
	}
	// Не стало меньше — оставляем исходник: хранить «оптимизированный» файл того же
	// размера незачем, а качество в нём уже другое.
	if out.Len() >= len(data) {
		return original, nil
	}

	return Result{
		Data:     out.Bytes(),
		Mime:     WebpMime,
		Filename: WebpName(filename),
		Width:    width,
		Height:   height,
		Changed:  true,
	}, nil
}

// fit уменьшает картинку, если её длинная сторона больше MaxSide, и возвращает
// итоговые размеры. Уменьшение — CatmullRom: тот же фильтр, что у остальных
// масштабирований в проекте, и он не мылит мелкие детали так, как билинейный.
func fit(img image.Image, width, height int) (image.Image, int, int) {
	if width <= MaxSide && height <= MaxSide {
		return img, width, height
	}
	scale := float64(MaxSide) / float64(width)
	if height > width {
		scale = float64(MaxSide) / float64(height)
	}
	newWidth := int(float64(width)*scale + 0.5)
	newHeight := int(float64(height)*scale + 0.5)
	if newWidth < 1 {
		newWidth = 1
	}
	if newHeight < 1 {
		newHeight = 1
	}
	dst := image.NewNRGBA(image.Rect(0, 0, newWidth, newHeight))
	xdraw.CatmullRom.Scale(dst, dst.Bounds(), img, img.Bounds(), xdraw.Over, nil)
	return dst, newWidth, newHeight
}

// WebpName меняет расширение файла на .webp: содержимое теперь другое, и имя
// должно об этом говорить (иначе скачанный файл открывался бы «не тем» просмотрщиком).
// Экспортировано, потому что имя файла меняют и строки уже загруженных вложений
// (пережатие того, что лежало в проекте до этой возможности).
func WebpName(filename string) string {
	base := strings.TrimSuffix(filename, filepath.Ext(filename))
	if base == "" {
		base = "image"
	}
	return base + ".webp"
}
