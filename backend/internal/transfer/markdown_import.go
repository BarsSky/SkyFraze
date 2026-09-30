package transfer

// markdown_import.go — разбор папки с md-файлами в новое дерево событий.
//
// Задача — не конвертация формата, а сборка дерева: текст события уже Markdown.
// Правила зафиксированы в docs/import-export.md (п. 2) и повторены здесь, потому
// что именно они решают, что получится из имён файлов:
//
//   - каталог = уровень вложенности: событием каталога становится сам каталог —
//     его заголовок и текст берёт `index.md`, а если его нет, событие собирается
//     из имени каталога (иначе файлу в каталоге не нашлось бы родителя). Каталог
//     НЕ разворачивается: выбранная в браузере папка — тоже уровень, только её имя
//     дополнительно годится в название проекта. `index.md` без каталога — сам
//     проект: заголовок в название, тело в описание;
//   - номер и порядок — из префикса имени `NN-`, `NN.NN-`, `NN.NN.NN-`. Точка в
//     номере задаёт вложенность: `01.1-Первая встреча.md` рядом с `01-Пролог.md`
//     становится под-событием «Пролога», даже если каталогов нет вовсе. Именно
//     поэтому папка story/ из выгрузки (плоский список файлов) читается обратно
//     в то же дерево;
//   - файл без префикса — в конец своего уровня, номера выдаются подряд;
//   - заголовок: front-matter `title:` → первый `# H1` → имя файла без номера и
//     расширения. Заголовок в приложении показывается отдельно, поэтому строка
//     `# H1` убирается из тела — и когда заголовок взят из неё, и когда он пришёл
//     из front-matter, а H1 в файле остался (так пишет наша выгрузка). Во втором
//     случае строку убираем, только если её текст совпадает с заголовком после
//     снятия номера кадра: чужой H1 — часть текста, трогать его нельзя. Из H1 (и
//     из имени) дополнительно срезается номер, если он там ровно такой же, как в
//     имени файла: так выгрузка (`# 01.1 Сборка`) читается обратно без номера;
//   - front-matter — необязательный плоский YAML: `title`, `date` (YYYY-MM-DD),
//     `bg`. Значение может быть в двойных кавычках — так выгрузка пишет заголовки
//     со служебными символами, — тогда кавычки снимаются, а `\"` и `\\`
//     разэкранируются. `bg` принимаем, но не применяем: настройки фона живут
//     только в CRDT;
//   - глубина больше 4 — предупреждение и отказ от файла (не молчаливое
//     обрезание), как MaxDepth в событиях;
//   - кодировка UTF-8 (BOM допускается), CRLF нормализуется; нечитаемый файл —
//     предупреждение, остальные продолжают;
//   - всё, что не `.md`/`.markdown`, игнорируется; в отчёте считаются ссылки на
//     картинки в текстах (`![...](...)`) — «картинки не переносятся»;
//   - лимиты: 2000 файлов, 4 МБ на файл, 200 МБ суммарно, 2000 событий.
//
// Отдельный случай — наш собственный архив выгрузки (story.md рядом с папкой
// story/): сводную ленту не разбираем как событие (иначе в проекте появилась бы
// глава со всей историей внутри), название проекта берём из её заголовка, а
// служебный каталог story/ снимаем — он обёртка над деревом, а не глава.
//
// Отдельно про CRDT (это важно понимать при чтении ImportMarkdown): у нового
// проекта снапшота нет, и первый подключившийся редактор засеивает пустой Y.Doc
// из таблицы events, а засев берёт id/parent_id/title/body и дату события
// (frontend/src/collab/yprovider.ts). Поэтому импорт заполняет ровно эти поля —
// дерево в редакторе появляется корректно, включая даты из front-matter, —
// а фон кадров и привязки вложений в засев не входят: они живут только в CRDT,
// и md-выгрузка их не переносит (см. docs/import-export.md).

import (
	"archive/zip"
	"context"
	"errors"
	"fmt"
	"io"
	"os"
	"regexp"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/google/uuid"

	"github.com/skyfraze/backend/internal/events"
	"github.com/skyfraze/backend/internal/store"
)

// Лимиты разбора: до 2000 файлов, 4 МБ на файл, 200 МБ суммарно (как MaxBundleSize).
const (
	markdownMaxFiles    = 2000
	markdownMaxFileSize = 4 << 20
	markdownMaxTotal    = MaxBundleSize
	markdownMaxEvents   = 2000
)

var (
	// ErrMarkdownEmpty — во входе нет ни одного md-файла: создавать проект не из чего.
	ErrMarkdownEmpty = errors.New("в наборе нет .md/.markdown файлов, из которых собирается история")
	// ErrMarkdownBadZip — zip не читается (обрезан, не архив).
	ErrMarkdownBadZip = errors.New("архив не читается")
	// ErrMarkdownUnsafePath — путь в архиве небезопасен (zip-slip) или недопустим.
	ErrMarkdownUnsafePath = errors.New("недопустимый путь в архиве")
	// ErrMarkdownTooLarge — превышен лимит размера или количества.
	ErrMarkdownTooLarge = errors.New("набор файлов больше допустимого")
)

var (
	// Номер кадра в имени файла: 01, 01.1, 01.1.1 (точка допустима), за номером —
	// разделитель `-`, `_`, пробел или конец имени.
	fileNameNumberRe = regexp.MustCompile(`^(\d+(?:\.\d+)*)[\-_ .]`)
	// Первый заголовок первого уровня в теле.
	h1Re = regexp.MustCompile(`(?m)^#\s+(\S.*)$`)
	// Ссылка на изображение в тексте: ![alt](url).
	imageLinkRe = regexp.MustCompile(`!\[[^\]]*\]\([^)]*\)`)
	// Машинный комментарий выгрузки: <!-- skyfraze: number=… id=… kind=event -->.
	skyfrazeCommentRe = regexp.MustCompile(`(?m)^[ \t]*<!--\s*skyfraze:[^\n]*-->[ \t]*\n?`)
)

// exportedImageRe — строка картинки, которую выгрузка приписала событию:
// `![01.1·2](…)`. Срезаем только такие строки и только с номером этого файла:
// чужую картинку из текста пользователя трогать нельзя.
func exportedImageRe(rawNum string) *regexp.Regexp {
	if rawNum == "" {
		return nil
	}
	return regexp.MustCompile(`(?m)^[ \t]*!\[` + regexp.QuoteMeta(rawNum) + `·\d+\]\([^)]*\)[ \t]*\n?`)
}

// stripExportedImages убирает приписанные выгрузкой строки картинок.
func stripExportedImages(body, rawNum string) string {
	re := exportedImageRe(rawNum)
	if re == nil {
		return body
	}
	return re.ReplaceAllString(body, "")
}

// markdownItem — один разобранный md-файл (ещё без места в дереве).
type markdownItem struct {
	// path — относительный путь исходного файла, как его прислал браузер или
	// записал архив (в нём и видно, из какого каталога пришёл файл).
	path string
	// dir — каталоги файла, name — имя без расширения.
	dir  []string
	name string
	// num — числовой префикс имени: nil, [1], [1,1] …
	num []int
	// rawNum — тот же префикс текстом («01.1»): по нему срезается номер из
	// заголовка, и он же отличает наши строки картинок от картинок пользователя.
	rawNum string
	// isIndex — файл называется index.md: это событие своего каталога.
	isIndex bool
	// lane — файл называется story.md: это сводная лента нашей выгрузки.
	lane bool

	title    string
	body     string
	date     *time.Time
	images   int
	warnings []string
}

// ParsedMarkdown — результат разбора: дерево в порядке таймлайна плюс отчёт.
type ParsedMarkdown struct {
	// ProjectTitle/Description — из корневого index.md, а если его нет, из
	// сводной story.md (наш собственный архив выгрузки).
	ProjectTitle string
	Description  string
	// RootFolder — имя общего корневого каталога (браузер отдаёт его как первый
	// сегмент пути); запасной вариант названия проекта.
	RootFolder string

	Events   []ParsedMarkdownEvent
	Warnings []string
	Stats    MarkdownStats
}

// ParsedMarkdownEvent — событие в том порядке, в каком оно попадёт в проект.
type ParsedMarkdownEvent struct {
	Number   string
	Depth    int
	Title    string
	Path     string
	Chars    int
	Warnings []string

	// Date — дата события из front-matter: сохраняется в базе и попадает в
	// CRDT-засев, поэтому видна первому редактору и в кадре.
	Date *time.Time

	// Body — текст события; для импорта он же уходит в базу.
	Body string

	// для импорта
	position int
	parent   int // индекс родителя в Events, -1 — корень
}

// MarkdownStats — счётчики отчёта (ровно те, что описаны в docs/import-export.md).
type MarkdownStats struct {
	Files      int `json:"files"`
	Events     int `json:"events"`
	Chars      int `json:"chars"`
	ImageLinks int `json:"image_links"`
}

// previewEvent — событие в JSON-ответе предпросмотра.
type previewEvent struct {
	Number   string   `json:"number"`
	Depth    int      `json:"depth"`
	Title    string   `json:"title"`
	Path     string   `json:"path"`
	Chars    int      `json:"chars"`
	Warnings []string `json:"warnings"`
}

// previewResponse — ответ POST /api/projects/import/markdown/preview.
type previewResponse struct {
	ProjectTitle string         `json:"project_title"`
	Events       []previewEvent `json:"events"`
	Warnings     []string       `json:"warnings"`
	Stats        MarkdownStats  `json:"stats"`
}

// importResponse — ответ POST /api/projects/import/markdown.
type importResponse struct {
	ProjectID uuid.UUID `json:"project_id"`
	Events    int       `json:"events"`
	Warnings  []string  `json:"warnings"`
}

// Preview отдаёт разобранное дерево, ничего не записывая.
func (p *ParsedMarkdown) Preview() previewResponse {
	out := previewResponse{
		ProjectTitle: p.ProjectTitle,
		Events:       make([]previewEvent, 0, len(p.Events)),
		Warnings:     nonNil(p.Warnings),
		Stats:        p.Stats,
	}
	for _, e := range p.Events {
		out.Events = append(out.Events, previewEvent{
			Number: e.Number, Depth: e.Depth, Title: e.Title, Path: e.Path,
			Chars: e.Chars, Warnings: nonNil(e.Warnings),
		})
	}
	return out
}

func nonNil(list []string) []string {
	if list == nil {
		return []string{}
	}
	return list
}

// ---------- сбор файлов ----------

// markdownCollector накапливает разобранные файлы и общие счётчики. Один и тот
// же приёмник для multipart-загрузки папки и для zip: правила разбора не должны
// зависеть от того, как файлы доехали.
type markdownCollector struct {
	items    []*markdownItem
	files    int
	total    int64
	warnings []string
	// stripRoot — общий корень архива, который надо снять (см. singleRootDir).
	// Только для zip: при загрузке папки корень срезает фронтенд, потому что
	// отличить выбранную папку от главы-папки на сервере невозможно.
	stripRoot string
}

// Add принимает один файл. Ошибка означает превышение лимита — вызывающий обязан
// прервать разбор: молча потерять часть файлов хуже, чем отказать целиком.
func (c *markdownCollector) Add(path string, r io.Reader) error {
	if !isMarkdownPath(path) {
		return nil // не md — игнорируем: ссылки на картинки считаются в текстах
	}
	c.files++
	if c.files > markdownMaxFiles {
		return fmt.Errorf("%w: больше %d файлов", ErrMarkdownTooLarge, markdownMaxFiles)
	}

	// Читаем не больше лимита плюс один байт: так «слишком большой файл» виден и
	// тогда, когда размер заранее неизвестен (multipart).
	data, err := io.ReadAll(io.LimitReader(r, markdownMaxFileSize+1))
	if err != nil {
		// Нечитаемый файл не должен ронять весь набор: предупреждаем и идём дальше.
		c.warnings = append(c.warnings, fmt.Sprintf("файл %s не прочитан: %v", path, err))
		c.files--
		return nil
	}
	if len(data) > markdownMaxFileSize {
		return fmt.Errorf("%w: файл %s больше %d МБ", ErrMarkdownTooLarge, path, markdownMaxFileSize>>20)
	}
	c.total += int64(len(data))
	if c.total > markdownMaxTotal {
		return fmt.Errorf("%w: суммарный размер больше %d МБ", ErrMarkdownTooLarge, markdownMaxTotal>>20)
	}

	item := parseMarkdownFile(path, data)
	if item == nil {
		c.files--
		return nil
	}
	c.warnings = append(c.warnings, item.warnings...)
	c.items = append(c.items, item)
	return nil
}

// ParseMarkdownReaders разбирает набор md-файлов (multipart-загрузка папки):
// paths[i] — относительный путь файла, readers[i] — его содержимое.
func ParseMarkdownReaders(paths []string, readers []io.Reader) (*ParsedMarkdown, error) {
	if len(paths) != len(readers) {
		return nil, fmt.Errorf("%w: путей %d, файлов %d", ErrMarkdownUnsafePath, len(paths), len(readers))
	}
	c := &markdownCollector{}
	for i, p := range paths {
		clean, err := cleanInputPath(p)
		if err != nil {
			return nil, fmt.Errorf("%w: %s", ErrMarkdownUnsafePath, p)
		}
		if err := c.Add(clean, readers[i]); err != nil {
			return nil, err
		}
	}
	return c.build()
}

// ParseMarkdownZip разбирает zip с той же структурой. Архив не распаковывается в
// память целиком: читаем по одной записи и сразу отпускаем прочитанное, а
// не-md записи (вложения, манифест) вообще не открываем.
func ParseMarkdownZip(r io.ReaderAt, size int64) (*ParsedMarkdown, error) {
	if size <= 0 || size > markdownMaxTotal {
		return nil, fmt.Errorf("%w: архив больше %d МБ", ErrMarkdownTooLarge, markdownMaxTotal>>20)
	}
	zr, err := zip.NewReader(r, size)
	if err != nil {
		return nil, fmt.Errorf("%w: %v", ErrMarkdownBadZip, err)
	}
	if len(zr.File) > markdownMaxFiles*4 {
		// Настоящая папка истории — это story/ да вложения; десятки тысяч записей
		// означают не то, что мы умеем разбирать.
		return nil, fmt.Errorf("%w: в архиве %d записей", ErrMarkdownTooLarge, len(zr.File))
	}

	type entry struct {
		name string
		file *zip.File
	}
	var entries []entry
	for _, f := range zr.File {
		if strings.HasSuffix(f.Name, "/") {
			continue // каталог
		}
		if f.Mode()&os.ModeSymlink != 0 {
			// Симлинк внутри архива — это попытка увести разбор за пределы папки.
			return nil, fmt.Errorf("%w: %s — симлинк", ErrMarkdownUnsafePath, f.Name)
		}
		name, err := cleanInputPath(f.Name)
		if err != nil {
			return nil, fmt.Errorf("%w: %s", ErrMarkdownUnsafePath, f.Name)
		}
		if !isMarkdownPath(name) {
			continue
		}
		if f.UncompressedSize64 > markdownMaxFileSize {
			return nil, fmt.Errorf("%w: файл %s больше %d МБ", ErrMarkdownTooLarge, name, markdownMaxFileSize>>20)
		}
		entries = append(entries, entry{name: name, file: f})
	}
	if len(entries) > markdownMaxFiles {
		return nil, fmt.Errorf("%w: больше %d md-файлов", ErrMarkdownTooLarge, markdownMaxFiles)
	}

	c := &markdownCollector{stripRoot: singleRootDir(zr.File)}
	for _, e := range entries {
		rc, err := e.file.Open()
		if err != nil {
			c.warnings = append(c.warnings, fmt.Sprintf("файл %s не открылся: %v", e.name, err))
			c.files++
			continue
		}
		err = c.Add(e.name, rc)
		rc.Close()
		if err != nil {
			return nil, err
		}
	}
	return c.build()
}

// singleRootDir — имя общего корня «архива с одной папкой»: ровно одна запись
// верхнего уровня, это каталог, и файлов в корне нет. Такой архив снимаем —
// иначе пользователь получил бы лишнюю главу с именем папки, хотя это просто
// обёртка (обычная выгрузка папки в zip). Если в корне есть файлы или
// верхнеуровневых записей несколько, корень трогать нельзя: это уже структура
// проекта, а не обёртка.
//
// Правило действует только для zip: при загрузке папки браузер присылает
// выбранный каталог первым сегментом пути, и отличить его от главы-папки на
// сервере невозможно — там корень срезает фронтенд.
func singleRootDir(files []*zip.File) string {
	root := ""
	// noteTop учитывает верхнеуровневый сегмент: если их окажется больше одного,
	// это уже структура проекта, а не обёртка.
	noteTop := func(top string) bool {
		if top == "" {
			return true
		}
		if root == "" {
			root = top
			return true
		}
		if root != top {
			root = ""
			return false
		}
		return true
	}
	for _, f := range files {
		name := strings.TrimPrefix(strings.ReplaceAll(f.Name, "\\", "/"), "./")
		if name == "" || name == "/" {
			continue
		}
		// Явная запись каталога («Моя история/») файлом в корне не считается.
		explicitDir := f.FileInfo().IsDir() || strings.HasSuffix(name, "/")
		name = strings.TrimSuffix(name, "/")
		if name == "" {
			continue
		}
		top, rest, nested := strings.Cut(name, "/")
		switch {
		case !nested && !explicitDir:
			return "" // файл лежит в корне архива
		case !nested, rest == "":
			// Верхнеуровневый каталог — тот самый возможный корень.
			if !noteTop(top) {
				return ""
			}
		default:
			// Файл внутри каталога: его верхний сегмент и есть корень.
			if !noteTop(top) {
				return ""
			}
		}
	}
	return root
}

// cleanInputPath нормализует путь из загрузки и отбивает zip-slip: абсолютные
// пути, `..`, пустые сегменты и управляющие символы. Файлы мы никуда не пишем,
// но недопустимый путь означает, что прислали не то, что мы умеем разбирать, —
// лучше отказать, чем строить дерево по мусорным именам.
func cleanInputPath(p string) (string, error) {
	p = strings.ReplaceAll(p, "\\", "/")
	if p == "" || strings.HasPrefix(p, "/") || strings.Contains(p, "\x00") {
		return "", ErrMarkdownUnsafePath
	}
	if len(p) >= 2 && p[1] == ':' { // C:/... — абсолютный путь
		return "", ErrMarkdownUnsafePath
	}
	for _, r := range p {
		if r < 0x20 || r == 0x7f {
			return "", ErrMarkdownUnsafePath
		}
	}
	segments := strings.Split(p, "/")
	out := make([]string, 0, len(segments))
	for _, s := range segments {
		switch s {
		case "", ".":
			continue
		case "..":
			return "", ErrMarkdownUnsafePath
		}
		out = append(out, s)
	}
	if len(out) == 0 {
		return "", ErrMarkdownUnsafePath
	}
	return strings.Join(out, "/"), nil
}

func isMarkdownPath(p string) bool {
	lower := strings.ToLower(p)
	return strings.HasSuffix(lower, ".md") || strings.HasSuffix(lower, ".markdown")
}

// parseMarkdownFile разбирает один файл: front-matter, заголовок, номер из имени.
// nil означает, что файл пропущен (не читается как UTF-8) — с предупреждением.
func parseMarkdownFile(path string, data []byte) *markdownItem {
	// BOM допускается, CRLF нормализуется: файлы приходят из чужих редакторов.
	text := strings.TrimPrefix(string(data), "\ufeff")
	if !utf8.ValidString(text) {
		return nil
	}
	text = strings.ReplaceAll(text, "\r\n", "\n")
	text = strings.ReplaceAll(text, "\r", "\n")

	segments := strings.Split(path, "/")
	base := segments[len(segments)-1]
	lower := strings.ToLower(base)
	var name string
	switch {
	case strings.HasSuffix(lower, ".markdown"):
		name = base[:len(base)-len(".markdown")]
	case strings.HasSuffix(lower, ".md"):
		name = base[:len(base)-len(".md")]
	default:
		name = base
	}

	item := &markdownItem{
		path:    path,
		dir:     segments[:len(segments)-1],
		name:    name,
		num:     parseNumberPrefix(name),
		rawNum:  numberPrefixText(name),
		isIndex: strings.EqualFold(name, "index"),
		lane:    strings.EqualFold(name, "story"),
	}

	fm, body := splitFrontMatter(text)
	if bg := strings.TrimSpace(fm["bg"]); bg != "" {
		// Фон кадра живёт в CRDT-снапшоте, а не в таблице событий: перенести его
		// папкой md в этой версии нечем.
		item.warnings = append(item.warnings,
			fmt.Sprintf("файл %s: настройка фона (bg: %s) не переносится — фон живёт только в CRDT", path, bg))
	}

	// Машинные комментарии выгрузки — часть формата, а не текст события; без этой
	// строки круговой обмен «выгрузили → загрузили» не сошёлся бы по телам.
	body = skyfrazeCommentRe.ReplaceAllString(body, "")

	title := frontMatterValue(fm["title"])
	if title == "" {
		if m := h1Re.FindStringSubmatchIndex(body); m != nil {
			title = stripNumberPrefix(strings.TrimSpace(body[m[2]:m[3]]), item.rawNum)
			// Заголовок показывается отдельно от текста, поэтому строку убираем.
			body = strings.TrimLeft(body[:m[0]]+body[m[1]:], "\n")
		}
	} else if m := h1Re.FindStringSubmatchIndex(body); m != nil {
		// Заголовок пришёл из front-matter, а H1 в файле остался — так пишет наша
		// выгрузка. Строку убираем, только если это тот же заголовок (с тем же
		// номером кадра): иначе H1 — часть текста, и в приложении он был бы дублем
		// заголовка только в первом случае.
		if h1Title(strings.TrimSpace(body[m[2]:m[3]]), item.rawNum) == title {
			body = strings.TrimLeft(body[:m[0]]+body[m[1]:], "\n")
		}
	}
	if title == "" {
		// Имя файла без номера и расширения, `-`/`_` → пробелы.
		title = strings.ReplaceAll(strings.ReplaceAll(name, "-", " "), "_", " ")
		title = stripNumberPrefix(strings.TrimSpace(title), item.rawNum)
	}
	if title == "" {
		title = name
	}
	item.title = title

	if d := frontMatterValue(fm["date"]); d != "" {
		parsed, err := time.Parse("2006-01-02", d)
		if err != nil {
			item.warnings = append(item.warnings,
				fmt.Sprintf("файл %s: дата %q не в формате ГГГГ-ММ-ДД — не переносится", path, d))
		} else {
			utc := parsed.UTC()
			item.date = &utc
		}
	}

	// Картинки, приписанные выгрузкой своему событию (`![01.1·2](../assets/…)`),
	// при обратном чтении снова становятся вложениями — в тексте им не место.
	body = stripExportedImages(body, item.rawNum)
	item.body = strings.TrimSpace(body)
	item.images = len(imageLinkRe.FindAllString(item.body, -1))
	if item.body == "" {
		item.warnings = append(item.warnings, fmt.Sprintf("файл %s пуст — событие без текста", path))
	}
	return item
}

// splitFrontMatter вырезает необязательный плоский YAML-блок в начале файла.
// Разбираем ровно пары `ключ: значение`: этого хватает для title/date/bg, а
// вложенный YAML всё равно некуда девать — импорт переносит только эти поля.
func splitFrontMatter(text string) (map[string]string, string) {
	fm := map[string]string{}
	if !strings.HasPrefix(text, "---\n") {
		return fm, text
	}
	rest := text[4:]
	end := strings.Index(rest, "\n---")
	if end < 0 {
		// Блок не закрыт — считаем, что front-matter'а нет: иначе мы бы съели
		// начало текста события (горизонтальная линия `---` — обычное дело).
		return fm, text
	}
	block := rest[:end]
	body := strings.TrimPrefix(rest[end+4:], "\n")

	for _, line := range strings.Split(block, "\n") {
		line = strings.TrimSpace(line)
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}
		key, value, ok := strings.Cut(line, ":")
		if !ok {
			continue
		}
		fm[strings.TrimSpace(key)] = strings.TrimSpace(value)
	}
	return fm, body
}

// frontMatterValue читает значение плоской пары front-matter: снимает кавычки и
// разэкранирует ровно то, что пишет выгрузка (`"` и `\`, см. yamlScalar в
// markdown.go). Без этого заголовок с кавычкой вернулся бы из файла с обратными
// слэшами — то есть с лишними символами, которых автор не писал. Остальные
// обратные слэши не трогаем: такого экранирования выгрузка не делает, и значение
// остаётся ровно таким, как его записал человек.
func frontMatterValue(raw string) string {
	raw = strings.TrimSpace(raw)
	if len(raw) >= 2 && raw[0] == '"' && raw[len(raw)-1] == '"' {
		body := raw[1 : len(raw)-1]
		var b strings.Builder
		b.Grow(len(body))
		for i := 0; i < len(body); i++ {
			if body[i] == '\\' && i+1 < len(body) && (body[i+1] == '\\' || body[i+1] == '"') {
				i++ // `\\` → `\`, `\"` → `"`
			}
			b.WriteByte(body[i])
		}
		return strings.TrimSpace(b.String())
	}
	if len(raw) >= 2 && raw[0] == '\'' && raw[len(raw)-1] == '\'' {
		// YAML в одинарных кавычках экранирует саму кавычку удвоением.
		return strings.TrimSpace(strings.ReplaceAll(raw[1:len(raw)-1], "''", "'"))
	}
	// Без кавычек: одиночные кавычки по краям — мусор от чужого редактора, и
	// раньше их срезал Trim.
	return strings.Trim(raw, "\"'")
}

// h1Title — текст H1 без ведущего номера кадра: «01.1 Сборка» → «Сборка». Номер
// снимается, только если он ровно такой же, как в имени файла (как и в
// stripNumberPrefix), но дефисы и точки самого заголовка не трогаются: сравнение
// с front-matter должно быть точным, а заголовок вполне может начинаться с
// дефиса.
func h1Title(h1, rawNum string) string {
	h1 = strings.TrimSpace(h1)
	if rawNum == "" || !strings.HasPrefix(h1, rawNum) {
		return h1
	}
	rest := strings.TrimPrefix(h1, rawNum)
	if rest == "" || !strings.ContainsRune(" \t-—.", rune(rest[0])) {
		return h1
	}
	return strings.TrimSpace(rest)
}

// parseNumberPrefix читает `01-`, `01.1-`, `01.1.1-` из имени файла. nil —
// префикса нет, номер будет выдан подряд по имени.
func parseNumberPrefix(name string) []int {
	raw := numberPrefixText(name)
	if raw == "" {
		return nil
	}
	parts := strings.Split(raw, ".")
	out := make([]int, 0, len(parts))
	for _, p := range parts {
		n, err := strconv.Atoi(p)
		if err != nil {
			return nil
		}
		out = append(out, n)
	}
	return out
}

// numberPrefixText — номер ровно так, как он записан в имени («02», «01.1»).
// Нужен для срезки номера из заголовка: сравнивать надо текст, а не числа, иначе
// `02-Магия.md` → «02 Магия» → срезка «2» не сработала бы.
func numberPrefixText(name string) string {
	if m := fileNameNumberRe.FindStringSubmatch(name); m != nil {
		return m[1]
	}
	return ""
}

// stripNumberPrefix убирает из заголовка номер, совпадающий с номером в имени
// файла: выгрузка пишет `# 01.1 Сборка`, а заголовок события — «Сборка».
func stripNumberPrefix(text, rawNum string) string {
	if rawNum == "" {
		return text
	}
	if !strings.HasPrefix(text, rawNum) {
		return text
	}
	rest := strings.TrimPrefix(text, rawNum)
	if rest == "" || !strings.ContainsRune(" \t-—.", rune(rest[0])) {
		return text
	}
	return strings.TrimSpace(strings.TrimLeft(rest, "-—. \t"))
}

// firstLine — первая содержательная строка текста (описание проекта из story.md).
func firstLine(text string) string {
	for _, line := range strings.Split(text, "\n") {
		line = strings.TrimSpace(line)
		if line == "" || strings.HasPrefix(line, "<!--") {
			continue
		}
		return strings.TrimSpace(strings.TrimPrefix(line, "#"))
	}
	return ""
}

// ---------- сборка дерева ----------

// markdownNode — узел дерева до нумерации.
type markdownNode struct {
	item *markdownItem
	// key — числовой путь внутри своего уровня (номер каталога плюс номер файла);
	// пустой — номера нет, порядок по имени в конце уровня.
	key []int
	// kids — дети: файлы каталога события плюс элементы, вложенные по номеру.
	kids []*markdownNode
}

// build собирает из накопленных файлов дерево проекта в порядке таймлайна.
func (c *markdownCollector) build() (*ParsedMarkdown, error) {
	items := c.items
	warnings := append([]string{}, c.warnings...)

	// Корневой каталог НЕ срезаем: «каталог = уровень вложенности», и выбранная
	// в браузере папка — тоже уровень (её файлы иначе потеряли бы глубину). Имя
	// корневой папки при этом остаётся запасным вариантом названия проекта.
	rootFolder := commonFolder(items)

	// Исключение — «архив с одной папкой» (см. singleRootDir): там корень это
	// обёртка, а не глава. Для multipart-загрузки stripRoot всегда пуст.
	if c.stripRoot != "" {
		prefix := c.stripRoot + "/"
		for _, it := range items {
			if len(it.dir) > 0 && it.dir[0] == c.stripRoot {
				it.dir = it.dir[1:]
				it.path = strings.TrimPrefix(it.path, prefix)
			}
		}
	}

	// Сводная лента story.md рядом с папкой story/ — это наша же выгрузка
	// (`GET /api/projects/{id}/export.md?assets=1`). Дерево описывают файлы
	// story/, а story.md — та же история одной лентой; разобрав её как событие,
	// мы получили бы лишнюю главу со всем текстом проекта внутри. Заодно снимаем
	// служебный префикс story/: в нашем архиве это обёртка над деревом, а не
	// глава (пользовательские каталоги так не разворачиваем).
	var projectItem *markdownItem
	if hasStoryDir(items) {
		for _, it := range items {
			if len(it.dir) == 0 && it.lane {
				projectItem = it
				warnings = append(warnings,
					"файл story.md пропущен как событие: это сводная лента, дерево берём из папки story/")
				break
			}
		}
	}
	if projectItem != nil {
		kept := items[:0]
		for _, it := range items {
			if it == projectItem {
				continue
			}
			if len(it.dir) > 0 && it.dir[0] == "story" {
				it.dir = it.dir[1:]
				it.path = strings.TrimPrefix(it.path, "story/")
			}
			kept = append(kept, it)
		}
		items = kept
	}

	// index.md без каталога — сам проект: его заголовок и есть название, тело —
	// описание. Отдельным событием он не становится («index.md — это событие
	// самого каталога», а корень — это и есть проект). index.md внутри каталога
	// остаётся событием этого каталога (см. buildLevel).
	rootIndex := rootLevelIndex(items)
	if rootIndex != nil {
		kept := items[:0]
		for _, it := range items {
			if it != rootIndex {
				kept = append(kept, it)
			}
		}
		items = kept
	}
	if len(items) == 0 {
		return nil, ErrMarkdownEmpty
	}

	byDir := map[string][]*markdownItem{}
	for _, it := range items {
		key := strings.Join(it.dir, "/")
		byDir[key] = append(byDir[key], it)
	}
	level := buildLevel(byDir, "", nil)

	parsed := &ParsedMarkdown{
		Warnings:   warnings,
		Stats:      MarkdownStats{Files: c.files},
		RootFolder: rootFolder,
	}
	if rootIndex != nil {
		parsed.ProjectTitle = rootIndex.title
		parsed.Description = rootIndex.body
	} else if projectItem != nil {
		parsed.ProjectTitle = projectItem.title
		parsed.Description = firstLine(projectItem.body)
	}
	for _, it := range items {
		parsed.Stats.ImageLinks += it.images
	}

	// Нумерация и глубина: pre-order, номера от позиции в дереве — ровно так их
	// считает таймлайн (chapterNumber/stepNumber в timelineModel.ts). Считать
	// номера от position в базе нельзя: при импорте папки позиции другие.
	var walk func(nodes []*markdownNode, prefix string, depth, parent int)
	walk = func(nodes []*markdownNode, prefix string, depth, parent int) {
		for i, n := range nodes {
			if depth > events.MaxDepth {
				// Глубже четырёх уровней приложение не умеет: честно отказываемся
				// от файла и его поддерева, а не обрезаем молча.
				for _, dropped := range flatten(n) {
					parsed.Warnings = append(parsed.Warnings, fmt.Sprintf(
						"файл %s не взят: глубина %d больше максимальной %d",
						dropped.item.path, depth, events.MaxDepth))
				}
				continue
			}
			num := prefix + "." + strconv.Itoa(i+1)
			if depth == 0 {
				num = fmt.Sprintf("%02d", i+1)
			}
			index := len(parsed.Events)
			e := ParsedMarkdownEvent{
				Number:   num,
				Depth:    depth,
				Title:    n.item.title,
				Path:     n.item.path,
				Chars:    utf8.RuneCountInString(n.item.body),
				Warnings: n.item.warnings,
				position: i,
				parent:   parent,
				Body:     n.item.body,
				Date:     n.item.date,
			}
			parsed.Stats.Chars += e.Chars
			parsed.Events = append(parsed.Events, e)
			walk(n.kids, num, depth+1, index)
		}
	}
	walk(level, "", 0, -1)
	parsed.Stats.Events = len(parsed.Events)

	if len(parsed.Events) == 0 {
		return nil, ErrMarkdownEmpty
	}
	if len(parsed.Events) > markdownMaxEvents {
		return nil, fmt.Errorf("%w: событий больше %d", ErrMarkdownTooLarge, markdownMaxEvents)
	}

	// Дата события попадает и в базу, и в CRDT-засев (редактор читает её из
	// таблицы events вместе с id/parent_id/title/body), поэтому предупреждать
	// здесь не о чем — только про то, что действительно не переносится.
	if parsed.Stats.ImageLinks > 0 {
		parsed.Warnings = append(parsed.Warnings, fmt.Sprintf(
			"картинки не переносятся: %d ссылок", parsed.Stats.ImageLinks))
	}
	return parsed, nil
}

// hasStoryDir сообщает, есть ли в наборе каталог story с файлами.
func hasStoryDir(items []*markdownItem) bool {
	for _, it := range items {
		if len(it.dir) >= 1 && it.dir[0] == "story" {
			return true
		}
	}
	return false
}

// buildLevel собирает уровень дерева: файлы каталога dir, у которых
// событие-владелец — host (nil для корня).
//
// Каталог — это уровень («каталог = уровень вложенности»), поэтому событием
// становится сам каталог: его заголовок и текст берёт index.md, а если index.md
// нет — событие собирается из имени каталога. Без этого у файла в каталоге не
// было бы родителя, и глубина терялась бы.
func buildLevel(byDir map[string][]*markdownItem, dir string, parentKey []int) []*markdownNode {
	items := byDir[dir]
	sortItems(items)

	var level []*markdownNode
	var cur *markdownNode
	curKey := parentKey
	if dir != "" {
		node := &markdownNode{
			item: dirEvent(items, dir),
			key:  appendKey(parentKey, parseNumberPrefix(lastSegment(dir))),
		}
		level = append(level, node)
		cur, curKey = node, node.key
	}
	// Файлы каталога — дети его события (или корня, если это корень набора).
	for _, it := range items {
		if it.isIndex {
			continue
		}
		node := &markdownNode{item: it, key: appendKey(curKey, it.num)}
		if cur == nil {
			level = append(level, node)
		} else {
			cur.kids = append(cur.kids, node)
		}
	}
	// Подкаталоги: у каждого свой уровень-событие, поэтому они становятся детьми
	// события текущего каталога (а у корня набора — его же уровнем).
	for _, sub := range subdirs(byDir, dir) {
		subs := buildLevel(byDir, sub, curKey)
		if cur == nil {
			level = append(level, subs...)
		} else {
			cur.kids = append(cur.kids, subs...)
		}
	}

	// Файлы каталога перемешались с подкаталогами, а номера с точкой
	// (`01.1-Первая встреча.md`) вкладываются в соседа с номером `01` — и это
	// касается как уровня целиком, так и детей события каталога.
	if cur != nil {
		sortNodes(cur.kids)
		cur.kids = nestNumbers(cur.kids)
	}

	sortNodes(level)
	level = nestNumbers(level)
	// Дети перемешались: свои файлы каталога плюс вложенные по номеру — порядок
	// задаёт один и тот же ключ. Сортировать надо по всему поддереву: вложенный
	// по номеру узел сам может получить детей на этом же шаге.
	for _, n := range level {
		sortKidsRec(n)
	}
	return level
}

// dirEvent — событие каталога: index.md, если он есть, иначе событие из имени
// каталога (номер в имени срезается так же, как у файла).
func dirEvent(items []*markdownItem, dir string) *markdownItem {
	for _, it := range items {
		if it.isIndex {
			return it
		}
	}
	name := lastSegment(dir)
	title := strings.TrimSpace(strings.ReplaceAll(strings.ReplaceAll(name, "-", " "), "_", " "))
	title = stripNumberPrefix(title, numberPrefixText(name))
	return &markdownItem{
		path:  dir,
		name:  name,
		num:   parseNumberPrefix(name),
		title: title,
	}
}

// rootLevelIndex — index.md без каталога: он описывает сам проект, а не событие
// (в каталоге index.md — событие каталога, см. dirEvent).
func rootLevelIndex(items []*markdownItem) *markdownItem {
	for _, it := range items {
		if it.isIndex && len(it.dir) == 0 {
			return it
		}
	}
	return nil
}

// sortKidsRec упорядочивает детей узла и всех его потомков.
func sortKidsRec(n *markdownNode) {
	if len(n.kids) == 0 {
		return
	}
	sortNodes(n.kids)
	for _, kid := range n.kids {
		sortKidsRec(kid)
	}
}

// nestNumbers вкладывает элемент с номером `01.1` в соседа с номером `01` в
// пределах одного уровня. Это и есть правило «точка в номере = вложенность»: и
// папка с каталогами, и плоская story/ из выгрузки собираются одинаково.
func nestNumbers(level []*markdownNode) []*markdownNode {
	if len(level) < 2 {
		return level
	}
	byKey := make(map[string]*markdownNode, len(level))
	for _, n := range level {
		if len(n.key) == 0 {
			continue
		}
		k := keyString(n.key)
		if _, exists := byKey[k]; !exists {
			byKey[k] = n
		}
	}
	keep := make([]*markdownNode, 0, len(level))
	for _, n := range level {
		if len(n.key) > 1 {
			if parent, ok := byKey[keyString(n.key[:len(n.key)-1])]; ok && parent != n {
				parent.kids = append(parent.kids, n)
				continue
			}
		}
		keep = append(keep, n)
	}
	sortNodes(keep)
	return keep
}

// sortItems упорядочивает файлы каталога: сначала с номером (по номеру), потом
// без номера (по имени) — так «файлы без номера уходят в конец».
func sortItems(items []*markdownItem) {
	insertionSort(len(items), func(i, j int) bool { return itemLess(items[i], items[j]) },
		func(i, j int) { items[i], items[j] = items[j], items[i] })
}

func itemLess(a, b *markdownItem) bool {
	if (len(a.num) == 0) != (len(b.num) == 0) {
		return len(a.num) > 0
	}
	if c := compareKeys(a.num, b.num); c != 0 {
		return c < 0
	}
	return a.name < b.name
}

// sortNodes упорядочивает уровень: по номеру, затем по имени, узлы без номера —
// в конец. Порядок должен быть детерминированным: от него зависят номера кадров.
func sortNodes(nodes []*markdownNode) {
	insertionSort(len(nodes), func(i, j int) bool { return nodeLess(nodes[i], nodes[j]) },
		func(i, j int) { nodes[i], nodes[j] = nodes[j], nodes[i] })
}

func nodeLess(a, b *markdownNode) bool {
	if (len(a.key) == 0) != (len(b.key) == 0) {
		return len(a.key) > 0
	}
	if c := compareKeys(a.key, b.key); c != 0 {
		return c < 0
	}
	if a.item.name != b.item.name {
		return a.item.name < b.item.name
	}
	return a.item.path < b.item.path
}

// insertionSort — сортировка вставками по предикату: элементы этих списков
// почти всегда уже упорядочены (файлы каталога или обход архива), а устойчивость
// важнее скорости.
func insertionSort(n int, less func(i, j int) bool, swap func(i, j int)) {
	for i := 1; i < n; i++ {
		for j := i; j > 0 && less(j, j-1); j-- {
			swap(j, j-1)
		}
	}
}

func compareKeys(a, b []int) int {
	for i := 0; i < len(a) && i < len(b); i++ {
		if a[i] != b[i] {
			if a[i] < b[i] {
				return -1
			}
			return 1
		}
	}
	switch {
	case len(a) < len(b):
		return -1
	case len(a) > len(b):
		return 1
	}
	return 0
}

func keyString(key []int) string {
	parts := make([]string, 0, len(key))
	for _, n := range key {
		parts = append(parts, strconv.Itoa(n))
	}
	return strings.Join(parts, ".")
}

// appendKey склеивает номер каталога с номером файла. Файл без собственного
// номера ключа не получает: иначе он унаследовал бы номер каталога и уехал в
// середину уровня.
func appendKey(prefix, own []int) []int {
	if len(own) == 0 {
		return nil
	}
	if len(prefix) == 0 {
		return own
	}
	out := make([]int, 0, len(prefix)+len(own))
	out = append(out, prefix...)
	return append(out, own...)
}

func lastSegment(dir string) string {
	if i := strings.LastIndex(dir, "/"); i >= 0 {
		return dir[i+1:]
	}
	return dir
}

// subdirs возвращает подкаталоги dir в устойчивом порядке: «02-Мир» идёт после
// «01-Пролог», а не в порядке обхода map.
func subdirs(byDir map[string][]*markdownItem, dir string) []string {
	prefix := dir
	if prefix != "" {
		prefix += "/"
	}
	seen := map[string]bool{}
	var out []string
	for key := range byDir {
		if key == dir || !strings.HasPrefix(key, prefix) {
			continue
		}
		rest := key[len(prefix):]
		if i := strings.Index(rest, "/"); i >= 0 {
			rest = rest[:i]
		}
		name := prefix + rest
		if !seen[name] {
			seen[name] = true
			out = append(out, name)
		}
	}
	sortStrings(out, dirLess)
	return out
}

func sortStrings(list []string, less func(a, b string) bool) {
	insertionSort(len(list), func(i, j int) bool { return less(list[i], list[j]) },
		func(i, j int) { list[i], list[j] = list[j], list[i] })
}

func dirLess(a, b string) bool {
	an, bn := parseNumberPrefix(lastSegment(a)), parseNumberPrefix(lastSegment(b))
	if (len(an) == 0) != (len(bn) == 0) {
		return len(an) > 0
	}
	if c := compareKeys(an, bn); c != 0 {
		return c < 0
	}
	return a < b
}

// commonFolder — общий первый сегмент путей: папка, которую пользователь выбрал
// в браузере (она остаётся уровнем дерева, но её имя — запасное название
// проекта). "" — общего сегмента нет или он есть не у всех путей.
func commonFolder(items []*markdownItem) string {
	root := ""
	for _, it := range items {
		if len(it.dir) == 0 {
			return ""
		}
		if root == "" {
			root = it.dir[0]
			continue
		}
		if it.dir[0] != root {
			return ""
		}
	}
	return root
}

// flatten разворачивает поддерево в список (для предупреждений об отказе).
func flatten(n *markdownNode) []*markdownNode {
	out := []*markdownNode{n}
	for _, kid := range n.kids {
		out = append(out, flatten(kid)...)
	}
	return out
}

// ---------- импорт ----------

// ImportMarkdown создаёт НОВЫЙ проект владельца по разобранной папке.
//
// titleOverride — необязательное поле `title` запроса. Иначе название берётся из
// разбора (корневой index.md или сводная story.md), затем из имени корневой
// папки, и лишь в самом конце — «Импорт Markdown».
//
// Почему всегда новый проект: импорт в СУЩЕСТВУЮЩИЙ проект с непустым
// CRDT-снапшотом в этой версии не поддерживается — первый же редактор засеял бы
// документ из таблицы events и затёр вставленное. Новый проект без снапшота
// безопасен: засев как раз и берёт наше дерево.
func (s *Service) ImportMarkdown(
	ctx context.Context, userID uuid.UUID, parsed *ParsedMarkdown, titleOverride string,
) (*store.Project, error) {
	if parsed == nil || len(parsed.Events) == 0 {
		return nil, ErrMarkdownEmpty
	}
	title := strings.TrimSpace(titleOverride)
	if title == "" {
		title = strings.TrimSpace(parsed.ProjectTitle)
	}
	if title == "" {
		title = strings.TrimSpace(parsed.RootFolder)
	}
	if title == "" {
		title = "Импорт Markdown"
	}

	// Заполняем ровно те поля, которые попадут в CRDT-засев
	// (id/parent_id/title/body/event_date); фон кадров и вложения засев не несёт
	// (см. комментарий к пакету).
	rows := make([]store.Event, 0, len(parsed.Events))
	for _, e := range parsed.Events {
		var parentID *uuid.UUID
		if e.parent >= 0 && e.parent < len(rows) {
			id := rows[e.parent].ID
			parentID = &id
		}
		rows = append(rows, store.Event{
			ID:        uuid.New(),
			ParentID:  parentID,
			Position:  e.position,
			Depth:     int16(e.Depth),
			Title:     e.Title,
			Body:      e.Body,
			EventDate: e.Date,
			CreatedBy: &userID,
			UpdatedBy: &userID,
		})
	}

	p, err := s.proj.Create(ctx, userID, title, parsed.Description)
	if err != nil {
		return nil, err
	}
	// Проект создаётся до вставки дерева, поэтому ошибку вставки обязаны убрать
	// за собой: иначе у пользователя останется пустой проект и непонятная ошибка.
	if err := s.store.InsertEventTree(ctx, p.ID, userID, rows); err != nil {
		_ = s.store.DeleteProject(ctx, p.ID)
		return nil, err
	}
	return p, nil
}
