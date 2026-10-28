package transfer_test

// export_docx_markers_test.go — маркеры DOCX в выгрузках (0.92.0, docs/docx-template.md §3).
//
// Проверяем три приёмника сразу, потому что «куда маркер попал, а куда нет» — это и есть решение:
//   - DOCX читает: разрыв страницы и оглавление становятся полями Word, `style=`/`begin=` — стилем
//     абзаца из шаблона, а служебные комментарии в текст не попадают;
//   - EPUB вырезает: у книги нет понятия «стиль абзаца из шаблона», а показывать читателю
//     `<!-- sf:... -->` нельзя;
//   - Markdown сохраняет: `.md` — исходник, и импорт должен вернуть разметку как была.

import (
	"bytes"
	"context"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"

	"github.com/skyfraze/backend/internal/store"
)

// projectWithMarkers — проект из двух глав, в тексте которых есть все четыре маркера.
func (e *env) projectWithMarkers(t *testing.T, owner uuid.UUID) uuid.UUID {
	t.Helper()
	ctx := context.Background()
	project, err := e.proj.Create(ctx, owner, "Книга с разметкой", "Описание")
	if err != nil {
		t.Fatalf("проект: %v", err)
	}
	chapter := uuid.New()
	body := strings.Join([]string{
		"Первый абзац главы.",
		"",
		"<!-- sf:pagebreak -->",
		"",
		"<!-- sf:style=Эпиграф -->",
		"",
		"Строки эпиграфа.",
	}, "\n")
	second := strings.Join([]string{
		"<!-- sf:toc -->",
		"",
		"<!-- sf:begin=Стих -->",
		"",
		"Строка стиха.",
		"",
		"<!-- sf:end -->",
		"",
		"Обычный текст после стиха.",
	}, "\n")
	date := time.Date(2026, 3, 1, 0, 0, 0, 0, time.UTC)
	if err := e.st.ReplaceEventTree(ctx, project.ID, owner, []store.Event{
		{ID: chapter, ProjectID: project.ID, Position: 0, Depth: 0, Title: "Глава 1",
			Body: body, EventDate: &date},
		{ID: uuid.New(), ProjectID: project.ID, Position: 1, Depth: 0, Title: "Глава 2",
			Body: second},
	}); err != nil {
		t.Fatalf("дерево: %v", err)
	}
	return project.ID
}

func TestExportDOCXReadsMarkers(t *testing.T) {
	e := setup(t)
	ctx := context.Background()
	owner := e.user(t, "owner@example.com")
	project := e.projectWithMarkers(t, owner)

	var buf bytes.Buffer
	if _, err := e.transfer.ExportDOCX(ctx, owner, project, &buf); err != nil {
		t.Fatalf("docx: %v", err)
	}
	files, _ := zipFiles(t, buf.Bytes())
	document := files["word/document.xml"]
	if document == "" {
		t.Fatal("нет word/document.xml")
	}

	// Служебные комментарии не должны попасть в документ: это не текст рукописи.
	if strings.Contains(document, "<!-- sf:") {
		t.Fatalf("маркер остался текстом: %s", document)
	}
	// Разрыв страницы — именно разрыв, а не абзац с текстом.
	if !strings.Contains(document, `<w:br w:type="page"/>`) {
		t.Fatalf("нет разрыва страницы: %s", document)
	}
	// Оглавление — поле TOC, а не выдуманный нами список.
	if !strings.Contains(document, `TOC \o "1-3"`) {
		t.Fatalf("нет поля оглавления: %s", document)
	}
	// style= и begin…end дают стиль шаблона абзацам своего куска.
	if !strings.Contains(document, `<w:pStyle w:val="Эпиграф"/>`) {
		t.Fatalf("стиль style= не применён: %s", document)
	}
	if !strings.Contains(document, `<w:pStyle w:val="Стих"/>`) {
		t.Fatalf("стиль begin/end не применён: %s", document)
	}
	// Текст кусков на месте.
	for _, want := range []string{"Первый абзац главы.", "Строки эпиграфа.", "Строка стиха.",
		"Обычный текст после стиха."} {
		if !strings.Contains(document, want) {
			t.Fatalf("потерян текст %q: %s", want, document)
		}
	}
}

func TestExportEPUBStripsMarkers(t *testing.T) {
	e := setup(t)
	ctx := context.Background()
	owner := e.user(t, "owner@example.com")
	project := e.projectWithMarkers(t, owner)

	var buf bytes.Buffer
	if _, err := e.transfer.ExportEPUB(ctx, owner, project, &buf); err != nil {
		t.Fatalf("epub: %v", err)
	}
	files, _ := zipFiles(t, buf.Bytes())
	page := files["OEBPS/text/chapter-01.xhtml"]
	if page == "" {
		t.Fatal("нет первой главы")
	}
	if strings.Contains(page, "<!-- sf:") {
		t.Fatalf("маркер попал в книгу: %s", page)
	}
	for _, want := range []string{"Первый абзац главы.", "Строки эпиграфа."} {
		if !strings.Contains(page, want) {
			t.Fatalf("потерян текст %q: %s", want, page)
		}
	}
}

func TestExportMarkdownKeepsMarkers(t *testing.T) {
	e := setup(t)
	ctx := context.Background()
	owner := e.user(t, "owner@example.com")
	project := e.projectWithMarkers(t, owner)

	var buf bytes.Buffer
	if _, err := e.transfer.ExportMarkdown(ctx, owner, project, &buf); err != nil {
		t.Fatalf("markdown: %v", err)
	}
	md := buf.String()
	for _, want := range []string{"<!-- sf:pagebreak -->", "<!-- sf:style=Эпиграф -->",
		"<!-- sf:toc -->", "<!-- sf:begin=Стих -->", "<!-- sf:end -->"} {
		if !strings.Contains(md, want) {
			t.Fatalf("маркер %q потерян в .md: %s", want, md)
		}
	}
}
