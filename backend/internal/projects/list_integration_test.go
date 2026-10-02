package projects_test

// list_integration_test.go — список проектов показывает вес файлов.
//
// Владелец видит, сколько занимает проект, не открывая его: «файлы: 8.4 МБ из 10».
// Вес считается по строкам `assets` (то есть после пережатия) одним агрегатом на все
// проекты, а предел приходит из assets.Service — чтобы у квоты был один источник.
//
// Нужна Postgres (TEST_DATABASE_URL), как и остальным интеграционным тестам.

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"

	"github.com/skyfraze/backend/internal/assets"
	"github.com/skyfraze/backend/internal/auth"
	"github.com/skyfraze/backend/internal/platform/testdb"
	"github.com/skyfraze/backend/internal/projects"
	"github.com/skyfraze/backend/internal/storage"
	"github.com/skyfraze/backend/internal/store"
)

const listRoutesSecret = "test-secret-projects-list"

func TestListProjectsShowsWeight(t *testing.T) {
	pool := testdb.Setup(t, "projects")
	testdb.Truncate(t, pool,
		"project_ratings", "project_views", "registration_requests", "app_settings",
		"project_event_state", "sessions", "invitations", "event_assets", "assets",
		"events", "team_memberships", "projects", "users")

	ctx := context.Background()
	st := store.New(pool)
	projSvc := projects.New(st)
	obj, err := storage.NewLocal(t.TempDir())
	if err != nil {
		t.Fatalf("хранилище: %v", err)
	}
	assetsSvc := assets.New(st, obj, projSvc)

	authSvc := auth.New(st, listRoutesSecret)
	owner, tokens, err := authSvc.Register(ctx, "owner@example.com", "hunter22!", "Владелец")
	if err != nil {
		t.Fatalf("пользователь: %v", err)
	}

	withFiles, err := projSvc.Create(ctx, owner.ID, "Проект с файлами", "")
	if err != nil {
		t.Fatalf("проект: %v", err)
	}
	empty, err := projSvc.Create(ctx, owner.ID, "Пустой проект", "")
	if err != nil {
		t.Fatalf("второй проект: %v", err)
	}

	const fileSize = 2048
	content := bytes.Repeat([]byte("x"), fileSize)
	if _, err := assetsSvc.Upload(ctx, owner.ID, withFiles.ID, assets.UploadOpts{
		Filename: "заметки.txt", ContentType: "text/plain", Size: int64(len(content)),
		Reader: bytes.NewReader(content),
	}); err != nil {
		t.Fatalf("вложение: %v", err)
	}

	const quota = 10 << 20
	h := projects.NewHandler(projSvc, slog.New(slog.NewTextHandler(io.Discard, nil)))
	h.UseQuota(quota)
	r := chi.NewRouter()
	r.With(authSvc.WithUser).Get("/api/projects", h.List)

	req := httptest.NewRequest(http.MethodGet, "/api/projects", nil)
	req.Header.Set("Authorization", "Bearer "+tokens.Access)
	rec := httptest.NewRecorder()
	r.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("список: код %d, тело %s", rec.Code, rec.Body.String())
	}

	var items []struct {
		ID         uuid.UUID `json:"id"`
		AssetBytes int64     `json:"asset_bytes"`
		QuotaBytes int64     `json:"quota_bytes"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &items); err != nil {
		t.Fatalf("json списка: %v (%s)", err, rec.Body.String())
	}
	if len(items) != 2 {
		t.Fatalf("проектов в списке %d, ожидалось 2", len(items))
	}
	byID := map[uuid.UUID]int64{}
	for _, item := range items {
		if item.QuotaBytes != quota {
			t.Errorf("проект %s: предел %d, ожидался %d", item.ID, item.QuotaBytes, quota)
		}
		byID[item.ID] = item.AssetBytes
	}
	if byID[withFiles.ID] != fileSize {
		t.Errorf("вес проекта с файлом %d, ожидался %d", byID[withFiles.ID], fileSize)
	}
	// У проекта без файлов вес нулевой: интерфейс по этому числу не покажет подпись.
	if byID[empty.ID] != 0 {
		t.Errorf("вес пустого проекта %d, ожидался 0", byID[empty.ID])
	}
}
