package transfer

// markdown_attachments.go — файлы набора, которые становятся вложениями проекта.
//
// Зачем это здесь. Ссылки на картинки в тексте события у нас не «переписываются» и
// не «ищутся по ссылкам»: файл прикладывается вложением к тому событию, в чьём
// файле о нём написано (docs/import-export.md, п. 4). Так не нужно угадывать, на
// что ведёт ссылка, а картинка оказывается ровно там, где о ней написано; сам
// текст события остаётся как есть.
//
// Что считается вложением. Любой не-md файл набора, который проект вообще умеет
// принять (тот же список типов, что у загрузки из интерфейса — assets.MimeAllowed):
// картинки, pdf, аудио/видео, svg. Служебные файлы набора (manifest.json,
// README.txt) и скрытые (.DS_Store) пропускаем: это не содержимое проекта.
//
// Как файл находит своё событие. Ссылка вида `![alt](path)` или строка картинки,
// приписанная выгрузкой (`![01.1·2](path)`), разрешается относительно каталога
// САМОГО md-файла — в том числе до снятия корневого каталога архива и служебной
// папки story/ (иначе `../assets/схема.png` из `story/01-глава.md` не нашлось бы).
// Если так не совпало, пробуем путь как есть и, в последнюю очередь, совпадение по
// имени файла — но только когда файл с таким именем в наборе один.

import (
	"fmt"
	"io"
	"net/url"
	"path"
	"strings"

	"github.com/skyfraze/backend/internal/assets"
)

// Лимиты вложений. Размер одного файла и список типов — те же, что у загрузки из
// интерфейса (иначе импорт создавал бы вложения, которые сервер не принимает),
// общий размер набора ограничен markdownMaxTotal вместе с md-файлами.
const (
	// markdownMaxOtherFiles — сколько вообще не-md файлов принимаем в наборе. В
	// проект попадут только те, на которые ссылаются тексты событий, но прочитать
	// и посчитать их надо все — иначе «файл не нашёлся» было бы неправдой.
	markdownMaxOtherFiles     = 500
	markdownMaxAttachmentSize = assets.MaxAssetSize
)

// serviceFiles — служебные файлы наших выгрузок и мусор файловых систем: они не
// становятся вложениями проекта.
var serviceFiles = map[string]bool{
	"manifest.json": true,
	"readme.txt":    true,
	"thumbs.db":     true,
	".ds_store":     true,
}

// markdownAttachment — файл набора, готовый стать вложением проекта.
type markdownAttachment struct {
	// path — путь в наборе ПОСЛЕ тех же снятий корня, что и у md-файлов: ссылки
	// из текстов ищут файл именно по нему.
	path string
	// name — имя файла для человека (в проекте вложение называется так же).
	name string
	mime string
	data []byte
	// origin — каталог файла до снятия корня: по нему разрешаются ссылки вида
	// `../assets/…`, когда md-файл лежит в служебной папке story/.
	origin []string
}

// addAttachment принимает не-md файл набора. Ошибка означает превышение лимита —
// вызывающий обязан прервать разбор целиком.
func (c *markdownCollector) addAttachment(filePath string, r io.Reader) error {
	name := baseName(filePath)
	if serviceFiles[strings.ToLower(name)] || strings.HasPrefix(name, ".") {
		return nil // служебное или скрытое — не содержимое проекта
	}

	data, tooLarge, err := readLimited(r, markdownMaxAttachmentSize)
	if err != nil {
		// Нечитаемый файл не должен ронять весь набор: предупреждаем и идём дальше.
		c.warnings = append(c.warnings, fmt.Sprintf("файл %s не прочитан: %v", filePath, err))
		return nil
	}
	if tooLarge {
		return fmt.Errorf("%w: файл %s больше %d МБ", ErrMarkdownTooLarge,
			filePath, markdownMaxAttachmentSize>>20)
	}

	mime := assets.MimeOf(name)
	if len(c.attachments) >= markdownMaxOtherFiles {
		return fmt.Errorf("%w: файлов кроме md больше %d", ErrMarkdownTooLarge, markdownMaxOtherFiles)
	}

	c.total += int64(len(data))
	if c.total > markdownMaxTotal {
		return fmt.Errorf("%w: суммарный размер больше %d МБ", ErrMarkdownTooLarge, markdownMaxTotal>>20)
	}

	c.attachments = append(c.attachments, &markdownAttachment{
		path:   filePath,
		name:   name,
		mime:   mime,
		data:   data,
		origin: dirOf(filePath),
	})
	return nil
}

// stripAttachmentRoot снимает корневой каталог архива с путей вложений — ровно так
// же, как он снимается с md-файлов: иначе ссылка «../assets/схема.png» указывала бы
// на файл в другой системе координат, чем сам набор.
func (c *markdownCollector) stripAttachmentRoot() {
	if c.stripRoot == "" {
		return
	}
	prefix := c.stripRoot + "/"
	for _, a := range c.attachments {
		a.path = strings.TrimPrefix(a.path, prefix)
		if len(a.origin) > 0 && a.origin[0] == c.stripRoot {
			a.origin = a.origin[1:]
		}
	}
}

// readLimited читает не больше limit байт и говорит, не оказался ли файл длиннее.
// Флаг нужен там, где размер заранее неизвестен (multipart): по нему отличаем
// «файл слишком большой» от «файл прочитан».
func readLimited(r io.Reader, limit int) ([]byte, bool, error) {
	data, err := io.ReadAll(io.LimitReader(r, int64(limit)+1))
	if err != nil {
		return nil, false, err
	}
	if len(data) > limit {
		return nil, true, nil
	}
	return data, false, nil
}

// baseName — последний сегмент пути.
func baseName(filePath string) string {
	if i := strings.LastIndex(filePath, "/"); i >= 0 {
		return filePath[i+1:]
	}
	return filePath
}

// dirOf — каталоги пути в том же виде, в каком их хранит md-файл.
func dirOf(filePath string) []string {
	i := strings.LastIndex(filePath, "/")
	if i < 0 {
		return nil
	}
	return strings.Split(filePath[:i], "/")
}

// attachmentIndex — поиск файла набора по ссылке из текста.
type attachmentIndex struct {
	byPath map[string]*markdownAttachment
	byName map[string][]*markdownAttachment
}

func newAttachmentIndex(list []*markdownAttachment) *attachmentIndex {
	index := &attachmentIndex{
		byPath: make(map[string]*markdownAttachment, len(list)),
		byName: make(map[string][]*markdownAttachment, len(list)),
	}
	for _, a := range list {
		index.byPath[a.path] = a
		key := strings.ToLower(a.name)
		index.byName[key] = append(index.byName[key], a)
	}
	return index
}

// appendUniqueInt добавляет номер в список, если его там ещё нет: на один файл
// могут ссылаться несколько раз из одного текста, а приложить его нужно один раз.
func appendUniqueInt(list []int, value int) []int {
	for _, existing := range list {
		if existing == value {
			return list
		}
	}
	return append(list, value)
}

// find ищет файл для ссылки из текста события.
//
// Порядок попыток — от самой точной к самой широкой:
//  1. путь относительно каталога файла ДО снятия корня (наш архив: `story/01.md` →
//     `../assets/01-схема.png` → `assets/01-схема.png`);
//  2. путь относительно текущего каталога файла (обычная папка с md рядом с
//     картинками: `![](картинки/схема.png)`);
//  3. путь как он написан (ссылка от корня проекта: `![](assets/схема.png)`);
//  4. то же без служебного префикса `story/`;
//  5. по имени файла — и только если такой файл в наборе ровно один.
//
// Абсолютные ссылки (`https://…`, `data:…`, `/api/assets/<id>`) не сопоставляются с
// файлами: первое — внешний ресурс, второе — уже загруженное вложение этого стенда.
func (idx *attachmentIndex) find(target string, item *markdownItem) *markdownAttachment {
	clean := cleanLinkTarget(target)
	if clean == "" {
		return nil
	}
	candidates := []string{
		joinRef(item.originDir, clean),
		joinRef(item.dir, clean),
		path.Clean(clean),
		strings.TrimPrefix(path.Clean(clean), "story/"),
	}
	for _, candidate := range candidates {
		if candidate == "" || candidate == "." || strings.HasPrefix(candidate, "..") {
			continue
		}
		if found := idx.byPath[candidate]; found != nil {
			return found
		}
	}
	name := baseName(clean)
	if list := idx.byName[strings.ToLower(name)]; len(list) == 1 {
		return list[0]
	}
	return nil
}

// cleanLinkTarget приводит цель ссылки к пути внутри набора: снимает `<…>`, якорь
// и параметры, декодирует %20. Пустая строка — ссылка не про файл набора.
func cleanLinkTarget(target string) string {
	value := strings.TrimSpace(target)
	value = strings.Trim(value, "<>")
	value = strings.TrimSpace(value)
	if value == "" {
		return ""
	}
	if i := strings.IndexAny(value, "?#"); i >= 0 {
		value = value[:i]
	}
	if decoded, err := url.PathUnescape(value); err == nil {
		value = decoded
	}
	lower := strings.ToLower(value)
	switch {
	case strings.Contains(lower, "://"),
		strings.HasPrefix(lower, "data:"),
		strings.HasPrefix(lower, "mailto:"),
		// Ссылка от корня стенда — уже загруженное вложение (наша же выгрузка
		// одной лентой), а не файл набора.
		strings.HasPrefix(value, "/"):
		return ""
	}
	return value
}

// joinRef склеивает каталог файла и относительный путь ссылки, схлопывая `..`.
// Выше корня набора не поднимается: там файлов набора быть не может.
func joinRef(dir []string, target string) string {
	parts := append([]string{}, dir...)
	for _, segment := range strings.Split(target, "/") {
		switch segment {
		case "", ".":
		case "..":
			if len(parts) > 0 {
				parts = parts[:len(parts)-1]
			}
		default:
			parts = append(parts, segment)
		}
	}
	return strings.Join(parts, "/")
}
