package transfer_test

// transfer_template_test.go — шаблон проекта в архиве (0.85.0, docs/entity-types.md §3).
//
// Архив возит устройство проекта отдельным файлом template.json: типы карточек (со своими
// ключами и заготовками) и настройки помощника. Отдельным файлом, а не полем манифеста, — потому
// что тот же JSON отдаёт GET /api/projects/{id}/template, и держать формат в двух видах значило
// бы поддерживать два парсера.
//
// Проверяем: файл в архиве есть; импорт применяет типы и настройки; архив без файла читается
// по-прежнему (старые сборки его не клали).

import (
	"archive/zip"
	"bytes"
	"context"
	"encoding/json"
	"io"
	"testing"

	"github.com/skyfraze/backend/internal/entities"
	"github.com/skyfraze/backend/internal/platform/testdb"
	"github.com/skyfraze/backend/internal/projecttemplate"
	"github.com/skyfraze/backend/internal/projects"
	"github.com/skyfraze/backend/internal/storage"
	"github.com/skyfraze/backend/internal/store"
	"github.com/skyfraze/backend/internal/transfer"
)

func setupTransferTemplates(t *testing.T) *transferEnv {
	t.Helper()
	pool := testdb.Setup(t, "transfer_template")
	testdb.Truncate(t, pool,
		"project_entity_types", "project_entity_links", "project_entities", "project_ai_settings",
		"ai_consents", "login_audit", "webauthn_challenges", "user_webauthn_credentials",
		"user_recovery_codes", "user_totp", "comment_notifications", "comment_views",
		"event_comments", "project_revisions", "ai_changes", "ai_messages", "ai_conversations",
		"project_event_state", "project_ratings", "project_views", "sessions",
		"invitations", "event_assets", "assets", "events", "team_memberships",
		"projects", "users")
	st := store.New(pool)
	proj := projects.New(st)
	local, err := storage.NewLocal(t.TempDir())
	if err != nil {
		t.Fatalf("хранилище: %v", err)
	}
	svc := transfer.New(st, local, proj)
	entitySvc := entities.New(st, proj)
	svc.UseEntities(entitySvc)
	svc.UseTemplates(projecttemplate.New(st, proj, entitySvc))

	ctx := context.Background()
	user, err := st.CreateUser(ctx, "transfer-template@example.com", "$2a$10$notarealhash", "Перенос")
	if err != nil {
		t.Fatalf("пользователь: %v", err)
	}
	return &transferEnv{st: st, proj: proj, svc: svc, user: user.ID, entity: entitySvc}
}

// zipFile ищет файл в архиве по имени (nil — файла нет).
func zipFile(t *testing.T, raw []byte, name string) []byte {
	t.Helper()
	zr, err := zip.NewReader(bytes.NewReader(raw), int64(len(raw)))
	if err != nil {
		t.Fatalf("архив не разобран: %v", err)
	}
	for _, f := range zr.File {
		if f.Name != name {
			continue
		}
		rc, err := f.Open()
		if err != nil {
			t.Fatalf("файл %s: %v", name, err)
		}
		defer rc.Close()
		data, err := io.ReadAll(rc)
		if err != nil {
			t.Fatalf("чтение %s: %v", name, err)
		}
		return data
	}
	return nil
}

func TestArchiveCarriesProjectTemplate(t *testing.T) {
	e := setupTransferTemplates(t)
	ctx := context.Background()
	project, err := e.proj.Create(ctx, e.user, "Серия", "")
	if err != nil {
		t.Fatalf("проект: %v", err)
	}
	if _, err := e.entity.CreateType(ctx, e.user, project.ID, "Фракция", "⚔", "#88aa66",
		store.EntityCardTemplate{Description: "{{name}} — союз городов.", Aliases: []string{"фракция"}}); err != nil {
		t.Fatalf("тип: %v", err)
	}
	if _, err := e.st.SaveAISettings(ctx, project.ID, e.user,
		"Летописец", "Пиши сдержанно.", true, store.GenerationText, "карандаш"); err != nil {
		t.Fatalf("настройки агента: %v", err)
	}

	var buf bytes.Buffer
	if _, err := e.svc.Export(ctx, e.user, project.ID, &buf); err != nil {
		t.Fatalf("экспорт: %v", err)
	}
	raw := zipFile(t, buf.Bytes(), "template.json")
	if raw == nil {
		t.Fatal("в архиве нет template.json")
	}
	var template projecttemplate.Template
	if err := json.Unmarshal(raw, &template); err != nil {
		t.Fatalf("template.json не разобран: %v", err)
	}
	if len(template.EntityTypes) != 4 {
		t.Fatalf("типов в шаблоне %d, ожидалось 4", len(template.EntityTypes))
	}
	if template.AI == nil || template.AI.Role != "Летописец" {
		t.Fatalf("настройки помощника в шаблоне: %+v", template.AI)
	}
	// Карточки в шаблон архива не кладём: они уже едут в манифесте.
	if len(template.Cards) != 0 {
		t.Fatalf("в шаблоне архива %d карточек, ожидалось 0", len(template.Cards))
	}

	bundle, err := transfer.ParseBundle(bytes.NewReader(buf.Bytes()), int64(buf.Len()))
	if err != nil {
		t.Fatalf("разбор архива: %v", err)
	}
	if bundle.Template == nil {
		t.Fatal("ParseBundle не прочитал шаблон")
	}
	result, err := e.svc.Import(ctx, e.user, bundle)
	if err != nil {
		t.Fatalf("импорт: %v", err)
	}
	if result.Template == nil || result.Template.TypesAdded != 1 {
		t.Fatalf("отчёт шаблона при импорте: %+v", result.Template)
	}
	// Свой тип с заготовкой доехал до нового проекта.
	types, err := e.st.ListEntityTypes(ctx, result.Project.ID)
	if err != nil {
		t.Fatalf("типы нового проекта: %v", err)
	}
	var found bool
	for _, item := range types {
		if item.Key == "frakciya" {
			found = true
			if item.CardTemplate.Description == "" {
				t.Fatal("заготовка карточки потерялась при импорте")
			}
		}
	}
	if !found {
		t.Fatal("свой тип не доехал до нового проекта")
	}
	settings, err := e.st.AISettingsForProject(ctx, result.Project.ID)
	if err != nil {
		t.Fatalf("настройки нового проекта: %v", err)
	}
	if settings.Role != "Летописец" || settings.ImageStyle != "карандаш" {
		t.Fatalf("настройки помощника потерялись: %+v", settings)
	}
}

// Старый архив (без template.json) читается: настройки — необязательная часть переноса.
func TestArchiveWithoutTemplateStillReads(t *testing.T) {
	e := setupTransferTemplates(t)
	ctx := context.Background()
	project, err := e.proj.Create(ctx, e.user, "Старый", "")
	if err != nil {
		t.Fatalf("проект: %v", err)
	}
	var buf bytes.Buffer
	if _, err := e.svc.Export(ctx, e.user, project.ID, &buf); err != nil {
		t.Fatalf("экспорт: %v", err)
	}

	// Собираем архив заново без template.json — так выглядит архив, снятый до 0.85.0.
	original, err := zip.NewReader(bytes.NewReader(buf.Bytes()), int64(buf.Len()))
	if err != nil {
		t.Fatalf("архив: %v", err)
	}
	var stripped bytes.Buffer
	zw := zip.NewWriter(&stripped)
	for _, f := range original.File {
		if f.Name == "template.json" {
			continue
		}
		rc, err := f.Open()
		if err != nil {
			t.Fatalf("чтение %s: %v", f.Name, err)
		}
		w, err := zw.Create(f.Name)
		if err != nil {
			t.Fatalf("создание %s: %v", f.Name, err)
		}
		if _, err := io.Copy(w, rc); err != nil {
			t.Fatalf("копирование %s: %v", f.Name, err)
		}
		rc.Close()
	}
	if err := zw.Close(); err != nil {
		t.Fatalf("архив: %v", err)
	}

	bundle, err := transfer.ParseBundle(bytes.NewReader(stripped.Bytes()), int64(stripped.Len()))
	if err != nil {
		t.Fatalf("разбор старого архива: %v", err)
	}
	if bundle.Template != nil {
		t.Fatal("шаблон найден там, где его нет")
	}
	result, err := e.svc.Import(ctx, e.user, bundle)
	if err != nil {
		t.Fatalf("импорт старого архива: %v", err)
	}
	if result.Template != nil {
		t.Fatalf("отчёт шаблона без шаблона: %+v", result.Template)
	}
	if result.Project == nil {
		t.Fatal("проект не создан")
	}
}
