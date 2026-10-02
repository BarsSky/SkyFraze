package assistant_test

// tokens_integration_test.go — расход токенов: подсчёт, оценка и предел.
//
// Зачем это проверять отдельно. Предел, который не считает расход, — это не предел, а
// надпись. Поэтому проверяем три вещи: расход виден по беседам человека (и только по
// своим), счётчик провайдера используется, когда он есть, и оценка подставляется,
// когда провайдер счётчиков не прислал.

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/google/uuid"

	"github.com/skyfraze/backend/internal/ai"
	"github.com/skyfraze/backend/internal/assistant"
	"github.com/skyfraze/backend/internal/auth"
)

func TestSendCountsProviderTokens(t *testing.T) {
	e := setup(t, ai.Reply{Content: "Ответ.", TokensIn: 120, TokensOut: 40})
	ctx := context.Background()
	owner := e.user(t, "owner@example.com")
	projectID, _, _ := e.seedProject(t, owner)

	turn, err := e.asst.Send(ctx, owner, projectID, uuid.Nil, "stub:stub-1", "Сколько весит маяк?")
	if err != nil {
		t.Fatalf("send: %v", err)
	}
	// Счётчик провайдера точный: подставлять вместо него оценку нельзя.
	if turn.Message.TokensIn != 120 || turn.Message.TokensOut != 40 {
		t.Fatalf("токены сообщения: %d/%d", turn.Message.TokensIn, turn.Message.TokensOut)
	}
	spent, err := e.models.SpentTokens(ctx, owner)
	if err != nil {
		t.Fatalf("расход: %v", err)
	}
	if spent != 160 {
		t.Fatalf("расход за сутки: %d, ожидалось 160", spent)
	}
	// Чужой расход в счёт не идёт: это личный бюджет, а не общий счётчик стенда.
	stranger := e.user(t, "stranger@example.com")
	if other, err := e.models.SpentTokens(ctx, stranger); err != nil || other != 0 {
		t.Fatalf("расход постороннего: %d (err=%v)", other, err)
	}
}

func TestSendEstimatesTokensWhenProviderSilent(t *testing.T) {
	// Провайдер не прислал счётчиков (в потоке так бывает): расход всё равно должен
	// быть посчитан, иначе предел не работал бы.
	e := setup(t, ai.Reply{Content: strings.Repeat("Маяк светит. ", 20)})
	ctx := context.Background()
	owner := e.user(t, "owner@example.com")
	projectID, _, _ := e.seedProject(t, owner)

	turn, err := e.asst.Send(ctx, owner, projectID, uuid.Nil, "stub:stub-1", "Расскажи о маяке")
	if err != nil {
		t.Fatalf("send: %v", err)
	}
	if turn.Message.TokensIn <= 0 || turn.Message.TokensOut <= 0 {
		t.Fatalf("расход не посчитан: %d/%d", turn.Message.TokensIn, turn.Message.TokensOut)
	}
	if turn.Message.TokensOut < 20 {
		t.Errorf("оценка выхода занижена: %d", turn.Message.TokensOut)
	}
}

func TestSendRefusesWhenTokenBudgetExhausted(t *testing.T) {
	e := setup(t, ai.Reply{Content: "Ответ.", TokensIn: 500, TokensOut: 500})
	ctx := context.Background()
	owner := e.user(t, "owner@example.com")
	projectID, _, _ := e.seedProject(t, owner)

	// Предел 900: первый вопрос (1000 токенов) проходит, второй — уже нет.
	e.models.SetTokensPerDay(900)
	if _, err := e.asst.Send(ctx, owner, projectID, uuid.Nil, "stub:stub-1", "Первый вопрос"); err != nil {
		t.Fatalf("первый вопрос должен пройти: %v", err)
	}
	_, err := e.asst.Send(ctx, owner, projectID, uuid.Nil, "stub:stub-1", "Второй вопрос")
	if !errors.Is(err, assistant.ErrTokenBudget) {
		t.Fatalf("ожидался отказ по пределу, получено: %v", err)
	}
	// Отказ — ДО обращения к модели: платить за вопрос, который не будет обслужен,
	// никто не должен.
	if got := e.stub.calls(); got != 1 {
		t.Errorf("запросов к провайдеру: %d, ожидался 1", got)
	}
	// И новой беседы с вопросом без ответа появиться не должно.
	conversations, err := e.st.ListAIConversations(ctx, projectID, owner)
	if err != nil {
		t.Fatalf("беседы: %v", err)
	}
	if len(conversations) != 1 {
		t.Errorf("бесед: %d, ожидалась одна (вторая не должна была создаться)", len(conversations))
	}
}

func TestTokenBudgetIsOffByDefault(t *testing.T) {
	// Предел по умолчанию не задан: локальная модель бесплатна, и запрет «на всякий
	// случай» только мешал бы.
	e := setup(t, ai.Reply{Content: "Ответ.", TokensIn: 9000, TokensOut: 9000})
	ctx := context.Background()
	owner := e.user(t, "owner@example.com")
	projectID, _, _ := e.seedProject(t, owner)

	if limit := e.models.TokensPerDay(); limit != 0 {
		t.Fatalf("предел по умолчанию: %d", limit)
	}
	if _, err := e.asst.Send(ctx, owner, projectID, uuid.Nil, "stub:stub-1", "Вопрос"); err != nil {
		t.Fatalf("без предела вопрос должен проходить: %v", err)
	}
}

// HTTP-контракт: предел упирается в 429 с признаком, по которому интерфейс объясняет
// человеку, что случилось (а не показывает «ошибка сервера»).
func TestTokenBudgetHTTPContract(t *testing.T) {
	e := setup(t, ai.Reply{Content: "Ответ.", TokensIn: 500, TokensOut: 500})
	owner := e.user(t, "owner@example.com")
	projectID, _, _ := e.seedProject(t, owner)
	e.models.SetTokensPerDay(600)

	router := assistantRouter(e)
	post := func() *httptest.ResponseRecorder {
		t.Helper()
		token, err := auth.IssueAccess(testSecret, owner)
		if err != nil {
			t.Fatalf("token: %v", err)
		}
		req := httptest.NewRequest(http.MethodPost,
			"/api/projects/"+projectID.String()+"/ai/conversations/new/stream",
			strings.NewReader(`{"text":"Вопрос","model":"stub:stub-1"}`))
		req.Header.Set("Content-Type", "application/json")
		req.Header.Set("Authorization", "Bearer "+token)
		rec := httptest.NewRecorder()
		router.ServeHTTP(rec, req)
		return rec
	}
	if rec := post(); rec.Code != http.StatusOK {
		t.Fatalf("первый запрос: код %d, тело %s", rec.Code, rec.Body.String())
	}
	rec := post()
	if rec.Code != http.StatusTooManyRequests {
		t.Fatalf("второй запрос: код %d, тело %s", rec.Code, rec.Body.String())
	}
	if !strings.Contains(rec.Body.String(), `"token_budget":true`) {
		t.Errorf("в ответе нет признака предела: %s", rec.Body.String())
	}
	// Ошибка до начала потока уходит обычным JSON — интерфейс покажет её как объяснение,
	// а не как обрыв потока.
	if ct := rec.Header().Get("Content-Type"); !strings.HasPrefix(ct, "application/json") {
		t.Errorf("Content-Type: %q", ct)
	}
}
