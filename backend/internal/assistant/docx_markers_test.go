package assistant

// docx_markers_test.go — маркеры DOCX глазами помощника (0.92.0).
//
// Проверяем две вещи, которые ломаются тихо:
//   - модель склеила маркер с абзацем — тогда он не работает, а человек этого не заметит;
//   - правила не сказали, какие стили есть в шаблоне, — тогда модель выдумывает имена.

import (
	"strings"
	"testing"
)

func TestCheckDocxMarkersAcceptsDictionary(t *testing.T) {
	body := strings.Join([]string{
		"Первый абзац.",
		"",
		"<!-- sf:pagebreak -->",
		"",
		"<!-- sf:toc -->",
		"",
		"<!-- sf:style=Эпиграф -->",
		"",
		"Эпиграф.",
		"",
		"<!-- sf:begin=Стих -->",
		"Строка стиха.",
		"<!-- sf:end -->",
		"",
		"Обычный текст.",
	}, "\n")
	if err := checkDocxMarkers(body); err != nil {
		t.Fatalf("правильные маркеры отклонены: %v", err)
	}
}

func TestCheckDocxMarkersRejectsGluedLine(t *testing.T) {
	body := "Абзац.\n<!-- sf:pagebreak --> ещё текст"
	err := checkDocxMarkers(body)
	if err == nil {
		t.Fatal("склеенный маркер принят")
	}
	if !strings.Contains(err.Error(), "целиком") {
		t.Fatalf("ошибка не объясняет причину: %v", err)
	}
}

func TestCheckDocxMarkersRejectsUnknownCommand(t *testing.T) {
	err := checkDocxMarkers("<!-- sf:newpage -->")
	if err == nil {
		t.Fatal("неизвестная команда принята")
	}
	if !strings.Contains(err.Error(), "pagebreak") {
		t.Fatalf("ошибка не перечисляет допустимое: %v", err)
	}
}

func TestCheckDocxMarkersRejectsEmptyStyle(t *testing.T) {
	if err := checkDocxMarkers("<!-- sf:style= -->"); err == nil {
		t.Fatal("пустое имя стиля принято")
	}
}

func TestCheckDocxMarkersIgnoresCodeAndPlainText(t *testing.T) {
	if err := checkDocxMarkers("Текст без маркеров."); err != nil {
		t.Fatalf("обычному тексту ошибка: %v", err)
	}
	code := "```html\n<!-- sf:pagebreak -->\n```"
	if err := checkDocxMarkers(code); err != nil {
		t.Fatalf("внутри блока кода маркер проверен: %v", err)
	}
	// Обычный HTML-комментарий — не наш: его нельзя ни отклонять, ни трактовать.
	if err := checkDocxMarkers("<!-- обычный комментарий -->"); err != nil {
		t.Fatalf("чужой комментарий отклонён: %v", err)
	}
}

func TestParseCreateKeepsMarkersAndRejectsGlued(t *testing.T) {
	limits := DefaultLimits(3)
	body := "Абзац.\n\n<!-- sf:pagebreak -->\n\nВторой абзац."
	args, err := ParseCreate(map[string]any{"title": "Глава", "body_md": body}, limits)
	if err != nil {
		t.Fatalf("правильный текст отклонён: %v", err)
	}
	if !strings.Contains(args.Body, "<!-- sf:pagebreak -->") {
		t.Fatalf("маркер потерян при разборе: %q", args.Body)
	}
	if _, err := ParseCreate(map[string]any{
		"title": "Глава", "body_md": "Абзац.\n<!-- sf:pagebreak --> ещё",
	}, limits); err == nil {
		t.Fatal("склеенный маркер дошёл до создания кадра")
	}
}

func TestDocxMarkupBlockListsStyles(t *testing.T) {
	block := docxMarkupBlock([]string{"Эпиграф", "Стих"})
	for _, want := range []string{"sf:pagebreak", "sf:toc", "sf:style=Имя", "Эпиграф", "Стих"} {
		if !strings.Contains(block, want) {
			t.Fatalf("в правилах нет %q: %s", want, block)
		}
	}
}

func TestDocxMarkupBlockForbidsStylesWithoutTemplate(t *testing.T) {
	block := docxMarkupBlock(nil)
	if strings.Contains(block, "sf:style=Имя") {
		t.Fatalf("без шаблона правила обещают стили: %s", block)
	}
	if !strings.Contains(block, "style= и begin= не используй") {
		t.Fatalf("нет запрета: %s", block)
	}
	// Разрыв и оглавление остаются: они не зависят от шаблона.
	if !strings.Contains(block, "sf:pagebreak") || !strings.Contains(block, "sf:toc") {
		t.Fatalf("пропали нешаблонные маркеры: %s", block)
	}
}
