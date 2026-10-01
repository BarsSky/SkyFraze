package update

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"
	"time"
)

// ---------- сравнение версий (чистая логика) ----------

func TestIsNewer(t *testing.T) {
	cases := []struct {
		latest, current string
		want            bool
	}{
		{"v0.2.0", "v0.1.9", true},
		{"v0.2.0", "v0.2.0", false},
		{"v0.1.9", "v0.2.0", false},
		{"v1.0.0", "v0.9.9", true},
		{"v0.2.0", "dev", true}, // у dev нет версии — любой релиз новее
		{"v0.2.0", "", true},
		{"v0.2.1", "0.2.1+build3", false}, // суффикс сборки не считается новее
		{"v0.3.0", "v0.2.9-rc1", true},
	}
	for _, c := range cases {
		if got := isNewer(c.latest, c.current); got != c.want {
			t.Errorf("isNewer(%q, %q) = %v, ожидалось %v", c.latest, c.current, got, c.want)
		}
	}
}

func TestNormalizeVersion(t *testing.T) {
	cases := map[string]string{
		"v0.2.0":          "0.2.0",
		"0.2.0+3-gabc123": "0.2.0",
		"dev":             "",
		"unknown":         "",
		"":                "",
	}
	for in, want := range cases {
		if got := normalizeVersion(in); got != want {
			t.Errorf("normalizeVersion(%q) = %q, ожидалось %q", in, got, want)
		}
	}
}

// ---------- заявка и состояние (каталог, общий с хостом) ----------

func TestRequestUpdate_WritesRequestAndStatus(t *testing.T) {
	dir := t.TempDir()
	svc := New("owner/repo", "", "stable", "v0.1.0", "abc1234", dir)

	if _, err := svc.RequestUpdate("v0.2.0", "admin@example.com"); err != nil {
		t.Fatalf("заявка: %v", err)
	}

	// request.json — то, что читает хост-скрипт
	raw, err := os.ReadFile(filepath.Join(dir, requestFile))
	if err != nil {
		t.Fatalf("request.json: %v", err)
	}
	var req Request
	if err := json.Unmarshal(raw, &req); err != nil {
		t.Fatalf("разбор request.json: %v", err)
	}
	if req.Target != "v0.2.0" || req.RequestedBy != "admin@example.com" {
		t.Errorf("заявка записана неверно: %+v", req)
	}

	// status.json сразу помечается «requested»: иначе админ нажмёт кнопку второй раз
	st, err := svc.Status()
	if err != nil || st == nil {
		t.Fatalf("status: %v", err)
	}
	if st.Status != StateRequested {
		t.Errorf("состояние после заявки: %q, ожидалось %q", st.Status, StateRequested)
	}

	// повторная заявка во время идущего обновления отклоняется
	if _, err := svc.RequestUpdate("v0.3.0", "admin@example.com"); err == nil {
		t.Error("повторная заявка во время обновления должна отклоняться")
	}
}

func TestStatus_ReadsHostResult(t *testing.T) {
	dir := t.TempDir()
	svc := New("owner/repo", "", "stable", "v0.2.0", "def5678", dir)

	// Так status.json пишет хост-скрипт после успешного обновления
	host := Status{
		Status: StateDone, Target: "v0.2.0", Message: "обновлено до v0.2.0",
		StartedAt: time.Now().Add(-time.Minute).UTC(), EndedAt: time.Now().UTC(), Commit: "def5678",
	}
	data, _ := json.MarshalIndent(host, "", "  ")
	if err := os.WriteFile(filepath.Join(dir, statusFile), data, 0o644); err != nil {
		t.Fatal(err)
	}

	st, err := svc.Status()
	if err != nil {
		t.Fatalf("status: %v", err)
	}
	if st == nil || st.Status != StateDone || st.Target != "v0.2.0" {
		t.Fatalf("состояние прочитано неверно: %+v", st)
	}

	// лог отдаётся хвостом
	if err := os.WriteFile(filepath.Join(dir, logFile), []byte("первая строка\nвторая строка\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	if log := svc.Log(4096); log == "" {
		t.Error("лог обновления должен читаться")
	}
}

func TestCheck_NotConfigured(t *testing.T) {
	svc := New("", "", "stable", "v0.1.0", "", t.TempDir())
	res := svc.Check(context.Background(), true)
	if res.Configured {
		t.Error("без UPDATE_REPO проверка должна сообщать, что источник не настроен")
	}
	if res.Error == "" {
		t.Error("ожидалось объяснение, почему проверка невозможна")
	}
}

func TestCheck_AgainstFakeGitHub(t *testing.T) {
	// Подменяем сам API: проверяем разбор ответа и решение «доступно обновление».
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/repos/owner/repo/releases/latest" {
			w.WriteHeader(http.StatusNotFound)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{
			"tag_name": "v0.3.0",
			"name": "Release 0.3.0",
			"html_url": "https://github.com/owner/repo/releases/tag/v0.3.0",
			"body": "что нового",
			"published_at": "2026-09-27T10:00:00Z",
			"prerelease": false
		}`))
	}))
	defer srv.Close()

	svc := New("owner/repo", "", "stable", "v0.2.0", "abc1234", t.TempDir())
	svc.client = srv.Client()
	// Меняем базовый адрес API: в тестах ходим на локальный сервер.
	origFetch := apiBase
	apiBase = srv.URL
	defer func() { apiBase = origFetch }()

	res := svc.Check(context.Background(), true)
	if res.Error != "" {
		t.Fatalf("проверка не должна падать: %s", res.Error)
	}
	if res.Latest == nil || res.Latest.Tag != "v0.3.0" {
		t.Fatalf("релиз разобран неверно: %+v", res.Latest)
	}
	if !res.UpdateAvail {
		t.Error("v0.3.0 должна считаться новее v0.2.0")
	}
}
