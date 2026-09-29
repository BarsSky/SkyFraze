package people_test

import (
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"

	"github.com/skyfraze/backend/internal/auth"
	"github.com/skyfraze/backend/internal/people"
	"github.com/skyfraze/backend/internal/store"
)

// Эти тесты не ходят в базу: они проверяют само дерево /api/users и разбор
// параметров — то, что ломается молча и выглядит как «поиск не работает».
const routeSecret = "test-secret-please-change"

func testRouter(t *testing.T) http.Handler {
	t.Helper()
	authSvc := auth.New(nil, routeSecret)
	h := people.NewHandler(people.New(nil), slog.New(slog.NewTextHandler(io.Discard, nil)))
	// Заглушка вместо coauthors.Search: важно лишь, что запрос попал в поиск.
	search := func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"handler":"search"}`))
	}
	r := chi.NewRouter()
	r.Mount("/api/users", h.Routes(authSvc, search))
	return r
}

func do(t *testing.T, h http.Handler, method, path string) *httptest.ResponseRecorder {
	t.Helper()
	token, err := auth.IssueAccess(routeSecret, uuid.New())
	if err != nil {
		t.Fatalf("token: %v", err)
	}
	req := httptest.NewRequest(method, path, nil)
	req.Header.Set("Authorization", "Bearer "+token)
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	return rec
}

// Статический /api/users/search не должен перехватываться параметрическим
// /api/users/{id}: иначе поиск людей уходил бы в профиль с id «search» и отвечал
// «invalid user id» вместо результатов, а искать человека стало бы нечем.
func TestRoutes_SearchIsNotShadowedByProfileID(t *testing.T) {
	h := testRouter(t)

	rec := do(t, h, http.MethodGet, "/api/users/search?q=bob")
	if rec.Code != http.StatusOK || !strings.Contains(rec.Body.String(), "search") {
		t.Fatalf("GET /api/users/search ушёл не в поиск: код %d, тело %s", rec.Code, rec.Body.String())
	}

	// Параметрическая ветка при этом жива: мусор в id — 400 от профиля, а не
	// «404 страница не найдена» (то есть ветка {id} действительно существует).
	rec = do(t, h, http.MethodGet, "/api/users/not-a-uuid")
	if rec.Code != http.StatusBadRequest || !strings.Contains(rec.Body.String(), "invalid user id") {
		t.Fatalf("GET /api/users/{id} с мусором: код %d, тело %s", rec.Code, rec.Body.String())
	}
}

func TestRoutes_CatalogRejectsBadQuery(t *testing.T) {
	h := testRouter(t)
	cases := []string{
		"/api/users?limit=abc",
		"/api/users?offset=x",
		"/api/users?limit=10&offset=-1",
		"/api/users?craft=" + url.QueryEscape(strings.Repeat("я", 61)),
	}
	for _, path := range cases {
		rec := do(t, h, http.MethodGet, path)
		if rec.Code != http.StatusBadRequest {
			t.Errorf("%s: код %d, ожидался 400 (%s)", path, rec.Code, rec.Body.String())
		}
	}
}

func TestRoutes_RequireAuth(t *testing.T) {
	h := testRouter(t)
	for _, path := range []string{"/api/users", "/api/users/search?q=bob"} {
		req := httptest.NewRequest(http.MethodGet, path, nil)
		rec := httptest.NewRecorder()
		h.ServeHTTP(rec, req)
		if rec.Code != http.StatusUnauthorized {
			t.Errorf("%s без токена: код %d, ожидался 401", path, rec.Code)
		}
	}
}

// Формат ответа — часть контракта с интерфейсом: он читает ровно эти ключи, и
// переименование поля в Go не должно проходить незамеченным.
func TestResponseShape(t *testing.T) {
	raw, err := json.Marshal(people.CatalogPage{
		Items: []store.UserPublic{{
			ID: uuid.New(), Username: "bob", DisplayName: "Борис", Bio: "Пишу фэнтези",
			Crafts: []string{"Арт"}, Relation: "coauthor", PublicStories: 2, Discoverable: true,
		}},
		Total: 3, Limit: 24, Offset: 0,
	})
	if err != nil {
		t.Fatalf("marshal page: %v", err)
	}
	page := decodeObject(t, raw)
	assertKeys(t, page, "items", "total", "limit", "offset")

	var items []json.RawMessage
	if err := json.Unmarshal(page["items"], &items); err != nil {
		t.Fatalf("items: %v", err)
	}
	if len(items) != 1 {
		t.Fatalf("items: %d записей", len(items))
	}
	item := decodeObject(t, items[0])
	// discoverable здесь лишний: в каталоге все и так видимые, а своё значение
	// человек смотрит в /api/auth/me.
	assertKeys(t, item, "id", "username", "display_name", "bio", "crafts", "relation", "public_stories")

	raw, err = json.Marshal(people.Profile{
		UserPublic: store.UserPublic{
			ID: uuid.New(), Username: "bob", DisplayName: "Борис", Bio: "Пишу фэнтези",
			Crafts: []string{"Арт"}, Relation: "", PublicStories: 1,
		},
		Stories: []store.UserPublicStory{{ID: uuid.New(), Title: "Роман", Slug: "roman-ab12"}},
	})
	if err != nil {
		t.Fatalf("marshal profile: %v", err)
	}
	assertKeys(t, decodeObject(t, raw),
		"id", "username", "display_name", "bio", "crafts", "relation", "public_stories", "stories")
}

func decodeObject(t *testing.T, raw json.RawMessage) map[string]json.RawMessage {
	t.Helper()
	var out map[string]json.RawMessage
	if err := json.Unmarshal(raw, &out); err != nil {
		t.Fatalf("unmarshal %s: %v", raw, err)
	}
	return out
}

func assertKeys(t *testing.T, obj map[string]json.RawMessage, want ...string) {
	t.Helper()
	if len(obj) != len(want) {
		t.Fatalf("ключей %d (%v), ожидалось %d (%v)", len(obj), keysOf(obj), len(want), want)
	}
	for _, k := range want {
		if _, ok := obj[k]; !ok {
			t.Fatalf("нет ключа %q в %v", k, keysOf(obj))
		}
	}
}

func keysOf(obj map[string]json.RawMessage) []string {
	out := make([]string, 0, len(obj))
	for k := range obj {
		out = append(out, k)
	}
	return out
}
