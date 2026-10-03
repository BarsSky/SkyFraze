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

	"github.com/skyfraze/backend/internal/ai"
	"github.com/skyfraze/backend/internal/events"
	"github.com/skyfraze/backend/internal/store"
)

// Persona — кем агент представлен в этом проекте: имя (одно и то же всегда), роль и
// указания владельца. Пустая роль и пустые указания — тоже нормально: агент работает
// по общим правилам, как соавтор без должностной инструкции.
type Persona struct {
	Name         string
	RoleTitle    string
	RoleHint     string
	RoleRules    string
	Instructions string
}

// personaOf собирает персону из настроек проекта.
func personaOf(settings *store.ProjectAISettings) Persona {
	persona := Persona{Name: ai.AgentName}
	if settings == nil {
		return persona
	}
	if role, ok := ai.AgentRoleByID(settings.Role); ok {
		persona.RoleTitle = role.Title
		persona.RoleHint = role.Hint
		persona.RoleRules = role.Instructions
	}
	persona.Instructions = strings.TrimSpace(settings.Instructions)
	return persona
}

// Capabilities — что агент умеет СЕЙЧАС в этом проекте.
//
// Зачем это отдельная структура, а не «флажки по месту». Возможности складываются из
// трёх независимых вещей, и путать их нельзя:
//
//  1. **что умеет стенд** (настроен ли генератор картинок, отвечает ли он);
//  2. **что разрешил владелец проекта** (режим: только текст, только картинки, оба);
//  3. **что реализовано в этой версии помощника** (какие инструменты вообще есть).
//
// Модель не знает ни одного из трёх. Без явного блока в правилах она на просьбу
// «нарисуй иллюстрацию» либо обещает и не делает, либо выдумывает несуществующий
// инструмент. Поэтому возможности уходят ей словами — и ровно теми же словами интерфейс
// объясняет человеку, почему чего-то нет.
type Capabilities struct {
	// Text — можно создавать и править кадры.
	Text bool
	// Images — можно генерировать иллюстрации.
	Images bool
	// Generation — режим проекта (auto|text|images|both).
	Generation string
	// ImageNote — почему картинок нет или как они работают (для человека и для модели).
	ImageNote string
	// ImageStyle — стиль иллюстраций владельца (пусто — не задан).
	ImageStyle string
}

// textPrompt — что сказать модели про текст и картинки. Отдельной функцией, потому что
// этот текст уходит в правила и должен совпадать с тем, что реально можно вызвать.
func (c Capabilities) promptBlock() string {
	var b strings.Builder
	b.WriteString("\nЧто тебе доступно в этом проекте сейчас:\n")
	if c.Text {
		b.WriteString("- текст: да — главы и под-события ты создаёшь инструментами.\n")
	} else {
		b.WriteString("- текст: НЕТ — в этом проекте тебе запрещено создавать и менять кадры. " +
			"Если попросят написать главу, скажи об этом и предложи включить текстовый режим.\n")
	}
	switch {
	case c.Images:
		b.WriteString("- картинки: да — ты умеешь генерировать иллюстрации к кадрам.\n")
		if c.ImageStyle != "" {
			fmt.Fprintf(&b, "  Стиль иллюстраций в этом проекте: %s\n", c.ImageStyle)
		}
	default:
		fmt.Fprintf(&b, "- картинки: НЕТ (%s). Не обещай нарисовать и не выдумывай инструмент: "+
			"скажи, чего не хватает.\n", c.ImageNote)
	}
	fmt.Fprintf(&b, "Режим, выбранный владельцем проекта: %s.\n", modeTitle(c.Generation))
	return b.String()
}

// modeTitle — человеческое название режима (оно же уходит модели, поэтому без жаргона).
func modeTitle(mode string) string {
	switch mode {
	case store.GenerationText:
		return "только текст — картинки не создавай"
	case store.GenerationImages:
		return "только картинки — текст кадров не меняй"
	case store.GenerationBoth:
		return "оба — и текст, и картинки"
	default:
		return "auto — делай то, что доступно"
	}
}

// systemPrompt собирает начало запроса: кто ты и по каким правилам работаешь.
func systemPrompt(project *store.Project, persona Persona, maxCalls int, caps Capabilities) string {
	title := "без названия"
	if project != nil && strings.TrimSpace(project.Title) != "" {
		title = project.Title
	}
	name := persona.Name
	if name == "" {
		name = ai.AgentName
	}

	// Роль и указания владельца — отдельным блоком перед правилами: «летописец,
	// следи за хронологией» и «соавтор-фантаст, придумывай детали мира» пишут
	// по-разному, и без этого настройка роли ни на что не влияла бы.
	var role strings.Builder
	if persona.RoleTitle != "" {
		fmt.Fprintf(&role, "\nТвоя роль в этом проекте — %s (%s).\n", persona.RoleTitle, persona.RoleHint)
		if persona.RoleRules != "" {
			fmt.Fprintf(&role, "%s\n", persona.RoleRules)
		}
	} else {
		role.WriteString("\nРоль в этом проекте не задана — работай как внимательный соавтор.\n")
	}
	if persona.Instructions != "" {
		fmt.Fprintf(&role, "\nУказания владельца проекта — выполняй их в первую очередь:\n%s\n", persona.Instructions)
	}

	return fmt.Sprintf(`Тебя зовут %s. Ты — соавтор проекта «%s» на платформе SkyFraze: правишь текст
на тех же правах, что и остальные соавторы, и твои правки подписаны твоим именем.
Проект — это лента кадров (событий): главы верхнего уровня и вложенные в них
под-события. Каждый кадр — заголовок и текст в Markdown.%s%s
Что ты умеешь:
- смотреть дерево проекта инструментом list_events;
- читать текст отдельного кадра инструментом read_event%s.%s

Если ты умеешь вызывать инструменты — вызывай их обычным способом. Если вызов инструмента
недоступен (модель без поддержки инструментов) — напиши вызов ТЕКСТОМ отдельным блоком
(три обратных кавычки, слово skyfraze-tools, внутри — JSON), и сервер выполнит его так же:

%s
[{"name": "create_chapter", "arguments": {"title": "Пролог", "body_md": "текст в Markdown"}}]
%s

Идентификаторы (parent_id, after_id) бери из list_events — выдуманные не сработают.
Даты — вид ГГГГ-ММ-ДД.

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

Отвечай по-русски, коротко и по делу.`,
		name, title, role.String(), caps.promptBlock(), textTools, imageTools, fence, fence, maxCalls)
}

// textTools — перечисление текстовых инструментов для правил. Отдельной строкой, чтобы
// список в правилах и список в реестре (`ToolDefs`) собирались из одного места.
const textTools = ",\n- создавать главу верхнего уровня инструментом create_chapter" +
	",\n- создавать под-событие внутри главы инструментом create_sub_event"

// imageTools — чем агент рисует (пусто, пока инструмента нет: правила не должны
// обещать то, чего в этой версии не существует).
const imageTools = ""

// fence — ограждение блока с текстовым вызовом. Отдельной константой, потому что
// внутри Go-строки в обратных кавычках тройные обратные кавычки написать нельзя, а
// формат вызова должен быть показан модели буквально.
const fence = "```"

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
