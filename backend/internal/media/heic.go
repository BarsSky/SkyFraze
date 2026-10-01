package media

// HEIC — формат, в котором по умолчанию снимает iPhone.
//
// Зачем отдельный путь. HEIC внутри — HEVC-кадр, и чистого Go-декодера для него не
// существует: без внешнего инструмента картинку не то что пережать, её даже
// показать нечем (браузеры, кроме Safari, HEIC не открывают). Поэтому сервер
// зовёт `heif-convert` из пакета libheif-tools: он разворачивает кадр в JPEG с
// учётом поворотов, записанных в самом файле, а дальше идёт обычный путь JPEG →
// WebP (см. recompress.go). Так выглядит «мягкая деградация»: если утилиты в образе
// нет, сервер отказывает с понятным текстом, а не принимает файл, который человек
// не увидит.
//
// Почему подпроцесс, а не библиотека. libheif — C, и подключение через CGO сломало
// бы статическую сборку (CGO_ENABLED=0, alpine). Вызов утилиты — та же работа, но
// без линковки: конвертер живёт в образе, а не в бинаре.

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"time"
)

const (
	// heicTool — имя утилиты в PATH (пакет libheif-tools).
	heicTool = "heif-convert"
	// heicQuality — качество промежуточного JPEG. Файл всё равно потеряет часть
	// деталей при пережатии в WebP (q82), поэтому промежуточный шаг держим
	// высоким: двойное сжатие заметно именно на низком качестве.
	heicQuality = 95
	// heicTimeout — предел на разбор одного файла. 12-мегапиксельный HEIC
	// разбирается за доли секунды; предел нужен, чтобы битый файл не держал
	// загрузку вечно.
	heicTimeout = 25 * time.Second
)

// ErrHEICUnavailable — в системе нет конвертера HEIC.
var ErrHEICUnavailable = errors.New("конвертер HEIC не установлен")

// heicExts — расширения формата. Проверяем и тип, и имя: браузеры присылают то
// `image/heic`, то `application/octet-stream`, то ничего.
var heicMimes = map[string]bool{
	"image/heic":          true,
	"image/heif":          true,
	"image/heic-sequence": true,
	"image/heif-sequence": true,
}

// IsHEIC — файл в формате HEIC/HEIF (по типу или по расширению).
func IsHEIC(mime string) bool {
	if heicMimes[strings.ToLower(strings.TrimSpace(mime))] {
		return true
	}
	return false
}

// IsHEICName — то же по имени файла: тип может быть пустым или общим.
func IsHEICName(filename string) bool {
	switch strings.ToLower(filepath.Ext(filename)) {
	case ".heic", ".heif":
		return true
	}
	return false
}

// HEICAvailable — есть ли чем разобрать HEIC: утилита в PATH или подключённый
// конвертер (тесты, стенд без libheif). Спрашиваем PATH каждый раз: это поиск в
// каталогах, а не запуск процесса, и кэш здесь только мешал бы тестам.
func HEICAvailable() bool {
	_, custom := currentHEICConverter()
	if custom {
		return true
	}
	_, err := exec.LookPath(heicTool)
	return err == nil
}

// heicConverter — то, что превращает HEIC в JPEG. Переменная, а не прямой вызов:
// тесты подменяют конвертер (в CI утилиты может не быть), а среда без libheif
// получает понятный отказ.
var (
	heicMu        sync.Mutex
	heicConverter = convertHEICWithTool
	heicCustom    bool
)

// UseHEICConverter подменяет конвертер HEIC. Нужен тестам: настоящий libheif есть
// не в каждой среде, а проверить весь путь (HEIC → JPEG → WebP) надо.
func UseHEICConverter(fn func(ctx context.Context, data []byte) ([]byte, error)) {
	heicMu.Lock()
	defer heicMu.Unlock()
	if fn != nil {
		heicConverter = fn
		heicCustom = true
	}
}

// ResetHEICConverter возвращает конвертер по умолчанию.
func ResetHEICConverter() {
	heicMu.Lock()
	defer heicMu.Unlock()
	heicConverter = convertHEICWithTool
	heicCustom = false
}

// HeicConvert — текущий конвертер (для вызова из Recompress).
func currentHEICConverter() (func(context.Context, []byte) ([]byte, error), bool) {
	heicMu.Lock()
	defer heicMu.Unlock()
	return heicConverter, heicCustom
}

// convertHEICWithTool — вызов libheif-tools: пишем файл, зовём утилиту, читаем
// результат. Временный каталог создаём свой и убираем за собой: файлы HEIC бывают
// по 10 МБ, держать их в памяти дважды смысла нет.
func convertHEICWithTool(ctx context.Context, data []byte) ([]byte, error) {
	tool, err := exec.LookPath(heicTool)
	if err != nil {
		return nil, ErrHEICUnavailable
	}
	dir, err := os.MkdirTemp("", "sf-heic-")
	if err != nil {
		return nil, fmt.Errorf("каталог для HEIC: %w", err)
	}
	defer func() { _ = os.RemoveAll(dir) }()

	input := filepath.Join(dir, "in.heic")
	output := filepath.Join(dir, "out.jpg")
	if err := os.WriteFile(input, data, 0o600); err != nil {
		return nil, fmt.Errorf("запись HEIC: %w", err)
	}

	ctx, cancel := context.WithTimeout(ctx, heicTimeout)
	defer cancel()
	cmd := exec.CommandContext(ctx, tool, "-q", strconv.Itoa(heicQuality), input, output)
	var stderr bytes.Buffer
	cmd.Stderr = &stderr
	if err := cmd.Run(); err != nil {
		detail := strings.TrimSpace(stderr.String())
		if detail != "" {
			return nil, fmt.Errorf("heif-convert: %w (%s)", err, detail)
		}
		return nil, fmt.Errorf("heif-convert: %w", err)
	}

	converted, err := os.ReadFile(output)
	if err != nil {
		return nil, fmt.Errorf("чтение результата HEIC: %w", err)
	}
	if len(converted) == 0 {
		return nil, errors.New("heif-convert вернул пустой файл")
	}
	return converted, nil
}
