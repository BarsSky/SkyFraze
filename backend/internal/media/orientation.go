package media

// EXIF-ориентация: зачем она здесь.
//
// Снимок с телефона часто записан «как лёг на матрицу», а как его показывать —
// написано в EXIF (тег Orientation). Браузеры это уважают, а Go-декодер — нет: он
// отдаёт пиксели в том порядке, в котором они лежат в файле. Мы, пережимая
// картинку, выбрасываем EXIF (кодируем только пиксели), поэтому для снимка с
// Orientation=6 (поворот на 90°) результат оказался бы повёрнутым на бок: тег
// пропал, а пиксели никто не развернул.
//
// Поэтому ориентацию применяем сами — до кодирования. После этого картинка
// физически правильная, и EXIF для показа больше не нужен (а заодно исчезают
// координаты съёмки, о чём в docs/storage-compression.md сказано отдельно).
//
// Разбираем EXIF вручную, а не тянем библиотеку: нужен ровно один тег, а любая
// внешняя зависимость здесь — лишний код в сборке без CGO ради 32 байт заголовка.

import (
	"encoding/binary"
	"image"
	"image/color"
)

// exifTagOrientation — номер тега Orientation в IFD0.
const exifTagOrientation = 0x0112

// exifOrientation возвращает тег Orientation из APP1-сегмента JPEG.
//
// Единица означает «показывать как есть»: её же отдаём, если тега нет, файл не
// JPEG или разобрать его не удалось. Это осознанный выбор: не развернуть снимок,
// у которого тег был, — потеря ориентации, а развернуть наугад — испортить
// картинку, которая была правильной.
func exifOrientation(data []byte) int {
	offset, order, ok := exifOrientationValue(data)
	if !ok {
		return 1
	}
	value := int(order.Uint16(data[offset : offset+2]))
	if value < 1 || value > 8 {
		return 1
	}
	return value
}

// normalizeJpegOrientation обнуляет тег ориентации (ставит 1 — «показывать как
// есть»). Нужно после внешнего разворота: libheif применяет поворот из HEIC к
// пикселям, но может оставить в JPEG исходный тег, и тогда мы развернули бы
// картинку второй раз. Копию делаем потому, что входные байты принадлежат
// вызывающему.
func normalizeJpegOrientation(data []byte) []byte {
	offset, order, ok := exifOrientationValue(data)
	if !ok {
		return data
	}
	out := append([]byte(nil), data...)
	order.PutUint16(out[offset:offset+2], 1)
	return out
}

// exifOrientationValue находит, где в файле лежит значение тега Orientation, и в
// каком порядке байт оно записано. Пустой ответ — тега нет или файл не разобрался.
func exifOrientationValue(data []byte) (int, binary.ByteOrder, bool) {
	if len(data) < 4 || data[0] != 0xFF || data[1] != 0xD8 {
		return 0, nil, false
	}
	// Идём по сегментам: маркер (2 байта), длина (2 байта, считая саму себя), тело.
	for i := 2; i+2 <= len(data); {
		if data[i] != 0xFF {
			return 0, nil, false
		}
		marker := data[i+1]
		// Заполнители и маркеры без длины: 0xFF, 0x01, 0xD0..0xD7.
		if marker == 0xFF {
			i++
			continue
		}
		if marker == 0x01 || (marker >= 0xD0 && marker <= 0xD7) {
			i += 2
			continue
		}
		// Начало сжатых данных или конец файла: дальше EXIF искать негде.
		if marker == 0xDA || marker == 0xD9 {
			return 0, nil, false
		}
		if i+4 > len(data) {
			return 0, nil, false
		}
		length := int(data[i+2])<<8 | int(data[i+3])
		if length < 2 || i+2+length > len(data) {
			return 0, nil, false
		}
		if marker == 0xE1 {
			if offset, order, ok := orientationValueInAPP1(data[i+4 : i+2+length]); ok {
				// Смещение считаем от начала файла: сегмент начинается на i+4.
				return i + 4 + offset, order, true
			}
		}
		i += 2 + length
	}
	return 0, nil, false
}

// orientationValueInAPP1 разбирает полезную нагрузку APP1 и возвращает смещение
// значения тега Orientation внутри неё.
func orientationValueInAPP1(payload []byte) (int, binary.ByteOrder, bool) {
	const exifHeader = "Exif\x00\x00"
	// Заголовок Exif + минимальный TIFF-заголовок (порядок байт, 0x002A, смещение IFD0).
	if len(payload) < len(exifHeader)+8 || string(payload[:len(exifHeader)]) != exifHeader {
		return 0, nil, false
	}
	tiff := payload[len(exifHeader):]

	var order binary.ByteOrder
	switch {
	case tiff[0] == 'I' && tiff[1] == 'I':
		order = binary.LittleEndian
	case tiff[0] == 'M' && tiff[1] == 'M':
		order = binary.BigEndian
	default:
		return 0, nil, false
	}
	if order.Uint16(tiff[2:4]) != 0x002A {
		return 0, nil, false
	}
	ifd := int(order.Uint32(tiff[4:8]))
	if ifd < 8 || ifd+2 > len(tiff) {
		return 0, nil, false
	}
	count := int(order.Uint16(tiff[ifd : ifd+2]))
	for entry := ifd + 2; entry+12 <= len(tiff); entry += 12 {
		if count == 0 {
			break
		}
		count--
		e := tiff[entry : entry+12]
		if order.Uint16(e[0:2]) != exifTagOrientation {
			continue
		}
		// Тип SHORT (3), одно значение: оно лежит прямо в поле значения.
		if order.Uint16(e[2:4]) != 3 {
			return 0, nil, false
		}
		// Значение внутри сегмента: смещение TIFF начинается сразу после «Exif\0\0».
		return len(exifHeader) + entry + 8, order, true
	}
	return 0, nil, false
}

// applyOrientation разворачивает пиксели так, как просит EXIF. Значения 1 и
// неизвестные возвращают картинку как есть.
//
// Формулы — это «куда встанет пиксель (x, y) исходника»:
//
//	2 — зеркало по горизонтали, 3 — поворот на 180°, 4 — зеркало по вертикали,
//	5 — транспонирование, 6 — поворот на 90° по часовой, 7 — антитранспонирование,
//	8 — поворот на 90° против часовой.
func applyOrientation(img image.Image, orientation int) image.Image {
	if orientation <= 1 || orientation > 8 {
		return img
	}
	bounds := img.Bounds()
	width, height := bounds.Dx(), bounds.Dy()
	if width <= 0 || height <= 0 {
		return img
	}
	// Поворот на 90° меняет стороны местами — иначе часть картинки обрезалась бы.
	swap := orientation >= 5
	dstWidth, dstHeight := width, height
	if swap {
		dstWidth, dstHeight = height, width
	}
	dst := image.NewNRGBA(image.Rect(0, 0, dstWidth, dstHeight))

	for y := 0; y < height; y++ {
		for x := 0; x < width; x++ {
			var dx, dy int
			switch orientation {
			case 2:
				dx, dy = width-1-x, y
			case 3:
				dx, dy = width-1-x, height-1-y
			case 4:
				dx, dy = x, height-1-y
			case 5:
				dx, dy = y, x
			case 6:
				dx, dy = height-1-y, x
			case 7:
				dx, dy = height-1-y, width-1-x
			case 8:
				dx, dy = y, width-1-x
			default:
				return img
			}
			dst.SetNRGBA(dx, dy, color.NRGBAModel.Convert(img.At(bounds.Min.X+x, bounds.Min.Y+y)).(color.NRGBA))
		}
	}
	return dst
}
