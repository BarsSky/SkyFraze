package assistant

// exec_knowledge.go — инструменты знаний проекта (0.149.0).
//
// Три роли, и все три нужны:
//
//	save_knowledge — уложить выводы беседы в знание (одно или несколько, если в предел не влезло);
//	list_knowledge — увидеть, что уже сохранено (не заводить дубли и вспомнить «мы это решали»);
//	read_knowledge — прочитать сохранённое целиком, когда в вопросе приложена только пометка.
//
// Почему сохранение — инструмент, а не отдельная кнопка «сжать беседу». Сжимать разговор
// до тезисов умеет именно модель: у неё перед глазами вся переписка, и она отличает
// «решили» от «обсуждали». Кнопка без модели либо копировала бы переписку целиком (и
// знание превращалось бы в ещё одну беседу), либо обрезала бы её по счёту знаков — и
// теряла бы ровно те выводы, ради которых всё затевалось.

import (
	"context"
	"fmt"
	"sort"
	"strings"

	"github.com/google/uuid"

	"github.com/skyfraze/backend/internal/ai"
)

// toolSaveKnowledge сохраняет пачку знаний.
func (s *Service) toolSaveKnowledge(
	ctx context.Context, userID, projectID uuid.UUID, call ai.ToolCall,
) toolResult {
	entries, err := ParseSaveKnowledge(call.Arguments)
	if err != nil {
		return refusedCall(call, err.Error())
	}
	// Восстановление формы (0.149.1): если модель положила тезисы в `summary`, а тело
	// оставила пустым — сохраняем саммари как знание, а не отказываем. Знание без
	// заголовка получает заголовок из первой строки текста: «безымянное» знание в списке
	// не найти, и это хуже, чем заголовок, придуманный из текста.
	for i := range entries {
		if strings.TrimSpace(entries[i].Body) == "" && strings.TrimSpace(entries[i].Summary) != "" {
			entries[i].Body = entries[i].Summary
			entries[i].Summary = ""
		}
		if strings.TrimSpace(entries[i].Title) == "" {
			entries[i].Title = titleFromKnowledgeBody(entries[i].Body)
		}
	}
	// Дубли (0.150.0): «Решения по миру» поверх уже сохранённого «Решения по миру
	// проекта» — это шум в списке знаний. Похожие пропускаем и говорим об этом модели,
	// чтобы она сказала человеку «это уже есть», а не молча проглотила просьбу.
	entries, duplicates, err := s.FilterKnowledgeDuplicates(ctx, projectID, entries)
	if err != nil {
		return refusedCall(call, "не удалось проверить знания на дубли: "+err.Error())
	}
	if len(entries) == 0 {
		titles := make([]string, 0, len(duplicates))
		for _, duplicate := range duplicates {
			titles = append(titles, "«"+duplicate.ExistingTitle+"»")
		}
		return refusedCall(call, "такие знания уже есть: "+strings.Join(titles, ", ")+
			" — не завожу дубли. Если это другое знание, измени заголовок; если то же самое — "+
			"скажи человеку, что оно уже сохранено")
	}
	saved, err := s.SaveKnowledgeEntries(ctx, userID, projectID, nil, entries)
	if err != nil {
		// Ошибка проверки (знание длиннее предела, пустой заголовок) возвращается МОДЕЛИ:
		// она должна увидеть число и разбить текст на несколько знаний, а не человек —
		// разбираться, почему «сохрани» не сработало. В журнал пишем только ИМЕНА полей:
		// в них лежит текст проекта, и лить его в журнал без просьбы нельзя.
		s.logger.Warn("ai: save_knowledge отклонён",
			"reason", err.Error(), "fields", argumentKeys(call.Arguments))
		return refusedCall(call, err.Error())
	}
	created := make([]map[string]any, 0, len(saved))
	views := make([]KnowledgeView, 0, len(saved))
	total := 0
	for _, k := range saved {
		total += k.Chars
		created = append(created, map[string]any{
			"id": k.ID.String(), "title": k.Title, "chars": k.Chars, "tags": k.Tags,
		})
		views = append(views, KnowledgeView{
			ID: k.ID, Title: k.Title, Summary: k.Summary, Tags: k.Tags, Chars: k.Chars,
			CreatedAt: k.CreatedAt,
		})
	}
	detail := fmt.Sprintf("сохранил знаний: %d", len(saved))
	payload := map[string]any{
		"created":     created,
		"total_chars": total,
		"note": "знания сохранены в проект: их увидят все соавторы, и они останутся " +
			"после удаления беседы. Скажи человеку, что именно сохранено.",
	}
	if len(duplicates) > 0 {
		payload["skipped"] = duplicates
		payload["skipped_note"] = "похожие знания уже есть в проекте — они не записаны повторно; " +
			"скажи человеку, какие именно, чтобы он не искал их заново"
	}
	return toolResult{
		call:      call,
		report:    Call{Name: call.Name, OK: true, Detail: detail},
		knowledge: views,
		payload:   payload,
	}
}

// titleFromKnowledgeBody — заголовок знания из первой строки текста.
//
// Зачем: модель может не дать заголовок, а знание без заголовка невозможно найти в списке.
// Первая строка — единственное, что у нас есть, и она обычно и есть тезис.
func titleFromKnowledgeBody(body string) string {
	first := strings.SplitN(strings.TrimSpace(body), "\n", 2)[0]
	first = strings.TrimSpace(strings.TrimLeft(strings.TrimSpace(first), "#>*- "))
	if first == "" {
		return "Знание"
	}
	if runes := []rune(first); len(runes) > MaxKnowledgeTitle {
		first = string(runes[:MaxKnowledgeTitle])
	}
	return first
}

// argumentKeys — имена полей аргументов (без содержимого) для журнала.
func argumentKeys(args map[string]any) []string {
	keys := make([]string, 0, len(args))
	for key := range args {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	return keys
}

// toolListKnowledge показывает сохранённые знания.
func (s *Service) toolListKnowledge(
	ctx context.Context, userID, projectID uuid.UUID, call ai.ToolCall,
) toolResult {
	list, err := s.KnowledgeList(ctx, userID, projectID, "")
	if err != nil {
		return refusedCall(call, "не удалось прочитать знания: "+err.Error())
	}
	if len(list) == 0 {
		return toolResult{
			call:   call,
			report: Call{Name: call.Name, OK: true, Detail: "знаний нет"},
			payload: map[string]any{
				"knowledge": []any{},
				"note":      "в проекте пока нет сохранённых знаний",
			},
		}
	}
	rows := make([]map[string]any, 0, len(list))
	for _, k := range list {
		rows = append(rows, map[string]any{
			"id":         k.ID.String(),
			"title":      k.Title,
			"summary":    k.Summary,
			"tags":       k.Tags,
			"chars":      k.Chars,
			"created_at": k.CreatedAt.Format("2006-01-02"),
		})
	}
	return toolResult{
		call:    call,
		report:  Call{Name: call.Name, OK: true, Detail: fmt.Sprintf("знаний: %d", len(rows))},
		payload: map[string]any{"knowledge": rows},
	}
}

// toolReadKnowledge читает знание целиком.
func (s *Service) toolReadKnowledge(
	ctx context.Context, userID, projectID uuid.UUID, call ai.ToolCall,
) toolResult {
	raw := strings.TrimSpace(argString(call.Arguments, "id"))
	id, err := uuid.Parse(raw)
	if err != nil {
		return refusedCall(call, "нужен идентификатор знания из list_knowledge")
	}
	k, err := s.store.AIKnowledgeByID(ctx, projectID, id)
	if err != nil {
		return refusedCall(call, "знание не найдено в этом проекте: "+raw)
	}
	body := k.Body
	if runes := []rune(body); len(runes) > toolBodyChars {
		body = string(runes[:toolBodyChars]) + "\n…(знание обрезано для контекста)"
	}
	return toolResult{
		call:   call,
		report: Call{Name: call.Name, OK: true, Detail: "прочитал знание «" + k.Title + "»"},
		payload: map[string]any{
			"id":      k.ID.String(),
			"title":   k.Title,
			"summary": k.Summary,
			"tags":    k.Tags,
			"chars":   k.Chars,
			"body_md": body,
		},
	}
}
