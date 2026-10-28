package docxtpl

// template_test.go — разбор шаблона и вставка текста (0.91.0).
//
// Шаблон в тестах собирается здесь же: минимальный DOCX с титулом до плейсхолдера, стилями
// «Заголовок 1»/«Цитата» и свойствами абзаца (шрифт и отступ). Так проверяется именно то, ради
// чего шаблон существует: текст встаёт на место {{content}}, стили берутся из шаблона, чужие части
// (титул, связи, типы содержимого) не ломаются.

import (
	"archive/zip"
	"bytes"
	"errors"
	"strings"
	"testing"
)

// buildTemplate собирает пакет-шаблон.
func buildTemplate(t *testing.T, document, styles, rels string) []byte {
	t.Helper()
	var buf bytes.Buffer
	zw := zip.NewWriter(&buf)
	add := func(name, body string) {
		w, err := zw.Create(name)
		if err != nil {
			t.Fatalf("часть %s: %v", name, err)
		}
		if _, err := w.Write([]byte(body)); err != nil {
			t.Fatalf("запись %s: %v", name, err)
		}
	}
	add("[Content_Types].xml", `<?xml version="1.0" encoding="UTF-8"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
</Types>`)
	add("_rels/.rels", `<?xml version="1.0" encoding="UTF-8"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>`)
	add("word/document.xml", document)
	add("word/styles.xml", styles)
	add("word/_rels/document.xml.rels", rels)
	add("word/header1.xml", `<w:hdr xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:p><w:r><w:t>КОЛОНТИТУЛ АВТОРА</w:t></w:r></w:p></w:hdr>`)
	if err := zw.Close(); err != nil {
		t.Fatalf("архив: %v", err)
	}
	return buf.Bytes()
}

const testStyles = `<?xml version="1.0" encoding="UTF-8"?>
<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
<w:style w:type="paragraph" w:styleId="Normal"><w:name w:val="Normal"/></w:style>
<w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/></w:style>
<w:style w:type="paragraph" w:styleId="Heading2"><w:name w:val="heading 2"/></w:style>
<w:style w:type="paragraph" w:styleId="Title"><w:name w:val="Title"/></w:style>
<w:style w:type="paragraph" w:styleId="Quote"><w:name w:val="Quote"/></w:style>
<w:style w:type="character" w:styleId="Strong"><w:name w:val="Strong"/></w:style>
<w:style w:type="paragraph" w:customStyle="1" w:styleId="Epigraph"><w:name w:val="Эпиграф"/></w:style>
</w:styles>`

const testRels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/header" Target="header1.xml"/>
</Relationships>`

// document с титулом, колонтитулом и плейсхолдером в абзаце со своим шрифтом/отступом.
const testDocument = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
<w:body>
<w:p><w:pPr><w:pStyle w:val="Title"/></w:pPr><w:r><w:t>ТИТУЛ КНИГИ</w:t></w:r></w:p>
<w:p><w:pPr><w:pStyle w:val="Normal"/><w:ind w:firstLine="567"/><w:rPr><w:rFonts w:ascii="PT Serif"/></w:rPr></w:pPr><w:r><w:t>{{content}}</w:t></w:r></w:p>
<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1134" w:right="1134" w:bottom="1134" w:left="1418"/></w:sectPr>
</w:body>
</w:document>`

func TestParseTemplate(t *testing.T) {
	raw := buildTemplate(t, testDocument, testStyles, testRels)
	parsed, err := Parse("роман.docx", raw)
	if err != nil {
		t.Fatalf("разбор: %v", err)
	}
	if !parsed.Placeholder.Found {
		t.Fatal("плейсхолдер {{content}} не найден")
	}
	if parsed.Placeholder.ParagraphStyleID != "Normal" {
		t.Fatalf("стиль абзаца-плейсхолдера: %q", parsed.Placeholder.ParagraphStyleID)
	}
	if !strings.Contains(parsed.Placeholder.BodyPPr, `w:firstLine="567"`) {
		t.Fatalf("свойства абзаца не вытащены: %q", parsed.Placeholder.BodyPPr)
	}
	if parsed.Page.Width != 11906 || parsed.Page.Height != 16838 || parsed.Page.Orientation != "portrait" {
		t.Fatalf("страница: %+v", parsed.Page)
	}
	if parsed.Page.MarginLeft != 1418 {
		t.Fatalf("поле слева: %+v", parsed.Page)
	}
	// Карта стилей: заголовки и цитата есть, имени не было — берём id.
	report := parsed.Report
	if report.Mapping["heading1"] != "Heading1" || report.Mapping["heading2"] != "Heading2" {
		t.Fatalf("карта заголовков: %+v", report.Mapping)
	}
	if report.Mapping["body"] != "Normal" {
		t.Fatalf("карта обычного текста: %+v", report.Mapping)
	}
	// Найден свой стиль «Эпиграф» (customStyle) — он попадёт в панель «Разметка DOCX».
	found := false
	for _, style := range parsed.Styles {
		if style.ID == "Epigraph" && style.Name == "Эпиграф" && !style.Builtin {
			found = true
		}
	}
	if !found {
		t.Fatalf("свой стиль не разобран: %+v", parsed.Styles)
	}
	if report.HasNumbering {
		t.Fatal("numbering быть не должно")
	}
}

func TestParseTemplateWithoutPlaceholder(t *testing.T) {
	document := strings.Replace(testDocument, "{{content}}", "текст без плейсхолдера", 1)
	parsed, err := Parse("без.docx", buildTemplate(t, document, testStyles, testRels))
	if err != nil {
		t.Fatalf("разбор: %v", err)
	}
	if parsed.Placeholder.Found {
		t.Fatal("плейсхолдер найден там, где его нет")
	}
	if !strings.Contains(strings.Join(parsed.Report.Warnings, " "), "нет абзаца") {
		t.Fatalf("отчёт без предупреждения: %+v", parsed.Report.Warnings)
	}
}

func TestParseRejectsNotDocx(t *testing.T) {
	if _, err := Parse("файл.doc", bytes.Repeat([]byte("x"), 100)); !errors.Is(err, ErrBadTemplate) {
		t.Fatalf("не .docx: %v", err)
	}
	if _, err := Parse("пусто.docx", nil); !errors.Is(err, ErrBadTemplate) {
		t.Fatalf("пустой файл: %v", err)
	}
	if _, err := Parse("мусор.docx", bytes.Repeat([]byte("x"), 100)); !errors.Is(err, ErrBadTemplate) {
		t.Fatalf("не zip: %v", err)
	}
}

func TestInjectKeepsTemplateAndInsertsContent(t *testing.T) {
	raw := buildTemplate(t, testDocument, testStyles, testRels)
	content := `<w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>ГЛАВА ПЕРВАЯ</w:t></w:r></w:p>
<w:p><w:r><w:t>Текст главы.</w:t></w:r></w:p>`

	result, err := Inject(raw, InjectOptions{ContentXML: content})
	if err != nil {
		t.Fatalf("вставка: %v", err)
	}
	parts := readZip(t, result.Data)
	document := string(parts["word/document.xml"])
	if !strings.Contains(document, "ГЛАВА ПЕРВАЯ") || !strings.Contains(document, "Текст главы.") {
		t.Fatalf("текст не вставлен: %s", document)
	}
	if strings.Contains(document, PlaceholderText) {
		t.Fatal("плейсхолдер остался в документе")
	}
	if !strings.Contains(document, "ТИТУЛ КНИГИ") {
		t.Fatal("титул шаблона потерян")
	}
	sect := strings.Index(document, "<w:sectPr")
	if sect <= strings.Index(document, "Текст главы.") {
		t.Fatal("sectPr должен остаться в конце тела")
	}
	if _, ok := parts["word/header1.xml"]; !ok {
		t.Fatal("колонтитул шаблона потерян")
	}
	if !strings.Contains(string(parts["word/_rels/document.xml.rels"]), "header1.xml") {
		t.Fatal("связь колонтитула потеряна")
	}
}

func TestInjectAddsImagesWithFreeRelIDs(t *testing.T) {
	raw := buildTemplate(t, testDocument, testStyles, testRels)
	// В шаблоне заняты rId1 и rId2 — картинка должна получить rId3, а не перезаписать связь.
	next := NextRelationshipID(raw)
	if next != 3 {
		t.Fatalf("свободный rId: %d, ожидалось 3", next)
	}
	content := `<w:p><w:r><w:drawing><wp:inline xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing"><a:graphic xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:pic xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:blipFill><a:blip r:embed="rId3"/></pic:blipFill></pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r></w:p>`
	result, err := Inject(raw, InjectOptions{
		ContentXML: content,
		Media: []Media{{
			Name:  "media/01.png",
			Data:  []byte("\x89PNG fake"),
			Mime:  "image/png",
			RelID: "rId3",
		}},
	})
	if err != nil {
		t.Fatalf("вставка с картинкой: %v", err)
	}
	parts := readZip(t, result.Data)
	rels := string(parts["word/_rels/document.xml.rels"])
	if !strings.Contains(rels, `Id="rId3"`) || !strings.Contains(rels, "media/01.png") {
		t.Fatalf("связь картинки: %s", rels)
	}
	if !strings.Contains(rels, `Id="rId2"`) {
		t.Fatal("чужая связь (колонтитул) потеряна")
	}
	if _, ok := parts["word/media/01.png"]; !ok {
		t.Fatal("файла картинки нет в пакете")
	}
	if !strings.Contains(string(parts["[Content_Types].xml"]), `Extension="png"`) {
		t.Fatal("расширение png не объявлено в типах содержимого")
	}
}

func TestInjectRefusesWithoutPlaceholder(t *testing.T) {
	document := strings.Replace(testDocument, "{{content}}", "нет", 1)
	_, err := Inject(buildTemplate(t, document, testStyles, testRels), InjectOptions{ContentXML: "<w:p/>"})
	if !errors.Is(err, ErrNoPlaceholder) {
		t.Fatalf("ожидался ErrNoPlaceholder, получено %v", err)
	}
}

func TestInjectRejectsMacros(t *testing.T) {
	raw := buildTemplate(t, testDocument, testStyles, testRels)
	// Добавим часть с макросами — шаблоном оформления такие файлы не бывают.
	var buf bytes.Buffer
	in, err := zip.NewReader(bytes.NewReader(raw), int64(len(raw)))
	if err != nil {
		t.Fatalf("zip: %v", err)
	}
	zw := zip.NewWriter(&buf)
	for _, file := range in.File {
		w, _ := zw.Create(file.Name)
		rc, _ := file.Open()
		_, _ = w.Write(readAll(t, rc))
		rc.Close()
	}
	w, _ := zw.Create("word/vbaProject.bin")
	_, _ = w.Write([]byte("macro"))
	_ = zw.Close()
	if _, err := Parse("макрос.docx", buf.Bytes()); err == nil {
		t.Fatal("файл с макросами принят шаблоном")
	}
}

func readZip(t *testing.T, raw []byte) map[string][]byte {
	t.Helper()
	zr, err := zip.NewReader(bytes.NewReader(raw), int64(len(raw)))
	if err != nil {
		t.Fatalf("результат не zip: %v", err)
	}
	out := make(map[string][]byte, len(zr.File))
	for _, file := range zr.File {
		rc, err := file.Open()
		if err != nil {
			t.Fatalf("часть %s: %v", file.Name, err)
		}
		out[file.Name] = readAll(t, rc)
		rc.Close()
	}
	return out
}

func readAll(t *testing.T, rc interface{ Read([]byte) (int, error) }) []byte {
	t.Helper()
	var buf bytes.Buffer
	chunk := make([]byte, 4096)
	for {
		n, err := rc.Read(chunk)
		buf.Write(chunk[:n])
		if err != nil {
			return buf.Bytes()
		}
	}
}
