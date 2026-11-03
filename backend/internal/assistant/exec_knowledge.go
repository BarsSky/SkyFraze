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
	saved, err := s.SaveKnowledgeEntries(ctx, userID, projectID, nil, entries)
	if err != nil {
		// Ошибка проверки (знание длиннее предела, пустой заголовок) возвращается МОДЕЛИ:
		// она должна увидеть число и разбить текст на несколько знаний, а не человек —
		// разбираться, почему «сохрани» не сработало.
		return refusedCall(call, err.Error())
	}
	created := make([]map[string]any, 0, len(saved))
	views := make([]KnowledgeView, 0, len(saved))
	total := 0
	for _, k := range saved {
		total += k.Chars
		created = append(created, map[string]any{
			"id": k.ID.String(), "title": k.Title, "chars": k.Chars,
		})
		views = append(views, KnowledgeView{
			ID: k.ID, Title: k.Title, Summary: k.Summary, Chars: k.Chars, CreatedAt: k.CreatedAt,
		})
	}
	detail := fmt.Sprintf("сохранил знаний: %d", len(saved))
	return toolResult{
		call:      call,
		report:    Call{Name: call.Name, OK: true, Detail: detail},
		knowledge: views,
		payload: map[string]any{
			"created":     created,
			"total_chars": total,
			"note": "знания сохранены в проект: их увидят все соавторы, и они останутся " +
				"после удаления беседы. Скажи человеку, что именно сохранено.",
		},
	}
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
			"chars":   k.Chars,
			"body_md": body,
		},
	}
}
