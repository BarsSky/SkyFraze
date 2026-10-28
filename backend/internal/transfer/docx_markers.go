package transfer

// docx_markers.go — маркеры DOCX в тексте кадра (0.92.0, docs/docx-template.md §3).
//
// Markdown не выражает разрыв страницы, оглавление и «этот блок — стилем шаблона». Поэтому в тексте
// живут HTML-комментарии:
//
//	<!-- sf:pagebreak -->
//	<!-- sf:toc -->
//	<!-- sf:style=Эпиграф -->   — оформляет следующий кусок (до конца текста или до style/end)
//	<!-- sf:begin=Стих --> … <!-- sf:end -->
//
// Разбор строгий: маркер — это ВСЯ строка (пробелы по краям допустимы), внутри ``` и ~~~ блоков
// маркеры не разбираются (это код). Неизвестная команда остаётся обычным текстом — лучше показать
// её, чем молча выбросить кусок рукописи.
//
// Маркеры ЧИТАЕТ DOCX и ВЫРЕЗАЕТ EPUB (у него нет понятия «стиль абзаца из шаблона»); выгрузка
// `.md` оставляет их как есть — это исходник, и обратный импорт должен сохранить разметку.

import "strings"

// markerOpen / markerClose — границы служебного комментария.
const (
	markerOpen  = "<!-- sf:"
	markerClose = "-->"
)

// docxMarker — разобранный маркер.
type docxMarker struct {
	kind  string // pagebreak | toc | style | begin | end
	style string
}

// docxSection — кусок текста между маркерами вместе с оформлением.
type docxSection struct {
	// style — стиль шаблона для блоков куска (пусто — обычные правила документа).
	style string
	// blocks — разметка куска; пусто у разрыва страницы и оглавления.
	blocks []mdBlock
	// pagebreak / toc — служебные куски без текста.
	pagebreak bool
	toc       bool
}

// parseDocxMarkerLine разбирает одну строку. Второе значение — «это маркер».
func parseDocxMarkerLine(line string) (docxMarker, bool) {
	trimmed := strings.TrimSpace(line)
	if !strings.HasPrefix(trimmed, markerOpen) || !strings.HasSuffix(trimmed, markerClose) {
		return docxMarker{}, false
	}
	body := strings.TrimSpace(strings.TrimSuffix(strings.TrimPrefix(trimmed, markerOpen), markerClose))
	switch body {
	case "pagebreak":
		return docxMarker{kind: "pagebreak"}, true
	case "toc":
		return docxMarker{kind: "toc"}, true
	case "end":
		return docxMarker{kind: "end"}, true
	}
	if style, ok := strings.CutPrefix(body, "style="); ok {
		return docxMarker{kind: "style", style: strings.TrimSpace(style)}, true
	}
	if style, ok := strings.CutPrefix(body, "begin="); ok {
		return docxMarker{kind: "begin", style: strings.TrimSpace(style)}, true
	}
	return docxMarker{}, false
}

// splitDocxSections режет текст на куски по маркерам и собирает их оформление.
func splitDocxSections(body string) []docxSection {
	if !strings.Contains(body, markerOpen) {
		if strings.TrimSpace(body) == "" {
			return nil
		}
		return []docxSection{{blocks: parseMarkdown(body)}}
	}
	var sections []docxSection
	var chunk []string
	// baseStyle — активный «от begin»; nextStyle — «для следующего куска».
	baseStyle, nextStyle := "", ""
	inFence := ""

	flush := func() {
		text := strings.Join(chunk, "\n")
		chunk = chunk[:0]
		if strings.TrimSpace(text) == "" {
			return
		}
		style := nextStyle
		if style == "" {
			style = baseStyle
		}
		sections = append(sections, docxSection{style: style, blocks: parseMarkdown(text)})
		nextStyle = ""
	}

	lines := strings.Split(body, "\n")
	for _, line := range lines {
		trimmed := strings.TrimSpace(line)
		if inFence != "" {
			if strings.HasPrefix(trimmed, inFence) {
				inFence = ""
			}
			chunk = append(chunk, line)
			continue
		}
		if strings.HasPrefix(trimmed, "```") || strings.HasPrefix(trimmed, "~~~") {
			inFence = trimmed[:3]
			chunk = append(chunk, line)
			continue
		}
		marker, ok := parseDocxMarkerLine(line)
		if !ok {
			chunk = append(chunk, line)
			continue
		}
		flush()
		switch marker.kind {
		case "pagebreak":
			sections = append(sections, docxSection{pagebreak: true})
		case "toc":
			sections = append(sections, docxSection{toc: true})
		case "style":
			nextStyle = marker.style
		case "begin":
			baseStyle = marker.style
		case "end":
			baseStyle = ""
		}
	}
	flush()
	return sections
}

// stripDocxMarkers убирает строки-маркеры: EPUB не умеет «стиль абзаца из шаблона», но и показывать
// комментарии в книге нельзя. Новую строку оставляем, чтобы блоки Markdown не слиплись.
func stripDocxMarkers(text string) string {
	if !strings.Contains(text, markerOpen) {
		return text
	}
	lines := strings.Split(text, "\n")
	inFence := ""
	for index, line := range lines {
		trimmed := strings.TrimSpace(line)
		if inFence != "" {
			if strings.HasPrefix(trimmed, inFence) {
				inFence = ""
			}
			continue
		}
		if strings.HasPrefix(trimmed, "```") || strings.HasPrefix(trimmed, "~~~") {
			inFence = trimmed[:3]
			continue
		}
		if _, ok := parseDocxMarkerLine(line); ok {
			lines[index] = ""
		}
	}
	return strings.Join(lines, "\n")
}

// docxPageBreak — разрыв страницы.
const docxPageBreak = `<w:p><w:r><w:br w:type="page"/></w:r></w:p>`

// docxTOCField — поле оглавления Word.
//
// Word не перестраивает его сам: при открытии он спросит «обновить поля». Это нормально и лучше,
// чем «оглавление, которого нет»: человек видит, что поле есть, и одно нажатие обновляет его.
const docxTOCField = `<w:p><w:r><w:fldChar w:fldCharType="begin"/></w:r>` +
	`<w:r><w:instrText xml:space="preserve"> TOC \o "1-3" \h \z \u </w:instrText></w:r>` +
	`<w:r><w:fldChar w:fldCharType="separate"/></w:r>` +
	`<w:r><w:t>Оглавление обновится при открытии документа (F9)</w:t></w:r>` +
	`<w:r><w:fldChar w:fldCharType="end"/></w:r></w:p>`
