package projecttemplate_test

// template_integration_test.go — шаблон проекта (0.85.0, docs/entity-types.md §3–5).
//
// Проверяем правила, которые человек видит как поведение, и которые ломаются молча:
//   - шаблон собирается из типов, карточек и настроек помощника;
//   - применение — СЛИЯНИЕ: тот же ключ типа обновляется, новый добавляется, карточки по имени,
//     лишние пропускаются с причиной;
//   - ничего не удаляется: чего нет в шаблоне, то остаётся;
//   - повторное применение ничего не меняет («всё уже на месте») — идемпотентность;
//   - применять может только владелец (редактор и читатель получают отказ);
//   - чужой вид карточки в шаблоне не создаёт карточку — пропуск с причиной, а не 500;
//   - шаблон без раздела `ai` не затирает роль помощника.

import (
	"context"
	"errors"
	"strings"
	"testing"

	"github.com/google/uuid"

	"github.com/skyfraze/backend/internal/auth"
	"github.com/skyfraze/backend/internal/entities"
	"github.com/skyfraze/backend/internal/platform/testdb"
	"github.com/skyfraze/backend/internal/projects"
	"github.com/skyfraze/backend/internal/projecttemplate"
	"github.com/skyfraze/backend/internal/store"
)

type templateEnv struct {
	st     *store.Store
	svc    *projecttemplate.Service
	proj   *projects.Service
	ent    *entities.Service
	owner  uuid.UUID
	editor uuid.UUID
	viewer uuid.UUID
	source uuid.UUID
	target uuid.UUID
}

func setupTemplates(t *testing.T) *templateEnv {
	t.Helper()
	pool := testdb.Setup(t, "projecttemplate")
	testdb.Truncate(t, pool,
		"project_entity_types", "project_entity_links", "project_entities",
		"project_ai_settings", "ai_consents", "login_audit", "webauthn_challenges",
		"user_webauthn_credentials", "user_recovery_codes", "user_totp", "comment_notifications",
		"comment_views", "event_comments", "project_revisions", "ai_changes", "ai_messages",
		"ai_conversations", "project_event_state", "project_ratings", "project_views", "sessions",
		"invitations", "event_assets", "assets", "events", "team_memberships", "projects", "users")
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
	env := &templateEnv{
		st: st, proj: proj, ent: entities.New(st, proj),
		owner: mkUser("owner@example.com"), editor: mkUser("editor@example.com"),
		viewer: mkUser("viewer@example.com"),
	}
	env.svc = projecttemplate.New(st, proj, env.ent)
	env.source, _ = createProject(t, proj, env.owner, "Образец")
	env.target, _ = createProject(t, proj, env.owner, "Новый")
	if err := st.AddMembership(ctx, env.target, env.editor, store.RoleEditor); err != nil {
		t.Fatalf("редактор: %v", err)
	}
	if err := st.AddMembership(ctx, env.target, env.viewer, store.RoleViewer); err != nil {
		t.Fatalf("читатель: %v", err)
	}
	return env
}

func createProject(t *testing.T, proj *projects.Service, owner uuid.UUID, title string) (uuid.UUID, *store.Project) {
	t.Helper()
	p, err := proj.Create(context.Background(), owner, title, "")
	if err != nil {
		t.Fatalf("проект %s: %v", title, err)
	}
	return p.ID, p
}

// seedSource наполняет проект-образец: свой тип с заготовкой, две карточки и настройки агента.
func seedSource(t *testing.T, e *templateEnv) {
	t.Helper()
	ctx := context.Background()
	if _, err := e.ent.CreateType(ctx, e.owner, e.source, "Фракция", "⚔", "#88aa66",
		store.EntityCardTemplate{Description: "{{name}} — союз городов.", Aliases: []string{"фракция"}}); err != nil {
		t.Fatalf("тип: %v", err)
	}
	for _, card := range []entities.Input{
		{Kind: "character", Name: "Аня"},
		{Kind: "frakciya", Name: "Северный союз"},
	} {
		if _, err := e.ent.Create(ctx, e.owner, e.source, card); err != nil {
			t.Fatalf("карточка %s: %v", card.Name, err)
		}
	}
	if _, err := e.st.SaveAISettings(ctx, e.source, e.owner,
		"Летописец", "Пиши сдержанно.", true, store.GenerationText, "карандаш",
		"без современных зданий"); err != nil {
		t.Fatalf("настройки агента: %v", err)
	}
}

func TestTemplateExportAndApplyMerge(t *testing.T) {
	e := setupTemplates(t)
	ctx := context.Background()
	seedSource(t, e)

	template, err := e.svc.Export(ctx, e.owner, e.source, true)
	if err != nil {
		t.Fatalf("экспорт шаблона: %v", err)
	}
	if template.Version != projecttemplate.TemplateVersion {
		t.Fatalf("версия шаблона %d", template.Version)
	}
	// Три стартовых типа + свой.
	if len(template.EntityTypes) != 4 {
		t.Fatalf("типов в шаблоне %d, ожидалось 4", len(template.EntityTypes))
	}
	if len(template.Cards) != 2 || template.AI == nil || template.AI.Role != "Летописец" {
		t.Fatalf("шаблон неполный: карточек %d, ai %+v", len(template.Cards), template.AI)
	}

	report, err := e.svc.Apply(ctx, e.owner, e.target, template)
	if err != nil {
		t.Fatalf("применение шаблона: %v", err)
	}
	// Тип «Фракция» новый (3 стартовых уже есть), две карточки — новые, настройки — новые.
	if report.TypesAdded != 1 || report.TypesUpdated != 0 {
		t.Fatalf("типы: добавлено %d, обновлено %d (ждали 1/0)", report.TypesAdded, report.TypesUpdated)
	}
	if report.CardsAdded != 2 || len(report.CardsSkipped) != 0 {
		t.Fatalf("карточки: добавлено %d, пропущено %+v", report.CardsAdded, report.CardsSkipped)
	}
	if !report.AIUpdated || report.Changed != 4 {
		t.Fatalf("изменений %d (ждали 4), ai %v", report.Changed, report.AIUpdated)
	}
	if !strings.Contains(report.Message, "типов добавлено: 1") {
		t.Fatalf("отчёт без числа типов: %q", report.Message)
	}

	// Заготовка карточки приехала вместе с типом: это то, ради чего её и заводили.
	types, err := e.ent.Types(ctx, e.owner, e.target)
	if err != nil {
		t.Fatalf("типы цели: %v", err)
	}
	var faction *store.EntityType
	for i := range types {
		if types[i].Key == "frakciya" {
			faction = &types[i]
		}
	}
	if faction == nil {
		t.Fatal("тип frakciya не приехал")
	}
	if faction.CardTemplate.Description != "{{name}} — союз городов." ||
		len(faction.CardTemplate.Aliases) != 1 {
		t.Fatalf("заготовка типа: %+v", faction.CardTemplate)
	}
	// Настройки помощника: роль и указания перенеслись.
	settings, err := e.st.AISettingsForProject(ctx, e.target)
	if err != nil {
		t.Fatalf("настройки агента цели: %v", err)
	}
	if settings.Role != "Летописец" || settings.Generation != store.GenerationText {
		t.Fatalf("настройки агента: %+v", settings)
	}
}

// Идемпотентность: второй раз тот же шаблон ничего не меняет.
func TestTemplateApplyIsIdempotent(t *testing.T) {
	e := setupTemplates(t)
	ctx := context.Background()
	seedSource(t, e)

	template, err := e.svc.Export(ctx, e.owner, e.source, true)
	if err != nil {
		t.Fatalf("экспорт: %v", err)
	}
	if _, err := e.svc.Apply(ctx, e.owner, e.target, template); err != nil {
		t.Fatalf("первое применение: %v", err)
	}
	second, err := e.svc.Apply(ctx, e.owner, e.target, template)
	if err != nil {
		t.Fatalf("второе применение: %v", err)
	}
	if second.Changed != 0 {
		t.Fatalf("повтор изменил проект: %+v", second)
	}
	if !strings.Contains(second.Message, "всё уже на месте") {
		t.Fatalf("сообщение повтора: %q", second.Message)
	}
	// Обе карточки на месте и не задублировались.
	cards, err := e.ent.ListEntities(ctx, e.viewer, e.target)
	if err != nil {
		t.Fatalf("карточки цели: %v", err)
	}
	if len(cards) != 2 {
		t.Fatalf("карточек после двух применений %d, ожидалось 2", len(cards))
	}
}

// Слияние без удаления: чего нет в шаблоне, то остаётся; чужое имя карточки пропускается.
func TestTemplateMergeKeepsLocalData(t *testing.T) {
	e := setupTemplates(t)
	ctx := context.Background()
	seedSource(t, e)

	// В цели уже есть своё: тип «Артефакт» и карточка «Аня» (та же, что в шаблоне).
	if _, err := e.ent.CreateType(ctx, e.owner, e.target, "Артефакт", "", ""); err != nil {
		t.Fatalf("тип цели: %v", err)
	}
	if _, err := e.ent.Create(ctx, e.owner, e.target, entities.Input{Kind: "character", Name: "Аня"}); err != nil {
		t.Fatalf("карточка цели: %v", err)
	}

	template, err := e.svc.Export(ctx, e.owner, e.source, true)
	if err != nil {
		t.Fatalf("экспорт: %v", err)
	}
	report, err := e.svc.Apply(ctx, e.owner, e.target, template)
	if err != nil {
		t.Fatalf("применение: %v", err)
	}
	if report.CardsAdded != 1 {
		t.Fatalf("добавлено карточек %d, ожидалась 1", report.CardsAdded)
	}
	if len(report.CardsSkipped) != 1 || !strings.Contains(report.CardsSkipped[0].Reason, "уже есть") {
		t.Fatalf("пропуск карточки не объяснён: %+v", report.CardsSkipped)
	}
	types, err := e.ent.Types(ctx, e.owner, e.target)
	if err != nil {
		t.Fatalf("типы цели: %v", err)
	}
	var hasArtifact bool
	for _, item := range types {
		if item.Key == "artefakt" || item.Title == "Артефакт" {
			hasArtifact = true
		}
	}
	if !hasArtifact {
		t.Fatal("свой тип цели исчез: шаблон не должен ничего удалять")
	}
}

// Права: применять шаблон может только владелец; читать — редактор и выше.
func TestTemplatePermissions(t *testing.T) {
	e := setupTemplates(t)
	ctx := context.Background()
	template, err := e.svc.Export(ctx, e.owner, e.source, false)
	if err != nil {
		t.Fatalf("экспорт: %v", err)
	}
	for _, user := range []uuid.UUID{e.editor, e.viewer} {
		if _, err := e.svc.Apply(ctx, user, e.target, template); !errors.Is(err, projecttemplate.ErrForbidden) {
			t.Fatalf("применение шаблона ролью %s: %v, ожидался отказ", user, err)
		}
	}
	if _, err := e.svc.Export(ctx, e.viewer, e.source, false); err == nil {
		t.Fatal("читатель получил шаблон с настройками: ожидался отказ")
	}
}

// Шаблон с чужим видом карточки: карточка пропускается с причиной, остальное переносится.
func TestTemplateSkipsUnknownKind(t *testing.T) {
	e := setupTemplates(t)
	ctx := context.Background()
	template := &projecttemplate.Template{
		Version: projecttemplate.TemplateVersion,
		EntityTypes: []projecttemplate.TypeRecord{
			{Key: "character", Title: "Персонаж"},
		},
		Cards: []projecttemplate.CardRecord{
			{Kind: "drakon", Name: "Дракон"},
			{Kind: "character", Name: "Аня"},
		},
	}
	report, err := e.svc.Apply(ctx, e.owner, e.target, template)
	if err != nil {
		t.Fatalf("применение: %v", err)
	}
	if report.CardsAdded != 1 {
		t.Fatalf("добавлено карточек %d, ожидалась 1", report.CardsAdded)
	}
	if len(report.CardsSkipped) != 1 || !strings.Contains(report.CardsSkipped[0].Reason, "drakon") {
		t.Fatalf("пропуск чужого вида: %+v", report.CardsSkipped)
	}
}

// Шаблон без раздела `ai` не затирает настройки проекта: «поля нет» ≠ «поле пустое».
func TestTemplateWithoutAIDoesNotResetSettings(t *testing.T) {
	e := setupTemplates(t)
	ctx := context.Background()
	if _, err := e.st.SaveAISettings(ctx, e.target, e.owner,
		"Соавтор", "Свои указания.", true, store.GenerationText, "тушь", "без людей"); err != nil {
		t.Fatalf("настройки цели: %v", err)
	}
	template := &projecttemplate.Template{
		Version:     projecttemplate.TemplateVersion,
		EntityTypes: []projecttemplate.TypeRecord{{Key: "character", Title: "Персонаж"}},
	}
	report, err := e.svc.Apply(ctx, e.owner, e.target, template)
	if err != nil {
		t.Fatalf("применение: %v", err)
	}
	if report.AIUpdated {
		t.Fatal("шаблон без ai обновил настройки помощника")
	}
	settings, err := e.st.AISettingsForProject(ctx, e.target)
	if err != nil {
		t.Fatalf("настройки: %v", err)
	}
	if settings.Role != "Соавтор" || settings.ImageStyle != "тушь" || settings.ImageNegative != "без людей" {
		t.Fatalf("настройки затёрты: %+v", settings)
	}
}

// Проект «по образцу»: создаётся сразу с типами и настройками, без второго запроса.
func TestCreateProjectFromTemplate(t *testing.T) {
	e := setupTemplates(t)
	ctx := context.Background()
	seedSource(t, e)

	template, err := e.svc.Export(ctx, e.owner, e.source, true)
	if err != nil {
		t.Fatalf("экспорт: %v", err)
	}
	p, report, err := e.svc.CreateFrom(ctx, e.owner, "Серия: вторая книга", "", template)
	if err != nil {
		t.Fatalf("создание по шаблону: %v", err)
	}
	if p.Title != "Серия: вторая книга" {
		t.Fatalf("название проекта: %q", p.Title)
	}
	if report.CardsAdded != 2 || report.TypesAdded != 1 {
		t.Fatalf("отчёт создания: %+v", report)
	}
	cards, err := e.ent.ListEntities(ctx, e.owner, p.ID)
	if err != nil {
		t.Fatalf("карточки: %v", err)
	}
	if len(cards) != 2 {
		t.Fatalf("карточек в новом проекте %d, ожидалось 2", len(cards))
	}
}

// Версия шаблона: неизвестная — отказ, а не «попробуем разобрать».
func TestTemplateRejectsUnknownVersion(t *testing.T) {
	e := setupTemplates(t)
	if _, err := e.svc.Apply(context.Background(), e.owner, e.target,
		&projecttemplate.Template{Version: 99}); !errors.Is(err, projecttemplate.ErrBadTemplate) {
		t.Fatalf("неизвестная версия: %v", err)
	}
}
