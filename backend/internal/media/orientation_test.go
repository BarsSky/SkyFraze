package media

// orientation_test.go — разбор EXIF-ориентации и сам разворот пикселей.
//
// Проверяем здесь, а не через пережатие, ровно по одной причине: интересны не
// «файл стал меньше», а «пиксель встал туда, куда просил тег» — это утверждение
// про геометрию, и проверять его надо на маленькой картинке с различимыми
// углами.

import (
	"bytes"
	"context"
	"encoding/binary"
	"image"
	"image/color"
	"image/jpeg"
	"testing"

	"github.com/KarpelesLab/gowebp"
)

// markerImage — картинка 3×2, где каждая точка — свой цвет: так видно, куда
// именно переехал конкретный пиксель.
func markerImage() *image.NRGBA {
	img := image.NewNRGBA(image.Rect(0, 0, 3, 2))
	colors := []color.NRGBA{
		{R: 255, A: 255},         // A (0,0)
		{G: 255, A: 255},         // B (1,0)
		{B: 255, A: 255},         // C (2,0)
		{R: 255, G: 255, A: 255}, // D (0,1)
		{G: 255, B: 255, A: 255}, // E (1,1)
		{R: 255, B: 255, A: 255}, // F (2,1)
	}
	for i, c := range colors {
		img.SetNRGBA(i%3, i/3, c)
	}
	return img
}

// pixelAt — цвет точки: в терминах «строка y, столбец x», чтобы проверка читалась
// как картинка, а не как арифметика с индексами.
func pixelAt(img image.Image, x, y int) color.NRGBA {
	r, g, b, a := img.At(x, y).RGBA()
	return color.NRGBA{R: uint8(r >> 8), G: uint8(g >> 8), B: uint8(b >> 8), A: uint8(a >> 8)}
}

// Разворот обязан быть перестановкой: ни одна точка не теряется и не появляется
// дважды. Проверяем это по числу уникальных цветов — у «залитой» картинки их было
// бы меньше.
func TestApplyOrientationIsPermutation(t *testing.T) {
	src := markerImage()
	for orientation := 1; orientation <= 8; orientation++ {
		out := applyOrientation(src, orientation)
		seen := map[color.NRGBA]int{}
		for y := 0; y < out.Bounds().Dy(); y++ {
			for x := 0; x < out.Bounds().Dx(); x++ {
				seen[pixelAt(out, x, y)]++
			}
		}
		if len(seen) != 6 {
			t.Errorf("ориентация %d: различных цветов %d, ожидалось 6", orientation, len(seen))
		}
		for c, count := range seen {
			if count != 1 {
				t.Errorf("ориентация %d: цвет %v встречается %d раз", orientation, c, count)
			}
		}
	}
}

// Куда встают углы — то самое, ради чего ориентация и читается. Раскладка
// исходника 3×2:
//
//	A B C
//	D E F
func TestApplyOrientationPlacesCorners(t *testing.T) {
	src := markerImage()
	a := color.NRGBA{R: 255, A: 255}
	f := color.NRGBA{R: 255, B: 255, A: 255}

	cases := []struct {
		orientation int
		width       int
		height      int
		// topLeft — что должно оказаться в левом верхнем углу результата.
		topLeft color.NRGBA
		// bottomRight — что должно оказаться в правом нижнем углу.
		bottomRight color.NRGBA
	}{
		// 1 — как есть.
		{1, 3, 2, a, f},
		// 2 — зеркало по горизонтали: C B A / F E D.
		{2, 3, 2, color.NRGBA{B: 255, A: 255}, color.NRGBA{R: 255, G: 255, A: 255}},
		// 3 — поворот на 180°: F E D / C B A.
		{3, 3, 2, f, a},
		// 4 — зеркало по вертикали: D E F / A B C.
		{4, 3, 2, color.NRGBA{R: 255, G: 255, A: 255}, color.NRGBA{B: 255, A: 255}},
		// 5 — транспонирование: A D / B E / C F.
		{5, 2, 3, a, color.NRGBA{R: 255, B: 255, A: 255}},
		// 6 — поворот на 90° по часовой: D A / E B / F C.
		{6, 2, 3, color.NRGBA{R: 255, G: 255, A: 255}, color.NRGBA{B: 255, A: 255}},
		// 7 — антитранспонирование: F C / E B / D A.
		{7, 2, 3, color.NRGBA{R: 255, B: 255, A: 255}, a},
		// 8 — поворот на 90° против часовой: C F / B E / A D.
		{8, 2, 3, color.NRGBA{B: 255, A: 255}, color.NRGBA{R: 255, G: 255, A: 255}},
	}
	for _, tc := range cases {
		out := applyOrientation(src, tc.orientation)
		if out.Bounds().Dx() != tc.width || out.Bounds().Dy() != tc.height {
			t.Errorf("ориентация %d: размер %dx%d, ожидался %dx%d",
				tc.orientation, out.Bounds().Dx(), out.Bounds().Dy(), tc.width, tc.height)
			continue
		}
		if got := pixelAt(out, 0, 0); got != tc.topLeft {
			t.Errorf("ориентация %d: левый верхний %v, ожидался %v", tc.orientation, got, tc.topLeft)
		}
		if got := pixelAt(out, tc.width-1, tc.height-1); got != tc.bottomRight {
			t.Errorf("ориентация %d: правый нижний %v, ожидался %v", tc.orientation, got, tc.bottomRight)
		}
	}
}

func TestApplyOrientationKeepsNormal(t *testing.T) {
	src := markerImage()
	for _, orientation := range []int{0, 1, 9, -3} {
		if out := applyOrientation(src, orientation); out != image.Image(src) {
			t.Errorf("ориентация %d: картинка должна остаться той же", orientation)
		}
	}
}

// app1WithOrientation собирает настоящий APP1-сегмент Exif с одним тегом
// Orientation. littleEndian — чтобы покрыть оба порядка байт: телефоны пишут
// по-разному.
func app1WithOrientation(t *testing.T, orientation int, littleEndian bool) []byte {
	t.Helper()
	order := binary.ByteOrder(binary.BigEndian)
	orderMark := "MM"
	if littleEndian {
		order = binary.LittleEndian
		orderMark = "II"
	}
	tiff := new(bytes.Buffer)
	tiff.WriteString(orderMark)
	writeUint16 := func(v uint16) { _ = binary.Write(tiff, order, v) }
	writeUint32 := func(v uint32) { _ = binary.Write(tiff, order, v) }

	writeUint16(0x002A) // признак TIFF
	writeUint32(8)      // IFD0 сразу за заголовком
	writeUint16(1)      // одна запись
	writeUint16(exifTagOrientation)
	writeUint16(3) // тип SHORT
	writeUint32(1) // значений одно
	writeUint16(uint16(orientation))
	writeUint16(0) // значение добито до 4 байт
	writeUint32(0) // следующего IFD нет

	payload := append([]byte("Exif\x00\x00"), tiff.Bytes()...)
	segment := new(bytes.Buffer)
	segment.Write([]byte{0xFF, 0xE1})
	_ = binary.Write(segment, binary.BigEndian, uint16(len(payload)+2))
	segment.Write(payload)
	return segment.Bytes()
}

// withExifOrientation вставляет APP1 сразу после SOI — так, как это делает камера.
func withExifOrientation(t *testing.T, jpegBytes []byte, orientation int, littleEndian bool) []byte {
	t.Helper()
	if len(jpegBytes) < 2 || jpegBytes[0] != 0xFF || jpegBytes[1] != 0xD8 {
		t.Fatal("это не jpeg")
	}
	out := append([]byte{}, jpegBytes[:2]...)
	out = append(out, app1WithOrientation(t, orientation, littleEndian)...)
	return append(out, jpegBytes[2:]...)
}

func TestExifOrientationReadsTag(t *testing.T) {
	img := markerImage()
	plain := func() []byte {
		var buf bytes.Buffer
		if err := jpeg.Encode(&buf, img, &jpeg.Options{Quality: 90}); err != nil {
			t.Fatalf("jpeg: %v", err)
		}
		return buf.Bytes()
	}

	if got := exifOrientation(plain()); got != 1 {
		t.Errorf("без тега: %d, ожидалось 1", got)
	}
	for _, littleEndian := range []bool{false, true} {
		for orientation := 1; orientation <= 8; orientation++ {
			withTag := withExifOrientation(t, plain(), orientation, littleEndian)
			if got := exifOrientation(withTag); got != orientation {
				t.Errorf("порядок littleEndian=%v, ориентация %d: прочитано %d",
					littleEndian, orientation, got)
			}
		}
	}
}

// Битые и чужие данные не должны ни паниковать, ни выдумывать ориентацию:
// повернуть картинку наугад хуже, чем не повернуть вовсе.
func TestExifOrientationIgnoresGarbage(t *testing.T) {
	img := markerImage()
	var plain bytes.Buffer
	if err := jpeg.Encode(&plain, img, &jpeg.Options{Quality: 90}); err != nil {
		t.Fatalf("jpeg: %v", err)
	}
	withTag := withExifOrientation(t, plain.Bytes(), 6, false)

	cases := map[string][]byte{
		"пусто":           {},
		"не jpeg":         []byte("просто текст"),
		"только SOI":      {0xFF, 0xD8},
		"обрезанный APP1": withTag[:12],
		"нет заголовка Exif": func() []byte {
			// APP1 с чужим содержимым (например, XMP) — не Exif.
			segment := []byte{0xFF, 0xE1, 0x00, 0x0A, 'h', 't', 't', 'p', ':', '/', '/'}
			return append(append([]byte{0xFF, 0xD8}, segment...), 0xFF, 0xD9)
		}(),
	}
	for name, data := range cases {
		if got := exifOrientation(data); got != 1 {
			t.Errorf("%s: прочитано %d, ожидалось 1", name, got)
		}
	}

	// Тег есть, но значение вне диапазона 1..8 — считаем, что ориентации нет.
	broken := withExifOrientation(t, plain.Bytes(), 6, false)
	// Находим значение тега (оно идёт сразу после «MM 002A 00000008 0001 0112 0003 00000001»)
	// и портим его на 9: проверка «вне диапазона» важнее знания смещения.
	marker := []byte{0x01, 0x12, 0x00, 0x03, 0x00, 0x00, 0x00, 0x01, 0x00, 0x06}
	idx := bytes.Index(broken, marker)
	if idx < 0 {
		t.Fatal("не нашёл тег в собранном сегменте")
	}
	broken[idx+9] = 9
	if got := exifOrientation(broken); got != 1 {
		t.Errorf("ориентация 9: прочитано %d, ожидалось 1", got)
	}
}

// rotate90CCW — то, как телефон записывает снимок «лёг боком»: пиксели повёрнуты
// против часовой, а как показывать — сказано тегом. Точка (x, y) исходника
// переезжает в (y, width-1-x).
func rotate90CCW(src image.Image) *image.NRGBA {
	b := src.Bounds()
	width, height := b.Dx(), b.Dy()
	dst := image.NewNRGBA(image.Rect(0, 0, height, width))
	for y := 0; y < height; y++ {
		for x := 0; x < width; x++ {
			dst.SetNRGBA(y, width-1-x, color.NRGBAModel.Convert(src.At(b.Min.X+x, b.Min.Y+y)).(color.NRGBA))
		}
	}
	return dst
}

// meanBrightness — средняя яркость полосы по x от x0 до x1: по ней видно, где
// светлая половина, а где тёмная.
//
// Каналы складываем во float64: у uint8 сумма трёх каналов переполняется, и
// «светлое» (240) превращается в 208 — яркость переставала что-либо значить.
func meanBrightness(img image.Image, x0, x1 int) float64 {
	sum, count := 0.0, 0
	for y := img.Bounds().Min.Y; y < img.Bounds().Max.Y; y++ {
		for x := x0; x < x1; x++ {
			c := pixelAt(img, x, y)
			sum += (float64(c.R) + float64(c.G) + float64(c.B)) / 3
			count++
		}
	}
	if count == 0 {
		return 0
	}
	return sum / float64(count)
}

// Сквозная проверка: снимок записан боком, тег просит развернуть. После пережатия
// ориентация обязана быть в пикселях — тег мы при кодировании теряем, и если не
// развернуть самим, фото останется лежать на боку.
func TestRecompressAppliesExifOrientation(t *testing.T) {
	// «Правильная» картинка: слева светлая половина, справа тёмная.
	const width, height = 120, 80
	display := image.NewNRGBA(image.Rect(0, 0, width, height))
	for y := 0; y < height; y++ {
		for x := 0; x < width; x++ {
			c := color.NRGBA{R: 20, G: 20, B: 20, A: 255}
			if x < width/2 {
				c = color.NRGBA{R: 240, G: 240, B: 240, A: 255}
			}
			display.SetNRGBA(x, y, c)
		}
	}
	stored := rotate90CCW(display)
	var buf bytes.Buffer
	if err := jpeg.Encode(&buf, stored, &jpeg.Options{Quality: 92}); err != nil {
		t.Fatalf("jpeg: %v", err)
	}
	plain := buf.Bytes()

	// Без тега побеждает то, что лежит в файле: 80×120, светлое сверху.
	untagged, err := Recompress(context.Background(), "снимок.jpg", "image/jpeg", plain)
	if err != nil {
		t.Fatalf("пережатие без тега: %v", err)
	}
	if untagged.Width != height || untagged.Height != width {
		t.Errorf("без тега размеры %dx%d, ожидались %dx%d",
			untagged.Width, untagged.Height, height, width)
	}

	// С тегом 6 — развёрнутая картинка 120×80, светлое слева.
	tagged, err := Recompress(context.Background(), "снимок.jpg", "image/jpeg", withExifOrientation(t, plain, 6, false))
	if err != nil {
		t.Fatalf("пережатие с тегом: %v", err)
	}
	if !tagged.Changed {
		t.Fatalf("с тегом файл не пережался")
	}
	if tagged.Width != width || tagged.Height != height {
		t.Fatalf("с тегом размеры %dx%d, ожидались %dx%d",
			tagged.Width, tagged.Height, width, height)
	}
	out, err := gowebp.Decode(bytes.NewReader(tagged.Data))
	if err != nil {
		t.Fatalf("результат не читается как webp: %v", err)
	}
	if out.Bounds().Dx() != width || out.Bounds().Dy() != height {
		t.Fatalf("в файле %dx%d, ожидалось %dx%d",
			out.Bounds().Dx(), out.Bounds().Dy(), width, height)
	}
	left := meanBrightness(out, 0, width/4)
	right := meanBrightness(out, width*3/4, width)
	if left-right < 100 {
		t.Errorf("светлая половина не слева: слева %.0f, справа %.0f", left, right)
	}
}
