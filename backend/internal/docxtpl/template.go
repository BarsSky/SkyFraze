package docxtpl

// template.go — разбор загруженного шаблона DOCX (0.91.0, docs/docx-template.md).
//
// Шаблон — это готовый документ автора: титул, колонтитулы, поля страницы, стили заголовков и
// шрифт. Мы не пытаемся воспроизвести его вёрстку своим генератором, а вставляем текст проекта в
// САМ пакет шаблона на место плейсхолдера {{content}}. Поэтому при загрузке нужно вытащить ровно
// то, что понадобится выгрузке: стили (чтобы знать, каким стилем набирать заголовки), абзац
// плейсхолдера (его свойства — это оформление обычного текста) и поля страницы (для отчёта).
//
// Разбор намеренно недоверчивый: DOCX от человека — это zip, а внутри XML, который мы не
// контролируем. Читаем только известные части по именам, размеры ограничиваем, внешние сущности
// не резолвим (encoding/xml), текст при сборке экранируем.

import (
	"archive/zip"
	"bytes"
	"encoding/xml"
	"fmt"
	"io"
	"strings"
)

// Пределы загрузки. Чужие документы бывают тяжёлыми, но шаблон оформления — это не книга:
// 20 МБ хватает с запасом, а распакованный объём ограничен отдельно (защита от zip-бомбы).
const (
	MaxTemplateSize     = 20 << 20  // 20 MB — сам файл
	MaxTemplateUnzipped = 200 << 20 // 200 MB — суммарно после распаковки
	maxTemplateParts    = 800       // частей в пакете
)

// PlaceholderText — что ищем в шаблоне. Текст абзаца, который будет заменён содержимым проекта.
const PlaceholderText = "{{content}}"

// ErrBadTemplate — файл не является DOCX или разбор невозможен.
var ErrBadTemplate = fmt.Errorf("файл не похож на шаблон DOCX")

// Style — стиль абзаца из шаблона.
type Style struct {
	ID      string `json:"id"`
	Name    string `json:"name"`
	Type    string `json:"type"`
	Builtin bool   `json:"builtin"`
}

// Placeholder — найденный абзац-плейсхолдер.
type Placeholder struct {
	Found bool `json:"found"`
	// ParagraphStyleID — стиль абзаца плейсхолдера: им набирается обычный текст.
	ParagraphStyleID string `json:"paragraph_style_id,omitempty"`
	// BodyPPr — XML блока свойств абзаца (шрифт, отступ, интервал). Именно он переносится
	// на параграфы текста, поэтому «мой шрифт и отступ» из шаблона работают без карты стилей.
	BodyPPr string `json:"body_ppr,omitempty"`
	Text    string `json:"text,omitempty"`
}

// Page — размер и поля страницы (для отчёта: человек видит, что шаблон применился).
type Page struct {
	Width        int    `json:"width,omitempty"`       // twips
	Height       int    `json:"height,omitempty"`      // twips
	Orientation  string `json:"orientation,omitempty"` // portrait | landscape
	MarginTop    int    `json:"margin_top,omitempty"`
	MarginRight  int    `json:"margin_right,omitempty"`
	MarginBottom int    `json:"margin_bottom,omitempty"`
	MarginLeft   int    `json:"margin_left,omitempty"`
}

// Report — что нашли в шаблоне и что с этим будет делать выгрузка.
type Report struct {
	HasPlaceholder bool    `json:"has_placeholder"`
	HasNumbering   bool    `json:"has_numbering"`
	Styles         []Style `json:"styles"`
	// Mapping — «что в проекте → каким стилем шаблона» (для интерфейса и отчёта).
	Mapping  map[string]string `json:"mapping"`
	Warnings []string          `json:"warnings,omitempty"`
	Page     Page              `json:"page"`
}

// Parsed — результат разбора шаблона.
type Parsed struct {
	Styles      []Style
	Placeholder Placeholder
	Page        Page
	Report      Report
}

// xml-структуры: теги без префикса — encoding/xml сопоставляет по локальному имени, поэтому
// `w:style` читается как `style`.
type stylesXML struct {
	Styles []styleXML `xml:"style"`
}

type styleXML struct {
	Type    string `xml:"type,attr"`
	StyleID string `xml:"styleId,attr"`
	Custom  string `xml:"customStyle,attr"`
	Name    struct {
		Val string `xml:"val,attr"`
	} `xml:"name"`
}

// Parse разбирает загруженный DOCX. Ничего не пишет: только читает и возвращает, что нашлось.
func Parse(name string, raw []byte) (*Parsed, error) {
	if !strings.HasSuffix(strings.ToLower(name), ".docx") {
		return nil, fmt.Errorf("%w: нужен файл .docx", ErrBadTemplate)
	}
	if len(raw) == 0 || len(raw) > MaxTemplateSize {
		return nil, fmt.Errorf("%w: размер файла должен быть от 1 байта до %d МБ", ErrBadTemplate, MaxTemplateSize>>20)
	}
	zr, err := zip.NewReader(bytes.NewReader(raw), int64(len(raw)))
	if err != nil {
		return nil, fmt.Errorf("%w: файл не распаковался: %v", ErrBadTemplate, err)
	}
	if len(zr.File) > maxTemplateParts {
		return nil, fmt.Errorf("%w: в пакете больше %d частей", ErrBadTemplate, maxTemplateParts)
	}

	var total int64
	parts := make(map[string][]byte, len(zr.File))
	for _, file := range zr.File {
		if file.FileInfo().IsDir() {
			continue
		}
		total += int64(file.UncompressedSize64)
		if total > MaxTemplateUnzipped {
			return nil, fmt.Errorf("%w: распакованный шаблон больше %d МБ", ErrBadTemplate, MaxTemplateUnzipped>>20)
		}
		switch file.Name {
		case "[Content_Types].xml", "word/document.xml", "word/styles.xml",
			"word/numbering.xml", "word/_rels/document.xml.rels":
			data, err := readPart(file)
			if err != nil {
				return nil, err
			}
			parts[file.Name] = data
		case "word/vbaProject.bin":
			// Макросы: шаблоном оформления они не нужны, а исполняемый контент в документе —
			// это уже не оформление (и .docm мы отказываемся принимать целиком).
			return nil, fmt.Errorf("%w: в файле есть макросы (vbaProject.bin) — нужен обычный .docx", ErrBadTemplate)
		}
	}
	if parts["word/document.xml"] == nil {
		return nil, fmt.Errorf("%w: в пакете нет word/document.xml", ErrBadTemplate)
	}

	document := string(parts["word/document.xml"])
	parsed := &Parsed{Page: parsePage(document)}
	parsed.Styles = parseStyles(parts["word/styles.xml"])
	parsed.Placeholder = findPlaceholder(document)
	parsed.Report = buildReport(parsed, parts["word/numbering.xml"] != nil)
	return parsed, nil
}

func readPart(file *zip.File) ([]byte, error) {
	rc, err := file.Open()
	if err != nil {
		return nil, fmt.Errorf("%w: %s не открылся: %v", ErrBadTemplate, file.Name, err)
	}
	defer rc.Close()
	data, err := io.ReadAll(io.LimitReader(rc, MaxTemplateUnzipped))
	if err != nil {
		return nil, fmt.Errorf("%w: %s не прочитан: %v", ErrBadTemplate, file.Name, err)
	}
	return data, nil
}

// parseStyles читает стили абзацев. Отдельные стили символов и таблиц нам не нужны, но пропускать
// их молча не стоит: отчёт показывает все, чтобы человек видел, что мы разобрали.
func parseStyles(raw []byte) []Style {
	if len(raw) == 0 {
		return nil
	}
	var doc stylesXML
	if err := xml.Unmarshal(raw, &doc); err != nil {
		return nil
	}
	out := make([]Style, 0, len(doc.Styles))
	for _, item := range doc.Styles {
		if item.StyleID == "" {
			continue
		}
		out = append(out, Style{
			ID:      item.StyleID,
			Name:    item.Name.Val,
			Type:    item.Type,
			Builtin: isBuiltinStyle(item.StyleID) && item.Custom != "1",
		})
	}
	return out
}

// builtinStyleIDs — стандартные идентификаторы Word, которые можно считать ожидаемыми.
var builtinStyleIDs = map[string]bool{
	"Normal": true, "Title": true, "Subtitle": true, "Quote": true, "IntenseQuote": true,
	"ListParagraph": true, "Caption": true, "Date": true, "Code": true,
	"Heading1": true, "Heading2": true, "Heading3": true, "Heading4": true,
	"Heading5": true, "Heading6": true, "Heading7": true, "Heading8": true, "Heading9": true,
}

func isBuiltinStyle(id string) bool { return builtinStyleIDs[id] }

// findPlaceholder ищет абзац с {{content}} и запоминает его свойства.
func findPlaceholder(document string) Placeholder {
	index := strings.Index(document, PlaceholderText)
	if index < 0 {
		return Placeholder{}
	}
	start := paragraphStart(document, index)
	end := strings.Index(document[index:], "</w:p>")
	if start < 0 || end < 0 {
		return Placeholder{}
	}
	paragraph := document[start : index+end+len("</w:p>")]
	return Placeholder{
		Found:            true,
		ParagraphStyleID: paragraphStyle(paragraph),
		BodyPPr:          paragraphProps(paragraph),
		Text:             PlaceholderText,
	}
}

// paragraphStart ищет начало абзаца перед позицией текста. `<w:pPr`, `<w:pStyle` — не абзацы,
// поэтому после `<w:p` должен стоять пробел или `>`.
func paragraphStart(document string, before int) int {
	for pos := before; pos >= 0; pos-- {
		idx := strings.LastIndex(document[:pos], "<w:p")
		if idx < 0 {
			return -1
		}
		next := byte(' ')
		if idx+4 < len(document) {
			next = document[idx+4]
		}
		if next == ' ' || next == '>' || next == '/' {
			return idx
		}
		pos = idx
	}
	return -1
}

// paragraphStyle вытаскивает w:pStyle/@w:val из абзаца.
func paragraphStyle(paragraph string) string {
	idx := strings.Index(paragraph, "<w:pStyle")
	if idx < 0 {
		return ""
	}
	rest := paragraph[idx:]
	end := strings.Index(rest, "/>")
	if end < 0 {
		return ""
	}
	return attrValue(rest[:end], "w:val")
}

// paragraphProps возвращает блок свойств абзаца как есть — его и переносим на обычный текст.
func paragraphProps(paragraph string) string {
	start := strings.Index(paragraph, "<w:pPr")
	if start < 0 {
		return ""
	}
	end := strings.Index(paragraph[start:], "</w:pPr>")
	if end < 0 {
		// Свойства могут быть пустыми: <w:pPr/>
		if selfEnd := strings.Index(paragraph[start:], "/>"); selfEnd >= 0 {
			return paragraph[start : start+selfEnd+2]
		}
		return ""
	}
	return paragraph[start : start+end+len("</w:pPr>")]
}

// attrValue достаёт значение атрибута из куска XML (простая форма для известных атрибутов).
func attrValue(chunk, attr string) string {
	idx := strings.Index(chunk, attr+`="`)
	if idx < 0 {
		return ""
	}
	rest := chunk[idx+len(attr)+2:]
	end := strings.Index(rest, `"`)
	if end < 0 {
		return ""
	}
	return rest[:end]
}

// parsePage читает sectPr документа: размер страницы и поля (в twips).
func parsePage(document string) Page {
	idx := strings.Index(document, "<w:pgSz")
	if idx < 0 {
		return Page{}
	}
	rest := document[idx:]
	page := Page{}
	if end := strings.Index(rest, "/>"); end >= 0 {
		tag := rest[:end]
		page.Width = atoiOrZero(attrValue(tag, "w:w"))
		page.Height = atoiOrZero(attrValue(tag, "w:h"))
		page.Orientation = attrValue(tag, "w:orient")
	}
	if page.Orientation == "" && page.Width > 0 && page.Height > 0 {
		page.Orientation = "portrait"
		if page.Width > page.Height {
			page.Orientation = "landscape"
		}
	}
	if mar := strings.Index(document, "<w:pgMar"); mar >= 0 {
		if end := strings.Index(document[mar:], "/>"); end >= 0 {
			tag := document[mar : mar+end]
			page.MarginTop = atoiOrZero(attrValue(tag, "w:top"))
			page.MarginRight = atoiOrZero(attrValue(tag, "w:right"))
			page.MarginBottom = atoiOrZero(attrValue(tag, "w:bottom"))
			page.MarginLeft = atoiOrZero(attrValue(tag, "w:left"))
		}
	}
	return page
}

func atoiOrZero(raw string) int {
	value := 0
	for i := 0; i < len(raw); i++ {
		if raw[i] < '0' || raw[i] > '9' {
			return value
		}
		value = value*10 + int(raw[i]-'0')
	}
	return value
}

// buildReport собирает карту сопоставления и предупреждения — то, что человек увидит после
// загрузки. Молча подставлять другой стиль нельзя: он должен знать, где шаблон не совпал.
func buildReport(parsed *Parsed, hasNumbering bool) Report {
	report := Report{
		HasPlaceholder: parsed.Placeholder.Found,
		HasNumbering:   hasNumbering,
		Styles:         parsed.Styles,
		Mapping:        map[string]string{},
		Page:           parsed.Page,
	}
	if !parsed.Placeholder.Found {
		report.Warnings = append(report.Warnings,
			"в шаблоне нет абзаца {{content}} — текст проекта будет собран встроенным оформлением")
	}

	names := map[string]Style{}
	byName := map[string]Style{}
	for _, style := range parsed.Styles {
		names[strings.ToLower(style.ID)] = style
		if style.Name != "" {
			byName[strings.ToLower(style.Name)] = style
		}
	}
	// find ищет стиль по id, затем по имени (в русском Word имя «Заголовок 1», id «Heading1»).
	find := func(candidates ...string) (Style, bool) {
		for _, candidate := range candidates {
			if style, ok := names[strings.ToLower(candidate)]; ok {
				return style, true
			}
			if style, ok := byName[strings.ToLower(candidate)]; ok {
				return style, true
			}
		}
		return Style{}, false
	}

	mappings := []struct {
		key        string
		candidates []string
	}{
		{"title", []string{"Title", "Заголовок"}},
		{"heading1", []string{"Heading1", "heading 1", "Заголовок 1"}},
		{"heading2", []string{"Heading2", "heading 2", "Заголовок 2"}},
		{"heading3", []string{"Heading3", "heading 3", "Заголовок 3"}},
		{"heading4", []string{"Heading4", "heading 4", "Заголовок 4"}},
		{"quote", []string{"Quote", "Цитата"}},
		{"code", []string{"Code", "SourceCode", "Source Code", "Код"}},
		{"date", []string{"Date", "Дата"}},
		{"list", []string{"ListParagraph", "List Paragraph", "Список"}},
	}
	// Заголовки: если точного уровня нет, берём ближайший существующий ниже — лучше один уровень,
	// чем «как обычный текст». В отчёте это сказано словами, чтобы человек видел подмену.
	lastHeading := ""
	for _, item := range mappings {
		style, ok := find(item.candidates...)
		if ok {
			report.Mapping[item.key] = style.ID
			if strings.HasPrefix(item.key, "heading") {
				lastHeading = style.ID
			}
			continue
		}
		if strings.HasPrefix(item.key, "heading") && lastHeading != "" {
			report.Mapping[item.key] = lastHeading
			report.Warnings = append(report.Warnings,
				fmt.Sprintf("стиля %s в шаблоне нет — использую %s", item.candidates[0], lastHeading))
			continue
		}
		// Стиля нет и замены нет: блок соберётся как обычный текст шаблона (с его шрифтом и
		// отступом). Это честнее, чем ссылаться на несуществующий стиль Word.
		report.Warnings = append(report.Warnings,
			fmt.Sprintf("стиль для «%s» в шаблоне не найден — блок будет как обычный текст", item.key))
	}
	if parsed.Placeholder.Found && parsed.Placeholder.ParagraphStyleID != "" {
		report.Mapping["body"] = parsed.Placeholder.ParagraphStyleID
	}
	return report
}
