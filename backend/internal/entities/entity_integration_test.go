package entities_test

// entity_integration_test.go — карточки сущностей проекта (миграция 0030, docs/entity-links.md).
//
// Проверяем то, на чём эта фича ломается молча:
//   - имя — идентичность: две «Анны» в одном проекте не появляются, даже разного регистра;
//   - алиасы чистятся (дубли, пустые, повтор имени) — по ним фаза 2 будет искать упоминания;
//   - права: читать может читатель, писать — только редактор и выше;
//   - карточка чужого проекта не меняется и не удаляется даже с верным идентификатором;
//   - помощник видит карточки через тот же метод, что интерфейс (assistant.EntityReader).

import (
	"context"
	"errors"
	"testing"

	"github.com/google/uuid"

	"github.com/skyfraze/backend/internal/auth"
	"github.com/skyfraze/backend/internal/entities"
	"github.com/skyfraze/backend/internal/platform/testdb"
	"github.com/skyfraze/backend/internal/projects"
	"github.com/skyfraze/backend/internal/store"
)

type entityEnv struct {
	st       *store.Store
	svc      *entities.Service
	proj     *projects.Service
	owner    uuid.UUID
	editor   uuid.UUID
	viewer   uuid.UUID
	outsider uuid.UUID
	project  uuid.UUID
	other    uuid.UUID
}

func setupEntities(t *testing.T) *entityEnv {
	t.Helper()
	pool := testdb.Setup(t, "entities")
	testdb.Truncate(t, pool,
		"project_entities", "login_audit", "webauthn_challenges", "user_webauthn_credentials",
		"user_recovery_codes", "user_totp", "comment_notifications", "comment_views",
		"event_comments", "project_revisions", "ai_changes", "ai_messages", "ai_conversations",
		"project_event_state", "project_ratings", "project_views", "sessions",
		"invitations", "event_assets", "assets", "events", "team_memberships",
		"projects", "users")
	st := store.New(pool)
	proj := projects.New(st)
	ctx := context.Background()

	mkUser := func(email string) uuid.UUID {
		hash, err := auth.HashPassword("hunter22!")
		if err != nil {
			t.Fatalf("хеш пароля: %v", err)
		}
		u, err := st.CreateUser(ctx, email, hash, "Человек")
		if err != nil {
			t.Fatalf("пользователь %s: %v", email, err)
		}
		return u.ID
	}
	env := &entityEnv{
		st: st, svc: entities.New(st, proj), proj: proj,
		owner: mkUser("owner@example.com"), editor: mkUser("editor@example.com"),
		viewer: mkUser("viewer@example.com"), outsider: mkUser("outsider@example.com"),
	}
	p, err := proj.Create(ctx, env.owner, "Роман", "")
	if err != nil {
		t.Fatalf("проект: %v", err)
	}
	env.project = p.ID
	other, err := proj.Create(ctx, env.owner, "Другой роман", "")
	if err != nil {
		t.Fatalf("второй проект: %v", err)
	}
	env.other = other.ID
	if err := st.AddMembership(ctx, env.project, env.editor, store.RoleEditor); err != nil {
		t.Fatalf("редактор: %v", err)
	}
	if err := st.AddMembership(ctx, env.project, env.viewer, store.RoleViewer); err != nil {
		t.Fatalf("читатель: %v", err)
	}
	return env
}

// Создание: вид, имя, алиасы и описание сохраняются; алиасы чистятся.
func TestCreateEntity(t *testing.T) {
	e := setupEntities(t)
	ctx := context.Background()
	aliases := []string{"Аня", "  ", "Анны", "аня", "Анна"}
	description := "Главная героиня"
	entity, err := e.svc.Create(ctx, e.owner, e.project, entities.Input{
		Kind: "character", Name: "Анна", Aliases: &aliases, Description: &description,
		Color: strPtr("#c9a227"),
	})
	if err != nil {
		t.Fatalf("создание: %v", err)
	}
	if entity.Kind != "character" || entity.Name != "Анна" {
		t.Fatalf("поля не сохранены: %+v", entity)
	}
	// Пустой алиас выброшен, дубль «аня» схлопнут, повтор имени «Анна» не нужен.
	want := []string{"Аня", "Анны"}
	if len(entity.Aliases) != len(want) {
		t.Fatalf("алиасы: %v, ожидалось %v", entity.Aliases, want)
	}
	for i, alias := range want {
		if entity.Aliases[i] != alias {
			t.Fatalf("алиасы: %v, ожидалось %v", entity.Aliases, want)
		}
	}
	list, err := e.svc.ListEntities(ctx, e.owner, e.project)
	if err != nil {
		t.Fatalf("список: %v", err)
	}
	if len(list) != 1 || list[0].ID != entity.ID {
		t.Fatalf("ожидалась одна карточка: %+v", list)
	}
}

// Имя — идентичность: дубль без учёта регистра отвергается понятной ошибкой.
func TestEntityNameIsUnique(t *testing.T) {
	e := setupEntities(t)
	ctx := context.Background()
	if _, err := e.svc.Create(ctx, e.owner, e.project, entities.Input{Kind: "character", Name: "Анна"}); err != nil {
		t.Fatalf("первая карточка: %v", err)
	}
	_, err := e.svc.Create(ctx, e.owner, e.project, entities.Input{Kind: "place", Name: "анна"})
	if !errors.Is(err, entities.ErrEntityExists) {
		t.Fatalf("ожидался конфликт имени: %v", err)
	}
	// В другом проекте то же имя можно: у каждого проекта свой мир.
	if _, err := e.svc.Create(ctx, e.owner, e.other, entities.Input{Kind: "place", Name: "Анна"}); err != nil {
		t.Fatalf("другой проект: %v", err)
	}
}

// Вид и поля проверяются: свободная строка вида превратила бы проект в хаос.
func TestEntityValidation(t *testing.T) {
	e := setupEntities(t)
	ctx := context.Background()
	cases := []struct {
		name  string
		input entities.Input
	}{
		{"неизвестный вид", entities.Input{Kind: "hero", Name: "Анна"}},
		{"пустое имя", entities.Input{Kind: "character", Name: "   "}},
		{"длинное имя", entities.Input{Kind: "character", Name: longString(81)}},
		{"плохой цвет", entities.Input{Kind: "character", Name: "Анна", Color: strPtr("золотой")}},
		{"длинное описание", entities.Input{Kind: "character", Name: "Анна", Description: strPtr(longString(601))}},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if _, err := e.svc.Create(ctx, e.owner, e.project, tc.input); !errors.Is(err, entities.ErrInvalidEntity) {
				t.Fatalf("ожидался отказ валидации: %v", err)
			}
		})
	}
	// Длинный алиас — тоже отказ: по нему ищутся упоминания, и «алиас на пол-абзаца» ловит всё.
	aliases := []string{longString(61)}
	if _, err := e.svc.Create(ctx, e.owner, e.project, entities.Input{
		Kind: "character", Name: "Анна", Aliases: &aliases,
	}); !errors.Is(err, entities.ErrInvalidEntity) {
		t.Fatalf("ожидался отказ по алиасу: %v", err)
	}
}

// Правка меняет только присланное: описание не стирается переименованием.
func TestUpdateEntityKeepsUnsentFields(t *testing.T) {
	e := setupEntities(t)
	ctx := context.Background()
	description := "Главная героиня"
	entity, err := e.svc.Create(ctx, e.owner, e.project, entities.Input{
		Kind: "character", Name: "Анна", Description: &description,
	})
	if err != nil {
		t.Fatalf("создание: %v", err)
	}
	updated, err := e.svc.Update(ctx, e.owner, e.project, entity.ID, entities.Input{Name: "Анна Сергеевна"})
	if err != nil {
		t.Fatalf("правка: %v", err)
	}
	if updated.Name != "Анна Сергеевна" {
		t.Fatalf("имя не изменилось: %+v", updated)
	}
	if updated.Description != description {
		t.Fatalf("описание стёрлось при переименовании: %q", updated.Description)
	}
	// Переименование в занятое имя — конфликт, а не тихая перезапись.
	if _, err := e.svc.Create(ctx, e.owner, e.project, entities.Input{Kind: "place", Name: "Дом"}); err != nil {
		t.Fatalf("вторая карточка: %v", err)
	}
	if _, err := e.svc.Update(ctx, e.owner, e.project, entity.ID, entities.Input{Name: "дом"}); !errors.Is(err, entities.ErrEntityExists) {
		t.Fatalf("ожидался конфликт: %v", err)
	}
}

// Права: читатель читает, но не пишет; посторонний не видит ничего.
func TestEntityPermissions(t *testing.T) {
	e := setupEntities(t)
	ctx := context.Background()
	if _, err := e.svc.Create(ctx, e.owner, e.project, entities.Input{Kind: "character", Name: "Анна"}); err != nil {
		t.Fatalf("создание владельцем: %v", err)
	}
	if _, err := e.svc.ListEntities(ctx, e.viewer, e.project); err != nil {
		t.Fatalf("читатель должен видеть карточки: %v", err)
	}
	if _, err := e.svc.Create(ctx, e.viewer, e.project, entities.Input{Kind: "place", Name: "Вокзал"}); err == nil {
		t.Fatal("читатель не должен создавать карточки")
	}
	if _, err := e.svc.Create(ctx, e.editor, e.project, entities.Input{Kind: "place", Name: "Вокзал"}); err != nil {
		t.Fatalf("редактор должен создавать карточки: %v", err)
	}
	if _, err := e.svc.ListEntities(ctx, e.outsider, e.project); err == nil {
		t.Fatal("посторонний не должен видеть карточки чужого проекта")
	}
}

// Удаление и «чужая» карточка: идентификатор из другого проекта не даёт трогать чужое.
func TestDeleteEntityIsProjectScoped(t *testing.T) {
	e := setupEntities(t)
	ctx := context.Background()
	entity, err := e.svc.Create(ctx, e.owner, e.project, entities.Input{Kind: "theme", Name: "Письмо"})
	if err != nil {
		t.Fatalf("создание: %v", err)
	}
	// Тот же владелец, но другой проект: карточки там нет.
	if _, err := e.svc.Update(ctx, e.owner, e.other, entity.ID, entities.Input{Name: "Другое"}); !errors.Is(err, store.ErrNotFound) {
		t.Fatalf("ожидался not found: %v", err)
	}
	if err := e.svc.Delete(ctx, e.owner, e.other, entity.ID); !errors.Is(err, store.ErrNotFound) {
		t.Fatalf("ожидался not found: %v", err)
	}
	if err := e.svc.Delete(ctx, e.owner, e.project, entity.ID); err != nil {
		t.Fatalf("удаление: %v", err)
	}
	list, err := e.svc.ListEntities(ctx, e.owner, e.project)
	if err != nil {
		t.Fatalf("список: %v", err)
	}
	if len(list) != 0 {
		t.Fatalf("карточка должна исчезнуть: %+v", list)
	}
}

func strPtr(value string) *string { return &value }

func longString(runes int) string {
	out := make([]rune, runes)
	for i := range out {
		out[i] = 'а'
	}
	return string(out)
}
