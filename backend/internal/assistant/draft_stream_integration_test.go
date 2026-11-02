package assistant_test

// draft_stream_integration_test.go — новый текст кадра, который человек видит в потоке (0.144.0).
//
// Зачем это. Модель не обязана переписывать главу внутри JSON-аргумента: текст можно отдать
// обычным блоком ```skyfraze-text id=<uuid>, и тогда экранировать нечего — а значит и
// обрываться не на чем. Такой блок должен:
//
//   - идти человеку ЧЕРНОВИКОМ по мере написания (события draft), а не молчать до конца;
//   - НЕ попадать в реплику помощника: это не ответ, а предлагаемый текст;
//   - превращаться в предложение правки, как и update_event_text;
//   - если модель оборвалась на середине — не становиться правкой, а вернуть внятную
//     ошибку: человек видел черновик, и он должен знать, что тот не применён.

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"testing"

	"github.com/google/uuid"

	"github.com/skyfraze/backend/internal/ai"
	"github.com/skyfraze/backend/internal/assistant"
	"github.com/skyfraze/backend/internal/store"
)

// draftText — склейка полученных событий-черновиков.
func (c *collector) draftText() string {
	var out strings.Builder
	for _, event := range c.events {
		if event.Type == assistant.EventDraft {
			out.WriteString(event.Text)
		}
	}
	return out.String()
}

// draftTruncated — пришло ли событие «черновик оборвался».
func (c *collector) draftTruncated() bool {
	for _, event := range c.events {
		if event.Type == assistant.EventDraft && event.Truncated {
			return true
		}
	}
	return false
}

// Новый текст кадра приходит в поток, как пишется, и становится предложением правки.
func TestSendStreamDraftBecomesProposal(t *testing.T) {
	e := setup(t)
	ctx := context.Background()
	owner := e.user(t, "owner@example.com")
	projectID, chapter := e.seedParagraphProject(t, owner)

	newText := "Новый первый абзац.\n\nНовый второй абзац."
	e.stub.setReplies(
		ai.Reply{Content: fmt.Sprintf("Предлагаю новую редакцию.\n\n```skyfraze-text id=%s\n%s\n```",
			chapter, newText)},
		ai.Reply{Content: "Предлагаю заменить текст главы — подтвердите в окне помощника."},
	)

	events := &collector{}
	turn, err := e.asst.SendStream(ctx, owner, projectID, uuid.Nil, "stub:stub-1",
		"Перепиши главу целиком", events.emit)
	if err != nil {
		t.Fatalf("поток: %v", err)
	}

	// Черновик пришёл кусками и целиком.
	draft := events.draftText()
	if strings.TrimSpace(draft) != newText {
		t.Fatalf("черновик:\n%q\nожидалось:\n%q", draft, newText)
	}
	if events.draftTruncated() {
		t.Fatal("целый черновик помечен оборванным")
	}
	// В реплике — только проза модели, без строки параметров и без текста главы.
	said := events.text()
	if strings.Contains(said, "skyfraze-text") || strings.Contains(said, "Новый первый абзац") {
		t.Fatalf("новый текст кадра попал в реплику помощника: %q", said)
	}
	if !strings.HasPrefix(said, "Предлагаю новую редакцию.") {
		t.Fatalf("проза модели потерялась: %q", said)
	}

	// Предложение правки есть, кадр при этом не изменён.
	if len(turn.Proposals) != 1 {
		t.Fatalf("предложений: %d (%+v)", len(turn.Proposals), turn.Proposals)
	}
	proposal := turn.Proposals[0]
	if proposal.Kind != store.AIChangeUpdateText || proposal.EventID != chapter {
		t.Fatalf("предложение: %+v", proposal)
	}
	if proposal.OldBody != paragraphBody || proposal.NewBody != newText {
		t.Errorf("снимок «было/станет»: %+v", proposal)
	}
	row, _ := e.eventByID(t, projectID, chapter)
	if row.Body != paragraphBody {
		t.Fatalf("текст изменён без подтверждения: %q", row.Body)
	}
	if turn.Answer == "" || strings.Contains(turn.Answer, "skyfraze-text") {
		t.Fatalf("ответ модели сохранён неверно: %q", turn.Answer)
	}
}

// Черновик оборвался на середине — правкой он не становится, и человеку это сказано.
func TestSendStreamTruncatedDraftIsRefused(t *testing.T) {
	e := setup(t)
	ctx := context.Background()
	owner := e.user(t, "owner@example.com")
	projectID, chapter := e.seedParagraphProject(t, owner)

	e.stub.setReplies(ai.Reply{Content: fmt.Sprintf(
		"```skyfraze-text id=%s\nНовый первый абзац и вдруг генерация", chapter)})

	events := &collector{}
	_, err := e.asst.SendStream(ctx, owner, projectID, uuid.Nil, "stub:stub-1",
		"Перепиши главу целиком", events.emit)
	if err == nil {
		t.Fatal("оборванный черновик должен быть ошибкой, а не «Готово»")
	}
	if !errors.Is(err, assistant.ErrDraftTruncated) {
		t.Fatalf("ошибка: %v", err)
	}
	if !events.draftTruncated() {
		t.Fatal("интерфейсу не сказали, что черновик оборвался")
	}
	if !strings.Contains(events.draftText(), "Новый первый абзац") {
		t.Fatalf("сказанное до обрыва потерялось: %q", events.draftText())
	}
	// Проект прежний: оборванный текст не применён.
	row, _ := e.eventByID(t, projectID, chapter)
	if row.Body != paragraphBody {
		t.Fatalf("оборванный черновик изменил текст: %q", row.Body)
	}
}
