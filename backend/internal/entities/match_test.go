package entities

// match_test.go — правила поиска упоминаний на сервере (0.70.0).
//
// Эти тесты — вторая половина спецификации из frontend/src/collab/mentions.test.ts. Правила
// должны совпадать: иначе одна и та же карточка находилась бы по-разному в интерфейсе и в
// ответе помощника, и вопрос «а где она на самом деле» стал бы спором двух реализаций.

import (
	"testing"

	"github.com/google/uuid"
)

func entityNamed(name string, aliases ...string) Entity {
	return Entity{ID: uuid.New(), Kind: "character", Name: name, Aliases: aliases}
}

func quotes(found []Mention) []string {
	out := make([]string, 0, len(found))
	for _, mention := range found {
		out = append(out, mention.Quote)
	}
	return out
}

func TestFindMentions(t *testing.T) {
	anna := entityNamed("Анна", "Аня", "Анны", "Анне")
	house := entityNamed("Дом на холме")
	entities := []Entity{anna, house}

	cases := []struct {
		name string
		text string
		want []string
	}{
		{"падеж из алиасов", "История Анны.", []string{"Анны"}},
		{"регистр не важен", "и тут анна поняла", []string{"анна"}},
		{"граница слова", "Аннами называли всех", nil},
		{"дефис — граница", "Анна-Мария вошла", nil},
		{"несколько карточек", "Анна вошла в дом на холме.", []string{"Анна", "дом на холме"}},
		{"пустой текст", "", nil},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got := quotes(FindMentions(tc.text, entities, "body"))
			if len(got) != len(tc.want) {
				t.Fatalf("найдено %v, ожидалось %v", got, tc.want)
			}
			for i := range tc.want {
				if got[i] != tc.want[i] {
					t.Fatalf("найдено %v, ожидалось %v", got, tc.want)
				}
			}
		})
	}
}

// Длинный алиас выигрывает: «Анна Сергеевна» — одно упоминание, а не два.
func TestFindMentionsLongestAliasWins(t *testing.T) {
	anna := entityNamed("Анна")
	full := entityNamed("Анна Сергеевна")
	found := FindMentions("Пришла Анна Сергеевна.", []Entity{anna, full}, "body")
	if len(found) != 1 {
		t.Fatalf("ожидалось одно упоминание: %v", quotes(found))
	}
	if found[0].EntityName != "Анна Сергеевна" {
		t.Fatalf("выиграл не длинный алиас: %+v", found[0])
	}
}

// Падеж, которого нет в алиасах, не находится — так же, как на клиенте.
func TestFindMentionsUnknownForm(t *testing.T) {
	anna := entityNamed("Анна", "Аня")
	if found := FindMentions("Позвал Аню.", []Entity{anna}, "body"); len(found) != 0 {
		t.Fatalf("форма без алиаса не должна находиться: %v", quotes(found))
	}
}

// Короткие имена и алиасы не ищутся: «Я» было бы в каждом предложении.
func TestFindMentionsSkipsShortAliases(t *testing.T) {
	short := entityNamed("Я", "Я")
	if found := FindMentions("Я пришёл, и я остался", []Entity{short}, "body"); len(found) != 0 {
		t.Fatalf("короткое имя не должно искаться: %v", quotes(found))
	}
}

// Заголовок ищется отдельным полем: по нему видно, где именно упоминание.
func TestFrameMentionsFields(t *testing.T) {
	anna := entityNamed("Анна")
	found := FrameMentions(TextFrame{ID: "f1", Title: "Анна возвращается", Body: "Она молчала"},
		[]Entity{anna})
	if len(found) != 1 || found[0].Field != "title" {
		t.Fatalf("ожидалось упоминание в заголовке: %+v", found)
	}
}

// Сводка: кадры считаются разными, упоминания — все; «сирота» внизу.
func TestUsage(t *testing.T) {
	anna := entityNamed("Анна")
	nobody := entityNamed("Сторож")
	frames := []TextFrame{
		{ID: "f1", Title: "Анна", Body: "Анна и Анна"},
		{ID: "f2", Title: "", Body: "тишина"},
	}
	rows := Usage(frames, []Entity{anna, nobody})
	if len(rows) != 2 {
		t.Fatalf("ожидались две строки: %+v", rows)
	}
	if rows[0].Entity.Name != "Анна" || rows[0].Frames != 1 || rows[0].Mentions != 3 {
		t.Fatalf("сводка по Анне: %+v", rows[0])
	}
	if rows[1].Entity.Name != "Сторож" || rows[1].Frames != 0 {
		t.Fatalf("сирота должна быть внизу с нулём: %+v", rows[1])
	}
}
