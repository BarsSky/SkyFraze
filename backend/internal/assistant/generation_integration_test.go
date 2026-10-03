package assistant_test

// generation_integration_test.go — режимы генерации на проекте.
//
// Проверяем главное обещание разделения: владелец выбирает, что агенту можно, агент об
// этом знает, а недоступное не изображается доступным. Отдельно — отказ, когда режим
// требует генератора, которого нет: это не ошибка запроса, а состояние стенда.

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/skyfraze/backend/internal/ai"
	"github.com/skyfraze/backend/internal/assistant"
	"github.com/skyfraze/backend/internal/auth"
	"github.com/skyfraze/backend/internal/store"

	"github.com/google/uuid"
)

func TestProjectSettingsExposeGenerationAndCapabilities(t *testing.T) {
	e := setup(t, ai.Reply{Content: "Ответ."})
	ctx := context.Background()
	owner := e.user(t, "owner@example.com")
	projectID, _, _ := e.seedProject(t, owner)

	settings, err := e.asst.ProjectSettings(ctx, owner, projectID)
	if err != nil {
		t.Fatalf("настройки: %v", err)
	}
	// Умолчание проекта — auto: «как получится».
	if settings.Generation != store.GenerationAuto {
		t.Errorf("режим по умолчанию: %q", settings.Generation)
	}
	// Текст доступен всегда, картинок в этой версии нет (инструмент генерации ещё не
	// сделан) — и настройка говорит это словами, а не молчит.
	if !settings.Capabilities.Text {
		t.Error("текст должен быть доступен")
	}
	if settings.Capabilities.Images {
		t.Error("картинки не могут быть доступны без инструмента генерации")
	}
	if !strings.Contains(settings.Capabilities.ImageNote, "не умеет") {
		t.Errorf("причина недоступности картинок: %q", settings.Capabilities.ImageNote)
	}
	// Режимы для интерфейса: недоступные тоже видны, но с причиной.
	byID := map[string]assistant.GenerationOption{}
	for _, option := range settings.Generations {
		byID[option.ID] = option
	}
	if len(byID) != 4 {
		t.Fatalf("режимов должно быть четыре: %+v", settings.Generations)
	}
	if !byID[store.GenerationAuto].Available || !byID[store.GenerationText].Available {
		t.Error("режимы «как получится» и «только текст» должны быть доступны")
	}
	if byID[store.GenerationImages].Available || byID[store.GenerationBoth].Available {
		t.Error("режимы с картинками недоступны, пока нет инструмента генерации")
	}
	if !strings.Contains(byID[store.GenerationImages].Hint, "недоступно") {
		t.Errorf("у недоступного режима должна быть причина: %q", byID[store.GenerationImages].Hint)
	}
}

func TestSaveGenerationRefusesModesWithoutGenerator(t *testing.T) {
	e := setup(t, ai.Reply{Content: "Ответ."})
	ctx := context.Background()
	owner := e.user(t, "owner@example.com")
	projectID, _, _ := e.seedProject(t, owner)

	for _, mode := range []string{store.GenerationImages, store.GenerationBoth} {
		_, err := e.asst.SaveProjectSettings(ctx, owner, projectID, "", "", true, mode, "акварель")
		if !errors.Is(err, assistant.ErrImagesUnavailable) {
			t.Errorf("режим %q: ожидался отказ «генерация недоступна», получено %v", mode, err)
		}
	}

	// Текстовый режим сохраняется, и стиль иллюстраций ему не мешает (он пригодится,
	// когда генератор появится).
	saved, err := e.asst.SaveProjectSettings(ctx, owner, projectID, "chronicler", "Кратко.",
		true, store.GenerationText, "акварель, тёплый свет")
	if err != nil {
		t.Fatalf("текстовый режим: %v", err)
	}
	if saved.Generation != store.GenerationText || saved.ImageStyle != "акварель, тёплый свет" {
		t.Fatalf("сохранённые настройки: %+v", saved)
	}
	// И это видно при следующем чтении — настройка живёт на проекте.
	again, err := e.asst.ProjectSettings(ctx, owner, projectID)
	if err != nil {
		t.Fatalf("повторное чтение: %v", err)
	}
	if again.Generation != store.GenerationText {
		t.Errorf("режим после сохранения: %q", again.Generation)
	}
	// Пустая строка режима означает «не менять» — интерфейс может сохранять форму,
	// не трогая режим.
	kept, err := e.asst.SaveProjectSettings(ctx, owner, projectID, "chronicler", "Кратко.",
		true, "", "")
	if err != nil {
		t.Fatalf("сохранение без режима: %v", err)
	}
	if kept.Generation != store.GenerationText {
		t.Errorf("пустой режим не должен менять выбранный: %q", kept.Generation)
	}
}

// Режим «только картинки» без генератора: агент отказывается сразу, а не зовёт модель ради
// пустого ответа.
func TestSendRefusesImagesOnlyModeWithoutGenerator(t *testing.T) {
	e := setup(t, ai.Reply{Content: "Ответ."})
	ctx := context.Background()
	owner := e.user(t, "owner@example.com")
	projectID, _, _ := e.seedProject(t, owner)

	// Пишем режим напрямую в базу: через API его не сохранить (и это правильно —
	// проверено выше), а состояние «режим выбран, генератор пропал» возможно.
	if _, err := e.st.SaveAISettings(ctx, projectID, owner, "", "", true,
		store.GenerationImages, ""); err != nil {
		t.Fatalf("настройки: %v", err)
	}
	_, err := e.asst.Send(ctx, owner, projectID, uuid.Nil, "stub:stub-1", "Нарисуй маяк")
	if !errors.Is(err, assistant.ErrImagesUnavailable) {
		t.Fatalf("ожидался отказ «генерация недоступна», получено %v", err)
	}
	if got := e.stub.calls(); got != 0 {
		t.Errorf("модель не должна вызываться: запросов %d", got)
	}
}

// HTTP-контракт: попытка сохранить недоступный режим даёт 409 с причиной — интерфейс по
// этому коду показывает объяснение, а не «ошибка сервера».
func TestGenerationModeHTTPContract(t *testing.T) {
	e := setup(t, ai.Reply{Content: "Ответ."})
	owner := e.user(t, "owner@example.com")
	projectID, _, _ := e.seedProject(t, owner)
	router := assistantRouter(e)

	token, err := auth.IssueAccess(testSecret, owner)
	if err != nil {
		t.Fatalf("token: %v", err)
	}
	req := httptest.NewRequest(http.MethodPut,
		"/api/projects/"+projectID.String()+"/ai/settings",
		strings.NewReader(`{"role":"chronicler","instructions":"","generation":"both"}`))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "Bearer "+token)
	rec := httptest.NewRecorder()
	router.ServeHTTP(rec, req)

	if rec.Code != http.StatusConflict {
		t.Fatalf("код %d, тело %s", rec.Code, rec.Body.String())
	}
	if !strings.Contains(rec.Body.String(), "генерация") {
		t.Errorf("в ответе нет причины: %s", rec.Body.String())
	}
}
