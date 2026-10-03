package assistant

// suggestions_test.go — что сервер предлагает сделать дальше.
//
// Это чистая функция от дерева проекта и возможностей, поэтому проверяем её без базы:
// важно не «список непустой», а что предложение ВЫПОЛНИМО и уместно — не советуем
// рисовать без генератора и не предлагаем разбить главу, где под-событий уже достаточно.

import (
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"

	"github.com/skyfraze/backend/internal/store"
)

func chapter(title, body string) store.Event {
	return store.Event{ID: uuid.New(), Title: title, Body: body, Depth: 0, Position: 0}
}

func subEvent(title string, date *time.Time) store.Event {
	return store.Event{ID: uuid.New(), Title: title, Depth: 1, EventDate: date}
}

// ids собирает идентификаторы предложений: тесты не должны зависеть от порядка.
func ids(list []Suggestion) []string {
	out := make([]string, 0, len(list))
	for _, s := range list {
		out = append(out, s.ID)
	}
	return out
}

func has(list []Suggestion, id string) bool {
	for _, s := range list {
		if s.ID == id {
			return true
		}
	}
	return false
}

func TestSuggestionsForEmptyProject(t *testing.T) {
	caps := Capabilities{Text: true, Images: true, Generation: store.GenerationBoth}
	list := Suggestions(nil, caps)
	if len(list) == 0 {
		t.Fatal("для пустого проекта должно быть предложение")
	}
	// Первым — собрать проект: это первый осмысленный шаг.
	if list[0].ID != "build-project" {
		t.Fatalf("первое предложение: %+v", list[0])
	}
	if !strings.Contains(list[0].Prompt, "главы") || list[0].Label == "" {
		t.Errorf("подпись или текст пустые: %+v", list[0])
	}
	// Иллюстрацию в пустом проекте предлагать не к чему.
	if has(list, "illustrate-chapter") {
		t.Error("в пустом проекте нечего иллюстрировать")
	}
}

func TestSuggestionsWithoutImages(t *testing.T) {
	caps := Capabilities{Text: true, Images: false, Generation: store.GenerationText,
		ImageNote: "генератор не настроен"}
	list := Suggestions([]store.Event{chapter("Пролог", "текст")}, caps)
	if has(list, "illustrate-chapter") {
		t.Fatal("без генератора иллюстрации предлагать нельзя")
	}
	for _, s := range list {
		if s.Kind == SuggestionKindImage {
			t.Errorf("предложение с картинками при недоступных картинках: %+v", s)
		}
	}
}

func TestSuggestionsImagesOnlyMode(t *testing.T) {
	// Режим «только картинки»: текстовые предложения бессмысленны — агент их не выполнит.
	caps := Capabilities{Text: false, Images: true, Generation: store.GenerationImages}
	list := Suggestions([]store.Event{chapter("Пролог", "текст")}, caps)
	if len(list) != 1 || list[0].ID != "illustrate-chapter" {
		t.Fatalf("в режиме «только картинки» ожидалась иллюстрация: %+v", list)
	}
}

func TestSuggestionsPointAtRealGaps(t *testing.T) {
	caps := Capabilities{Text: true, Images: true, Generation: store.GenerationBoth}

	// Глава без текста — предлагаем дописать именно её.
	empty := chapter("Без текста", "   ")
	list := Suggestions([]store.Event{empty}, caps)
	if !has(list, "fill-chapter") {
		t.Fatalf("глава без текста должна предлагаться к дописыванию: %v", ids(list))
	}
	for _, s := range list {
		if s.ID == "fill-chapter" && !strings.Contains(s.Prompt, "Без текста") {
			t.Errorf("предложение не называет главу: %+v", s)
		}
	}

	// Главы с текстом, под-событий нет, дат нет — структура и хронология.
	full := chapter("Пролог", "Текст главы.")
	list = Suggestions([]store.Event{full}, caps)
	if !has(list, "split-chapter") {
		t.Errorf("главу без под-событий стоит предложить разбить: %v", ids(list))
	}
	if !has(list, "set-dates") {
		t.Errorf("без дат стоит предложить хронологию: %v", ids(list))
	}

	// Всё есть: под-события, даты, текст — остаётся только иллюстрация.
	date := time.Date(2024, 5, 17, 0, 0, 0, 0, time.UTC)
	full.EventDate = &date
	list = Suggestions([]store.Event{full, subEvent("Начало", &date)}, caps)
	if has(list, "split-chapter") || has(list, "set-dates") {
		t.Errorf("нечего чинить — предложений быть не должно: %v", ids(list))
	}
	if !has(list, "illustrate-chapter") {
		t.Errorf("картинки доступны — иллюстрацию предложить стоит: %v", ids(list))
	}
}

func TestSuggestionsAreShortAndActionable(t *testing.T) {
	// Список — не меню: больше четырёх предложений человек не читает. И у каждого должна
	// быть подпись и готовый текст вопроса, иначе чип некуда нажать.
	tree := []store.Event{chapter("Пролог", ""), chapter("Глава 2", ""), subEvent("Что-то", nil)}
	for _, caps := range []Capabilities{
		{Text: true, Images: true, Generation: store.GenerationBoth},
		{Text: true, Images: false, Generation: store.GenerationAuto},
		{Text: false, Images: true, Generation: store.GenerationImages},
	} {
		list := Suggestions(tree, caps)
		if len(list) > 4 {
			t.Errorf("предложений %d, больше четырёх не нужно: %v", len(list), ids(list))
		}
		for _, s := range list {
			if strings.TrimSpace(s.Label) == "" || strings.TrimSpace(s.Prompt) == "" {
				t.Errorf("пустое предложение: %+v", s)
			}
			if len([]rune(s.Label)) > 60 {
				t.Errorf("подпись длинная, не влезет на чип: %q", s.Label)
			}
		}
	}
}

func TestSuggestionsNothingPossible(t *testing.T) {
	// Ни текста, ни картинок — предлагать нечего, и пустой список честнее выдуманного.
	if list := Suggestions(nil, Capabilities{}); list != nil {
		t.Fatalf("ожидался пустой список: %+v", list)
	}
}
