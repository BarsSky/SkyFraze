package assistant

// suggestions.go — что предложить человеку дальше.
//
// Зачем это на СЕРВЕРЕ, а не «пусть модель придумает». Предложение должно быть выполнимым
// и уместным: «нарисуй иллюстрацию» бессмысленно, если генератора нет; «разбей главу» —
// если глав всего одна и в ней уже пятнадцать под-событий. Модель не знает ни состояния
// проекта, ни возможностей стенда, а сервер знает и то, и другое. Поэтому предложения
// считаются детерминированно по дереву проекта и возможностям, а модель по-прежнему
// отвечает за слова.
//
// Отсюда же и вид: короткая подпись на чипе и готовый текст вопроса. Нажатие подставляет
// текст в поле ввода (как подсказки в пустом чате) — человек видит, что уйдёт модели, и
// может поправить формулировку.

import (
	"context"

	"fmt"
	"github.com/google/uuid"
	"strings"

	"github.com/skyfraze/backend/internal/store"
)

// Suggestion — один следующий шаг.
type Suggestion struct {
	// ID — короткий идентификатор вида шага: интерфейсу он нужен для ключа списка,
	// а тестам — чтобы не зависеть от порядка.
	ID string `json:"id"`
	// Label — подпись на чипе.
	Label string `json:"label"`
	// Prompt — что подставится в поле ввода.
	Prompt string `json:"prompt"`
	// Kind: text — правка текста, image — иллюстрация.
	Kind string `json:"kind"`
}

// Виды предложений.
const (
	SuggestionKindText  = "text"
	SuggestionKindImage = "image"
)

// Suggestions считает, что логично дальше, по дереву проекта и возможностям агента.
//
// Порядок важен: сначала то, без чего проект не проект (пустой проект, главы без текста),
// потом структура (под-события, даты), и только потом иллюстрации — они украшение, а не
// основа. Больше четырёх предложений не отдаём: список превратился бы в меню, которое
// никто не читает.
func Suggestions(tree []store.Event, caps Capabilities) []Suggestion {
	if !caps.Text && !caps.Images {
		return nil
	}
	out := make([]Suggestion, 0, 4)

	chapters := make([]store.Event, 0, len(tree))
	subEvents := 0
	for _, event := range tree {
		if event.Depth == 0 {
			chapters = append(chapters, event)
			continue
		}
		subEvents++
	}

	// Пустой проект: первый осмысленный шаг — собрать его по описанию.
	if len(chapters) == 0 {
		if caps.Text {
			out = append(out, Suggestion{
				ID: "build-project", Kind: SuggestionKindText,
				Label:  "Собери проект по описанию",
				Prompt: "Собери проект по описанию: придумай три главы и для каждой — по два под-события. Опиши мир и завязку.",
			})
		}
		return appendImageSuggestions(out, nil, caps, 0)
	}

	// Глава без текста — дыра, которую видно всем: её и предлагаем закрыть.
	if caps.Text {
		if empty := firstEmptyChapter(chapters); empty != nil {
			out = append(out, Suggestion{
				ID: "fill-chapter", Kind: SuggestionKindText,
				Label:  fmt.Sprintf("Допиши главу «%s»", empty.Title),
				Prompt: fmt.Sprintf("Прочитай главу «%s» и допиши её текст: она пока пустая.", empty.Title),
			})
		}
	}

	// Главы есть, а под-событий нет — структура не раскрыта.
	if caps.Text && subEvents == 0 && len(out) < 2 {
		out = append(out, Suggestion{
			ID: "split-chapter", Kind: SuggestionKindText,
			Label:  fmt.Sprintf("Разбей главу «%s» на под-события", chapters[0].Title),
			Prompt: fmt.Sprintf("Разбей главу «%s» на три под-события с осмысленными названиями.", chapters[0].Title),
		})
	}

	// Ни у одного кадра нет даты — хронология потеряна.
	if caps.Text && !hasAnyDate(tree) && len(out) < 3 {
		out = append(out, Suggestion{
			ID: "set-dates", Kind: SuggestionKindText,
			Label:  "Проставь даты по порядку",
			Prompt: "Посмотри дерево проекта и проставь даты кадрам так, чтобы порядок был непротиворечивым. Если дата неизвестна — оставь пустой.",
		})
	}

	return appendImageSuggestions(out, chapters, caps, 4)
}

// appendImageSuggestions добавляет предложение нарисовать иллюстрацию — только если
// картинки действительно доступны. Числом ограничиваем: «нарисуй ко всем главам» — это
// не предложение, а задание на вечер.
func appendImageSuggestions(
	out []Suggestion, chapters []store.Event, caps Capabilities, limit int,
) []Suggestion {
	if !caps.Images || len(chapters) == 0 || len(out) >= limit {
		return out
	}
	// Берём первую главу: её видно в дереве, и человек понимает, о чём речь.
	chapter := chapters[0]
	prompt := fmt.Sprintf("Нарисуй иллюстрацию к главе «%s»: опиши сцену по её тексту.", chapter.Title)
	return append(out, Suggestion{
		ID: "illustrate-chapter", Kind: SuggestionKindImage,
		Label:  fmt.Sprintf("Нарисуй иллюстрацию к «%s»", chapter.Title),
		Prompt: prompt,
	})
}

// firstEmptyChapter — первая глава без текста (только заголовок).
func firstEmptyChapter(chapters []store.Event) *store.Event {
	for i := range chapters {
		if strings.TrimSpace(chapters[i].Body) == "" {
			return &chapters[i]
		}
	}
	return nil
}

// hasAnyDate — есть ли хотя бы у одного кадра дата.
func hasAnyDate(tree []store.Event) bool {
	for _, event := range tree {
		if event.EventDate != nil {
			return true
		}
	}
	return false
}

// suggestionsFor — предложения для проекта: читает дерево и считает шаги.
func (s *Service) suggestionsFor(ctx context.Context, projectID uuid.UUID, caps Capabilities) []Suggestion {
	list, err := s.store.ListEvents(ctx, projectID)
	if err != nil {
		// Сбой чтения дерева не должен ломать ответ: предложения — украшение, а не
		// часть ответа на вопрос.
		s.logger.Warn("ai: предложения не посчитаны", "project", projectID, "err", err)
		return nil
	}
	return Suggestions(list, caps)
}
