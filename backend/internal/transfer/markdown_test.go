package transfer_test

// markdown_test.go — разбор папки с md: правила дерева, лимиты и защита от
// небезопасных имён. Без базы: разбор ничего не пишет, а именно в нём живёт
// основная логика импорта.

import (
	"archive/zip"
	"bytes"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"sort"
	"strings"
	"testing"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"

	"github.com/skyfraze/backend/internal/auth"
	"github.com/skyfraze/backend/internal/transfer"
)

// mdRoutesSecret — секрет для подписи токенов в тестах маршрутов (базы здесь нет:
// проверяем само дерево путей и то, что обработчик получает управление).
const mdRoutesSecret = "test-secret-please-change"

// parseFolder разбирает набор файлов как папку (путь → содержимое).
func parseFolder(t *testing.T, files map[string]string) (*transfer.ParsedMarkdown, error) {
	t.Helper()
	paths := make([]string, 0, len(files))
	for p := range files {
		paths = append(paths, p)
	}
	sort.Strings(paths)
	readers := make([]io.Reader, 0, len(paths))
	for _, p := range paths {
		readers = append(readers, strings.NewReader(files[p]))
	}
	return transfer.ParseMarkdownReaders(paths, readers)
}

// collectedTree — плоский снимок дерева для сравнения: номер, глубина, заголовок, тело.
type collectedTree struct {
	Number string
	Depth  int
	Title  string
	Path   string
	Body   string
}

func treeOf(parsed *transfer.ParsedMarkdown) []collectedTree {
	out := make([]collectedTree, 0, len(parsed.Events))
	for _, e := range parsed.Events {
		out = append(out, collectedTree{
			Number: e.Number, Depth: e.Depth, Title: e.Title, Path: e.Path, Body: e.Body,
		})
	}
	return out
}

// Каталог — уровень, index.md — событие каталога, номер из префикса имени,
// заголовок из front-matter/H1/имени, точка в номере задаёт вложенность.
func TestParseMarkdown_Tree(t *testing.T) {
	parsed, err := parseFolder(t, map[string]string{
		"Моя история/01-Пролог.md":           "---\ntitle: Пролог\n---\n\nТекст главы.\n",
		"Моя история/01.1-Первая встреча.md": "# Первая встреча\nВстреча состоялась.\n",
		"Моя история/02-Мир/index.md":        "# Мир\nОписание мира.\n",
		"Моя история/02-Мир/01-Города.md":    "# Города\nМного городов.\n",
		"Моя история/02-Мир/02-Магия.md":     "Магия без заголовка.\n",
		"Моя история/Эпилог.md":              "Конец.\n",
		"Моя история/заметки.txt":            "не md — игнорируется\n",
		"Моя история/assets/карта.png":       "бинарные данные не читаем\n",
		"Моя история/03-С ссылкой.md":        "# Со ссылкой\n![карта](карта.png)\n",
		"Моя история/04-Пустой.md":           "",
	})
	if err != nil {
		t.Fatalf("разбор: %v", err)
	}

	want := []collectedTree{
		{Number: "01", Depth: 0, Title: "Моя история", Path: "Моя история", Body: ""},
		{Number: "01.1", Depth: 1, Title: "Пролог", Path: "Моя история/01-Пролог.md", Body: "Текст главы."},
		{Number: "01.1.1", Depth: 2, Title: "Первая встреча", Path: "Моя история/01.1-Первая встреча.md", Body: "Встреча состоялась."},
		{Number: "01.2", Depth: 1, Title: "Мир", Path: "Моя история/02-Мир/index.md", Body: "Описание мира."},
		{Number: "01.2.1", Depth: 2, Title: "Города", Path: "Моя история/02-Мир/01-Города.md", Body: "Много городов."},
		{Number: "01.2.2", Depth: 2, Title: "Магия", Path: "Моя история/02-Мир/02-Магия.md", Body: "Магия без заголовка."},
		{Number: "01.3", Depth: 1, Title: "Со ссылкой", Path: "Моя история/03-С ссылкой.md", Body: "![карта](карта.png)"},
		{Number: "01.4", Depth: 1, Title: "Пустой", Path: "Моя история/04-Пустой.md", Body: ""},
		// Файл без номера уходит в конец уровня, номер выдаётся подряд.
		{Number: "01.5", Depth: 1, Title: "Эпилог", Path: "Моя история/Эпилог.md", Body: "Конец."},
	}
	got := treeOf(parsed)
	if len(got) != len(want) {
		t.Fatalf("событий %d, ожидалось %d:\n%+v", len(got), len(want), got)
	}
	for i := range want {
		if got[i] != want[i] {
			t.Errorf("событие #%d:\n получено %+v\n ожидалось %+v", i, got[i], want[i])
		}
	}

	// Заголовок проекта из разбора пуст (корневого index.md нет), поэтому название
	// возьмётся из имени корневой папки — оно же запасной вариант в ImportMarkdown.
	if parsed.ProjectTitle != "" || parsed.RootFolder != "Моя история" {
		t.Errorf("название проекта: title=%q root=%q", parsed.ProjectTitle, parsed.RootFolder)
	}
	// files — прочитанные md-файлы (включая index.md), events — узлы дерева:
	// каталог без index.md добавляет событие, не добавляя файла.
	if parsed.Stats.Files != 8 || parsed.Stats.Events != 9 {
		t.Errorf("счётчики: %+v", parsed.Stats)
	}
	if parsed.Stats.ImageLinks != 1 {
		t.Errorf("ссылок на картинки: %d, ожидалось 1", parsed.Stats.ImageLinks)
	}
	// Файл `assets/карта.png` нашёлся по ссылке `![карта](карта.png)` (совпадение по
	// имени: такой файл в наборе один) и стал вложением своего события.
	if parsed.Stats.Attachments != 1 || len(parsed.Attachments) != 1 {
		t.Fatalf("вложений %d: %+v", parsed.Stats.Attachments, parsed.Attachments)
	}
	if parsed.Attachments[0].Name != "карта.png" || parsed.Attachments[0].Kind != "image" {
		t.Errorf("вложение: %+v", parsed.Attachments[0])
	}
	if parsed.Stats.MissingFiles != 0 {
		t.Errorf("ненайденных ссылок: %d", parsed.Stats.MissingFiles)
	}
	// `заметки.txt` — не md и никто на него не ссылается: в проект он не попадает,
	// но об этом честно сказано.
	if parsed.Stats.UnusedFiles != 1 {
		t.Errorf("непригодившихся файлов: %d, ожидался 1", parsed.Stats.UnusedFiles)
	}
	if !hasWarning(parsed.Warnings, "в проект не попали файлов: 1") {
		t.Errorf("нет предупреждения о непригодившихся файлах: %v", parsed.Warnings)
	}
	if !hasWarning(parsed.Warnings, "пуст — событие без текста") {
		t.Errorf("нет предупреждения про пустой файл: %v", parsed.Warnings)
	}
	// Ссылка нашла файл — значит, «картинки не переносятся» больше не говорим.
	if hasWarning(parsed.Warnings, "картинки не переносятся") {
		t.Errorf("устаревшее предупреждение о картинках: %v", parsed.Warnings)
	}
}

// Вложения при импорте: файлы набора становятся вложениями ТОГО события, в чьём
// файле о них написано. Правило не «искать ссылки» и не «переписать текст», а
// «приложить найденный файл»: текст события остаётся как есть.
func TestParseMarkdown_AttachesReferencedFiles(t *testing.T) {
	parsed, err := parseFolder(t, map[string]string{
		// Строки картинок, приписанные выгрузкой своему событию.
		"01-Глава.md":         "---\ntitle: Глава\n---\n\nТекст главы.\n![01·1](assets/01-схема.png)\n![01·2](assets/02-старт.png)\n",
		"02-Вторая.md":        "# Вторая\nТекст второй главы.\n![02·1](assets/01-схема.png)\n",
		"03-Своя.md":          "# Своя\nВот схема: ![моя](картинки/моё.png)\n",
		"04-Пропавшая.md":     "# Пропавшая\n![нет](картинки/нет.png)\n",
		"05-Архив.md":         "# Архив\n![архив](вложения/данные.zip)\n",
		"assets/01-схема.png": "PNG-схема",
		"assets/02-старт.png": "PNG-старт",
		"картинки/моё.png":    "PNG-моё",
		"вложения/данные.zip": "PK",
		"manifest.json":       "{}",
		"README.txt":          "служебный",
		".DS_Store":           "мусор",
		"заметки.txt":         "заметки на полях",
	})
	if err != nil {
		t.Fatalf("разбор: %v", err)
	}

	// Три файла пригодились (схема, старт, «моё»), архив с zip не поддерживается,
	// ссылка на «нет.png» не нашлась, служебные файлы и мусор не считаются.
	if parsed.Stats.Attachments != 3 {
		t.Fatalf("вложений %d, ожидалось 3: %+v", parsed.Stats.Attachments, parsed.Attachments)
	}
	if parsed.Stats.MissingFiles != 1 {
		t.Errorf("ненайденных ссылок %d, ожидалась 1", parsed.Stats.MissingFiles)
	}
	// «заметки.txt» лежат рядом, но ссылок на них нет: в проект они не попадают.
	// Служебные файлы, скрытые и zip (на него ссылались, но такой тип не
	// поддерживается) в этот счётчик не входят.
	if parsed.Stats.UnusedFiles != 1 {
		t.Errorf("непригодившихся файлов %d, ожидался 1 (заметки.txt)", parsed.Stats.UnusedFiles)
	}
	if !hasWarning(parsed.Warnings, "в проект не попали файлов: 1") {
		t.Errorf("нет предупреждения о непригодившихся файлах: %v", parsed.Warnings)
	}
	names := make([]string, 0, len(parsed.Attachments))
	for _, a := range parsed.Attachments {
		names = append(names, a.Name)
	}
	if strings.Join(names, ",") != "01-схема.png,02-старт.png,моё.png" {
		t.Errorf("состав вложений: %v", names)
	}

	byPath := map[string]transfer.ParsedMarkdownEvent{}
	for _, e := range parsed.Events {
		byPath[e.Path] = e
	}
	// Наша выгрузка: обе строки картинок стали вложениями своего события, и в теле
	// их не осталось (иначе при выгрузке картинка задвоилась бы).
	chapter := byPath["01-Глава.md"]
	if len(chapter.Attachments) != 2 || chapter.Attachments[0] != 0 || chapter.Attachments[1] != 1 {
		t.Errorf("вложения главы: %+v", chapter.Attachments)
	}
	if strings.Contains(chapter.Body, "![") {
		t.Errorf("в теле остались строки картинок: %q", chapter.Body)
	}
	// Один файл, на который ссылаются два события, загружается один раз.
	if second := byPath["02-Вторая.md"]; len(second.Attachments) != 1 || second.Attachments[0] != 0 {
		t.Errorf("вложения второй главы: %+v", second.Attachments)
	}
	// Ссылка из текста: файл лежит в подкаталоге, и ссылка ведёт на вложение проекта
	// (после импорта), а не в никуда — в тексте она заменяется адресом `/api/assets/…`.
	own := byPath["03-Своя.md"]
	if len(own.Attachments) != 1 || own.Attachments[0] != 2 {
		t.Errorf("вложения «Своей»: %+v", own.Attachments)
	}
	if !strings.Contains(own.Body, "![моя](картинки/моё.png)") {
		t.Errorf("до импорта ссылка в тексте остаётся как написана: %q", own.Body)
	}
	if len(own.Links) != 1 || own.Links[0].Raw != "картинки/моё.png" || own.Links[0].Attachment != 2 {
		t.Errorf("ссылка для замены на адрес вложения: %+v", own.Links)
	}
	if missing := byPath["04-Пропавшая.md"]; len(missing.Attachments) != 0 {
		t.Errorf("у «Пропавшей» не должно быть вложений: %+v", missing.Attachments)
	}
	if archive := byPath["05-Архив.md"]; len(archive.Attachments) != 0 {
		t.Errorf("zip не должен становиться вложением: %+v", archive.Attachments)
	}
	if !hasWarning(parsed.Warnings, "не нашлось файлов для 1 ссылки: картинки/нет.png") {
		t.Errorf("нет предупреждения о ненайденной ссылке: %v", parsed.Warnings)
	}
	if !hasWarning(parsed.Events[4].Warnings, "не поддерживается как вложение") {
		t.Errorf("нет предупреждения о типе вложения: %+v", parsed.Events[4].Warnings)
	}
}

// Архив с одним корневым каталогом: корень снимается и с вложений, иначе ссылка
// `картинки/схема.png` из `01-Глава.md` не нашла бы `Моя история/картинки/схема.png`.
func TestParseMarkdownZip_StripsRootForAttachments(t *testing.T) {
	var buf bytes.Buffer
	zw := zip.NewWriter(&buf)
	writeFile(t, zw, "Моя история/01-Глава.md", []byte("# Глава\n![схема](картинки/схема.png)\n"))
	writeFile(t, zw, "Моя история/картинки/схема.png", []byte("PNG"))
	closeZip(t, zw)

	parsed, err := transfer.ParseMarkdownZip(bytes.NewReader(buf.Bytes()), int64(buf.Len()))
	if err != nil {
		t.Fatalf("разбор архива: %v", err)
	}
	if parsed.Stats.Attachments != 1 {
		t.Fatalf("вложений %d: %+v", parsed.Stats.Attachments, parsed.Attachments)
	}
	if parsed.Attachments[0].Path != "картинки/схема.png" {
		t.Errorf("путь вложения после снятия корня: %q", parsed.Attachments[0].Path)
	}
	if len(parsed.Events) != 1 || len(parsed.Events[0].Attachments) != 1 {
		t.Fatalf("событие без вложения: %+v", parsed.Events)
	}
}

// index.md без каталога описывает проект, а не событие.
func TestParseMarkdown_RootIndexIsProject(t *testing.T) {
	parsed, err := parseFolder(t, map[string]string{
		"index.md":     "# Моя сага\nИстория одной станции.\n",
		"01-Начало.md": "# Начало\nТекст.\n",
	})
	if err != nil {
		t.Fatalf("разбор: %v", err)
	}
	if parsed.ProjectTitle != "Моя сага" || parsed.Description != "История одной станции." {
		t.Errorf("проект: title=%q desc=%q", parsed.ProjectTitle, parsed.Description)
	}
	if len(parsed.Events) != 1 || parsed.Events[0].Title != "Начало" || parsed.Events[0].Number != "01" {
		t.Errorf("дерево: %+v", treeOf(parsed))
	}
}

// front-matter: date переносится, bg — нет (фон живёт только в CRDT).
func TestParseMarkdown_FrontMatter(t *testing.T) {
	parsed, err := parseFolder(t, map[string]string{
		"01-Пролог.md": "---\ntitle: \"Пролог\"\ndate: 2024-05-17\nbg: \"tone:#8FB98A\"\n---\n\nТекст.\n",
	})
	if err != nil {
		t.Fatalf("разбор: %v", err)
	}
	if len(parsed.Events) != 1 {
		t.Fatalf("событий: %d", len(parsed.Events))
	}
	e := parsed.Events[0]
	if e.Title != "Пролог" || e.Body != "Текст." {
		t.Errorf("событие: %+v", e)
	}
	if e.Date == nil || e.Date.Format("2006-01-02") != "2024-05-17" {
		t.Errorf("дата: %v", e.Date)
	}
	if !hasWarning(parsed.Warnings, "настройка фона") {
		t.Errorf("нет предупреждения про bg: %v", parsed.Warnings)
	}
	// А про дату предупреждать больше не о чем: засев CRDT теперь несёт
	// event_date, поэтому дата видна первому редактору и попадает в кадр.
	if hasWarning(parsed.Warnings, "CRDT-засев") {
		t.Errorf("устаревшее предупреждение про дату и CRDT: %v", parsed.Warnings)
	}
}

// Заголовок из front-matter, а `# H1` в файле остался: так пишет наша выгрузка,
// и строку H1 надо убрать — иначе в приложении заголовок и тот же текст в теле.
// Убираем только совпадающий H1: чужой заголовок в тексте — часть текста.
func TestParseMarkdown_FrontMatterTitleDropsOwnHeadline(t *testing.T) {
	parsed, err := parseFolder(t, map[string]string{
		"01-Пролог.md": "---\ntitle: Пролог\n---\n\n" +
			"<!-- skyfraze: number=01 id=x kind=event -->\n# 01 Пролог\nТекст главы.\n",
		"02-Мир.md":    "---\ntitle: Мир\n---\n\n# Мир\nОписание мира.\n",
		"03-Другой.md": "---\ntitle: Заголовок\n---\n\n# Другой заголовок\nТекст.\n",
		"04-Дефис.md":  "---\ntitle: - С минусом\n---\n\n# 04 - С минусом\nТекст.\n",
	})
	if err != nil {
		t.Fatalf("разбор: %v", err)
	}
	want := []collectedTree{
		{Number: "01", Depth: 0, Title: "Пролог", Path: "01-Пролог.md", Body: "Текст главы."},
		{Number: "02", Depth: 0, Title: "Мир", Path: "02-Мир.md", Body: "Описание мира."},
		{Number: "03", Depth: 0, Title: "Заголовок", Path: "03-Другой.md", Body: "# Другой заголовок\nТекст."},
		{Number: "04", Depth: 0, Title: "- С минусом", Path: "04-Дефис.md", Body: "Текст."},
	}
	got := treeOf(parsed)
	if len(got) != len(want) {
		t.Fatalf("событий %d, ожидалось %d: %+v", len(got), len(want), got)
	}
	for i := range want {
		if got[i] != want[i] {
			t.Errorf("событие #%d:\n получено %+v\n ожидалось %+v", i, got[i], want[i])
		}
	}
}

// Front-matter в кавычках: так выгрузка пишет заголовки со служебными символами
// (`:`, кавычки, `#`, обратный слэш) — импорт обязан вернуть их ровно теми же,
// без кавычек и без экранирующих слэшей.
func TestParseMarkdown_FrontMatterQuotedValue(t *testing.T) {
	parsed, err := parseFolder(t, map[string]string{
		"01-Сборка.md": "---\ntitle: \"Сборка: «Прометей-7» \\\"старт\\\"\"\ndate: \"2026-01-15\"\n---\n\nТекст.\n",
		"02-Путь.md":   "---\ntitle: \"C:\\\\верфь\"\n---\n\nТекст.\n",
	})
	if err != nil {
		t.Fatalf("разбор: %v", err)
	}
	want := []collectedTree{
		{Number: "01", Depth: 0, Title: `Сборка: «Прометей-7» "старт"`, Path: "01-Сборка.md", Body: "Текст."},
		{Number: "02", Depth: 0, Title: `C:\верфь`, Path: "02-Путь.md", Body: "Текст."},
	}
	got := treeOf(parsed)
	if len(got) != len(want) {
		t.Fatalf("событий %d, ожидалось %d: %+v", len(got), len(want), got)
	}
	for i := range want {
		if got[i] != want[i] {
			t.Errorf("событие #%d:\n получено %+v\n ожидалось %+v", i, got[i], want[i])
		}
	}
	if d := parsed.Events[0].Date; d == nil || d.Format("2006-01-02") != "2026-01-15" {
		t.Errorf("дата в кавычках не разобралась: %v", parsed.Events[0].Date)
	}
}

// Глубже четырёх уровней приложение не умеет: файл не берём и предупреждаем
// (не молчаливое обрезание).
func TestParseMarkdown_DepthLimit(t *testing.T) {
	parsed, err := parseFolder(t, map[string]string{
		// Каталоги: Глава(0) → Под(1) → Шаг(2) → Ещё(3) → Слишком(4), файл в
		// «Слишком» оказался бы на пятом уровне — его не берём.
		"01-Глава/01-Под/01-Шаг/01-Ещё/01-Верх.md":            "# Верх\n",
		"01-Глава/01-Под/01-Шаг/01-Ещё/01-Слишком/01-Файл.md": "# Файл\n",
	})
	if err != nil {
		t.Fatalf("разбор: %v", err)
	}
	for _, e := range parsed.Events {
		if e.Depth > 4 {
			t.Errorf("событие глубже максимума попало в дерево: %+v", e)
		}
	}
	if !hasWarning(parsed.Warnings, "не взят: глубина") ||
		!hasWarning(parsed.Warnings, "01-Файл.md") {
		t.Errorf("нет предупреждения про глубину: %v", parsed.Warnings)
	}
}

// Наш собственный архив выгрузки: story.md — сводная лента, дерево берём из story/.
func TestParseMarkdownZip_OwnExportLayout(t *testing.T) {
	var buf bytes.Buffer
	zw := zip.NewWriter(&buf)
	writeFile(t, zw, "story.md", []byte("# Сага\nОписание саги.\n\n<!-- skyfraze: number=01 id=x kind=event -->\n## 01 Пролог\nТекст.\n"))
	writeFile(t, zw, "story/01-Пролог.md", []byte("<!-- skyfraze: number=01 id=x kind=event -->\n# 01 Пролог\nТекст.\n"))
	writeFile(t, zw, "story/01.1-Под.md", []byte("<!-- skyfraze: number=01.1 id=y kind=event -->\n# 01.1 Под\nПод-текст.\n"))
	writeFile(t, zw, "manifest.json", []byte(`{"format":"skyfraze-project","version":1}`))
	writeFile(t, zw, "README.txt", []byte("что это за архив\n"))
	closeZip(t, zw)

	parsed, err := transfer.ParseMarkdownZip(bytes.NewReader(buf.Bytes()), int64(buf.Len()))
	if err != nil {
		t.Fatalf("разбор архива: %v", err)
	}
	// Сводную ленту не разбираем как событие, иначе в проекте появилась бы глава
	// со всей историей внутри; название проекта берём из неё.
	if parsed.ProjectTitle != "Сага" || parsed.Description != "Описание саги." {
		t.Errorf("проект: title=%q desc=%q", parsed.ProjectTitle, parsed.Description)
	}
	want := []collectedTree{
		{Number: "01", Depth: 0, Title: "Пролог", Path: "01-Пролог.md", Body: "Текст."},
		{Number: "01.1", Depth: 1, Title: "Под", Path: "01.1-Под.md", Body: "Под-текст."},
	}
	got := treeOf(parsed)
	if len(got) != len(want) {
		t.Fatalf("событий %d, ожидалось %d: %+v", len(got), len(want), got)
	}
	for i := range want {
		if got[i] != want[i] {
			t.Errorf("событие #%d: получено %+v, ожидалось %+v", i, got[i], want[i])
		}
	}
	if !hasWarning(parsed.Warnings, "story.md пропущен") {
		t.Errorf("нет предупреждения про story.md: %v", parsed.Warnings)
	}
}

// Защита: битый архив, zip-slip, огромный файл, пустой набор.
func TestParseMarkdown_Guards(t *testing.T) {
	junk := []byte("это не zip")
	if _, err := transfer.ParseMarkdownZip(bytes.NewReader(junk), int64(len(junk))); !errors.Is(err, transfer.ErrMarkdownBadZip) {
		t.Errorf("мусор вместо архива: %v", err)
	}

	var slip bytes.Buffer
	zw := zip.NewWriter(&slip)
	writeFile(t, zw, "../секрет.md", []byte("# Секрет\n"))
	closeZip(t, zw)
	if _, err := transfer.ParseMarkdownZip(bytes.NewReader(slip.Bytes()), int64(slip.Len())); !errors.Is(err, transfer.ErrMarkdownUnsafePath) {
		t.Errorf("путь с .. должен отклоняться: %v", err)
	}

	var absolute bytes.Buffer
	zw = zip.NewWriter(&absolute)
	writeFile(t, zw, "/etc/passwd.md", []byte("# Нет\n"))
	closeZip(t, zw)
	if _, err := transfer.ParseMarkdownZip(bytes.NewReader(absolute.Bytes()), int64(absolute.Len())); !errors.Is(err, transfer.ErrMarkdownUnsafePath) {
		t.Errorf("абсолютный путь должен отклоняться: %v", err)
	}

	// Файл больше 4 МБ: лимит проверяется до чтения, поэтому в архив кладём
	// ровно на байт больше (нули жмутся почти в ноль).
	var huge bytes.Buffer
	zw = zip.NewWriter(&huge)
	big := bytes.Repeat([]byte("a"), (4<<20)+1)
	writeFile(t, zw, "01-Большой.md", big)
	closeZip(t, zw)
	if _, err := transfer.ParseMarkdownZip(bytes.NewReader(huge.Bytes()), int64(huge.Len())); !errors.Is(err, transfer.ErrMarkdownTooLarge) {
		t.Errorf("файл больше 4 МБ должен отклоняться: %v", err)
	}

	// Пустой набор и набор без md-файлов.
	if _, err := transfer.ParseMarkdownReaders(nil, nil); !errors.Is(err, transfer.ErrMarkdownEmpty) {
		t.Errorf("пустой набор: %v", err)
	}
	if _, err := parseFolder(t, map[string]string{"заметки.txt": "нет md"}); !errors.Is(err, transfer.ErrMarkdownEmpty) {
		t.Errorf("набор без md: %v", err)
	}
}

// Многоточие в пути внутри набора (multipart) тоже отбиваем: правило одно и то же
// для папки и для архива.
func TestParseMarkdown_UnsafeGivenPath(t *testing.T) {
	_, err := transfer.ParseMarkdownReaders([]string{"../снаружи.md"}, []io.Reader{strings.NewReader("# Нет\n")})
	if !errors.Is(err, transfer.ErrMarkdownUnsafePath) {
		t.Errorf("путь с .. должен отклоняться: %v", err)
	}
}

// Имя части multipart — относительный путь: Go срезает каталоги в FileName(),
// поэтому вложенность обязана читаться из сырого Content-Disposition. Без этого
// папка «Глава 01/01-Пролог.md» схлопнулась бы в один уровень.
func TestPreviewHTTP_MultipartKeepsRelativePath(t *testing.T) {
	var body bytes.Buffer
	mw := multipart.NewWriter(&body)
	part, err := mw.CreateFormFile("files", "Глава 01/01-Пролог.md")
	if err != nil {
		t.Fatalf("multipart: %v", err)
	}
	if _, err := part.Write([]byte("# Пролог\nТекст главы.\n")); err != nil {
		t.Fatalf("multipart write: %v", err)
	}
	if err := mw.Close(); err != nil {
		t.Fatalf("multipart close: %v", err)
	}

	rec := doPreview(t, body.Bytes(), mw.FormDataContentType())
	if rec.Code != http.StatusOK {
		t.Fatalf("код %d, тело %s", rec.Code, rec.Body.String())
	}
	var got struct {
		ProjectTitle string `json:"project_title"`
		Events       []struct {
			Number string `json:"number"`
			Depth  int    `json:"depth"`
			Title  string `json:"title"`
			Path   string `json:"path"`
		} `json:"events"`
		Stats struct {
			Files  int `json:"files"`
			Events int `json:"events"`
		} `json:"stats"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &got); err != nil {
		t.Fatalf("json: %v (%s)", err, rec.Body.String())
	}
	if len(got.Events) != 2 {
		t.Fatalf("событий %d, ожидалось 2: %s", len(got.Events), rec.Body.String())
	}
	if got.Events[0].Depth != 0 || got.Events[0].Title != "Глава 01" || got.Events[0].Number != "01" {
		t.Errorf("каталог не стал уровнем: %+v", got.Events[0])
	}
	if got.Events[1].Depth != 1 || got.Events[1].Title != "Пролог" || got.Events[1].Path != "Глава 01/01-Пролог.md" {
		t.Errorf("файл потерял вложенность: %+v", got.Events[1])
	}
	if got.Stats.Files != 1 || got.Stats.Events != 2 {
		t.Errorf("счётчики: %+v", got.Stats)
	}
}

// «Архив с одной папкой» — обёртку снимаем, а структуру проекта в корне — нет.
// Правило только для zip: при загрузке папки корень срезает фронтенд, иначе
// серверу пришлось бы угадывать, папка это или глава.
func TestParseMarkdownZip_SingleRootFolder(t *testing.T) {
	var wrapped bytes.Buffer
	zw := zip.NewWriter(&wrapped)
	// Явная запись каталога тоже встречается в архивах (её пишут многие
	// упаковщики) и не должна ломать правило «zip с одной папкой».
	if _, err := zw.Create("Моя история/"); err != nil {
		t.Fatalf("zip create dir: %v", err)
	}
	writeFile(t, zw, "Моя история/01-Пролог.md", []byte("# Пролог\nТекст главы.\n"))
	writeFile(t, zw, "Моя история/assets/карта.png", []byte("не md\n"))
	closeZip(t, zw)

	parsed, err := transfer.ParseMarkdownZip(bytes.NewReader(wrapped.Bytes()), int64(wrapped.Len()))
	if err != nil {
		t.Fatalf("разбор: %v", err)
	}
	got := treeOf(parsed)
	want := []collectedTree{{Number: "01", Depth: 0, Title: "Пролог", Path: "01-Пролог.md", Body: "Текст главы."}}
	if len(got) != len(want) || got[0] != want[0] {
		t.Errorf("обёртку не сняли: %+v", got)
	}
	if parsed.RootFolder != "Моя история" {
		t.Errorf("имя корневой папки потерялось: %q", parsed.RootFolder)
	}

	// В корне есть файлы — значит это структура проекта, корень не трогаем.
	var flat bytes.Buffer
	zw = zip.NewWriter(&flat)
	writeFile(t, zw, "01-Пролог.md", []byte("# Пролог\nТекст главы.\n"))
	writeFile(t, zw, "02-Мир/index.md", []byte("# Мир\nОписание мира.\n"))
	writeFile(t, zw, "02-Мир/01-Города.md", []byte("# Города\nМного городов.\n"))
	closeZip(t, zw)
	parsed, err = transfer.ParseMarkdownZip(bytes.NewReader(flat.Bytes()), int64(flat.Len()))
	if err != nil {
		t.Fatalf("разбор: %v", err)
	}
	got = treeOf(parsed)
	want = []collectedTree{
		{Number: "01", Depth: 0, Title: "Пролог", Path: "01-Пролог.md", Body: "Текст главы."},
		{Number: "02", Depth: 0, Title: "Мир", Path: "02-Мир/index.md", Body: "Описание мира."},
		{Number: "02.1", Depth: 1, Title: "Города", Path: "02-Мир/01-Города.md", Body: "Много городов."},
	}
	if len(got) != len(want) {
		t.Fatalf("событий %d, ожидалось %d: %+v", len(got), len(want), got)
	}
	for i := range want {
		if got[i] != want[i] {
			t.Errorf("событие #%d: получено %+v, ожидалось %+v", i, got[i], want[i])
		}
	}

	// Те же пути, но папкой (multipart): корень остаётся уровнем — его срезает
	// фронтенд, сервер не угадывает.
	folder, err := parseFolder(t, map[string]string{
		"Моя история/01-Пролог.md": "# Пролог\nТекст главы.\n",
	})
	if err != nil {
		t.Fatalf("разбор папки: %v", err)
	}
	if folder.RootFolder != "Моя история" || len(folder.Events) != 2 || folder.Events[0].Title != "Моя история" {
		t.Errorf("папку сервер не должен разворачивать: %+v", treeOf(folder))
	}
}

// Предпросмотр и импорт живут на статических путях под /api/projects/import, а
// выгрузка Markdown — рядом с /export. Проверяем дерево маршрутов на настоящем
// chi: статический сегмент не должен перехватываться параметрическим {id}, а
// /export не должен съедать /export.md.
func TestMarkdownRoutes(t *testing.T) {
	r := chi.NewRouter()
	authSvc := auth.New(nil, mdRoutesSecret)
	h := transfer.NewHandler(nil, slog.New(slog.NewTextHandler(io.Discard, nil)))
	const pid = "11111111-1111-4111-8111-111111111111"
	r.With(authSvc.WithUser).Post("/api/projects/import", h.Import)
	r.With(authSvc.WithUser).Post("/api/projects/import/markdown", h.MarkdownImport)
	r.With(authSvc.WithUser).Post("/api/projects/import/markdown/preview", h.MarkdownPreview)
	r.Route("/api/projects/{id}", func(r chi.Router) {
		r.Use(authSvc.WithUser)
		r.Get("/export", h.Export)
		r.Get("/export.md", h.ExportMarkdown)
	})

	token, err := auth.IssueAccess(mdRoutesSecret, uuid.New())
	if err != nil {
		t.Fatalf("token: %v", err)
	}
	do := func(method, path string, withToken bool) *httptest.ResponseRecorder {
		t.Helper()
		req := httptest.NewRequest(method, path, nil)
		if withToken {
			req.Header.Set("Authorization", "Bearer "+token)
		}
		rec := httptest.NewRecorder()
		r.ServeHTTP(rec, req)
		return rec
	}

	// Без токена — 401 (middleware маршрута жива), а не 404.
	for _, path := range []string{
		"/api/projects/import/markdown",
		"/api/projects/import/markdown/preview",
		"/api/projects/" + pid + "/export",
		"/api/projects/" + pid + "/export.md",
	} {
		method := http.MethodPost
		if strings.Contains(path, "/export") {
			method = http.MethodGet
		}
		if rec := do(method, path, false); rec.Code != http.StatusUnauthorized {
			t.Errorf("%s %s без токена: код %d, ожидался 401", method, path, rec.Code)
		}
	}

	// С токеном обработчик получает управление: до сервиса дело не доходит, но
	// 400 «invalid project id» доказывает, что маршрут выбран именно этот
	// (несовпавший путь дал бы 404, а /export вместо /export.md — тоже).
	for _, path := range []string{"/api/projects/not-a-uuid/export", "/api/projects/not-a-uuid/export.md"} {
		rec := do(http.MethodGet, path, true)
		if rec.Code != http.StatusBadRequest || !strings.Contains(rec.Body.String(), "invalid project id") {
			t.Errorf("GET %s: код %d, тело %s", path, rec.Code, rec.Body.String())
		}
	}

	// Импорт без multipart — 400 с объяснением, то есть тоже дошёл до обработчика.
	for _, path := range []string{
		"/api/projects/import",
		"/api/projects/import/markdown",
		"/api/projects/import/markdown/preview",
	} {
		rec := do(http.MethodPost, path, true)
		if rec.Code != http.StatusBadRequest {
			t.Errorf("POST %s: код %d, тело %s", path, rec.Code, rec.Body.String())
		}
	}
}

// ---------- вспомогательное ----------

func doPreview(t *testing.T, body []byte, contentType string) *httptest.ResponseRecorder {
	t.Helper()
	r := chi.NewRouter()
	authSvc := auth.New(nil, mdRoutesSecret)
	h := transfer.NewHandler(nil, slog.New(slog.NewTextHandler(io.Discard, nil)))
	r.With(authSvc.WithUser).Post("/api/projects/import/markdown/preview", h.MarkdownPreview)

	token, err := auth.IssueAccess(mdRoutesSecret, uuid.New())
	if err != nil {
		t.Fatalf("token: %v", err)
	}
	req := httptest.NewRequest(http.MethodPost, "/api/projects/import/markdown/preview", bytes.NewReader(body))
	req.Header.Set("Content-Type", contentType)
	req.Header.Set("Authorization", "Bearer "+token)
	rec := httptest.NewRecorder()
	r.ServeHTTP(rec, req)
	return rec
}

func hasWarning(list []string, substr string) bool {
	for _, w := range list {
		if strings.Contains(w, substr) {
			return true
		}
	}
	return false
}
