package docxtpl

// sample.go — готовый пример шаблона оформления DOCX (0.94.0).
//
// Зачем: чтобы «сделать свой шаблон» не начиналось с чтения документации. Человек скачивает
// пример, открывает в Word, меняет шрифты/титул/колонтитул и загружает обратно. Пример
// ГАРАНТИРОВАННО принимается нашим же разбором (это проверяет тест): в нём есть абзац
// {{content}} отдельной строкой и стили с теми именами, которые карта сопоставления ищет.
//
// Что в примере есть намеренно:
//   * титульная строка стилем Title и обычный абзац-подсказка — видно, что титул остаётся автора;
//   * колонтитул: именно он теряется у самодельных конвертеров, и в примере видно, что он живёт
//     в отдельной части пакета и после выгрузки остаётся;
//   * стили Heading1–Heading4, Quote, Code, Date, ListParagraph — ровно те, что разбор умеет
//     сопоставить; если в своём шаблоне оставить эти имена, оформление заработает без правок;
//   * поля страницы 2 см и A4 — их человек заменит своими.

import (
	"archive/zip"
	"bytes"
)

// SampleTemplate собирает пример шаблона. Возвращает готовый .docx.
func SampleTemplate() []byte {
	var buf bytes.Buffer
	zw := zip.NewWriter(&buf)
	parts := []struct{ name, body string }{
		{"[Content_Types].xml", sampleContentTypes},
		{"_rels/.rels", sampleRootRels},
		{"docProps/core.xml", sampleCore},
		{"word/document.xml", sampleDocument},
		{"word/styles.xml", sampleStyles},
		{"word/header1.xml", sampleHeader},
		{"word/_rels/document.xml.rels", sampleDocumentRels},
	}
	for _, part := range parts {
		w, err := zw.Create(part.name)
		if err != nil {
			// bytes.Buffer и zip.Writer ошибок не дают; но если дадут — пустой файл лучше не
			// отдавать, и вызывающий увидит это по отсутствию абзаца {{content}}.
			_ = zw.Close()
			return nil
		}
		if _, err := w.Write([]byte(part.body)); err != nil {
			_ = zw.Close()
			return nil
		}
	}
	if err := zw.Close(); err != nil {
		return nil
	}
	return buf.Bytes()
}

const sampleContentTypes = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
<Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>
<Override PartName="/word/header1.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.header+xml"/>
<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>
</Types>`

const sampleRootRels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/>
</Relationships>`

const sampleCore = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties"
  xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/"
  xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
<dc:title>Пример шаблона SkyFraze</dc:title>
<dc:creator>SkyFraze</dc:creator>
<dcterms:created xsi:type="dcterms:W3CDTF">2026-01-01T00:00:00Z</dcterms:created>
</cp:coreProperties>`

// sampleDocument — титул, подсказка и абзац-плейсхолдер. Подсказка остаётся в готовом документе:
// человек, скачавший книгу, видит, что титул он может менять в шаблоне, а не в проекте.
const sampleDocument = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"
  xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
<w:body>
<w:p><w:pPr><w:pStyle w:val="Title"/></w:pPr><w:r><w:t>Титул вашего издательства</w:t></w:r></w:p>
<w:p><w:pPr><w:pStyle w:val="Normal"/></w:pPr><w:r><w:t>Этот абзац можно изменить или удалить: он остаётся в готовом документе.</w:t></w:r></w:p>
<w:p><w:pPr><w:pStyle w:val="Normal"/><w:ind w:firstLine="567"/></w:pPr><w:r><w:t>{{content}}</w:t></w:r></w:p>
<w:sectPr>
<w:headerReference w:type="default" r:id="rId2"/>
<w:pgSz w:w="11906" w:h="16838"/>
<w:pgMar w:top="1134" w:right="1134" w:bottom="1134" w:left="1134"/>
</w:sectPr>
</w:body></w:document>`

const sampleHeader = `<w:hdr xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
<w:p><w:pPr><w:jc w:val="right"/></w:pPr><w:r><w:t>Колонтитул шаблона — он останется в готовом документе</w:t></w:r></w:p>
</w:hdr>`

const sampleDocumentRels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/header" Target="header1.xml"/>
</Relationships>`

// sampleStyles — стили с именами, которые ищет карта сопоставления (см. buildReport).
//
// Оформление нарочно «нейтральное»: Georgia 12 pt, как у встроенного набора. Человек меняет
// шрифт и отступы под свою рукопись, а имена стилей оставляет — тогда оформление заработает.
const sampleStyles = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
<w:docDefaults><w:rPrDefault><w:rPr>
<w:rFonts w:ascii="Georgia" w:hAnsi="Georgia" w:cs="Georgia"/>
<w:sz w:val="24"/><w:lang w:val="ru-RU"/>
</w:rPr></w:rPrDefault></w:docDefaults>
<w:style w:type="paragraph" w:styleId="Normal"><w:name w:val="Normal"/>
<w:pPr><w:spacing w:after="120" w:line="360" w:lineRule="auto"/></w:pPr></w:style>
<w:style w:type="paragraph" w:styleId="Title"><w:name w:val="Title"/>
<w:pPr><w:spacing w:before="240" w:after="240"/></w:pPr><w:rPr><w:b/><w:sz w:val="48"/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/>
<w:pPr><w:pageBreakBefore/><w:spacing w:before="360" w:after="120"/></w:pPr><w:rPr><w:b/><w:sz w:val="36"/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="Heading2"><w:name w:val="heading 2"/>
<w:pPr><w:spacing w:before="240" w:after="80"/></w:pPr><w:rPr><w:b/><w:sz w:val="28"/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="Heading3"><w:name w:val="heading 3"/>
<w:pPr><w:spacing w:before="180" w:after="60"/></w:pPr><w:rPr><w:b/><w:sz w:val="26"/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="Heading4"><w:name w:val="heading 4"/>
<w:pPr><w:spacing w:before="120" w:after="60"/></w:pPr><w:rPr><w:b/><w:i/><w:sz w:val="24"/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="Quote"><w:name w:val="Quote"/>
<w:pPr><w:ind w:left="567"/></w:pPr><w:rPr><w:i/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="Code"><w:name w:val="Code"/>
<w:pPr><w:ind w:left="283"/></w:pPr>
<w:rPr><w:rFonts w:ascii="Consolas" w:hAnsi="Consolas"/><w:sz w:val="20"/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="Date"><w:name w:val="Date"/>
<w:rPr><w:color w:val="666666"/><w:sz w:val="20"/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="ListParagraph"><w:name w:val="List Paragraph"/>
<w:pPr><w:ind w:left="567"/></w:pPr></w:style>
</w:styles>`
