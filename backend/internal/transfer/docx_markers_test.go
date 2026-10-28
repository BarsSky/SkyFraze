package transfer

// docx_markers_test.go — разбор маркеров DOCX (0.92.0).
//
// Тест внутренний (package transfer): разбор — чистая функция над текстом, и проверять её через
// выгрузку значило бы проверять три вещи сразу. Внешняя сторона — сборка документа — проверяется
// в export_docx_markers_test.go.

import (
	"strings"
	"testing"
)

func TestParseDocxMarkerLine(t *testing.T) {
	cases := []struct {
		line  string
		kind  string
		style string
		ok    bool
	}{
		{"<!-- sf:pagebreak -->", "pagebreak", "", true},
		{"  <!-- sf:pagebreak -->  ", "pagebreak", "", true},
		{"<!-- sf:toc -->", "toc", "", true},
		{"<!-- sf:style=Эпиграф -->", "style", "Эпиграф", true},
		{"<!-- sf:style= Эпиграф -->", "style", "Эпиграф", true},
		{"<!-- sf:begin=Стих -->", "begin", "Стих", true},
		{"<!-- sf:end -->", "end", "", true},
		{"<!-- sf:unknown -->", "", "", false},
		{"<!-- skyfraze: number=01 id=x kind=event -->", "", "", false},
		{"текст <!-- sf:pagebreak -->", "", "", false},
		{"<!-- sf:pagebreak --> текст", "", "", false},
		{"", "", "", false},
	}
	for _, c := range cases {
		marker, ok := parseDocxMarkerLine(c.line)
		if ok != c.ok {
			t.Fatalf("%q: разобран=%v, хотим %v", c.line, ok, c.ok)
		}
		if !ok {
			continue
		}
		if marker.kind != c.kind || marker.style != c.style {
			t.Fatalf("%q: %+v, хотим kind=%q style=%q", c.line, marker, c.kind, c.style)
		}
	}
}

func TestSplitDocxSectionsWithoutMarkers(t *testing.T) {
	sections := splitDocxSections("Абзац один.\n\nАбзац два.")
	if len(sections) != 1 {
		t.Fatalf("кусков: %d", len(sections))
	}
	if sections[0].style != "" {
		t.Fatalf("стиль без маркера: %q", sections[0].style)
	}
	if len(sections[0].blocks) != 2 {
		t.Fatalf("блоков: %d", len(sections[0].blocks))
	}
	if got := splitDocxSections("   \n\n"); len(got) != 0 {
		t.Fatalf("пустой текст дал %d кусков", len(got))
	}
}

func TestSplitDocxSectionsPageBreakAndTOC(t *testing.T) {
	body := strings.Join([]string{
		"Первый кусок.",
		"<!-- sf:pagebreak -->",
		"Второй кусок.",
		"<!-- sf:toc -->",
	}, "\n")
	sections := splitDocxSections(body)
	if len(sections) != 4 {
		t.Fatalf("кусков: %d (%+v)", len(sections), sections)
	}
	if sections[0].style != "" || len(sections[0].blocks) != 1 {
		t.Fatalf("первый кусок: %+v", sections[0])
	}
	if !sections[1].pagebreak {
		t.Fatal("разрыв страницы не распознан")
	}
	if len(sections[2].blocks) != 1 {
		t.Fatalf("второй кусок: %+v", sections[2])
	}
	if !sections[3].toc {
		t.Fatal("оглавление не распознано")
	}
}

func TestSplitDocxSectionsStyleMarkerAppliesOnce(t *testing.T) {
	body := strings.Join([]string{
		"Обычный текст.",
		"<!-- sf:style=Эпиграф -->",
		"Кусок в эпиграфе.",
		"Обычный текст снова.",
	}, "\n")
	sections := splitDocxSections(body)
	if len(sections) != 2 {
		t.Fatalf("кусков: %d (%+v)", len(sections), sections)
	}
	if sections[0].style != "" {
		t.Fatalf("стиль до маркера: %q", sections[0].style)
	}
	// Маркер действует до конца текста — это и записано в подсказке интерфейса: «второй
	// маркер style= или begin=…end». Проверяем ровно то, что обещали.
	if sections[1].style != "Эпиграф" {
		t.Fatalf("стиль после маркера: %q", sections[1].style)
	}
}

func TestSplitDocxSectionsBeginEnd(t *testing.T) {
	body := strings.Join([]string{
		"Обычный.",
		"<!-- sf:begin=Стих -->",
		"Строка стиха.",
		"<!-- sf:end -->",
		"Обычный снова.",
	}, "\n")
	sections := splitDocxSections(body)
	if len(sections) != 3 {
		t.Fatalf("кусков: %d (%+v)", len(sections), sections)
	}
	if sections[0].style != "" {
		t.Fatalf("до begin: %q", sections[0].style)
	}
	if sections[1].style != "Стих" {
		t.Fatalf("внутри begin:end: %q", sections[1].style)
	}
	if sections[2].style != "" {
		t.Fatalf("после end: %q", sections[2].style)
	}
}

func TestSplitDocxSectionsIgnoresMarkersInFence(t *testing.T) {
	body := strings.Join([]string{
		"```",
		"<!-- sf:pagebreak -->",
		"```",
		"После кода.",
	}, "\n")
	sections := splitDocxSections(body)
	if len(sections) != 1 {
		t.Fatalf("маркер внутри ``` разобран: %+v", sections)
	}
	if sections[0].blocks[0].Kind != "code" {
		t.Fatalf("первый блок: %q", sections[0].blocks[0].Kind)
	}
}

func TestStripDocxMarkers(t *testing.T) {
	body := strings.Join([]string{
		"Первый.",
		"<!-- sf:pagebreak -->",
		"<!-- sf:toc -->",
		"<!-- sf:style=Эпиграф -->",
		"Второй.",
	}, "\n")
	got := stripDocxMarkers(body)
	if strings.Contains(got, "<!-- sf:") {
		t.Fatalf("маркеры остались: %q", got)
	}
	if !strings.Contains(got, "Первый.") || !strings.Contains(got, "Второй.") {
		t.Fatalf("текст потерян: %q", got)
	}
	// Абзацы не слипаются: на месте маркера осталась пустая строка.
	if !strings.Contains(got, "Первый.\n\n\n\nВторой.") {
		t.Fatalf("структура абзацев изменилась: %q", got)
	}
}

func TestStripDocxMarkersKeepsFence(t *testing.T) {
	body := "```\n<!-- sf:pagebreak -->\n```\n"
	if got := stripDocxMarkers(body); !strings.Contains(got, "<!-- sf:pagebreak -->") {
		t.Fatalf("маркер внутри кода вырезан: %q", got)
	}
}

func TestStripDocxMarkersFastPath(t *testing.T) {
	body := "Текст без маркеров."
	if got := stripDocxMarkers(body); got != body {
		t.Fatalf("текст изменён: %q", got)
	}
}
