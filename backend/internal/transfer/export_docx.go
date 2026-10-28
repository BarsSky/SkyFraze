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
	"errors"
	"fmt"
	"io"
	"strings"
	"time"

	"github.com/google/uuid"

	"github.com/skyfraze/backend/internal/docxtpl"
	"github.com/skyfraze/backend/internal/store"
)

// docxFileMime — MIME тип документа.
const docxFileMime = "application/vnd.openxmlformats-officedocument.wordprocessingml.document"

// DocxTemplates — шаблоны оформления проекта (0.91.0, docs/docx-template.md).
//
// Интерфейс, а не конкретный сервис: transfer собирает документ и не должен знать, как шаблоны
// хранятся и кто их вправе менять. Выгрузке нужен активный шаблон (пакет + разбор) — и всё.
type DocxTemplates interface {
	Active(ctx context.Context, projectID uuid.UUID) (*docxtpl.ActiveTemplate, error)
}

// docxStyles — какие стили использовать при сборке тела.
//
// С шаблоном значения приходят из карты сопоставления разбора; без шаблона — встроенные, как до
// 0.91.0. `BodyPPr` — свойства абзаца-плейсхолдера: именно они дают «мой шрифт и отступ» обычному
// тексту, без ручной карты стилей.
type docxStyleSet struct {
	Title   string
	Heading [5]string
	Quote   string
	Code    string
	Date    string
	List    string
	Nested  string
	Table   string
	BodyPPr string
}

// builtinDocxStyles — прежнее оформление (шаблона нет).
func builtinDocxStyles() docxStyleSet {
	return docxStyleSet{
		Title:   "Title",
		Heading: [5]string{"", "Heading1", "Heading2", "Heading3", "Heading3"},
		Quote:   "Quote",
		Code:    "Code",
		Date:    "Date",
		List:    "",
		Nested:  "ListNested",
		Table:   "TableHead",
	}
}

// docxStylesFrom — карта стилей из разбора шаблона, с встроенными запасными значениями.
func docxStylesFrom(tpl *docxtpl.ActiveTemplate) docxStyleSet {
	styles := builtinDocxStyles()
	if tpl == nil {
		return styles
	}
	mapping := tpl.Report.Mapping
	pick := func(key, fallback string) string {
		if value := strings.TrimSpace(mapping[key]); value != "" {
			return value
		}
		return fallback
	}
	// Стиля может не быть в шаблоне: тогда блок собирается без pStyle — с абзацными свойствами
	// плейсхолдера (шрифт и отступ автора), а не с несуществующим стилем Word.
	styles.Title = pick("title", "")
	for depth := 1; depth <= 4; depth++ {
		styles.Heading[depth] = pick("heading"+fmt.Sprint(depth), "")
	}
	styles.Quote = pick("quote", "")
	styles.Code = pick("code", "")
	styles.Date = pick("date", "")
	styles.List = pick("list", "")
	styles.Nested = styles.List
	styles.BodyPPr = tpl.Placeholder.BodyPPr
	return styles
}

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
//
// Если у проекта есть активный шаблон оформления (0.91.0), документ собирается В ЕГО ПАКЕТЕ: текст
// встаёт на место абзаца {{content}}, остальное (титул, колонтитулы, поля, стили) остаётся автора.
// Без шаблона — прежняя сборка с нуля.
func (s *Service) ExportDOCX(
	ctx context.Context, userID, projectID uuid.UUID, w io.Writer,
) (*MarkdownInfo, error) {
	st, err := s.loadStory(ctx, userID, projectID)
	if err != nil {
		return nil, err
	}

	var template *docxtpl.ActiveTemplate
	if s.docxTemplates != nil {
		template, err = s.docxTemplates.Active(ctx, projectID)
		if err != nil {
			template = nil
		}
	}
	styles := docxStylesFrom(template)

	// Картинки: по одной на вложение. Идентификаторы связей в шаблоне уже заняты, поэтому
	// начинаем с первого свободного; без шаблона — прежние rId10+.
	nextRID := 10
	if template != nil {
		nextRID = docxtpl.NextRelationshipID(template.Raw)
	}
	media := make([]docxMedia, 0, len(st.Assets))
	mediaByID := make(map[uuid.UUID]docxMedia, len(st.Assets))
	for _, frame := range st.Frames {
		for _, a := range frame.Images {
			if _, ok := mediaByID[a.ID]; ok {
				continue
			}
			item := docxMedia{
				RelID:     fmt.Sprintf("rId%d", nextRID),
				Path:      fmt.Sprintf("media/%02d.%s", st.AssetNumber[a.ID], mimeExtension(a.Mime)),
				MediaType: a.Mime,
				Asset:     a,
			}
			nextRID++
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

	body := docxBody(st, mediaByID, styles)
	title := oneLine(st.Project.Title)
	if title == "" {
		title = "Без названия"
	}
	author := "SkyFraze"
	created := time.Now().UTC().Format("2006-01-02T15:04:05Z")

	if template != nil {
		mediaBytes, err := s.readDocxMedia(ctx, media)
		if err != nil {
			return nil, err
		}
		parts := make([]docxtpl.Media, 0, len(media))
		for _, item := range media {
			data, ok := mediaBytes[item.Asset.ID]
			if !ok {
				continue
			}
			parts = append(parts, docxtpl.Media{
				Name:  item.Path,
				Data:  data,
				Mime:  item.MediaType,
				RelID: item.RelID,
			})
		}
		result, injectErr := docxtpl.Inject(template.Raw, docxtpl.InjectOptions{
			ContentXML: body,
			Media:      parts,
		})
		if injectErr == nil {
			_, writeErr := w.Write(result.Data)
			if writeErr != nil {
				return nil, writeErr
			}
			return &MarkdownInfo{
				Title:    title,
				Filename: bookFilename(st.Project.Title, ".docx"),
				Events:   len(st.Frames),
				Assets:   len(parts),
				Bytes:    int64(len(result.Data)),
				Template: "custom",
			}, nil
		}
		// Шаблон не применился (например, плейсхолдер исчез после загрузки): собираем встроенным
		// оформлением, но не молча — пишем в лог, а человек увидит это по виду файла.
		if s.logger != nil && !errors.Is(injectErr, docxtpl.ErrNoPlaceholder) {
			s.logger.Warn("docx template inject failed", "project", projectID, "err", injectErr)
		}
	}

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
		Template: "builtin",
	}, nil
}

// readDocxMedia читает файлы картинок проекта из хранилища (только те, что войдут в документ).
func (s *Service) readDocxMedia(ctx context.Context, media []docxMedia) (map[uuid.UUID][]byte, error) {
	out := make(map[uuid.UUID][]byte, len(media))
	for _, item := range media {
		rc, err := s.obj.Get(ctx, item.Asset.S3Key)
		if err != nil {
			// Картинки нет в хранилище — не роняем выгрузку, текст важнее.
			continue
		}
		var buf bytes.Buffer
		_, copyErr := io.Copy(&buf, rc)
		_ = rc.Close()
		if copyErr != nil {
			continue
		}
		out[item.Asset.ID] = buf.Bytes()
	}
	return out, nil
}

// docxBody печатает тело документа: название, описание, затем кадры по порядку.
//
// `styles` — какие стили использовать: с шаблоном оформления они приходят из его карты, без
// шаблона — встроенные. Обычный текст получает свойства абзаца-плейсхолдера (BodyPPr): так
// работают «мой шрифт и отступ» шаблона.
func docxBody(st *story, media map[uuid.UUID]docxMedia, styles docxStyleSet) string {
	var b strings.Builder
	b.WriteString(docxParagraph(st.Project.Title, styles.Title, "", styles.BodyPPr))
	if desc := oneLine(st.Project.Description); desc != "" {
		b.WriteString(docxParagraph(desc, "", "", styles.BodyPPr))
	}
	for _, frame := range st.Frames {
		pictures := 0
		// Глубина кадра: глава (0) — заголовок 1, под-событие (1) — заголовок 2, и так далее.
		level := frame.Depth + 1
		if level < 1 {
			level = 1
		}
		if level > 4 {
			level = 4
		}
		style := styles.Heading[level]
		b.WriteString(docxParagraph(frameHeadline(frame), style, "", ""))
		if frame.Event.EventDate != nil {
			b.WriteString(docxParagraph(frame.Event.EventDate.Format("2 January 2006"), "", "Date", ""))
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
			b.WriteString(docxBlock(block, styles))
		}
	}
	return b.String()
}

// docxBlock печатает один блок разметки.
func docxBlock(block mdBlock, styles docxStyleSet) string {
	switch block.Kind {
	case "heading":
		level := block.Level
		if level < 2 {
			level = 2
		}
		if level > 4 {
			level = 4
		}
		return docxParagraph(inlinePlain(block.Text), styles.Heading[level], "", "")
	case "paragraph":
		return docxRunsParagraph(inlineRuns(block.Text), "", styles.BodyPPr)
	case "quote":
		return docxRunsParagraph(inlineRuns(block.Text), styles.Quote, "")
	case "code":
		return docxParagraph(block.Text, styles.Code, "", "")
	case "list":
		var b strings.Builder
		for _, item := range block.Items {
			prefix := "• "
			if item.Ordered {
				prefix = "1. "
			}
			style := styles.List
			if item.Depth > 0 && styles.Nested != "" {
				style = styles.Nested
			}
			b.WriteString(docxRunsParagraph(
				append([]inlineRun{{Text: prefix}}, inlineRuns(item.Text)...), style, styles.BodyPPr))
		}
		return b.String()
	case "table":
		var b strings.Builder
		for rowIndex, row := range block.Rows {
			text := strings.Join(row, " | ")
			style := ""
			if rowIndex == 0 {
				style = styles.Table
			}
			b.WriteString(docxRunsParagraph([]inlineRun{{Text: text, Bold: rowIndex == 0}}, style, ""))
		}
		return b.String()
	case "image":
		// Картинки внутри текста кадра не привязываются к вложениям проекта, поэтому в
		// DOCX они остаются строкой-ссылкой: текст не потерян, а ссылка открывается.
		return docxParagraph(block.ImageAlt+" ("+block.ImageSrc+")", styles.Date, "", "")
	}
	return ""
}

// docxParagraph — параграф одной строкой без выделения.
func docxParagraph(text, style, extra, bodyPPr string) string {
	return docxRunsParagraph([]inlineRun{{Text: text}}, styleWithExtra(style, extra), bodyPPr)
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
//
// `bodyPPr` — свойства абзаца из шаблона (шрифт, отступ, интервал). Применяются только к абзацу
// БЕЗ своего стиля: у заголовка и цитаты оформление задаёт стиль, и навязывать им абзацные
// свойства плейсхолдера значило бы спорить с шаблоном.
func docxRunsParagraph(runs []inlineRun, style, bodyPPr string) string {
	var b strings.Builder
	b.WriteString("<w:p>")
	switch {
	case style != "":
		fmt.Fprintf(&b, `<w:pPr><w:pStyle w:val="%s"/></w:pPr>`, style)
	case bodyPPr != "":
		b.WriteString(bodyPPr)
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
