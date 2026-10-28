package transfer_test

// export_docx_template_test.go — скачивание DOCX в оформлении автора (0.91.0).
//
// Проверяем то, ради чего шаблон существует: файл собирается в ПАКЕТЕ шаблона — титул и колонтитул
// автора остаются, текст проекта встаёт на место {{content}}, стили берутся из шаблона, а картинки
// проекта получают СВОБОДНЫЕ идентификаторы связей (иначе ломаются связи шаблона).
//
// Тест нарочно проверяет и «чужое»: колонтитул шаблона и его связь. Именно они отваливаются у
// самодельных конвертеров, которые «просто вставляют текст в новый документ».

import (
	"archive/zip"
	"bytes"
	"context"
	"strings"
	"testing"
)

// templatePackage собирает шаблон: титул, колонтитул, стили и {{content}} с настройками абзаца.
func templatePackage(t *testing.T) []byte {
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
	add("word/styles.xml", `<?xml version="1.0" encoding="UTF-8"?>
<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
<w:style w:type="paragraph" w:styleId="Normal"><w:name w:val="Normal"/></w:style>
<w:style w:type="paragraph" w:styleId="Title"><w:name w:val="Title"/></w:style>
<w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/></w:style>
<w:style w:type="paragraph" w:styleId="Heading2"><w:name w:val="heading 2"/></w:style>
</w:styles>`)
	add("word/document.xml", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>
<w:p><w:pPr><w:pStyle w:val="Title"/></w:pPr><w:r><w:t>ТИТУЛ ИЗДАТЕЛЬСТВА</w:t></w:r></w:p>
<w:p><w:pPr><w:pStyle w:val="Normal"/><w:ind w:firstLine="567"/></w:pPr><w:r><w:t>{{content}}</w:t></w:r></w:p>
<w:sectPr><w:pgSz w:w="11906" w:h="16838"/></w:sectPr>
</w:body></w:document>`)
	add("word/header1.xml", `<w:hdr xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:p><w:r><w:t>КОЛОНТИТУЛ АВТОРА</w:t></w:r></w:p></w:hdr>`)
	add("word/_rels/document.xml.rels", `<?xml version="1.0" encoding="UTF-8"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/header" Target="header1.xml"/>
</Relationships>`)
	if err := zw.Close(); err != nil {
		t.Fatalf("архив: %v", err)
	}
	return buf.Bytes()
}

func TestExportDOCXUsesTemplate(t *testing.T) {
	e := setup(t)
	ctx := context.Background()
	owner := e.user(t, "owner@example.com")
	project, _, _ := e.projectWithBook(t, owner)

	raw := templatePackage(t)
	if _, err := e.docx.Upload(ctx, owner, project, "рукопись", "рукопись.docx", int64(len(raw)), bytes.NewReader(raw)); err != nil {
		t.Fatalf("загрузка шаблона: %v", err)
	}

	var buf bytes.Buffer
	info, err := e.transfer.ExportDOCX(ctx, owner, project, &buf)
	if err != nil {
		t.Fatalf("docx: %v", err)
	}
	if info.Events != 3 {
		t.Fatalf("кадров: %d", info.Events)
	}
	files, _ := zipFiles(t, buf.Bytes())

	document := files["word/document.xml"]
	if document == "" {
		t.Fatal("нет word/document.xml")
	}
	// Шаблон остался основой: титул автора на месте, плейсхолдер заменён текстом проекта.
	if !strings.Contains(document, "ТИТУЛ ИЗДАТЕЛЬСТВА") {
		t.Fatal("титул шаблона потерян")
	}
	if strings.Contains(document, "{{content}}") {
		t.Fatal("плейсхолдер остался в документе")
	}
	if !strings.Contains(document, "Глава 1") || !strings.Contains(document, "Под-событие") {
		t.Fatalf("текст проекта не вставлен: %s", document)
	}
	// Стили — из шаблона, а не наши встроенные (у шаблона только эти два заголовка).
	if !strings.Contains(files["word/styles.xml"], "heading 1") {
		t.Fatal("стили шаблона потеряны")
	}
	// Колонтитул и его связь — на месте.
	if !strings.Contains(files["word/header1.xml"], "КОЛОНТИТУЛ АВТОРА") {
		t.Fatal("колонтитул шаблона потерян")
	}
	if !strings.Contains(files["word/_rels/document.xml.rels"], "header1.xml") {
		t.Fatal("связь колонтитула потеряна")
	}
	// Чужие rId1/rId2 не перезаписаны картинками проекта.
	rels := files["word/_rels/document.xml.rels"]
	if !strings.Contains(rels, `Id="rId1"`) || !strings.Contains(rels, `Id="rId2"`) {
		t.Fatalf("связи шаблона перезаписаны: %s", rels)
	}
	// Картинка проекта попала в пакет под свободным rId.
	var imagePart string
	for name := range files {
		if strings.HasPrefix(name, "word/media/") {
			imagePart = name
			break
		}
	}
	if imagePart == "" {
		t.Fatal("картинка проекта не попала в документ")
	}
	if !strings.Contains(rels, imagePart[len("word/"):]) {
		t.Fatalf("связь картинки (%s) не добавлена: %s", imagePart, rels)
	}
}

func TestExportDOCXWithoutTemplateUnchanged(t *testing.T) {
	e := setup(t)
	ctx := context.Background()
	owner := e.user(t, "owner@example.com")
	project, _, _ := e.projectWithBook(t, owner)

	var buf bytes.Buffer
	if _, err := e.transfer.ExportDOCX(ctx, owner, project, &buf); err != nil {
		t.Fatalf("docx: %v", err)
	}
	files, _ := zipFiles(t, buf.Bytes())
	if !strings.Contains(files["word/document.xml"], "Глава 1") {
		t.Fatal("встроенная сборка сломалась")
	}
	// Без шаблона используется наш styles.xml (в нём есть ListNested — примета встроенного набора).
	if !strings.Contains(files["word/styles.xml"], "ListNested") {
		t.Fatal("встроенные стили подменены")
	}
}
