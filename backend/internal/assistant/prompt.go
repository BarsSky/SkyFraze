package assistant

// prompt.go — что именно уходит модели как контекст и правила.
//
// Здесь важны две вещи, и обе — про приватность и предсказуемость:
//
//  1. **В запрос уходит не проект, а его оглавление.** Дерево событий (идентификатор,
//     уровень, заголовок, дата) плюс тот текст, который модель запросила инструментом
//     `read_event`. Отправлять весь текст проекта «на всякий случай» нельзя: это и
//     дороже, и означает, что наружу ушло больше, чем нужно для ответа.
//  2. **Правила написаны явно.** Модель не должна «догадываться», что заголовок — это
//     одна строка, что текст — Markdown и что идентификаторы выдумывать нельзя.
//     Догадки стоят человеку испорченного дерева.

import (
	"fmt"
	"strings"

	"github.com/skyfraze/backend/internal/events"
	"github.com/skyfraze/backend/internal/store"
)

// systemPrompt собирает начало запроса: кто ты и по каким правилам работаешь.
func systemPrompt(project *store.Project, maxCalls int) string {
	title := "без названия"
	if project != nil && strings.TrimSpace(project.Title) != "" {
		title = project.Title
	}
	return fmt.Sprintf(`Ты — помощник в проекте «%s» на платформе SkyFraze. Проект — это лента кадров
(событий): главы верхнего уровня и вложенные в них под-события. Каждый кадр — заголовок
и текст в Markdown.

Что ты умеешь:
- смотреть дерево проекта инструментом list_events;
- читать текст отдельного кадра инструментом read_event;
- создавать главу верхнего уровня инструментом create_chapter;
- создавать под-событие внутри главы инструментом create_sub_event.

Правила, которые нельзя нарушать:
1. Создавай кадры ТОЛЬКО вызовом инструментов. Текст ответа ничего не меняет в проекте.
2. Никогда не выдумывай идентификаторы: бери их из list_events. Если не знаешь, куда
   вставить кадр, вызови list_events.
3. Заголовок — одна короткая строка без разметки и без перевода строки.
4. Текст кадра — Markdown: абзацы, списки, выделение, таблицы. Заголовки (#) внутри
   текста не нужны: заголовок кадра уже отдельный.
5. Не создавай больше %d кадров за один ответ и не повторяй уже созданное.
6. Когда кадры созданы, коротко скажи по-русски, что именно сделано. Если ничего
   создавать не нужно (например, тебя только спросили), просто ответь по существу.

Отвечай по-русски, коротко и по делу.`, title, maxCalls)
}

// treeContext — оглавление проекта в виде текста: то, что уходит модели вместо
// полного текста. Пустое дерево — тоже информация («проект пуст»), и модель должна
// это видеть, иначе она будет искать главы, которых нет.
func treeContext(list []store.Event, limit int) string {
	if len(list) == 0 {
		return "Проект пока пуст: кадров нет."
	}
	var b strings.Builder
	b.WriteString("Дерево проекта (идентификатор | уровень | заголовок | дата):\n")
	shown := 0
	for _, e := range list {
		if shown >= limit {
			fmt.Fprintf(&b, "… и ещё %d кадр(ов), их видно через list_events.\n", len(list)-shown)
			break
		}
		date := "—"
		if e.EventDate != nil {
			date = e.EventDate.Format("2006-01-02")
		}
		fmt.Fprintf(&b, "%s | %d | %s | %s\n", e.ID, e.Depth, indent(e.Depth)+e.Title, date)
		shown++
	}
	return b.String()
}

// indent — отступ по уровню: дерево читается даже моделью, которая «видит» только текст.
func indent(depth int16) string {
	if depth <= 0 {
		return ""
	}
	return strings.Repeat("· ", int(depth))
}

// treeRow — одна строка дерева в JSON-ответе инструмента list_events.
type treeRow struct {
	ID       string `json:"id"`
	Title    string `json:"title"`
	Depth    int16  `json:"depth"`
	ParentID string `json:"parent_id,omitempty"`
	Date     string `json:"date,omitempty"`
}

// treeRows переводит проекцию в ответ инструмента: те же поля, что и в тексте
// контекста, чтобы модель не училась двум разным форматам одного дерева.
func treeRows(list []store.Event) []treeRow {
	out := make([]treeRow, 0, len(list))
	for _, e := range list {
		row := treeRow{ID: e.ID.String(), Title: e.Title, Depth: e.Depth}
		if e.ParentID != nil {
			row.ParentID = e.ParentID.String()
		}
		if e.EventDate != nil {
			row.Date = e.EventDate.Format("2006-01-02")
		}
		out = append(out, row)
	}
	return out
}

// maxDepthHint — человеческая подсказка о пределе вложенности (нужна в тексте ошибки).
func maxDepthHint() string {
	return fmt.Sprintf("глубже %d уровней дерево не поддерживает", events.MaxDepth)
}
