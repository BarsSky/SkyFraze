package ai_test

// endpoints_integration_test.go — свои серверы моделей у пользователя.
//
// Это ответ на «у меня работает, а у других нет»: адрес сервера моделей раньше задавало
// только окружение стенда, и человек со своим llama.cpp подключиться не мог — поля для
// адреса не существовало. Проверяем, что теперь может: добавить, увидеть в списке
// провайдеров, получить с него модели, и что чужие серверы ему не видны.

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/skyfraze/backend/internal/ai"
	"github.com/skyfraze/backend/internal/store"
)

// ownServerStub — «свой сервер» человека: OpenAI-совместимый список моделей.
func ownServerStub(t *testing.T, wantKey string) *httptest.Server {
	t.Helper()
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if wantKey != "" && r.Header.Get("Authorization") != "Bearer "+wantKey {
			w.WriteHeader(http.StatusUnauthorized)
			_, _ = w.Write([]byte(`{"error":{"message":"требуется ключ"}}`))
			return
		}
		_, _ = w.Write([]byte(`{"data":[{"id":"моя-модель","supported_parameters":["tools"]}]}`))
	}))
	t.Cleanup(server.Close)
	return server
}

// mustProviders — список провайдеров человека или падение теста.
func mustProviders(t *testing.T, e *aiTestEnv) []ai.ProviderInfo {
	t.Helper()
	providers, err := e.svc.Providers(context.Background(), e.user)
	if err != nil {
		t.Fatalf("провайдеры: %v", err)
	}
	return providers
}

// TestUserEndpointBecomesProvider: свой сервер виден как обычный провайдер, и модели
// приходят с него, а не от сервера стенда.
func TestUserEndpointBecomesProvider(t *testing.T) {
	e := aiEnv(t)
	ctx := context.Background()
	own := ownServerStub(t, "")

	endpoint, err := e.svc.AddEndpoint(ctx, e.user, "llama.cpp дома", own.URL, "", true)
	if err != nil {
		t.Fatalf("добавление сервера: %v", err)
	}
	if endpoint.ProviderID != "own:"+endpoint.ID.String() {
		t.Errorf("идентификатор провайдера: %q", endpoint.ProviderID)
	}

	// Свой сервер виден в списке провайдеров рядом со стендовыми и помечен как локальный:
	// от этого зависит, спрашивать ли согласие на отправку текста.
	providers, err := e.svc.Providers(ctx, e.user)
	if err != nil {
		t.Fatalf("провайдеры: %v", err)
	}
	var found *ai.ProviderInfo
	for i := range providers {
		if providers[i].ID == endpoint.ProviderID {
			found = &providers[i]
		}
	}
	if found == nil {
		t.Fatalf("своего сервера нет в списке провайдеров: %+v", providers)
	}
	if !found.Local || found.KeyRequired {
		t.Errorf("свой сервер без ключа должен быть локальным и готовым: %+v", found)
	}
	if !found.Own || found.StandKey {
		t.Errorf("свой сервер должен быть помечен своим и не выдавать себя за сервер стенда: %+v", found)
	}
	if !strings.Contains(found.Title, "дома") {
		t.Errorf("название потерялось: %q", found.Title)
	}

	// И модели берутся ИМЕННО с него: адрес, который задал человек, действительно
	// используется (а не провайдер стенда).
	models, err := e.svc.Models(ctx, e.user, endpoint.ProviderID)
	if err != nil {
		t.Fatalf("модели своего сервера: %v", err)
	}
	if len(models) != 1 || models[0].ID != "моя-модель" {
		t.Fatalf("модели: %+v", models)
	}
	if !models[0].Local {
		t.Error("модель своего сервера должна считаться локальной")
	}
}

func TestUserEndpointsArePrivate(t *testing.T) {
	e := aiEnv(t)
	ctx := context.Background()
	own := ownServerStub(t, "")
	endpoint, err := e.svc.AddEndpoint(ctx, e.user, "мой сервер", own.URL, "", true)
	if err != nil {
		t.Fatalf("добавление: %v", err)
	}
	other, err := e.store.CreateUser(ctx, "other@example.com", "hash", "Другой")
	if err != nil {
		t.Fatalf("второй пользователь: %v", err)
	}

	// У другого человека своего сервера быть не должно: это его личный адрес.
	list, err := e.svc.Endpoints(ctx, other.ID)
	if err != nil {
		t.Fatalf("серверы другого: %v", err)
	}
	if len(list) != 0 {
		t.Fatalf("чужие серверы видны: %+v", list)
	}
	// И удалить чужой сервер нельзя — он для него не существует.
	// Чужой сервер для него не существует: удаление возвращает «не найдено».
	if err := e.svc.DeleteEndpoint(ctx, other.ID, endpoint.ID); !errors.Is(err, store.ErrNotFound) {
		t.Fatalf("чужой сервер должен быть неотличим от несуществующего, получено %v", err)
	}
	// А свой — можно, и он исчезает из списка.
	if err := e.svc.DeleteEndpoint(ctx, e.user, endpoint.ID); err != nil {
		t.Fatalf("удаление своего сервера: %v", err)
	}
	list, _ = e.svc.Endpoints(ctx, e.user)
	if len(list) != 0 {
		t.Fatalf("после удаления остался сервер: %+v", list)
	}
}

func TestUserEndpointKeyIsEncrypted(t *testing.T) {
	e := aiEnv(t)
	ctx := context.Background()
	own := ownServerStub(t, "секрет-сервера")

	// Сервер требует ключ: без ключа модели не придут.
	if _, err := e.svc.AddEndpoint(ctx, e.user, "сервер с ключом", own.URL, "", false); err != nil {
		t.Fatalf("добавление: %v", err)
	}
	list, _ := e.svc.Endpoints(ctx, e.user)
	if _, err := e.svc.Models(ctx, e.user, list[0].ProviderID); err == nil {
		t.Fatal("без ключа сервер не должен отвечать моделями")
	}
	// С ключом — работает, и ключ наружу не отдаётся.
	if err := e.svc.DeleteEndpoint(ctx, e.user, list[0].ID); err != nil {
		t.Fatalf("удаление: %v", err)
	}
	endpoint, err := e.svc.AddEndpoint(ctx, e.user, "сервер с ключом", own.URL, "секрет-сервера", false)
	if err != nil {
		t.Fatalf("добавление с ключом: %v", err)
	}
	if !endpoint.HasKey {
		t.Error("признак «ключ задан» потерялся")
	}
	// Сервер с уже заданным ключом НЕ должен выглядеть как «нужен ключ»: ключ лежит в
	// самой записи сервера, и предлагать ввести его ещё раз (в другом месте, где его
	// негде хранить) — значит показывать неготовое там, где всё готово.
	for _, provider := range mustProviders(t, e) {
		if provider.ID != endpoint.ProviderID {
			continue
		}
		if !provider.HasKey || provider.KeyRequired {
			t.Errorf("сервер с ключом должен быть готов: %+v", provider)
		}
		if provider.StandKey {
			t.Errorf("ключ стенда не имеет отношения к своему серверу: %+v", provider)
		}
	}
	if strings.Contains(endpoint.URL, "секрет") {
		t.Error("ключ попал в адрес")
	}
	models, err := e.svc.Models(ctx, e.user, endpoint.ProviderID)
	if err != nil {
		t.Fatalf("модели с ключом: %v", err)
	}
	if len(models) != 1 {
		t.Fatalf("модели: %+v", models)
	}
	// В базе ключ лежит шифртекстом, а не открытым текстом.
	rows, err := e.store.ListAIEndpoints(ctx, e.user)
	if err != nil || len(rows) != 1 {
		t.Fatalf("записи: %v (%v)", rows, err)
	}
	if strings.Contains(string(rows[0].KeyCiphertext), "секрет-сервера") {
		t.Fatal("ключ сервера лежит открытым текстом")
	}
	// И через ручку ключей он не меняется: у своего сервера ключ часть адреса.
	if err := e.svc.SetKey(ctx, e.user, endpoint.ProviderID, "другой"); err == nil {
		t.Error("ключ своего сервера не должен задаваться через /keys")
	}
}

// TestUserEndpointConsent закрывает тихий отказ, который легко не заметить: согласие
// хранилось, но список согласий фильтровался по провайдерам СТЕНДА, и для `own:<uuid>`
// всегда выходил пустым. Снаружи это выглядело так: галочка согласия снимается сама, а
// отправка в свой (не локальный) сервер всегда отклоняется — «ничего не работает», без
// единой ошибки в логах.
func TestUserEndpointConsent(t *testing.T) {
	e := aiEnv(t)
	ctx := context.Background()
	own := ownServerStub(t, "")

	// 1. Локальный свой сервер: согласие не спрашивают — текст никуда не уходит.
	local, err := e.svc.AddEndpoint(ctx, e.user, "llama.cpp дома", own.URL, "", true)
	if err != nil {
		t.Fatalf("добавление локального: %v", err)
	}
	if ok, err := e.svc.HasConsentFor(ctx, e.user, local.ProviderID, "моя-модель"); err != nil || !ok {
		t.Fatalf("локальному серверу согласие не нужно: ok=%v err=%v", ok, err)
	}
	consents, err := e.svc.Consents(ctx, e.user)
	if err != nil {
		t.Fatalf("согласия: %v", err)
	}
	if len(consents) != 0 {
		t.Fatalf("локальному серверу согласие не записывается: %+v", consents)
	}

	// 2. Свой сервер в интернете: согласие нужно и должно работать как обычное.
	remote, err := e.svc.AddEndpoint(ctx, e.user, "чужой сервер", own.URL, "", false)
	if err != nil {
		t.Fatalf("добавление внешнего: %v", err)
	}
	if ok, err := e.svc.HasConsentFor(ctx, e.user, remote.ProviderID, "моя-модель"); err != nil || ok {
		t.Fatalf("без согласия отправлять нельзя: ok=%v err=%v", ok, err)
	}
	if err := e.svc.SetConsent(ctx, e.user, remote.ProviderID); err != nil {
		t.Fatalf("сохранение согласия: %v", err)
	}
	// Главное: согласие видно в списке — именно здесь оно раньше терялось.
	consents, err = e.svc.Consents(ctx, e.user)
	if err != nil {
		t.Fatalf("согласия: %v", err)
	}
	if len(consents) != 1 || consents[0] != remote.ProviderID {
		t.Fatalf("согласие своего сервера потерялось: %+v", consents)
	}
	if ok, err := e.svc.HasConsentFor(ctx, e.user, remote.ProviderID, "моя-модель"); err != nil || !ok {
		t.Fatalf("с согласием отправлять можно: ok=%v err=%v", ok, err)
	}

	// 3. Удалили сервер — согласие перестаёт быть видимым: оно относилось к нему.
	if err := e.svc.DeleteEndpoint(ctx, e.user, remote.ID); err != nil {
		t.Fatalf("удаление: %v", err)
	}
	consents, err = e.svc.Consents(ctx, e.user)
	if err != nil {
		t.Fatalf("согласия: %v", err)
	}
	if len(consents) != 0 {
		t.Fatalf("согласие удалённого сервера осталось в списке: %+v", consents)
	}
	// 4. Отзыв согласия работает и не мешает следующему согласию.
	if err := e.svc.SetConsent(ctx, e.user, local.ProviderID); err != nil {
		t.Fatalf("согласие на локальный: %v", err)
	}
	if err := e.svc.DeleteConsent(ctx, e.user, local.ProviderID); err != nil {
		t.Fatalf("отзыв: %v", err)
	}
}

// TestUserEndpointURLIsNormalized: адрес сохраняется в виде без хвостового слэша.
// Иначе клиент дописывает путь сам (`/v1/models`) и получает двойной слэш — часть
// OpenAI-совместимых серверов на такое отвечает 404, и это выглядит как «сервер не тот».
func TestUserEndpointURLIsNormalized(t *testing.T) {
	e := aiEnv(t)
	ctx := context.Background()

	endpoint, err := e.svc.AddEndpoint(ctx, e.user, "со слэшем", "http://127.0.0.1:8080/v1/", "", true)
	if err != nil {
		t.Fatalf("добавление: %v", err)
	}
	if endpoint.URL != "http://127.0.0.1:8080/v1" {
		t.Errorf("адрес сохранён как %q, ожидался без хвостового слэша", endpoint.URL)
	}
	// Адрес без пути сохраняется как есть — лишний слэш не появляется.
	bare, err := e.svc.AddEndpoint(ctx, e.user, "без пути", "http://127.0.0.1:8080/", "", true)
	if err != nil {
		t.Fatalf("добавление без пути: %v", err)
	}
	if bare.URL != "http://127.0.0.1:8080" {
		t.Errorf("адрес без пути сохранён как %q", bare.URL)
	}
}

func TestUserEndpointValidation(t *testing.T) {
	e := aiEnv(t)
	ctx := context.Background()

	cases := map[string]struct{ title, url string }{
		"без названия":    {"", "http://127.0.0.1:8080"},
		"без схемы":       {"сервер", "127.0.0.1:8080/v1"},
		"чужая схема":     {"сервер", "ftp://127.0.0.1"},
		"без хоста":       {"сервер", "http://"},
		"слишком длинный": {"сервер", "http://127.0.0.1/" + strings.Repeat("a", 400)},
	}
	for name, tc := range cases {
		if _, err := e.svc.AddEndpoint(ctx, e.user, tc.title, tc.url, "", true); err == nil {
			t.Errorf("%s: должно быть отвергнуто", name)
		}
	}
	// Предел на число своих серверов: каталог вместо «своего сервера» не нужен.
	own := ownServerStub(t, "")
	for i := 0; i < 5; i++ {
		if _, err := e.svc.AddEndpoint(ctx, e.user, "сервер", own.URL, "", true); err != nil {
			t.Fatalf("добавление %d: %v", i+1, err)
		}
	}
	if _, err := e.svc.AddEndpoint(ctx, e.user, "шестой", own.URL, "", true); err == nil {
		t.Fatal("шестой сервер должен быть отвергнут")
	}
}
