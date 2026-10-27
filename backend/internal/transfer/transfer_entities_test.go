package transfer_test

// transfer_entities_test.go — карточки мира в архиве проекта (0.69.0).
//
// Проверяем то, что иначе теряется молча: экспорт кладёт карточки в манифест, импорт создаёт
// их в новом проекте, а архив без карточек (снятый до 0.69.0) по-прежнему читается.

import (
	"archive/zip"
	"bytes"
	"context"
	"encoding/json"
	"io"
	"testing"

	"github.com/google/uuid"

	"github.com/skyfraze/backend/internal/entities"
	"github.com/skyfraze/backend/internal/platform/testdb"
	"github.com/skyfraze/backend/internal/projects"
	"github.com/skyfraze/backend/internal/storage"
	"github.com/skyfraze/backend/internal/store"
	"github.com/skyfraze/backend/internal/transfer"
)

type transferEnv struct {
	st     *store.Store
	proj   *projects.Service
	svc    *transfer.Service
	user   uuid.UUID
	entity *entities.Service
}

func setupTransfer(t *testing.T) *transferEnv {
	t.Helper()
	pool := testdb.Setup(t, "transfer_entities")
	testdb.Truncate(t, pool,
		"project_entities", "login_audit", "webauthn_challenges", "user_webauthn_credentials",
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

	ctx := context.Background()
	hash := "$2a$10$notarealhash"
	user, err := st.CreateUser(ctx, "transfer@example.com", hash, "Перенос")
	if err != nil {
		t.Fatalf("пользователь: %v", err)
	}
	return &transferEnv{st: st, proj: proj, svc: svc, user: user.ID, entity: entitySvc}
}

// Экспорт → импорт: карточки и их алиасы доезжают до нового проекта.
func TestArchiveCarriesEntities(t *testing.T) {
	e := setupTransfer(t)
	ctx := context.Background()
	project, err := e.proj.Create(ctx, e.user, "Роман", "")
	if err != nil {
		t.Fatalf("проект: %v", err)
	}
	aliases := []string{"Аня", "Анны"}
	description := "Главная героиня"
	if _, err := e.entity.Create(ctx, e.user, project.ID, entities.Input{
		Kind: "character", Name: "Анна", Aliases: &aliases, Description: &description,
	}); err != nil {
		t.Fatalf("карточка: %v", err)
	}
	if _, err := e.entity.Create(ctx, e.user, project.ID, entities.Input{
		Kind: "place", Name: "Дом на холме",
	}); err != nil {
		t.Fatalf("место: %v", err)
	}

	var buf bytes.Buffer
	if _, err := e.svc.Export(ctx, e.user, project.ID, &buf); err != nil {
		t.Fatalf("экспорт: %v", err)
	}

	// В манифесте карточки есть — это и есть переносимость.
	m := readManifest(t, buf.Bytes())
	if len(m.Entities) != 2 {
		t.Fatalf("в манифесте %d карточек, ожидалось 2: %+v", len(m.Entities), m.Entities)
	}
	if m.Entities[0].Kind != "character" || m.Entities[0].Name != "Анна" {
		t.Fatalf("первая карточка: %+v", m.Entities[0])
	}
	if len(m.Entities[0].Aliases) != 2 || m.Entities[0].Description != description {
		t.Fatalf("алиасы и описание не попали в архив: %+v", m.Entities[0])
	}

	bundle, err := transfer.ParseBundle(bytes.NewReader(buf.Bytes()), int64(buf.Len()))
	if err != nil {
		t.Fatalf("разбор архива: %v", err)
	}
	result, err := e.svc.Import(ctx, e.user, bundle)
	if err != nil {
		t.Fatalf("импорт: %v", err)
	}
	if result.Entities != 2 {
		t.Fatalf("импортировано карточек: %d, ожидалось 2", result.Entities)
	}
	list, err := e.st.ListEntities(ctx, result.Project.ID)
	if err != nil {
		t.Fatalf("карточки нового проекта: %v", err)
	}
	if len(list) != 2 {
		t.Fatalf("в новом проекте %d карточек: %+v", len(list), list)
	}
	// Имя — идентичность: проверяем, что перенос не потерял её и алиасы.
	var found bool
	for _, entity := range list {
		if entity.Name == "Анна" {
			found = true
			if len(entity.Aliases) != 2 {
				t.Fatalf("алиасы потерялись при переносе: %+v", entity)
			}
		}
	}
	if !found {
		t.Fatal("карточка «Анна» не доехала")
	}
}

// Архив без поля entities (снятый до 0.69.0) читается: поле необязательное.
func TestArchiveWithoutEntitiesStillReads(t *testing.T) {
	e := setupTransfer(t)
	ctx := context.Background()
	project, err := e.proj.Create(ctx, e.user, "Старый архив", "")
	if err != nil {
		t.Fatalf("проект: %v", err)
	}
	var buf bytes.Buffer
	if _, err := e.svc.Export(ctx, e.user, project.ID, &buf); err != nil {
		t.Fatalf("экспорт: %v", err)
	}
	// Пересобираем архив без поля entities — так выглядел архив до этой версии.
	rewritten := rewriteManifestWithoutEntities(t, buf.Bytes())
	bundle, err := transfer.ParseBundle(bytes.NewReader(rewritten), int64(len(rewritten)))
	if err != nil {
		t.Fatalf("старый архив должен читаться: %v", err)
	}
	result, err := e.svc.Import(ctx, e.user, bundle)
	if err != nil {
		t.Fatalf("импорт старого архива: %v", err)
	}
	if result.Entities != 0 {
		t.Fatalf("в старом архиве карточек нет, а импортировано %d", result.Entities)
	}
}

func readManifest(t *testing.T, archive []byte) transfer.Manifest {
	t.Helper()
	reader, err := zip.NewReader(bytes.NewReader(archive), int64(len(archive)))
	if err != nil {
		t.Fatalf("zip: %v", err)
	}
	for _, file := range reader.File {
		if file.Name != "manifest.json" {
			continue
		}
		rc, err := file.Open()
		if err != nil {
			t.Fatalf("манифест: %v", err)
		}
		defer rc.Close()
		raw, err := io.ReadAll(rc)
		if err != nil {
			t.Fatalf("чтение манифеста: %v", err)
		}
		var m transfer.Manifest
		if err := json.Unmarshal(raw, &m); err != nil {
			t.Fatalf("разбор манифеста: %v", err)
		}
		return m
	}
	t.Fatal("в архиве нет manifest.json")
	return transfer.Manifest{}
}

// rewriteManifestWithoutEntities пересобирает архив, выкинув поле entities.
func rewriteManifestWithoutEntities(t *testing.T, archive []byte) []byte {
	t.Helper()
	reader, err := zip.NewReader(bytes.NewReader(archive), int64(len(archive)))
	if err != nil {
		t.Fatalf("zip: %v", err)
	}
	var out bytes.Buffer
	writer := zip.NewWriter(&out)
	for _, file := range reader.File {
		rc, err := file.Open()
		if err != nil {
			t.Fatalf("чтение %s: %v", file.Name, err)
		}
		raw, err := io.ReadAll(rc)
		rc.Close()
		if err != nil {
			t.Fatalf("чтение %s: %v", file.Name, err)
		}
		if file.Name == "manifest.json" {
			var generic map[string]any
			if err := json.Unmarshal(raw, &generic); err != nil {
				t.Fatalf("манифест: %v", err)
			}
			delete(generic, "entities")
			if raw, err = json.Marshal(generic); err != nil {
				t.Fatalf("манифест: %v", err)
			}
		}
		f, err := writer.Create(file.Name)
		if err != nil {
			t.Fatalf("запись %s: %v", file.Name, err)
		}
		if _, err := f.Write(raw); err != nil {
			t.Fatalf("запись %s: %v", file.Name, err)
		}
	}
	if err := writer.Close(); err != nil {
		t.Fatalf("zip close: %v", err)
	}
	return out.Bytes()
}
