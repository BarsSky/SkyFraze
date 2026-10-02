package assistant_test

// images_integration_test.go — картинки, приложенные к вопросу.
//
// Проверяем три обещания, которые даёт интерфейс:
//   - картинка действительно уходит модели (и в том виде, который та понимает);
//   - модель, которая картинок не видит, получает отказ ДО запроса, а не молча
//     игнорирует изображение (иначе человек думает, что модель его посмотрела);
//   - мусор вместо картинки отвергается нами: провайдеру такое отправлять незачем.

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/google/uuid"
	"github.com/skyfraze/backend/internal/ai"
	"github.com/skyfraze/backend/internal/auth"
)

// tinyPNG — настоящая картинка 1×1 в виде data URL (не «abc»): проверяем формат так,
// как его увидит провайдер.
const tinyPNG = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg=="

func TestSendStreamImagesGoToProvider(t *testing.T) {
	e := setup(t, ai.Reply{Content: "Вижу маяк на скале."})
	ctx := context.Background()
	owner := e.user(t, "owner@example.com")
	projectID, _, _ := e.seedProject(t, owner)

	events := &collector{}
	turn, err := e.asst.SendStreamImages(ctx, owner, projectID, uuid.Nil, "stub:stub-vision",
		"Что на картинке?", []string{tinyPNG}, events.emit)
	if err != nil {
		t.Fatalf("вопрос с картинкой: %v", err)
	}
	if turn.Answer != "Вижу маяк на скале." {
		t.Errorf("ответ: %q", turn.Answer)
	}
	sent := e.stub.lastRaw()
	if !strings.Contains(sent, "iVBORw0KGgo") {
		t.Errorf("картинка не ушла провайдеру: %s", sent)
	}
	// OpenAI-совместимые серверы ждут data URL целиком — так и отправляем.
	if !strings.Contains(sent, "data:image/png;base64,") {
		t.Errorf("картинка ушла не как data URL: %s", sent)
	}
	if !strings.Contains(sent, `"type":"image_url"`) {
		t.Errorf("картинка не стала частью контента: %s", sent)
	}
}

func TestSendStreamImagesRefusesBlindModel(t *testing.T) {
	e := setup(t, ai.Reply{Content: "Ответ."})
	ctx := context.Background()
	owner := e.user(t, "owner@example.com")
	projectID, _, _ := e.seedProject(t, owner)

	_, err := e.asst.SendStreamImages(ctx, owner, projectID, uuid.Nil, "stub:stub-1",
		"Что на картинке?", []string{tinyPNG}, nil)
	if !errors.Is(err, ai.ErrNoVision) {
		t.Fatalf("ожидался отказ «модель не видит картинки», получено: %v", err)
	}
	// Отказ — до обращения к модели: незачем платить за запрос, в котором картинку
	// проигнорируют.
	if got := e.stub.calls(); got != 0 {
		t.Errorf("запросов к модели: %d, ожидалось 0", got)
	}
	// И беседы с вопросом без ответа не появилось.
	conversations, err := e.st.ListAIConversations(ctx, projectID, owner)
	if err != nil {
		t.Fatalf("беседы: %v", err)
	}
	if len(conversations) != 0 {
		t.Errorf("бесед: %d, ожидалось 0", len(conversations))
	}
}

func TestSendStreamImagesRejectsGarbage(t *testing.T) {
	e := setup(t, ai.Reply{Content: "Ответ."})
	ctx := context.Background()
	owner := e.user(t, "owner@example.com")
	projectID, _, _ := e.seedProject(t, owner)

	for name, image := range map[string]string{
		"не data URL": "просто текст",
		"svg":         "data:image/svg+xml;base64,PHN2Zy8+",
		"без base64":  "data:image/png,abc",
	} {
		_, err := e.asst.SendStreamImages(ctx, owner, projectID, uuid.Nil, "stub:stub-vision",
			"Что тут?", []string{image}, nil)
		if err == nil {
			t.Errorf("%s: должно быть отвергнуто", name)
		}
	}
	if got := e.stub.calls(); got != 0 {
		t.Errorf("запросов к модели: %d, ожидалось 0", got)
	}
}

// HTTP-контракт: тело с картинкой проходит (обработчик поднимает предел размера тела), а
// слепая модель получает 415 — по этому коду интерфейс объясняет причину словами.
func TestImageHTTPContract(t *testing.T) {
	e := setup(t, ai.Reply{Content: "Вижу."})
	owner := e.user(t, "owner@example.com")
	projectID, _, _ := e.seedProject(t, owner)
	router := assistantRouter(e)

	post := func(body string) *httptest.ResponseRecorder {
		t.Helper()
		token, err := auth.IssueAccess(testSecret, owner)
		if err != nil {
			t.Fatalf("token: %v", err)
		}
		req := httptest.NewRequest(http.MethodPost,
			"/api/projects/"+projectID.String()+"/ai/conversations/new/stream",
			strings.NewReader(body))
		req.Header.Set("Content-Type", "application/json")
		req.Header.Set("Authorization", "Bearer "+token)
		rec := httptest.NewRecorder()
		router.ServeHTTP(rec, req)
		return rec
	}

	ok := post(`{"text":"Что на картинке?","model":"stub:stub-vision","images":["` + tinyPNG + `"]}`)
	if ok.Code != http.StatusOK {
		t.Fatalf("вопрос с картинкой: код %d, тело %s", ok.Code, ok.Body.String())
	}

	blind := post(`{"text":"Что на картинке?","model":"stub:stub-1","images":["` + tinyPNG + `"]}`)
	if blind.Code != http.StatusUnsupportedMediaType {
		t.Fatalf("слепая модель: код %d, тело %s", blind.Code, blind.Body.String())
	}
	if !strings.Contains(blind.Body.String(), "не видит изображения") {
		t.Errorf("в ответе нет объяснения: %s", blind.Body.String())
	}
}
