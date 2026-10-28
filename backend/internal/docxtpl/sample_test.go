package docxtpl_test

// sample_test.go — пример шаблона принимается нашим же разбором (0.94.0).
//
// Пример существует, чтобы «сделать свой шаблон» не начиналось с чтения документации: человек
// скачивает файл, правит оформление и загружает обратно. Значит, проверять надо главное —
// собственный разбор обязан найти в нём и плейсхолдер, и ВСЕ стили карты сопоставления. Иначе
// человек скачает пример, загрузит его без изменений и получит предупреждения.

import (
	"archive/zip"
	"bytes"
	"strings"
	"testing"

	"github.com/skyfraze/backend/internal/docxtpl"
)

func TestSampleTemplateParses(t *testing.T) {
	raw := docxtpl.SampleTemplate()
	if len(raw) == 0 {
		t.Fatal("пример шаблона пустой")
	}
	parsed, err := docxtpl.Parse("пример.docx", raw)
	if err != nil {
		t.Fatalf("пример не разобрался: %v", err)
	}
	if !parsed.Placeholder.Found {
		t.Fatal("в примере нет абзаца {{content}}")
	}
	// Карта сопоставления должна быть полной: ради этого пример и существует.
	want := []string{"title", "heading1", "heading2", "heading3", "heading4", "quote", "code", "date", "list", "body"}
	for _, key := range want {
		if parsed.Report.Mapping[key] == "" {
			t.Errorf("в примере не сопоставлен стиль «%s»: %+v", key, parsed.Report.Mapping)
		}
	}
	// Предупреждения — это «шаблон не совпал с ожиданием». В готовом примере их быть не должно.
	if len(parsed.Report.Warnings) > 0 {
		t.Fatalf("у примера есть предупреждения разбора: %v", parsed.Report.Warnings)
	}
	// Колонтитул и стили на месте — по ним видно, что оформление берётся из пакета шаблона.
	if parsed.Report.Page.Width == 0 {
		t.Error("поля страницы не разобраны")
	}
}

func TestSampleTemplateContainsHeader(t *testing.T) {
	raw := docxtpl.SampleTemplate()
	reader, err := zip.NewReader(bytes.NewReader(raw), int64(len(raw)))
	if err != nil {
		t.Fatalf("пример не zip: %v", err)
	}
	parts := map[string]string{}
	for _, file := range reader.File {
		handle, err := file.Open()
		if err != nil {
			t.Fatalf("часть %s: %v", file.Name, err)
		}
		var buf bytes.Buffer
		if _, err := buf.ReadFrom(handle); err != nil {
			handle.Close()
			t.Fatalf("чтение %s: %v", file.Name, err)
		}
		handle.Close()
		parts[file.Name] = buf.String()
	}
	// Колонтитул: именно его теряют самодельные конвертеры, поэтому в примере он должен быть —
	// и связан с телом документа, иначе Word его не покажет.
	if !strings.Contains(parts["word/header1.xml"], "Колонтитул") {
		t.Fatal("в примере нет колонтитула")
	}
	if !strings.Contains(parts["word/_rels/document.xml.rels"], "header1.xml") {
		t.Fatal("колонтитул не связан с документом")
	}
	parsed, err := docxtpl.Parse("пример.docx", raw)
	if err != nil {
		t.Fatalf("разбор: %v", err)
	}
	if parsed.Placeholder.Text != docxtpl.PlaceholderText {
		t.Fatalf("текст плейсхолдера: %q", parsed.Placeholder.Text)
	}
}
