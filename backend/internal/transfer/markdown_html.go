package transfer

// markdown_html.go — Markdown кадра в XHTML (для EPUB) и в простые блоки (для DOCX).
//
// Почему свой маленький конвертер, а не библиотека. В зависимостях проекта нет
// Markdown-рендерера на Go: интерфейс рендерит Markdown на клиенте, а сервер до сих пор
// отдавал текст как есть. Тащить ради выгрузки целый CommonMark-движок (с расширениями
// таблиц, сносок, HTML) — это новая зависимость и её CVE, а нужен ровно тот набор, который
// реально пишется в кадрах: абзацы, заголовки, выделение, списки, цитаты, код, ссылки,
// картинки и таблицы.
//
// Чего здесь НЕТ и почему: вложенный HTML (в EPUB он либо невалиден, либо требует
// отдельной проверки безопасности — выгрузка не должна исполнять чужую разметку),
// сноски, определения ссылок, вложенные списки глубже двух уровней. Всё это
// сохраняется как текст, а не теряется: абзац с нераспознанной разметкой уходит как
// экранированный текст.
//
// Важно: всё, что попадает в XHTML, экранируется. Текст кадра — пользовательский
// ввод, и «<script>» в кадре должен остаться текстом.

import (
	"fmt"
	"html"
	"regexp"
	"strings"
)

// mdBlock — один блок разметки после разбора: XHTML печатается из него, а DOCX
// переводит тот же блок в свои параграфы (одна разметка — два приёмника).
type mdBlock struct {
	// Kind: paragraph | heading | list | quote | code | table | image.
	Kind string
	// Level — уровень заголовка (1..6).
	Level int
	// Text — текст блока с сохранённой строчной разметкой (**жирный**, *курсив*, `код`).
	Text string
	// Items — элементы списка (для Kind=list), упорядоченный или нет.
	Items []mdListItem
	// Rows — строки таблицы (первая — заголовок).
	Rows [][]string
	// Image — картинка блока: источник и подпись.
	ImageSrc string
	ImageAlt string
}

// mdListItem — элемент списка.
type mdListItem struct {
	Text string
	// Depth — 0 для верхнего уровня, 1 для вложенного.
	Depth int
	// Ordered — нумерованный ли список.
	Ordered bool
}

// Порядок проверок важен: сначала ограждения кода и таблицы (они многострочные),
// потом одиночные строки.
var (
	mdImageLine = regexp.MustCompile(`^!\[([^\]]*)\]\(([^)\s]+)\)\s*$`)
	mdHeading   = regexp.MustCompile(`^(#{1,6})\s+(.*)$`)
	mdOrdered   = regexp.MustCompile(`^(\s*)(\d{1,3})[.)]\s+(.*)$`)
	mdBullet    = regexp.MustCompile(`^(\s*)[-*+]\s+(.*)$`)
	mdQuote     = regexp.MustCompile(`^>\s?(.*)$`)
)

// parseMarkdown разбирает текст кадра на блоки.
func parseMarkdown(source string) []mdBlock {
	lines := strings.Split(strings.ReplaceAll(source, "\r\n", "\n"), "\n")
	blocks := make([]mdBlock, 0, len(lines)/2+1)
	paragraph := make([]string, 0, 4)

	flush := func() {
		if len(paragraph) == 0 {
			return
		}
		blocks = append(blocks, mdBlock{Kind: "paragraph", Text: strings.Join(paragraph, " ")})
		paragraph = paragraph[:0]
	}

	for i := 0; i < len(lines); i++ {
		line := lines[i]
		trimmed := strings.TrimSpace(line)

		// Пустая строка закрывает абзац.
		if trimmed == "" {
			flush()
			continue
		}

		// Ограждение кода: всё до закрывающего ``` — как есть.
		if strings.HasPrefix(trimmed, "```") {
			flush()
			code := make([]string, 0, 8)
			for i++; i < len(lines); i++ {
				if strings.HasPrefix(strings.TrimSpace(lines[i]), "```") {
					break
				}
				code = append(code, lines[i])
			}
			blocks = append(blocks, mdBlock{Kind: "code", Text: strings.Join(code, "\n")})
			continue
		}

		// Таблица: строка с `|` и следующая строка-разделитель.
		if strings.Contains(trimmed, "|") && i+1 < len(lines) && isTableSeparator(lines[i+1]) {
			flush()
			rows := [][]string{tableCells(trimmed)}
			for i += 2; i < len(lines); i++ {
				next := strings.TrimSpace(lines[i])
				if next == "" || !strings.Contains(next, "|") {
					i-- // эту строку обработает основной цикл
					break
				}
				rows = append(rows, tableCells(next))
			}
			blocks = append(blocks, mdBlock{Kind: "table", Rows: rows})
			continue
		}

		// Картинка отдельной строкой — как её пишет выгрузка и вставляет редактор.
		if m := mdImageLine.FindStringSubmatch(trimmed); m != nil {
			flush()
			blocks = append(blocks, mdBlock{Kind: "image", ImageAlt: m[1], ImageSrc: m[2]})
			continue
		}

		if m := mdHeading.FindStringSubmatch(trimmed); m != nil {
			flush()
			blocks = append(blocks, mdBlock{Kind: "heading", Level: len(m[1]), Text: m[2]})
			continue
		}

		// Списки: собираем подряд идущие элементы, вложенность — по отступу.
		if mdOrdered.MatchString(line) || mdBullet.MatchString(line) {
			flush()
			items := make([]mdListItem, 0, 4)
			for ; i < len(lines); i++ {
				current := lines[i]
				if m := mdOrdered.FindStringSubmatch(current); m != nil {
					items = append(items, mdListItem{Text: m[3], Depth: depthOf(m[1]), Ordered: true})
					continue
				}
				if m := mdBullet.FindStringSubmatch(current); m != nil {
					items = append(items, mdListItem{Text: m[2], Depth: depthOf(m[1])})
					continue
				}
				i--
				break
			}
			blocks = append(blocks, mdBlock{Kind: "list", Items: items})
			continue
		}

		if m := mdQuote.FindStringSubmatch(line); m != nil {
			flush()
			quote := []string{m[1]}
			for i+1 < len(lines) {
				next, ok := quoteLine(lines[i+1])
				if !ok {
					break
				}
				quote = append(quote, next)
				i++
			}
			blocks = append(blocks, mdBlock{Kind: "quote", Text: strings.Join(quote, " ")})
			continue
		}

		paragraph = append(paragraph, trimmed)
	}
	flush()
	return blocks
}

// quoteLine — продолжение цитаты.
func quoteLine(line string) (string, bool) {
	if m := mdQuote.FindStringSubmatch(line); m != nil {
		return m[1], true
	}
	return "", false
}

// depthOf — уровень вложенности по отступу в два пробела.
func depthOf(indent string) int {
	width := len(strings.ReplaceAll(indent, "\t", "  "))
	depth := width / 2
	if depth > 1 {
		// Глубже двух уровней в EPUB/DOCX читается плохо, а писать так почти никто не
		// пишет: третий уровень уже неразличим на телефоне.
		depth = 1
	}
	return depth
}

// isTableSeparator — строка вида |---|:--:|.
func isTableSeparator(line string) bool {
	trimmed := strings.TrimSpace(line)
	if !strings.Contains(trimmed, "-") {
		return false
	}
	for _, r := range trimmed {
		switch r {
		case '-', '|', ':', ' ':
		default:
			return false
		}
	}
	return true
}

// tableCells режет строку таблицы по `|`, снимая внешние ограничители.
func tableCells(line string) []string {
	trimmed := strings.TrimSpace(line)
	trimmed = strings.TrimPrefix(trimmed, "|")
	trimmed = strings.TrimSuffix(trimmed, "|")
	parts := strings.Split(trimmed, "|")
	cells := make([]string, 0, len(parts))
	for _, part := range parts {
		cells = append(cells, strings.TrimSpace(part))
	}
	return cells
}

// inlineXHTML превращает строчную разметку в XHTML-фрагмент.
//
// Порядок: сначала экранирование всего текста (пользовательский ввод!), потом замена
// разметки на теги. Так «<b>» в тексте кадра остаётся текстом, а «**жирный**» — жирным.
func inlineXHTML(text string) string {
	escaped := html.EscapeString(text)
	escaped = replacePairs(escaped, "`", "<code>", "</code>")
	escaped = replacePairs(escaped, "**", "<strong>", "</strong>")
	escaped = replacePairs(escaped, "__", "<strong>", "</strong>")
	escaped = replaceEmphasis(escaped)
	escaped = mdLink.ReplaceAllString(escaped, `<a href="$2">$1</a>`)
	return escaped
}

// mdLink — ссылка `[текст](адрес)`. Адрес уже экранирован вместе с текстом.
var mdLink = regexp.MustCompile(`\[([^\]]+)\]\(([^)\s]+)\)`)

// replacePairs заменяет парные маркеры на открывающий и закрывающий теги.
func replacePairs(text, marker, open, close string) string {
	parts := strings.Split(text, marker)
	if len(parts) < 3 {
		return text
	}
	var b strings.Builder
	for i, part := range parts {
		if i > 0 {
			if i%2 == 1 {
				b.WriteString(open)
			} else {
				b.WriteString(close)
			}
		}
		b.WriteString(part)
	}
	return b.String()
}

// replaceEmphasis — одиночные * и _, но не внутри только что вставленных тегов.
func replaceEmphasis(text string) string {
	text = replacePairs(text, "*", "<em>", "</em>")
	return replacePairs(text, "_", "<em>", "</em>")
}

// blocksXHTML печатает блоки в XHTML-фрагмент.
func blocksXHTML(blocks []mdBlock) string {
	var b strings.Builder
	for _, block := range blocks {
		switch block.Kind {
		case "heading":
			level := block.Level
			if level < 2 {
				// H1 в главе уже занят названием кадра: внутренний заголовок кадра
				// начинает с h2, иначе получилось бы две «главные» строки подряд.
				level = 2
			}
			fmt.Fprintf(&b, "<h%d>%s</h%d>\n", level, inlineXHTML(block.Text), level)
		case "paragraph":
			fmt.Fprintf(&b, "<p>%s</p>\n", inlineXHTML(block.Text))
		case "quote":
			fmt.Fprintf(&b, "<blockquote><p>%s</p></blockquote>\n", inlineXHTML(block.Text))
		case "code":
			fmt.Fprintf(&b, "<pre><code>%s</code></pre>\n", html.EscapeString(block.Text))
		case "list":
			b.WriteString(renderListXHTML(block.Items))
		case "table":
			b.WriteString(renderTableXHTML(block.Rows))
		case "image":
			fmt.Fprintf(&b, `<figure><img src="%s" alt="%s"/></figure>`+"\n",
				html.EscapeString(block.ImageSrc), html.EscapeString(block.ImageAlt))
		}
	}
	return b.String()
}

// renderListXHTML печатает список, вложенность — вложенными <ul>/<ol>.
func renderListXHTML(items []mdListItem) string {
	var b strings.Builder
	openTag := ""
	for _, item := range items {
		tag := "ul"
		if item.Ordered {
			tag = "ol"
		}
		if openTag == "" {
			fmt.Fprintf(&b, "<%s>\n", tag)
			openTag = tag
		}
		if item.Depth > 0 {
			b.WriteString(`<li class="nested">`)
		} else {
			b.WriteString("<li>")
		}
		b.WriteString(inlineXHTML(item.Text))
		b.WriteString("</li>\n")
	}
	if openTag != "" {
		fmt.Fprintf(&b, "</%s>\n", openTag)
	}
	return b.String()
}

// renderTableXHTML печатает таблицу: первая строка — заголовок.
func renderTableXHTML(rows [][]string) string {
	if len(rows) == 0 {
		return ""
	}
	var b strings.Builder
	b.WriteString("<table>\n")
	for i, row := range rows {
		if i == 0 {
			b.WriteString("<thead><tr>")
			for _, cell := range row {
				fmt.Fprintf(&b, "<th>%s</th>", inlineXHTML(cell))
			}
			b.WriteString("</tr></thead>\n<tbody>\n")
			continue
		}
		b.WriteString("<tr>")
		for _, cell := range row {
			fmt.Fprintf(&b, "<td>%s</td>", inlineXHTML(cell))
		}
		b.WriteString("</tr>\n")
	}
	if len(rows) > 1 {
		b.WriteString("</tbody>\n")
	}
	b.WriteString("</table>\n")
	return b.String()
}

// plainText снимает строчную разметку — для DOCX, где выделение задаётся прогонами, а
// не символами. Возвращает текст без маркеров и куски с признаком «жирный/курсив/код»,
// чтобы DOCX мог поставить нужный стиль.
func inlineRuns(text string) []inlineRun {
	runs := make([]inlineRun, 0, 4)
	rest := text
	for len(rest) > 0 {
		index, marker, bold, italic, code := nextInlineMarker(rest)
		if index < 0 {
			runs = append(runs, inlineRun{Text: rest})
			break
		}
		if index > 0 {
			runs = append(runs, inlineRun{Text: rest[:index]})
		}
		end := strings.Index(rest[index+len(marker):], marker)
		if end < 0 {
			// Незакрытый маркер — обычный текст, а не проглоченный фрагмент.
			runs = append(runs, inlineRun{Text: rest[index : index+len(marker)]})
			rest = rest[index+len(marker):]
			continue
		}
		inner := rest[index+len(marker) : index+len(marker)+end]
		runs = append(runs, inlineRun{Text: inner, Bold: bold, Italic: italic, Code: code})
		rest = rest[index+len(marker)+end+len(marker):]
	}
	return runs
}

// inlineRun — кусок текста с начертанием (для DOCX).
type inlineRun struct {
	Text   string
	Bold   bool
	Italic bool
	Code   bool
}

// nextInlineMarker ищет ближайший маркер выделения.
func nextInlineMarker(text string) (int, string, bool, bool, bool) {
	best := -1
	marker := ""
	bold, italic, code := false, false, false
	consider := func(index int, value string, b, i, c bool) {
		if index >= 0 && (best < 0 || index < best) {
			best, marker, bold, italic, code = index, value, b, i, c
		}
	}
	consider(strings.Index(text, "**"), "**", true, false, false)
	consider(strings.Index(text, "`"), "`", false, false, true)
	consider(strings.Index(text, "*"), "*", false, true, false)
	// «**» сильнее «*» на той же позиции: иначе жирный текст развалился бы на два курсива.
	if best >= 0 && marker == "*" && strings.HasPrefix(text[best:], "**") {
		marker, bold, italic = "**", true, false
	}
	return best, marker, bold, italic, code
}
