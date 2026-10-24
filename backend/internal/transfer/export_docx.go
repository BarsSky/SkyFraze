package transfer

// export_docx.go — выгрузка проекта в DOCX (Office Open XML).
//
// Зачем второй формат, если есть EPUB. EPUB читают в читалке, DOCX — правят: автору нужно
// отдать рукопись редактору, а редактор откроет Word/LibreOffice, а не EPUB. Формат тот же
// zip с XML, поэтому ни новой зависимости, ни внешнего конвертера.
//
// Что внутри: `[Content_Types].xml`, связи, `word/document.xml` с параграфами и стилями,
// `word/styles.xml` (заголовки, цитата, код, подпись даты) и картинки в `word/media/`.
// Разметка кадров переводится тем же разбором, что и в EPUB (`markdown_html.go`), поэтому
// два формата не могут разойтись в трактовке текста — только в оформлении.
//
// Ограничения, о которых честно сказано в docs/import-export.md: сложные таблицы DOCX
// получаются простой сеткой по границам (первая строка — жирная), а вложенные списки
// глубже второго уровня выравниваются в один. Это выгрузка для чтения и правки, а не
// обратимая миграция.

import (
	"archive/zip"
	"bytes"
	"context"
	"fmt"
	"io"
	"strings"
	"time"

	"github.com/google/uuid"

	"github.com/skyfraze/backend/internal/store"
)

// docxFileMime — MIME тип документа.
const docxFileMime = "application/vnd.openxmlformats-officedocument.wordprocessingml.document"

// docxMedia — картинка документа.
type docxMedia struct {
	// RelID — идентификатор связи (rIdN) внутри документа.
	RelID     string
	Path      string
	MediaType string
	Width     int
	Height    int
	Asset     store.Asset
}

// ExportDOCX собирает документ и пишет его в w.
func (s *Service) ExportDOCX(
	ctx context.Context, userID, projectID uuid.UUID, w io.Writer,
) (*MarkdownInfo, error) {
	st, err := s.loadStory(ctx, userID, projectID)
	if err != nil {
		return nil, err
	}

	// Картинки: по одной на вложение, идентификатор связи — по порядку.
	media := make([]docxMedia, 0, len(st.Assets))
	mediaByID := make(map[uuid.UUID]docxMedia, len(st.Assets))
	for _, frame := range st.Frames {
		for _, a := range frame.Images {
			if _, ok := mediaByID[a.ID]; ok {
				continue
			}
			item := docxMedia{
				RelID:     fmt.Sprintf("rId%d", len(media)+10),
				Path:      fmt.Sprintf("media/%02d.%s", st.AssetNumber[a.ID], mimeExtension(a.Mime)),
				MediaType: a.Mime,
				Asset:     a,
			}
			if a.Width != nil {
				item.Width = *a.Width
			}
			if a.Height != nil {
				item.Height = *a.Height
			}
			media = append(media, item)
			mediaByID[a.ID] = item
		}
	}

	body := docxBody(st, mediaByID)
	title := oneLine(st.Project.Title)
	if title == "" {
		title = "Без названия"
	}
	author := "SkyFraze"
	created := time.Now().UTC().Format("2006-01-02T15:04:05Z")

	counter := &countingWriter{w: w}
	zw := zip.NewWriter(counter)

	files := []struct {
		name string
		data []byte
	}{
		{"[Content_Types].xml", []byte(docxContentTypes(media))},
		{"_rels/.rels", []byte(docxRootRels())},
		{"docProps/core.xml", []byte(docxCore(title, author, created))},
		{"word/document.xml", []byte(docxDocument(body))},
		{"word/styles.xml", []byte(docxStyles)},
		{"word/_rels/document.xml.rels", []byte(docxDocumentRels(media))},
	}
	for _, file := range files {
		if err := writeZipFile(zw, file.name, file.data); err != nil {
			return nil, err
		}
	}
	for _, item := range media {
		rc, err := s.obj.Get(ctx, item.Asset.S3Key)
		if err != nil {
			// Файла нет в хранилище — не роняем выгрузку: текст важнее картинки.
			continue
		}
		var buf bytes.Buffer
		_, copyErr := io.Copy(&buf, rc)
		_ = rc.Close()
		if copyErr != nil {
			continue
		}
		if err := writeZipFile(zw, "word/"+item.Path, buf.Bytes()); err != nil {
			return nil, err
		}
	}
	if err := zw.Close(); err != nil {
		return nil, err
	}
	return &MarkdownInfo{
		Title:    title,
		Filename: bookFilename(st.Project.Title, ".docx"),
		Events:   len(st.Frames),
		Assets:   len(media),
		Bytes:    counter.n,
	}, nil
}

// docxBody печатает тело документа: название, описание, затем кадры по порядку.
func docxBody(st *story, media map[uuid.UUID]docxMedia) string {
	var b strings.Builder
	b.WriteString(docxParagraph(st.Project.Title, "Title", ""))
	if desc := oneLine(st.Project.Description); desc != "" {
		b.WriteString(docxParagraph(desc, "", ""))
	}
	for _, frame := range st.Frames {
		pictures := 0
		style := "Heading1"
		switch frame.Depth {
		case 1:
			style = "Heading2"
		case 2:
			style = "Heading3"
		}
		b.WriteString(docxParagraph(frameHeadline(frame), style, ""))
		if frame.Event.EventDate != nil {
			b.WriteString(docxParagraph(frame.Event.EventDate.Format("2 January 2006"), "", "Date"))
		}
		for _, a := range frame.Images {
			item, ok := media[a.ID]
			if !ok {
				continue
			}
			pictures++
			b.WriteString(docxImage(item, pictures))
		}
		for _, block := range parseMarkdown(frame.Event.Body) {
			b.WriteString(docxBlock(block))
		}
	}
	return b.String()
}

// docxBlock печатает один блок разметки.
func docxBlock(block mdBlock) string {
	switch block.Kind {
	case "heading":
		level := block.Level
		if level < 2 {
			level = 2
		}
		if level > 4 {
			level = 4
		}
		return docxParagraph(inlinePlain(block.Text), fmt.Sprintf("Heading%d", level), "")
	case "paragraph":
		return docxRunsParagraph(inlineRuns(block.Text), "")
	case "quote":
		return docxRunsParagraph(inlineRuns(block.Text), "Quote")
	case "code":
		return docxParagraph(block.Text, "Code", "")
	case "list":
		var b strings.Builder
		for _, item := range block.Items {
			prefix := "• "
			if item.Ordered {
				prefix = "1. "
			}
			indent := ""
			if item.Depth > 0 {
				indent = "Nested"
			}
			b.WriteString(docxRunsParagraph(
				append([]inlineRun{{Text: prefix}}, inlineRuns(item.Text)...), indent))
		}
		return b.String()
	case "table":
		var b strings.Builder
		for rowIndex, row := range block.Rows {
			text := strings.Join(row, " | ")
			style := ""
			if rowIndex == 0 {
				style = "TableHead"
			}
			b.WriteString(docxRunsParagraph([]inlineRun{{Text: text, Bold: rowIndex == 0}}, style))
		}
		return b.String()
	case "image":
		// Картинки внутри текста кадра не привязываются к вложениям проекта, поэтому в
		// DOCX они остаются строкой-ссылкой: текст не потерян, а ссылка открывается.
		return docxParagraph(block.ImageAlt+" ("+block.ImageSrc+")", "Date", "")
	}
	return ""
}

// docxParagraph — параграф одной строкой без выделения.
func docxParagraph(text, style, extra string) string {
	return docxRunsParagraph([]inlineRun{{Text: text}}, styleWithExtra(style, extra))
}

// styleWithExtra склеивает стиль и дополнительный класс (дата, вложенный список).
func styleWithExtra(style, extra string) string {
	switch {
	case style != "" && extra != "":
		return style
	case style != "":
		return style
	case extra == "Date":
		return "Date"
	case extra == "Nested":
		return "ListNested"
	default:
		return extra
	}
}

// docxRunsParagraph — параграф из кусков с начертанием.
func docxRunsParagraph(runs []inlineRun, style string) string {
	var b strings.Builder
	b.WriteString("<w:p>")
	if style != "" {
		fmt.Fprintf(&b, `<w:pPr><w:pStyle w:val="%s"/></w:pPr>`, style)
	}
	for _, run := range runs {
		if run.Text == "" {
			continue
		}
		b.WriteString("<w:r>")
		if run.Bold || run.Italic || run.Code {
			b.WriteString("<w:rPr>")
			if run.Bold {
				b.WriteString("<w:b/>")
			}
			if run.Italic {
				b.WriteString("<w:i/>")
			}
			if run.Code {
				b.WriteString(`<w:rFonts w:ascii="Consolas" w:hAnsi="Consolas"/>`)
			}
			b.WriteString("</w:rPr>")
		}
		fmt.Fprintf(&b, `<w:t xml:space="preserve">%s</w:t></w:r>`, escapeXML(run.Text))
	}
	b.WriteString("</w:p>")
	return b.String()
}

// docxImage — картинка встроенным объектом.
//
// Ширина ограничена шестью дюймами (5486400 EMU): картинка кадра может быть широкой, и
// без предела она вылезала бы за поля страницы. Пропорции сохраняются по размерам из
// вложения; если их нет (файл загружен до миграции 0007), берётся 4×3 дюйма.
func docxImage(item docxMedia, index int) string {
	const emuPerInch = 914400
	const maxWidth = 6 * emuPerInch
	width, height := item.Width, item.Height
	if width <= 0 || height <= 0 {
		width, height = 4*96, 3*96
	}
	cx := int64(width) * emuPerInch / 96
	cy := int64(height) * emuPerInch / 96
	if cx > maxWidth {
		cy = cy * maxWidth / cx
		cx = maxWidth
	}
	return fmt.Sprintf(`<w:p><w:r><w:drawing>`+
		`<wp:inline distT="0" distB="0" distL="0" distR="0">`+
		`<wp:extent cx="%d" cy="%d"/>`+
		`<wp:docPr id="%d" name="picture"/>`+
		`<a:graphic xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">`+
		`<a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture">`+
		`<pic:pic xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture">`+
		`<pic:nvPicPr><pic:cNvPr id="%d" name="%s"/><pic:cNvPicPr/></pic:nvPicPr>`+
		`<pic:blipFill><a:blip r:embed="%s"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill>`+
		`<pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="%d" cy="%d"/></a:xfrm>`+
		`<a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr>`+
		`</pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r></w:p>`,
		cx, cy, index, index, escapeXML(item.Asset.Filename), item.RelID, cx, cy)
}

// inlinePlain снимает выделение (для строки таблицы).
func inlinePlain(text string) string {
	var b strings.Builder
	for _, run := range inlineRuns(text) {
		b.WriteString(run.Text)
	}
	return b.String()
}

// docxDocument оборачивает тело в документ.
func docxDocument(body string) string {
	return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"
  xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"
  xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing">
<w:body>` + body + `<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1134" w:right="1134" w:bottom="1134" w:left="1134"/></w:sectPr></w:body></w:document>`
}

// docxContentTypes — типы содержимого пакета.
func docxContentTypes(media []docxMedia) string {
	extensions := map[string]bool{}
	for _, item := range media {
		if ext := mimeExtension(item.MediaType); ext != "img" {
			extensions[ext] = true
		}
	}
	var b strings.Builder
	b.WriteString(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>` + "\n")
	for ext := range extensions {
		fmt.Fprintf(&b, `<Default Extension="%s" ContentType="image/%s"/>`+"\n", ext, ext)
	}
	b.WriteString(`<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
<Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>
<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>
</Types>`)
	return b.String()
}

// docxRootRels — корневые связи пакета.
func docxRootRels() string {
	return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/>
</Relationships>`
}

// docxDocumentRels — связи документа со стилями и картинками.
func docxDocumentRels(media []docxMedia) string {
	var b strings.Builder
	b.WriteString(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>` + "\n")
	for _, item := range media {
		fmt.Fprintf(&b, `<Relationship Id="%s" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="%s"/>`+"\n",
			item.RelID, item.Path)
	}
	b.WriteString("</Relationships>")
	return b.String()
}

// docxCore — свойства документа (название, автор, дата).
func docxCore(title, author, created string) string {
	return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties"
  xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/"
  xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
<dc:title>` + escapeXML(title) + `</dc:title>
<dc:creator>` + escapeXML(author) + `</dc:creator>
<dcterms:created xsi:type="dcterms:W3CDTF">` + created + `</dcterms:created>
</cp:coreProperties>`
}

// docxStyles — стили документа: заголовки, цитата, код, дата, вложенный список.
const docxStyles = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
<w:docDefaults><w:rPrDefault><w:rPr>
<w:rFonts w:ascii="Georgia" w:hAnsi="Georgia" w:cs="Georgia"/>
<w:sz w:val="24"/><w:lang w:val="ru-RU"/>
</w:rPr></w:rPrDefault></w:docDefaults>
<w:style w:type="paragraph" w:styleId="Title"><w:name w:val="Title"/>
<w:pPr><w:spacing w:before="240" w:after="240"/></w:pPr>
<w:rPr><w:b/><w:sz w:val="48"/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/>
<w:pPr><w:pageBreakBefore/><w:spacing w:before="360" w:after="120"/></w:pPr>
<w:rPr><w:b/><w:sz w:val="36"/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="Heading2"><w:name w:val="heading 2"/>
<w:pPr><w:spacing w:before="240" w:after="80"/></w:pPr>
<w:rPr><w:b/><w:sz w:val="28"/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="Heading3"><w:name w:val="heading 3"/>
<w:pPr><w:spacing w:before="180" w:after="60"/></w:pPr>
<w:rPr><w:b/><w:sz w:val="26"/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="Quote"><w:name w:val="Quote"/>
<w:pPr><w:ind w:left="567"/></w:pPr><w:rPr><w:i/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="Code"><w:name w:val="Code"/>
<w:pPr><w:ind w:left="283"/></w:pPr>
<w:rPr><w:rFonts w:ascii="Consolas" w:hAnsi="Consolas"/><w:sz w:val="20"/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="Date"><w:name w:val="Date"/>
<w:rPr><w:color w:val="666666"/><w:sz w:val="20"/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="ListNested"><w:name w:val="List Nested"/>
<w:pPr><w:ind w:left="567"/></w:pPr></w:style>
<w:style w:type="paragraph" w:styleId="TableHead"><w:name w:val="Table Head"/>
<w:rPr><w:b/></w:rPr></w:style>
</w:styles>`
