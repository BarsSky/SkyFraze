package assistant

// paragraphs_test.go — правка кадра абзацами (0.143.0).
//
// Проверяем ровно то, на чём обрывалась живая gemma: она не может отдать всю главу одним
// куском, но может отдать один абзац. Значит, сервер должен уметь показать абзацы с
// номерами и собрать текст обратно после замены одного из них — не потеряв остальные.

import (
	"strings"
	"testing"

	"github.com/google/uuid"
)

func TestSplitParagraphs(t *testing.T) {
	cases := []struct {
		name string
		body string
		want []string
	}{
		{"пустой текст", "", nil},
		{"только пробелы", "  \n\n \t ", nil},
		{"один абзац", "Жил смотритель у маяка.", []string{"Жил смотритель у маяка."}},
		{
			"три абзаца",
			"Первый.\n\nВторой.\n\nТретий.",
			[]string{"Первый.", "Второй.", "Третий."},
		},
		{
			"лишние пустые строки не создают пустых абзацев",
			"Первый.\n\n\n\nВторой.\n \n \nТретий.",
			[]string{"Первый.", "Второй.", "Третий."},
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got := splitParagraphs(tc.body)
			if len(got) != len(tc.want) {
				t.Fatalf("абзацев %d, ожидалось %d: %#v", len(got), len(tc.want), got)
			}
			for i := range got {
				if got[i] != tc.want[i] {
					t.Fatalf("абзац %d = %q, ожидался %q", i+1, got[i], tc.want[i])
				}
			}
		})
	}
}

func TestReplaceParagraph(t *testing.T) {
	body := "Первый.\n\nВторой.\n\nТретий."

	got, ok := replaceParagraph(body, 2, "Второй, но по-другому.")
	if !ok {
		t.Fatal("абзац 2 не найден, хотя он есть")
	}
	want := "Первый.\n\nВторой, но по-другому.\n\nТретий."
	if got != want {
		t.Fatalf("текст после замены:\n%q\nожидался:\n%q", got, want)
	}

	// Соседние абзацы не должны пострадать: правка «одного абзаца» не имеет права
	// переписать главу — иначе человек подтвердит не то, что просил.
	if !strings.Contains(got, "Первый.") || !strings.Contains(got, "Третий.") {
		t.Fatalf("замена абзаца потеряла соседей: %q", got)
	}

	// Пустой текст — законное действие: абзац убирается (0.143.0).
	if got, ok := replaceParagraph(body, 3, "  "); !ok || got != "Первый.\n\nВторой." {
		t.Fatalf("удаление абзаца дало %q (ok=%v)", got, ok)
	}

	for _, index := range []int{0, -1, 4, 99} {
		if _, ok := replaceParagraph(body, index, "что-то"); ok {
			t.Fatalf("абзац %d не должен считаться найденным", index)
		}
	}
	if _, ok := replaceParagraph("", 1, "текст"); ok {
		t.Fatal("в пустом кадре нет абзаца 1")
	}
}

func TestParagraphPage(t *testing.T) {
	body := "Один.\n\nДва.\n\nТри.\n\nЧетыре."
	rows, total := paragraphPage(body, 2, 2)
	if total != 4 {
		t.Fatalf("всего абзацев %d, ожидалось 4", total)
	}
	if len(rows) != 2 || rows[0].Number != 2 || rows[1].Number != 3 {
		t.Fatalf("страница не та: %#v", rows)
	}
	if rows[0].Text != "Два." || rows[1].Text != "Три." {
		t.Fatalf("текст страницы не тот: %#v", rows)
	}

	// За пределами текста — пусто, но всего абзацев по-прежнему известно: по этому числу
	// модель понимает, что дочитала, а не что кадр пуст.
	rows, total = paragraphPage(body, 10, 5)
	if len(rows) != 0 || total != 4 {
		t.Fatalf("за концом: строк %d, всего %d", len(rows), total)
	}

	// Длинный абзац режется с пометкой: модели нужен смысл, а не весь монолог.
	long := strings.Repeat("а", paragraphLimit+50)
	rows, _ = paragraphPage(long, 1, 1)
	if len(rows) != 1 || !rows[0].Truncated {
		t.Fatalf("длинный абзац не помечен обрезанным: %#v", rows)
	}
	if !strings.HasSuffix(rows[0].Text, "…") {
		t.Fatalf("обрезанный абзац без многоточия: %q", rows[0].Text)
	}
}

func TestParseParagraphRead(t *testing.T) {
	id := uuid.New()
	args, err := ParseParagraphRead(map[string]any{"id": id.String()})
	if err != nil {
		t.Fatal(err)
	}
	if args.EventID != id || args.From != 1 || args.Count != 5 {
		t.Fatalf("умолчания не те: %#v", args)
	}

	// Номера приходят строкой и float — это не повод отказывать.
	args, err = ParseParagraphRead(map[string]any{
		"id": id.String(), "from": "3", "count": float64(2),
	})
	if err != nil {
		t.Fatal(err)
	}
	if args.From != 3 || args.Count != 2 {
		t.Fatalf("страница не та: %#v", args)
	}

	// Больше страницы за раз не отдаём: иначе возвращается та же проблема с окном.
	args, _ = ParseParagraphRead(map[string]any{"id": id.String(), "count": 500})
	if args.Count != paragraphPageMax {
		t.Fatalf("count не ограничен: %d", args.Count)
	}

	for _, bad := range []map[string]any{{}, {"id": "не-uuid"}} {
		if _, err := ParseParagraphRead(bad); err == nil {
			t.Fatalf("аргументы %#v должны быть отвергнуты", bad)
		}
	}
}

func TestParseParagraphUpdate(t *testing.T) {
	id := uuid.New()
	args, err := ParseParagraphUpdate(map[string]any{
		"id": id.String(), "paragraph": float64(2), "text": "Новый абзац.", "reason": "просили",
	}, DefaultLimits(10))
	if err != nil {
		t.Fatal(err)
	}
	if args.Paragraph != 2 || args.Text != "Новый абзац." || args.Reason != "просили" {
		t.Fatalf("аргументы разобраны неверно: %#v", args)
	}

	// Пустой текст — это удаление абзаца, а не забытый аргумент.
	args, err = ParseParagraphUpdate(map[string]any{
		"id": id.String(), "paragraph": 1, "text": "",
	}, DefaultLimits(10))
	if err != nil || args.Text != "" {
		t.Fatalf("пустой текст должен приниматься: %#v, %v", args, err)
	}

	// А вот отсутствие text — ошибка модели: иначе абзац молча исчезнет.
	if _, err := ParseParagraphUpdate(map[string]any{
		"id": id.String(), "paragraph": 1,
	}, DefaultLimits(10)); err == nil {
		t.Fatal("без text правка не должна приниматься")
	}
	if _, err := ParseParagraphUpdate(map[string]any{
		"id": id.String(), "paragraph": 0, "text": "x",
	}, DefaultLimits(10)); err == nil {
		t.Fatal("абзац 0 не существует")
	}
	if _, err := ParseParagraphUpdate(map[string]any{
		"id": id.String(), "text": "x",
	}, DefaultLimits(10)); err == nil {
		t.Fatal("без paragraph правка не должна приниматься")
	}
	if _, err := ParseParagraphUpdate(map[string]any{
		"id": "не-uuid", "paragraph": 1, "text": "x",
	}, DefaultLimits(10)); err == nil {
		t.Fatal("плохой id должен быть отвергнут")
	}
}
