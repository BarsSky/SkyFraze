package assistant_test

// knowledge_test.go — разбор аргументов save_knowledge без базы (0.149.0).
//
// Терпимость к форме — не украшение: живая gemma E4B присылает то массив, то один
// объект, то поля в корне. Каждая из этих форм должна превращаться в знания, а не в
// «нужен список» на просьбу «сохрани выводы».

import (
	"testing"

	"github.com/skyfraze/backend/internal/assistant"
)

func TestParseSaveKnowledgeAcceptsModelForms(t *testing.T) {
	cases := []struct {
		name   string
		args   map[string]any
		titles []string
		bodies []string
	}{
		{
			name: "массив",
			args: map[string]any{"entries": []any{
				map[string]any{"title": "Первое", "summary": "раз", "body": "тезис"},
				map[string]any{"title": "Второе", "body": "тезис"},
			}},
			titles: []string{"Первое", "Второе"},
		},
		{
			name:   "один объект вместо массива",
			args:   map[string]any{"entries": map[string]any{"title": "Одно", "body": "тезис"}},
			titles: []string{"Одно"},
		},
		{
			name:   "поля в корне",
			args:   map[string]any{"title": "В корне", "body": "тезис"},
			titles: []string{"В корне"},
		},
		{
			// Живой прогон на стенде (0.149.1): gemma E4B назвала поля name/content.
			name: "синонимы полей от живой модели",
			args: map[string]any{"entries": []any{
				map[string]any{"name": "Канон", "content": "Драконы спят до весны"},
			}},
			titles: []string{"Канон"},
			bodies: []string{"Драконы спят до весны"},
		},
		{
			name:   "entries пришёл строкой с JSON",
			args:   map[string]any{"entries": `{"entries":[{"title":"Из строки","body":"тезис"}]}`},
			titles: []string{"Из строки"},
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got, err := assistant.ParseSaveKnowledge(tc.args)
			if err != nil {
				t.Fatalf("разбор: %v", err)
			}
			if len(got) != len(tc.titles) {
				t.Fatalf("знаний %d, ожидалось %d", len(got), len(tc.titles))
			}
			for i, title := range tc.titles {
				if got[i].Title != title {
					t.Fatalf("знание №%d: заголовок %q, ожидался %q", i+1, got[i].Title, title)
				}
			}
			for i, body := range tc.bodies {
				if got[i].Body != body {
					t.Fatalf("знание №%d: тело %q, ожидалось %q", i+1, got[i].Body, body)
				}
			}
		})
	}

	// Пустой массив — ошибка, а не «сохранил ноль знаний и отчитался».
	if _, err := assistant.ParseSaveKnowledge(map[string]any{"entries": []any{}}); err == nil {
		t.Fatal("пустая пачка принята")
	}
	// Не массив и не объект — тоже понятный отказ.
	if _, err := assistant.ParseSaveKnowledge(map[string]any{"entries": "Первое"}); err == nil {
		t.Fatal("строка вместо пачки принята")
	}
}

func TestValidateKnowledgeRejectsEmptyFields(t *testing.T) {
	if _, err := assistant.ValidateKnowledge(assistant.KnowledgeInput{Body: "тезис"}, 100); err == nil {
		t.Fatal("знание без заголовка принято")
	}
	if _, err := assistant.ValidateKnowledge(assistant.KnowledgeInput{Title: "Заголовок"}, 100); err == nil {
		t.Fatal("знание без тела принято")
	}
	if _, err := assistant.ValidateKnowledge(
		assistant.KnowledgeInput{Title: "Заголовок", Body: "длинно"}, 3); err == nil {
		t.Fatal("знание длиннее предела принято")
	}
	ok, err := assistant.ValidateKnowledge(
		assistant.KnowledgeInput{Title: " Заголовок ", Summary: " пометка ", Body: " тезис "}, 100)
	if err != nil {
		t.Fatalf("нормальное знание отклонено: %v", err)
	}
	if ok.Title != "Заголовок" || ok.Summary != "пометка" || ok.Body != "тезис" {
		t.Fatalf("поля не обрезаны по краям: %+v", ok)
	}
	if ok.Chars != len([]rune("тезис")) {
		t.Fatalf("знаков %d", ok.Chars)
	}
}

// Заголовок чистится от обрамляющих кавычек (0.150.0): живой прогон дал ««Проверка…«».
func TestValidateKnowledgeTrimsTitleQuotes(t *testing.T) {
	cases := map[string]string{
		"«Проверка инструмента знаний«": "Проверка инструмента знаний",
		"„Канон мира“":                  "Канон мира",
		"\"Драконы\"":                   "Драконы",
		"## Пролог":                     "Пролог",
		"  Канон  ":                     "Канон",
	}
	for input, want := range cases {
		got, err := assistant.ValidateKnowledge(
			assistant.KnowledgeInput{Title: input, Body: "тезис"}, 100)
		if err != nil {
			t.Fatalf("%q: %v", input, err)
		}
		if got.Title != want {
			t.Errorf("%q → %q, ожидалось %q", input, got.Title, want)
		}
	}
	// Одна пара обрамляющих кавычек снимается целиком.
	got, err := assistant.ValidateKnowledge(
		assistant.KnowledgeInput{Title: "«Анна и дом»", Body: "тезис"}, 100)
	if err != nil {
		t.Fatalf("пара кавычек: %v", err)
	}
	if got.Title != "Анна и дом" {
		t.Errorf("пара кавычек → %q", got.Title)
	}
	// Внутренние кавычки не трогаем: «Анна» и «дом» — законный заголовок.
	got, err = assistant.ValidateKnowledge(
		assistant.KnowledgeInput{Title: "«Анна» и «дом»", Body: "тезис"}, 100)
	if err != nil {
		t.Fatalf("внутренние кавычки: %v", err)
	}
	if got.Title != "Анна» и «дом" {
		t.Errorf("внутренние кавычки → %q", got.Title)
	}
}
