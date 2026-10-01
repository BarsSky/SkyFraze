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

	"github.com/skyfraze/backend/internal/assets"
	"github.com/skyfraze/backend/internal/collab/yjs"
	"github.com/skyfraze/backend/internal/events"
	"github.com/skyfraze/backend/internal/projects"
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
	// Та же ссылка, но с целью: в первой группе — путь (`assets/схема.png`).
	imageTargetRe = regexp.MustCompile(`!\[[^\]]*\]\(\s*([^)\s]+)`)
	// Машинный комментарий выгрузки: <!-- skyfraze: number=… id=… kind=event -->.
	skyfrazeCommentRe = regexp.MustCompile(`(?m)^[ \t]*<!--\s*skyfraze:[^\n]*-->[ \t]*\n?`)
)

// exportedImageRe — строка картинки, которую выгрузка приписала событию:
// `![01.1·2](…)`. Срезаем только такие строки и только с номером этого файла:
// чужую картинку из текста пользователя трогать нельзя. Цель ссылки — в первой
// группе: по ней файл находит своё событие при обратном импорте.
func exportedImageRe(rawNum string) *regexp.Regexp {
	if rawNum == "" {
		return nil
	}
	return regexp.MustCompile(`(?m)^[ \t]*!\[` + regexp.QuoteMeta(rawNum) + `·\d+\]\(\s*([^)]*?)\s*\)[ \t]*\n?`)
}

// stripExportedImages убирает приписанные выгрузкой строки картинок.
func stripExportedImages(body, rawNum string) string {
	re := exportedImageRe(rawNum)
	if re == nil {
		return body
	}
	return re.ReplaceAllString(body, "")
}

// exportedImageTargets — цели строк картинок, приписанных выгрузкой: это вложения
// самого события, и при обратном чтении они снова становятся вложениями (в тексте
// им не место).
func exportedImageTargets(body, rawNum string) []string {
	re := exportedImageRe(rawNum)
	if re == nil {
		return nil
	}
	matches := re.FindAllStringSubmatch(body, -1)
	out := make([]string, 0, len(matches))
	for _, m := range matches {
		if len(m) > 1 && strings.TrimSpace(m[1]) != "" {
			out = append(out, strings.TrimSpace(m[1]))
		}
	}
	return out
}

// imageTargets — цели ссылок на изображения в тексте события, в порядке появления.
func imageTargets(body string) []string {
	matches := imageTargetRe.FindAllStringSubmatch(body, -1)
	out := make([]string, 0, len(matches))
	for _, m := range matches {
		if len(m) > 1 && strings.TrimSpace(m[1]) != "" {
			out = append(out, strings.TrimSpace(m[1]))
		}
	}
	return out
}

// markdownItem — один разобранный md-файл (ещё без места в дереве).
type markdownItem struct {
	// path — относительный путь исходного файла, как его прислал браузер или
	// записал архив (в нём и видно, из какого каталога пришёл файл).
	path string
	// dir — каталоги файла, name — имя без расширения.
	dir  []string
	name string
	// originDir — каталоги файла ДО снятия корня архива и служебной папки story/.
	// По ним разрешаются ссылки на вложения: `../assets/схема.png` из
	// `story/01-глава.md` указывает на `assets/схема.png`, и после снятия story/
	// этот путь уже не восстановить от текущего каталога файла.
	originDir []string
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

	// refs — ссылки на файлы, найденные в этом событии: сначала строки картинок,
	// приписанные выгрузкой (они и есть вложения этого события), затем ссылки из
	// текста — в порядке появления.
	refs []markdownRef
	// assets — индексы вложений набора (ParsedMarkdown.Attachments), привязанных к
	// этому событию. Заполняется после сборки дерева, когда пути уже нормализованы.
	assets []int
	// missing — ссылки, для которых файла в наборе не нашлось.
	missing []string
	// links — ссылки ИЗ ТЕКСТА, для которых файл нашёлся: в тексте они заменяются
	// адресом вложения (см. MarkdownLink), иначе картинка в приложении не откроется.
	links []MarkdownLink
}

// markdownRef — одна ссылка на файл в тексте события.
type markdownRef struct {
	// raw — цель ссылки ровно как она написана (по ней правится текст).
	raw string
	// text — ссылка из текста события, а не строка картинки нашей выгрузки:
	// строки выгрузки из текста удаляются, поэтому править в них нечего.
	text bool
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

	// Attachments — файлы набора, которые станут вложениями проекта: картинки,
	// pdf и прочее, что проект умеет принять. Событие ссылается на них индексами
	// (ParsedMarkdownEvent.Attachments), а не путями: файл может быть приложен к
	// нескольким событиям, и загружать его дважды незачем.
	Attachments []ParsedAttachment

	// missingRefs — до maxReportedMisses ссылок, для которых файла не нашлось:
	// они идут в текст предупреждения (остальные видны в статистике).
	missingRefs []string
}

// ParsedAttachment — файл набора, готовый стать вложением проекта.
type ParsedAttachment struct {
	// Path — путь файла в наборе (после снятия корня). Служит только для отчёта и
	// предупреждений: в проекте вложение живёт под своим идентификатором.
	Path string
	// Name — имя файла, под которым он будет в проекте.
	Name string
	Mime string
	Kind string
	Data []byte
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

	// Attachments — индексы вложений (ParsedMarkdown.Attachments), привязанных к
	// этому событию: файлы, о которых написано в его тексте (или строки картинок
	// нашей выгрузки). Привязка живёт только в CRDT, поэтому импорт собирает по ней
	// документ.
	Attachments []int

	// Links — ссылки из текста, для которых файл нашёлся: при импорте такая ссылка
	// заменяется адресом вложения (`/api/assets/<id>`). Иначе картинка открывалась
	// бы в приложении только как вложение, а ссылка в тексте вела бы в никуда
	// (относительный путь `картинки/схема.png` браузер искал бы от страницы проекта).
	Links []MarkdownLink

	// для импорта
	position int
	parent   int // индекс родителя в Events, -1 — корень
}

// MarkdownLink — ссылка из текста события и вложение, которым она стала.
type MarkdownLink struct {
	// Raw — цель ссылки ровно как написана в тексте: по ней текст и правится.
	Raw string
	// Attachment — индекс в ParsedMarkdown.Attachments.
	Attachment int
}

// MarkdownStats — счётчики отчёта (ровно те, что описаны в docs/import-export.md).
type MarkdownStats struct {
	Files      int `json:"files"`
	Events     int `json:"events"`
	Chars      int `json:"chars"`
	ImageLinks int `json:"image_links"`
	// Attachments — сколько файлов набора станут вложениями проекта.
	Attachments int `json:"attachments"`
	// AttachmentBytes — их суммарный вес ДО пережатия. Картинки станут легче, но
	// предупреждать о квоте надо по худшему случаю: обещать «поместится», а потом
	// отказать — хуже, чем сказать «может не поместиться».
	AttachmentBytes int64 `json:"attachment_bytes"`
	// MissingFiles — ссылки, для которых файла в наборе не нашлось.
	MissingFiles int `json:"missing_files"`
	// UnusedFiles — файлы набора, на которые никто не ссылается: в проект они не
	// попадают, но человеку полезно знать, что именно осталось за бортом.
	UnusedFiles int `json:"unused_files"`
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
	// QuotaBytes — предел вложений проекта (0 — без предела). Нужен интерфейсу,
	// чтобы предупредить ДО импорта: набор, который не помещается, отклоняется на
	// первом же файле, и лучше сказать об этом в предпросмотре, а не после.
	QuotaBytes int64 `json:"quota_bytes"`
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
	// attachments — не-md файлы набора: они становятся вложениями проекта, а
	// ссылки из текстов находят их по пути (см. markdown_attachments.go).
	attachments []*markdownAttachment
}

// Add принимает один файл. Ошибка означает превышение лимита — вызывающий обязан
// прервать разбор: молча потерять часть файлов хуже, чем отказать целиком.
func (c *markdownCollector) Add(path string, r io.Reader) error {
	if !isMarkdownPath(path) {
		// Не md — это не событие, но и не мусор: файл может стать вложением
		// проекта, если на него ссылается текст события.
		return c.addAttachment(path, r)
	}
	c.files++
	if c.files > markdownMaxFiles {
		return fmt.Errorf("%w: больше %d файлов", ErrMarkdownTooLarge, markdownMaxFiles)
	}

	// Читаем не больше лимита плюс один байт: так «слишком большой файл» виден и
	// тогда, когда размер заранее неизвестен (multipart).
	data, tooLarge, err := readLimited(r, markdownMaxFileSize)
	if err != nil {
		// Нечитаемый файл не должен ронять весь набор: предупреждаем и идём дальше.
		c.warnings = append(c.warnings, fmt.Sprintf("файл %s не прочитан: %v", path, err))
		c.files--
		return nil
	}
	if tooLarge {
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
// память целиком: читаем по одной записи и сразу отпускаем прочитанное. Не-md
// записи тоже читаются, но не как события: это вложения проекта (картинки и прочее,
// на что ссылаются тексты), поэтому у них свой предел размера.
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
		limit := int64(markdownMaxAttachmentSize)
		if isMarkdownPath(name) {
			limit = markdownMaxFileSize
		}
		if f.UncompressedSize64 > uint64(limit) {
			return nil, fmt.Errorf("%w: файл %s больше %d МБ", ErrMarkdownTooLarge, name, limit>>20)
		}
		entries = append(entries, entry{name: name, file: f})
	}
	mdFiles := 0
	for _, e := range entries {
		if isMarkdownPath(e.name) {
			mdFiles++
		}
	}
	if mdFiles > markdownMaxFiles {
		return nil, fmt.Errorf("%w: больше %d md-файлов", ErrMarkdownTooLarge, markdownMaxFiles)
	}

	c := &markdownCollector{stripRoot: singleRootDir(zr.File)}
	for _, e := range entries {
		rc, err := e.file.Open()
		if err != nil {
			c.warnings = append(c.warnings, fmt.Sprintf("файл %s не открылся: %v", e.name, err))
			if isMarkdownPath(e.name) {
				c.files++
			}
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
		path:      path,
		dir:       segments[:len(segments)-1],
		originDir: segments[:len(segments)-1],
		name:      name,
		num:       parseNumberPrefix(name),
		rawNum:    numberPrefixText(name),
		isIndex:   strings.EqualFold(name, "index"),
		lane:      strings.EqualFold(name, "story"),
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
	// Их цели собираем ДО срезания строк: это и есть вложения этого события.
	for _, target := range exportedImageTargets(body, item.rawNum) {
		item.refs = append(item.refs, markdownRef{raw: target})
	}
	body = stripExportedImages(body, item.rawNum)
	item.body = strings.TrimSpace(body)
	item.images = len(imageLinkRe.FindAllString(item.body, -1))
	// Ссылки из текста — тоже кандидаты во вложения: файл должен лежать в наборе,
	// тогда он приложится к этому событию, а сама ссылка станет адресом вложения.
	for _, target := range imageTargets(item.body) {
		item.refs = append(item.refs, markdownRef{raw: target, text: true})
	}
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
		// Вложения живут в той же системе координат, что и md-файлы: если корень
		// снят с файлов, он снят и с них, иначе ссылки не сойдутся.
		c.stripAttachmentRoot()
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
	// Вложения — после всех снятий корня и story/ (пути md-файлов и файлов набора
	// теперь в одной системе координат): ссылка из текста находит свой файл, и он
	// становится вложением ТОГО события, в чьём файле о нём написано.
	//
	// Прикладываются только те файлы, на которые есть ссылки: папка с историей
	// часто лежит рядом с чужими файлами (заметки, конфиги, черновики), и тащить их
	// все в проект — не то, о чём просил человек. О непригодившихся файлах скажем
	// отдельно, чтобы «картинка не доехала» не выяснялось постфактум.
	index := newAttachmentIndex(c.attachments)
	// attached — файл → его номер в parsed.Attachments; порядок — по первому
	// использованию, чтобы список вложений в проекте читался так же, как текст.
	attached := make(map[*markdownAttachment]int, len(c.attachments))
	// rejected — файлы, на которые сослались, но тип не поддерживается: они не
	// вложения и не «непригодившиеся» — про них уже сказано отдельно.
	rejected := make(map[*markdownAttachment]bool)
	var used []*markdownAttachment
	for _, it := range items {
		for _, ref := range it.refs {
			file := index.find(ref.raw, it)
			if file == nil {
				it.missing = append(it.missing, ref.raw)
				continue
			}
			if !assets.MimeAllowed(file.mime) {
				rejected[file] = true
				it.warnings = append(it.warnings, fmt.Sprintf(
					"файл %s не переносится: тип «%s» не поддерживается как вложение", file.path, file.mime))
				continue
			}
			at, ok := attached[file]
			if !ok {
				at = len(used)
				attached[file] = at
				used = append(used, file)
			}
			it.assets = appendUniqueInt(it.assets, at)
			// Ссылка из текста: запоминаем, чем её заменить (адрес вложения
			// появится, когда вложения получат идентификаторы при импорте).
			if ref.text {
				it.links = append(it.links, MarkdownLink{Raw: ref.raw, Attachment: at})
			}
		}
	}
	for _, file := range used {
		parsed.Attachments = append(parsed.Attachments, ParsedAttachment{
			Path: file.path,
			Name: file.name,
			Mime: file.mime,
			Kind: assets.KindOf(file.mime, file.name),
			Data: file.data,
		})
		// Вес набора до пережатия: картинки станут легче (WebP), но оценивать
		// «поместится ли в проект» надо по худшему случаю — иначе предупреждение
		// о квоте было бы оптимистичным.
		parsed.Stats.AttachmentBytes += int64(len(file.data))
	}
	parsed.Stats.Attachments = len(parsed.Attachments)
	parsed.Stats.UnusedFiles = len(c.attachments) - len(used) - len(rejected)
	if rootIndex != nil {
		parsed.ProjectTitle = rootIndex.title
		parsed.Description = rootIndex.body
	} else if projectItem != nil {
		parsed.ProjectTitle = projectItem.title
		parsed.Description = firstLine(projectItem.body)
	}
	for _, it := range items {
		parsed.Stats.ImageLinks += it.images
		// Ссылка без файла в наборе: либо картинка осталась в чужой папке, либо
		// это ссылка в интернет. Скачать её мы не можем и не пытаемся — говорим
		// человеку, что именно не переехало.
		parsed.Stats.MissingFiles += len(it.missing)
		for _, ref := range it.missing {
			if len(parsed.missingRefs) < maxReportedMisses {
				parsed.missingRefs = append(parsed.missingRefs, ref)
			}
		}
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
				Number:      num,
				Depth:       depth,
				Title:       n.item.title,
				Path:        n.item.path,
				Chars:       utf8.RuneCountInString(n.item.body),
				Warnings:    n.item.warnings,
				position:    i,
				parent:      parent,
				Body:        n.item.body,
				Date:        n.item.date,
				Attachments: n.item.assets,
				Links:       n.item.links,
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
	if parsed.Stats.MissingFiles > 0 {
		parsed.Warnings = append(parsed.Warnings, fmt.Sprintf(
			"не нашлось файлов для %d %s: %s — ссылки остались в тексте как есть",
			parsed.Stats.MissingFiles,
			russianPlural(parsed.Stats.MissingFiles, "ссылки", "ссылок", "ссылок"),
			strings.Join(parsed.missingRefs, ", ")))
	}
	if parsed.Stats.UnusedFiles > 0 {
		// Без глагола: «1 файл не пригодились» — так не говорят, а согласовывать
		// число с глаголом ради одной строки отчёта не стоит.
		parsed.Warnings = append(parsed.Warnings, fmt.Sprintf(
			"в проект не попали файлов: %d — на них нет ссылок в текстах событий",
			parsed.Stats.UnusedFiles))
	}
	return parsed, nil
}

// maxReportedMisses — сколько ненайденных ссылок показать в отчёте: остальные
// считаются в статистике, иначе список предупреждений превращался бы в полотно.
const maxReportedMisses = 3

// russianPlural подбирает форму слова по числу (1 ссылка, 2 ссылки, 5 ссылок).
func russianPlural(n int, one, few, many string) string {
	switch {
	case n%10 == 1 && n%100 != 11:
		return one
	case n%10 >= 2 && n%10 <= 4 && (n%100 < 10 || n%100 >= 20):
		return few
	default:
		return many
	}
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
// Два пути записи, и выбор между ними не про удобство:
//
//   - **без вложений** пишем только таблицу событий. Первый редактор засеет из неё
//     пустой документ — так проект и живёт дальше; так же работал импорт до сих пор;
//   - **с вложениями** собираем документ сразу (события + привязки файлов) и пишем
//     его снапшотом. Привязка «событие → вложения» существует ТОЛЬКО в CRDT
//     (таблица event_assets пуста с миграции 0002), поэтому засев из таблицы её бы
//     не принёс: картинки пришлось бы прикреплять руками заново.
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

	p, err := s.proj.Create(ctx, userID, title, parsed.Description)
	if err != nil {
		return nil, err
	}
	// Проект создаётся до записи содержимого, поэтому любую ошибку обязаны убрать
	// за собой: иначе у пользователя останется пустой проект и непонятная ошибка.
	if err := s.fillProject(ctx, p.ID, userID, parsed); err != nil {
		_ = s.store.DeleteProject(ctx, p.ID)
		return nil, err
	}
	return p, nil
}

// fillProject записывает содержимое импортированного проекта: строки событий или
// собранный документ (когда есть вложения) плюс сами файлы вложений.
//
// Если запись сорвалась, файлы убираем здесь же: вызывающий удалит строку проекта,
// а вместе с ней каскадом уйдут и строки вложений — после этого файлы уже никто не
// найдёт, и они остались бы в хранилище навсегда.
func (s *Service) fillProject(ctx context.Context, projectID, owner uuid.UUID, parsed *ParsedMarkdown) (err error) {
	// Вложения проекта: файлы набора — в хранилище, строки — в assets. Идентификаторы
	// нужны до сборки документа: на них ссылаются события.
	assetIDs, keys, err := s.storeAttachments(ctx, projectID, owner, parsed.Attachments)
	if err != nil {
		return err
	}
	defer func() {
		if err != nil {
			s.dropUnreferenced(ctx, keys)
		}
	}()

	if len(parsed.Attachments) > 0 {
		doc := yjs.NewDoc()
		if err := doc.InsertEvents(0, buildSeeds(parsed, assetIDs, nil)); err != nil {
			return err
		}
		if _, err := s.store.SaveProjectEventStateServer(ctx, projectID, owner, doc.EncodeState()); err != nil {
			return err
		}
		// Таблица событий — проекция документа (как и после любых правок): один
		// источник правды, а не две похожие записи.
		return s.projectDocument(ctx, projectID, owner, doc)
	}

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
			CreatedBy: &owner,
			UpdatedBy: &owner,
		})
	}
	return s.store.InsertEventTree(ctx, projectID, owner, rows)
}

// storeAttachments кладёт файлы набора в проект (в хранилище и в таблицу вложений).
// Возвращает идентификаторы в том же порядке, что и files (на них ссылаются события
// документа) и ключи записанных файлов (чтобы вызывающий мог убрать их, если запись
// проекта сорвётся).
func (s *Service) storeAttachments(
	ctx context.Context, projectID, owner uuid.UUID, files []ParsedAttachment,
) ([]uuid.UUID, []string, error) {
	if len(files) == 0 {
		return nil, nil, nil
	}
	if s.files == nil {
		// Так быть не должно: без этого пути файлы проекта писались бы мимо
		// дедупликации и без учёта общих файлов. Лучше явная ошибка, чем тихая
		// запись в обход.
		return nil, nil, errors.New("запись файлов проекта не подключена (transfer.UseFileStore)")
	}
	ids := make([]uuid.UUID, 0, len(files))
	written := make([]string, 0, len(files))
	for _, file := range files {
		asset, err := s.files.StoreFile(ctx, assets.StoreFileOptions{
			ProjectID: projectID,
			OwnerID:   owner,
			Filename:  file.Name,
			Mime:      file.Mime,
			Kind:      file.Kind,
			Data:      file.Data,
		})
		if err != nil {
			s.dropUnreferenced(ctx, written)
			return nil, nil, err
		}
		ids = append(ids, asset.ID)
		written = append(written, asset.S3Key)
	}
	return ids, written, nil
}

// dropUnreferenced убирает файлы, на которые больше не ссылается ни одна строка
// вложений. Вызывается после удаления строк (в том числе каскадом вместе с
// проектом): только тогда «сколько осталось ссылок» отвечает на вопрос «нужен ли
// файл ещё кому-нибудь» — после дедупликации одним файлом могут пользоваться
// несколько проектов.
func (s *Service) dropUnreferenced(ctx context.Context, keys []string) {
	if s.files == nil || len(keys) == 0 {
		return
	}
	_, _ = s.files.DeleteUnreferencedFiles(ctx, keys)
}

// dropObjects убирает файлы, вставленные ДО появления строк вложений: если запись
// сорвалась на первом же файле, строк нет, и «есть ли ещё ссылки» спрашивать не у
// кого — файлы точно наши.
func (s *Service) dropObjects(ctx context.Context, keys []string) {
	for _, key := range keys {
		_ = s.obj.Delete(ctx, key)
	}
}

// rewriteAssetLinks заменяет в тексте ссылки, для которых файл стал вложением
// проекта, на адрес вложения (`/api/assets/<id>`).
//
// Зачем. Текст события показывается в приложении как Markdown, а относительный путь
// из чужой папки (`картинки/схема.png`) браузер разрешает от страницы проекта — и
// картинка не открывается вовсе (404). Вложение при этом лежит в проекте, поэтому
// ссылка должна вести на него. Правило «не переписывать текст» остаётся для всего
// остального: правится ровно та ссылка, файл для которой нашёлся.
func rewriteAssetLinks(body string, links []MarkdownLink, assetIDs []uuid.UUID) string {
	if len(links) == 0 || len(assetIDs) == 0 {
		return body
	}
	// Идём по событию в обратном порядке: замены не пересекаются, но так их
	// результат не влияет на поиск следующей ссылки.
	for i := len(links) - 1; i >= 0; i-- {
		link := links[i]
		if link.Attachment < 0 || link.Attachment >= len(assetIDs) || link.Raw == "" {
			continue
		}
		body = strings.ReplaceAll(body, "]("+link.Raw+")", "](/api/assets/"+assetIDs[link.Attachment].String()+")")
	}
	return body
}

// buildSeeds собирает события куска для документа: id/parent_id/title/body/дата
// плюс вложения (идентификаторы файлов) и фон кадра. parentID — под какое событие
// подвесить корни куска (nil — верхний уровень).
//
// Вложения берутся из разбора индексами: один и тот же файл, на который ссылаются
// два события, загружается один раз и прикрепляется к обоим.
func buildSeeds(parsed *ParsedMarkdown, assetIDs []uuid.UUID, parentID *uuid.UUID) []yjs.EventSeed {
	seeds := make([]yjs.EventSeed, 0, len(parsed.Events))
	for _, e := range parsed.Events {
		seed := yjs.EventSeed{
			ID:    uuid.New().String(),
			Title: e.Title,
			Body:  rewriteAssetLinks(e.Body, e.Links, assetIDs),
		}
		switch {
		case e.parent >= 0 && e.parent < len(seeds):
			seed.ParentID = seeds[e.parent].ID
		case parentID != nil:
			seed.ParentID = parentID.String()
		}
		if e.Date != nil {
			seed.EventDate = e.Date.Format("2006-01-02")
		}
		for _, at := range e.Attachments {
			if at < 0 || at >= len(assetIDs) {
				continue
			}
			seed.Assets = append(seed.Assets, assetIDs[at].String())
		}
		// Фон кадра — первая картинка события: интерфейс ставит фоном первую
		// загруженную картинку, и импорт ведёт себя так же, иначе кадр остался бы
		// с унаследованным фоном, а картинка — просто в списке вложений.
		for _, at := range e.Attachments {
			if at < 0 || at >= len(parsed.Attachments) {
				continue
			}
			if strings.HasPrefix(parsed.Attachments[at].Mime, "image/") {
				seed.Background = assetIDs[at].String()
				break
			}
		}
		seeds = append(seeds, seed)
	}
	return seeds
}

// InsertPlace — место вставки куска в существующий проект: под какое событие
// положить его корень и между какими он встанет. Пустые поля — «верхний уровень»
// и «в конец»: так выглядит импорт, о месте которого не спрашивали.
type InsertPlace struct {
	ParentID *uuid.UUID
	AfterID  *uuid.UUID
	BeforeID *uuid.UUID
}

// yPlace переводит место в форму документа: идентификаторы события — строки,
// пустая строка означает «не задано».
func (p InsertPlace) yPlace() yjs.InsertPlace {
	out := yjs.InsertPlace{}
	if p.ParentID != nil {
		out.ParentID = p.ParentID.String()
	}
	if p.AfterID != nil {
		out.AfterID = p.AfterID.String()
	}
	if p.BeforeID != nil {
		out.BeforeID = p.BeforeID.String()
	}
	return out
}

// FileStore — запись файлов проекта (реализует assets.Service).
//
// Импорт обязан идти тем же путём, что и загрузка из интерфейса: иначе он обходил бы
// дедупликацию по содержимому стороной, и один и тот же файл лежал бы в хранилище
// дважды (миграция 0007). Проверку «нужен ли файл ещё кому-нибудь» тоже делает этот
// путь: после дедупликации одним файлом могут пользоваться несколько проектов.
type FileStore interface {
	StoreFile(ctx context.Context, opts assets.StoreFileOptions) (*store.Asset, error)
	DeleteUnreferencedFiles(ctx context.Context, keys []string) (int, error)
}

// UseFileStore подключает запись файлов проекта.
func (s *Service) UseFileStore(files FileStore) { s.files = files }

// QuotaSource — кто знает предел вложений проекта (реализует assets.Service).
type QuotaSource interface {
	Quota() int64
}

// UseQuota подключает источник предела вложений: предпросмотр показывает его
// человеку, чтобы тот заранее видел, поместится ли набор в проект.
func (s *Service) UseQuota(source QuotaSource) { s.quotaSource = source }

// QuotaBytes — предел вложений проекта (0 — без предела).
func (s *Service) QuotaBytes() int64 {
	if s.quotaSource == nil {
		return 0
	}
	return s.quotaSource.Quota()
}

// LiveDoc — документ ЖИВОЙ комнаты проекта (collab.Hub).
//
// Зачем это отдельный путь. Источник правды проекта — CRDT-документ, а пока в
// проекте кто-то редактирует, сервер держит его копию в памяти комнаты. Запись
// вставки только в снапшот базы была бы затёрта ближайшим сохранением комнаты
// (она кодирует СВОЙ документ), а редакторы не увидели бы кусок вообще. Поэтому
// импорт «в место» сначала спрашивает комнату — и только если её нет, пишет
// снапшот сам (вкладка без realtime, CLI, выключенный WebSocket).
//
// Интерфейс объявлен здесь, а реализует его хаб: так transfer не зависит от
// collab (иначе транспорт и импорт сцепились бы намертво). Исход вставки — словарь
// `yjs.InsertOutcome`, а не набор sentinel-ошибок: часть исходов ошибками не
// является (кусок не влез по глубине; документ комнаты ещё грузится).
type LiveDoc interface {
	InsertLive(ctx context.Context, projectID, by uuid.UUID, seeds []yjs.EventSeed, place yjs.InsertPlace) (yjs.InsertOutcome, error)
}

// UseLiveDoc подключает живые комнаты. Без него импорт «в место» работает только
// через снапшот базы — это корректно для проекта, который никто не открыл.
func (s *Service) UseLiveDoc(live LiveDoc) { s.live = live }

// ImportIntoResult — что вышло из вставки куска в существующий проект.
type ImportIntoResult struct {
	// Events — сколько событий вставлено.
	Events int
	// Warning — вставка сделана, но что-то на серверной стороне не доехало
	// (например, не сохранился снапшот или не перестроилась таблица событий).
	// Это не ошибка запроса: события уже в документе проекта, и повторный импорт
	// только задвоил бы кусок. Поэтому человеку это показывают предупреждением.
	Warning string
}

// ImportMarkdownInto вставляет разобранный кусок в СУЩЕСТВУЮЩИЙ проект.
//
// Чем это отличается от ImportMarkdown: тот создаёт новый проект и пишет только
// реляционную таблицу (первый редактор засеет из неё документ). Здесь проект уже
// живёт, и источник правды — его CRDT-документ, поэтому кусок вставляется именно
// в документ, а таблица событий перестраивается из него. Иначе вставленное было бы
// видно только в базе и исчезло бы у редакторов.
func (s *Service) ImportMarkdownInto(
	ctx context.Context, userID, projectID uuid.UUID, parsed *ParsedMarkdown, place InsertPlace,
) (ImportIntoResult, error) {
	if parsed == nil || len(parsed.Events) == 0 {
		return ImportIntoResult{}, ErrMarkdownEmpty
	}
	if err := s.proj.RequireEditor(ctx, userID, projectID); err != nil {
		// Ошибки проектов переводим в свои: обработчик отвечает по ним 403/404,
		// а не 500 (та же схема, что у выгрузки — loadStory).
		if errors.Is(err, projects.ErrForbidden) {
			return ImportIntoResult{}, ErrForbidden
		}
		return ImportIntoResult{}, err
	}

	// Вложения куска: файлы — в хранилище и в список вложений ПРОЕКТА (не куска),
	// идентификаторы — в события документа. Привязка «событие → вложения» живёт
	// только в CRDT, поэтому у проекта без снапшота и без живой комнаты картинки
	// доедут вместе с засевом документа из таблицы событий, а сам файл будет лежать
	// в проекте: его видно в списке вложений и можно прикрепить руками.
	assetIDs, assetKeys, err := s.storeAttachments(ctx, projectID, userID, parsed.Attachments)
	if err != nil {
		return ImportIntoResult{}, err
	}
	// Вложения нужны только вместе с событиями: если вставка не состоялась (отказ
	// по глубине, занятая комната, ошибка записи), файлы убираем вместе со строками
	// — иначе после отказа в проекте остались бы файлы, которых человек не
	// прикреплял, а повтор импорта добавил бы вторые такие же.
	inserted := false
	defer func() {
		if inserted || len(assetIDs) == 0 {
			return
		}
		for _, id := range assetIDs {
			_ = s.store.DeleteAsset(ctx, id)
		}
		s.dropUnreferenced(ctx, assetKeys)
	}()

	// Идентификаторы и связи куска: корень куска подвешивается к выбранному
	// событию, дети — друг к другу (порядок разбора гарантирует, что родитель уже
	// создан).
	seeds := buildSeeds(parsed, assetIDs, place.ParentID)
	chunkDepth := yjs.SeedDepth(seeds)

	// Живая комната — главный путь: в ней документ, который редакторы видят сейчас.
	// Глубину она проверяет сама, по своему документу (он может быть свежее базы).
	if s.live != nil {
		outcome, err := s.live.InsertLive(ctx, projectID, userID, seeds, place.yPlace())
		if err != nil {
			return ImportIntoResult{}, err
		}
		switch {
		case outcome.TooDeep:
			return ImportIntoResult{}, errTooDeep(chunkDepth)
		case outcome.RoomLoading:
			return ImportIntoResult{}, ErrMarkdownBusy
		case outcome.Handled:
			inserted = true
			return ImportIntoResult{Events: len(seeds), Warning: outcome.Warning}, nil
		}
	}

	state, err := s.store.GetProjectEventState(ctx, projectID)
	if err != nil {
		return ImportIntoResult{}, err
	}
	var raw []byte
	if state != nil {
		raw = state.YjsState
	}
	doc, err := yjs.FromState(raw)
	if err != nil {
		return ImportIntoResult{}, err
	}

	// У проекта может не быть снапшота (его создали через API или импортировали
	// архивом без CRDT): тогда документ собираем из реляционных строк, иначе
	// вставка потеряла бы уже существующее дерево.
	if doc.EventCount() == 0 {
		rows, err := s.store.ListEvents(ctx, projectID)
		if err != nil {
			return ImportIntoResult{}, err
		}
		legacy := make([]yjs.EventSeed, 0, len(rows))
		for _, row := range rows {
			seed := yjs.EventSeed{ID: row.ID.String(), Title: row.Title, Body: row.Body}
			if row.ParentID != nil {
				seed.ParentID = row.ParentID.String()
			}
			if row.EventDate != nil {
				seed.EventDate = row.EventDate.Format("2006-01-02")
			}
			legacy = append(legacy, seed)
		}
		if err := doc.SeedEvents(legacy); err != nil {
			return ImportIntoResult{}, err
		}
	}

	// Глубину проверяем ПОСЛЕ засева (иначе у проекта без снапшота родителя в
	// документе ещё нет и проверка была бы пустой) и ДО вставки: `NormalizeTree`
	// отвергает слишком глубокое дерево уже после неё, и проекция таблицы событий
	// осталась бы устаревшей.
	if !events.FitsDepth(doc.InsertMaxDepth(seeds)) {
		return ImportIntoResult{}, errTooDeep(chunkDepth)
	}

	if err := doc.InsertAt(place.yPlace(), seeds); err != nil {
		return ImportIntoResult{}, err
	}

	if _, err := s.store.SaveProjectEventStateServer(ctx, projectID, userID, doc.EncodeState()); err != nil {
		// Снапшот не записался — вставки нет нигде: повтор запроса безопасен.
		return ImportIntoResult{}, err
	}
	// Таблица событий перестраивается из документа целиком — ровно так же, как это
	// делает хаб после правок редакторов: один источник правды, одна проекция.
	// Её сбой вставку не отменяет (снапшот уже записан), поэтому это
	// предупреждение, а не ошибка: иначе человек повторил бы импорт и задвоил кусок.
	result := ImportIntoResult{Events: len(seeds)}
	if err := s.projectDocument(ctx, projectID, userID, doc); err != nil {
		result.Warning = fmt.Sprintf(
			"кусок вставлен в проект, но таблица событий не перестроена (%v) — она обновится при следующем сохранении", err)
	}
	// Вставка сделана: вложения остаются в проекте (даже если проекция отстала —
	// события уже в документе, а значит и привязки к файлам).
	inserted = true
	return result, nil
}

// errTooDeep — кусок не помещается в выбранное место: уровень места плюс глубина
// куска больше предела дерева.
func errTooDeep(chunkDepth int) error {
	return fmt.Errorf("%w: в куске %d уровень(ей), а глубже %d дерево не поддерживает",
		ErrMarkdownTooDeep, chunkDepth+1, events.MaxDepth)
}

// projectDocument переносит структуру документа в таблицу событий.
func (s *Service) projectDocument(ctx context.Context, projectID, userID uuid.UUID, doc *yjs.Doc) error {
	seeds := make([]events.EventSeed, 0, doc.EventCount())
	for _, e := range doc.Events() {
		seeds = append(seeds, events.EventSeed{
			ID:        e.ID,
			ParentID:  e.ParentID,
			Title:     e.Title,
			Body:      e.Body,
			EventDate: e.EventDate,
			Position:  e.Position,
		})
	}
	normalized, err := events.NormalizeTree(events.NodesFromSeeds(seeds))
	if err != nil {
		return err
	}
	rows := make([]store.Event, 0, len(normalized))
	for _, n := range normalized {
		rows = append(rows, store.Event{
			ID:        n.ID,
			ProjectID: projectID,
			ParentID:  n.ParentID,
			Position:  n.Position,
			Depth:     n.Depth,
			Title:     n.Title,
			Body:      n.Body,
			EventDate: n.EventDate.Value,
			// Дата пришла из документа: поле авторитетно, пустое — очищает дату.
			EventDateSet: true,
			CreatedBy:    &userID,
			UpdatedBy:    &userID,
		})
	}
	return s.store.ReplaceEventTree(ctx, projectID, userID, rows)
}
