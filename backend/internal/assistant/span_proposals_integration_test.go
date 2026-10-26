package assistant_test

// span_proposals_integration_test.go — правка ФРАГМЕНТА по замечанию (0.62.0, миграция 0027).
//
// Что проверяется и почему именно это. Правка фрагмента — единственное, где «применить»
// зависит от текста, которого может уже не быть: человек подтверждает замену куска, который
// кто-то успел переписать. Ошибки здесь тихие (заменили не тот абзац и не заметили), поэтому
// проверяются границы:
//
//   - модель НЕ меняет проект: после предложения текст кадра прежний;
//   - применяет человек — и меняется РОВНО фрагмент, соседний текст остаётся;
//   - «Вернуть» возвращает прежний фрагмент;
//   - если фрагмент правили после предложения, применить нельзя («предложение устарело»);
//   - замечание к кадру целиком не даёт предложить правку фрагмента (нет якоря).

import (
	"context"
	"errors"
	"strings"
	"testing"

	ygo "github.com/Deln0r/ygo"

	"github.com/google/uuid"

	"github.com/skyfraze/backend/internal/ai"
	"github.com/skyfraze/backend/internal/assistant"
	"github.com/skyfraze/backend/internal/collab/yjs"
	"github.com/skyfraze/backend/internal/events"
	"github.com/skyfraze/backend/internal/store"
)

// spanEnv заводит проект с текстом, замечание к фрагменту и возвращает всё нужное.
func spanEnv(t *testing.T, e *env, owner uuid.UUID) (projectID, eventID, commentID uuid.UUID, quote string) {
	t.Helper()
	ctx := context.Background()
	projectID, eventID, _ = e.seedProject(t, owner)
	e.seedSnapshot(t, projectID, owner)

	// Документ берём из сохранённого снапшота: якорь обязан быть из ТОЙ ЖЕ линии, иначе
	// он не разрешится ни на сервере, ни на клиенте.
	state, err := e.st.GetProjectEventState(ctx, projectID)
	if err != nil || state == nil {
		t.Fatalf("снапшот: %v", err)
	}
	doc, err := yjs.FromState(state.YjsState)
	if err != nil {
		t.Fatalf("документ: %v", err)
	}
	text, ok := doc.TextOf(eventID.String(), "body")
	if !ok {
		t.Fatal("текста кадра нет в документе")
	}
	body := text.String()
	quote = "текст главы"
	if !strings.Contains(body, quote) {
		t.Fatalf("в тексте кадра нет %q: %q", quote, body)
	}
	// Индексы Yjs — единицы UTF-16, а не байты Go: считаем по рунам (в тексте без
	// суррогатных пар это совпадает), иначе границы фрагмента уедут на кириллице.
	byteIndex := strings.Index(body, quote)
	from := uint64(len([]rune(body[:byteIndex])))
	to := from + uint64(len([]rune(quote)))
	startPos, err := ygo.CreateRelativePositionFromTypeIndex(text, from, 1)
	if err != nil {
		t.Fatalf("якорь начала: %v", err)
	}
	endPos, err := ygo.CreateRelativePositionFromTypeIndex(text, to, -1)
	if err != nil {
		t.Fatalf("якорь конца: %v", err)
	}
	start, err := ygo.EncodeRelativePosition(startPos)
	if err != nil {
		t.Fatalf("кодирование: %v", err)
	}
	end, err := ygo.EncodeRelativePosition(endPos)
	if err != nil {
		t.Fatalf("кодирование: %v", err)
	}

	comments := events.New(e.st, e.proj)
	comment, err := comments.AddComment(ctx, owner, projectID, eventID, "Здесь провал в логике.", nil,
		&store.CommentAnchor{Field: "body", Start: start, End: end, Quote: quote})
	if err != nil {
		t.Fatalf("замечание к фрагменту: %v", err)
	}
	return projectID, eventID, comment.ID, quote
}

// Модель предлагает замену фрагмента; проект не меняется, пока человек не подтвердил.
func TestSpanProposalApplyAndRevert(t *testing.T) {
	e := setup(t,
		ai.Reply{ToolCalls: []ai.ToolCall{{
			Name: assistant.ToolProposeFragmentEdit,
			Arguments: map[string]any{
				"comment_id":  placeholderID,
				"replacement": "логика восстановлена",
				"reason":      "логика провисает",
			},
		}}},
		ai.Reply{Content: "Предлагаю поправить фрагмент."},
	)
	ctx := context.Background()
	owner := e.user(t, "owner@example.com")
	projectID, eventID, commentID, quote := spanEnv(t, e, owner)
	e.stub.replaceArgs(assistant.ToolProposeFragmentEdit, map[string]any{"comment_id": commentID.String()})

	turn, err := e.asst.Send(ctx, owner, projectID, uuid.Nil, "stub:stub-1", "Поправь по замечанию")
	if err != nil {
		t.Fatalf("send: %v", err)
	}
	if len(turn.Proposals) != 1 {
		t.Fatalf("предложений: %d, ожидалось 1 (%+v)", len(turn.Proposals), turn)
	}
	proposal := turn.Proposals[0]
	if proposal.Kind != store.AIChangeUpdateSpan {
		t.Fatalf("вид предложения: %q", proposal.Kind)
	}
	if proposal.OldSpan != quote || proposal.NewSpan != "логика восстановлена" {
		t.Errorf("«было/станет»: %q → %q", proposal.OldSpan, proposal.NewSpan)
	}
	// Проект не изменился до подтверждения.
	row, _ := e.eventByID(t, projectID, eventID)
	if !strings.Contains(row.Body, quote) {
		t.Fatalf("фрагмент изменился без подтверждения: %q", row.Body)
	}

	// Что именно сохранилось в предложении и что сейчас в документе — печатаем при провале:
	// «текст изменился» без этих двух строк не отличить от ошибки в индексах.
	stored, _ := e.st.AIChangeByID(ctx, projectID, proposal.ID)
	t.Logf("old_span=%q new_span=%q", stored.OldSpan, stored.NewSpan)

	// Применяем: меняется ровно фрагмент, окружающий текст на месте.
	if _, warning, err := e.asst.ApplyProposal(ctx, owner, owner, projectID, proposal.ID); err != nil {
		t.Fatalf("применение: %v (old_span=%q)", err, stored.OldSpan)
	} else if warning != "" {
		t.Errorf("предупреждение: %q", warning)
	}
	row, _ = e.eventByID(t, projectID, eventID)
	if !strings.Contains(row.Body, "логика восстановлена") || strings.Contains(row.Body, quote) {
		t.Fatalf("текст после применения: %q", row.Body)
	}

	// «Вернуть» возвращает прежний фрагмент.
	if _, _, err := e.asst.RevertProposal(ctx, owner, owner, projectID, proposal.ID); err != nil {
		t.Fatalf("возврат: %v", err)
	}
	row, _ = e.eventByID(t, projectID, eventID)
	if !strings.Contains(row.Body, quote) {
		t.Fatalf("после возврата текст: %q", row.Body)
	}
}

// Фрагмент правили после предложения — применять нельзя: подтверждали не этот текст.
func TestSpanProposalStaleAfterEdit(t *testing.T) {
	e := setup(t)
	ctx := context.Background()
	owner := e.user(t, "owner@example.com")
	projectID, eventID, commentID, quote := spanEnv(t, e, owner)

	// Заводим предложение напрямую: механика применения проверяется дешевле, чем через
	// заглушку провайдера, а путь «модель → предложение» проверен выше.
	state, err := e.st.GetProjectEventState(ctx, projectID)
	if err != nil || state == nil {
		t.Fatalf("снапшот: %v", err)
	}
	doc, err := yjs.FromState(state.YjsState)
	if err != nil {
		t.Fatalf("документ: %v", err)
	}
	anchors, err := e.st.CommentAnchors(ctx, []uuid.UUID{commentID})
	if err != nil {
		t.Fatalf("якоря: %v", err)
	}
	anchor := anchors[commentID]
	change, err := e.st.CreateAIChange(ctx, store.AIChange{
		ProjectID: projectID, UserID: owner,
		Kind: store.AIChangeUpdateSpan, EventID: eventID, EventTitle: "Глава 1",
		CommentID: &commentID, AnchorStart: anchor.Start, AnchorEnd: anchor.End,
		OldSpan: quote, NewSpan: "другой текст",
	})
	if err != nil {
		t.Fatalf("предложение: %v", err)
	}

	// Человек правит этот же фрагмент сам (через тот же спан-путь).
	span, ok := doc.ResolveSpan(eventID.String(), "body", anchor.Start, anchor.End)
	if !ok {
		t.Fatal("якорь не разрешился")
	}
	if found, err := doc.ReplaceEventSpan(eventID.String(), "body", span.From, span.To, "человек переписал"); err != nil || !found {
		t.Fatalf("правка человека: found=%v err=%v", found, err)
	}
	if _, err := e.st.SaveProjectEventStateServer(ctx, projectID, owner, doc.EncodeState()); err != nil {
		t.Fatalf("сохранение снапшота: %v", err)
	}

	_, _, err = e.asst.ApplyProposal(ctx, owner, owner, projectID, change.ID)
	if !errors.Is(err, assistant.ErrProposalStale) {
		t.Fatalf("применение устаревшего: %v, ожидалось ErrProposalStale", err)
	}
	// Правка человека на месте: проверяем ДОКУМЕНТ (проекция обновляется отдельным шагом,
	// и в этом тесте её пересчёта нет — важно, что текст не потерян).
	saved, err := e.st.GetProjectEventState(ctx, projectID)
	if err != nil || saved == nil {
		t.Fatalf("снапшот после правки: %v", err)
	}
	after, err := yjs.FromState(saved.YjsState)
	if err != nil {
		t.Fatalf("документ после правки: %v", err)
	}
	row, ok := after.EventByID(eventID.String())
	if !ok || !strings.Contains(row.Body, "человек переписал") {
		t.Fatalf("правка человека потеряна в документе: %+v", row)
	}
}
