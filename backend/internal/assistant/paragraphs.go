package assistant

// paragraphs.go — правка кадра по абзацам (0.143.0).
//
// Зачем. Живая gemma на «перепиши главу» пишет в JSON-аргументе всю главу целиком, с
// экранированием переводов строк, и обрывается на середине строки — вызов не разбирается.
// Причина не в контексте (вход у нас ~6k токенов при окне балансера 16384), а в ОТВЕТЕ:
// длинный текст внутри JSON-строки для маленькой модели — самая хрупкая часть.
//
// Поэтому контекст и правка идут абзацами: читаем несколько абзацев (read_event_paragraphs),
// модель оценивает их и меняет только нужный (update_event_paragraph). Каждый ответ короткий,
// экранировать нечего, и «достаточное количество абзацев для понимания идеи» модель набирает
// повторными вызовами, а не одним гигантским.

import (
	"regexp"
	"strings"
)

// paragraphLimit — сколько знаков одного абзаца отдавать модели. Абзац длиннее — режем с
// пометкой: модели нужен смысл, а не весь монолог.
const paragraphLimit = 1200

// paragraphSep — разделитель абзацев в тексте кадра: пустая строка между ними.
var paragraphSep = regexp.MustCompile(`\n\s*\n`)

// splitParagraphs режет текст кадра на абзацы.
//
// Пустые куски выбрасываем, но пустой текст даёт пустой список — «в кадре нет текста» это
// факт, который модели полезно знать.
func splitParagraphs(body string) []string {
	if strings.TrimSpace(body) == "" {
		return nil
	}
	parts := paragraphSep.Split(body, -1)
	out := make([]string, 0, len(parts))
	for _, part := range parts {
		if strings.TrimSpace(part) == "" {
			continue
		}
		out = append(out, part)
	}
	return out
}

// joinParagraphs собирает текст обратно: абзацы через пустую строку.
func joinParagraphs(paragraphs []string) string {
	return strings.Join(paragraphs, "\n\n")
}

// replaceParagraph заменяет абзац номер index (1-based) на text.
//
// Пустой text убирает абзац целиком, а не оставляет пустое место: пустая строка в тексте
// кадра всё равно не считается абзацем при следующем чтении, и «убрал абзац» не должно
// оставлять после себя двойной перевод строки.
//
// Возвращает новый текст кадра и «нашли ли абзац». Номер вне диапазона — ошибка модели, и
// вызывающий скажет ей об этом словами, а не молча проигнорирует.
func replaceParagraph(body string, index int, text string) (string, bool) {
	paragraphs := splitParagraphs(body)
	if index < 1 || index > len(paragraphs) {
		return body, false
	}
	next := strings.TrimSpace(text)
	if next == "" {
		paragraphs = append(paragraphs[:index-1], paragraphs[index:]...)
	} else {
		paragraphs[index-1] = next
	}
	return joinParagraphs(paragraphs), true
}

// paragraphRow — абзац в ответе инструмента.
type paragraphRow struct {
	Number int    `json:"number"`
	Text   string `json:"text"`
	// Truncated — абзац длиннее paragraphLimit и обрезан для контекста.
	Truncated bool `json:"truncated,omitempty"`
}

// paragraphPage отдаёт страницу абзацев: from — с какого (1-based), count — сколько.
//
// Всего абзацев возвращается всегда: по нему модель понимает, сколько ещё осталось, и может
// дочитать следующими вызовами.
func paragraphPage(body string, from, count int) ([]paragraphRow, int) {
	paragraphs := splitParagraphs(body)
	if from < 1 {
		from = 1
	}
	if count <= 0 {
		count = 5
	}
	rows := make([]paragraphRow, 0, count)
	for i := from - 1; i < len(paragraphs) && len(rows) < count; i++ {
		text := paragraphs[i]
		truncated := false
		if runes := []rune(text); len(runes) > paragraphLimit {
			text = string(runes[:paragraphLimit]) + "…"
			truncated = true
		}
		rows = append(rows, paragraphRow{Number: i + 1, Text: text, Truncated: truncated})
	}
	return rows, len(paragraphs)
}
