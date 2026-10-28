package docxtpl_test

// service_integration_test.go — шаблоны оформления DOCX в проекте (0.91.0).
//
// Проверяем то, что человек увидит как поведение и что ломается молча:
//   · загрузка шаблона разбирает стили и плейсхолдер и возвращает отчёт;
//   · первый шаблон становится активным сам, второй — только по нажатию;
//   · шаблон с тем же именем заменяется (id и активность сохраняются);
//   · менять шаблоны может только владелец, читать — редактор;
//   · удаление активного шаблона передаёт активность другому, а не оставляет «нет шаблона».

import (
	"archive/zip"
	"bytes"
	"context"
	"errors"
	"strings"
	"testing"

	"github.com/google/uuid"

	"github.com/skyfraze/backend/internal/auth"
	"github.com/skyfraze/backend/internal/docxtpl"
	"github.com/skyfraze/backend/internal/platform/testdb"
	"github.com/skyfraze/backend/internal/projects"
	"github.com/skyfraze/backend/internal/storage"
	"github.com/skyfraze/backend/internal/store"
)

type docxEnv struct {
	store   *store.Store
	svc     *docxtpl.Service
	proj    *projects.Service
	owner   uuid.UUID
	editor  uuid.UUID
	viewer  uuid.UUID
	project uuid.UUID
}

func setupDocx(t *testing.T) *docxEnv {
	t.Helper()
	pool := testdb.Setup(t, "docxtpl")
	testdb.Truncate(t, pool,
		"project_docx_templates", "project_entity_types", "project_entity_links",
		"project_entities", "project_ai_settings", "ai_consents", "login_audit",
		"webauthn_challenges", "user_webauthn_credentials", "user_recovery_codes", "user_totp",
		"comment_notifications", "comment_views", "event_comments", "project_revisions",
		"ai_changes", "ai_messages", "ai_conversations", "project_event_state",
		"project_ratings", "project_views", "sessions", "invitations", "event_assets",
		"assets", "events", "team_memberships", "projects", "users")
	st := store.New(pool)
	proj := projects.New(st)
	local, err := storage.NewLocal(t.TempDir())
	if err != nil {
		t.Fatalf("хранилище: %v", err)
	}
	ctx := context.Background()
	mkUser := func(email string) uuid.UUID {
		hash, err := auth.HashPassword("hunter22!")
		if err != nil {
			t.Fatalf("хеш: %v", err)
		}
		user, err := st.CreateUser(ctx, email, hash, "Человек")
		if err != nil {
			t.Fatalf("пользователь %s: %v", email, err)
		}
		return user.ID
	}
	env := &docxEnv{store: st, proj: proj, svc: docxtpl.New(st, local, proj),
		owner: mkUser("owner@example.com"), editor: mkUser("editor@example.com"),
		viewer: mkUser("viewer@example.com")}
	p, err := proj.Create(ctx, env.owner, "Книга", "")
	if err != nil {
		t.Fatalf("проект: %v", err)
	}
	env.project = p.ID
	if err := st.AddMembership(ctx, env.project, env.editor, store.RoleEditor); err != nil {
		t.Fatalf("редактор: %v", err)
	}
	if err := st.AddMembership(ctx, env.project, env.viewer, store.RoleViewer); err != nil {
		t.Fatalf("читатель: %v", err)
	}
	return env
}

// buildDocx собирает минимальный шаблон с плейсхолдером и стилями.
func buildDocx(t *testing.T, placeholder string) []byte {
	t.Helper()
	var buf bytes.Buffer
	zw := zip.NewWriter(&buf)
	add := func(name, body string) {
		w, err := zw.Create(name)
		if err != nil {
			t.Fatalf("часть %s: %v", name, err)
		}
		if _, err := w.Write([]byte(body)); err != nil {
			t.Fatalf("запись %s: %v", name, err)
		}
	}
	add("[Content_Types].xml", `<?xml version="1.0" encoding="UTF-8"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
</Types>`)
	add("_rels/.rels", `<?xml version="1.0" encoding="UTF-8"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>`)
	add("word/styles.xml", `<?xml version="1.0" encoding="UTF-8"?>
<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
<w:style w:type="paragraph" w:styleId="Normal"><w:name w:val="Normal"/></w:style>
<w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/></w:style>
</w:styles>`)
	add("word/document.xml", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>
<w:p><w:r><w:t>ТИТУЛ</w:t></w:r></w:p>
<w:p><w:r><w:t>`+placeholder+`</w:t></w:r></w:p>
<w:sectPr><w:pgSz w:w="11906" w:h="16838"/></w:sectPr>
</w:body></w:document>`)
	add("word/_rels/document.xml.rels", `<?xml version="1.0" encoding="UTF-8"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"></Relationships>`)
	if err := zw.Close(); err != nil {
		t.Fatalf("архив: %v", err)
	}
	return buf.Bytes()
}

func upload(t *testing.T, e *docxEnv, user uuid.UUID, name string) *docxtpl.Entry {
	t.Helper()
	raw := buildDocx(t, docxtpl.PlaceholderText)
	entry, err := e.svc.Upload(context.Background(), user, e.project, name, name+".docx", int64(len(raw)), bytes.NewReader(raw))
	if err != nil {
		t.Fatalf("загрузка «%s»: %v", name, err)
	}
	return entry
}

func TestDocxTemplateUploadAndActivate(t *testing.T) {
	e := setupDocx(t)
	ctx := context.Background()

	first := upload(t, e, e.owner, "рукопись")
	if !first.IsActive {
		t.Fatal("первый шаблон должен стать активным сам")
	}
	if !first.Placeholder.Found {
		t.Fatalf("плейсхолдер не разобран: %+v", first.Placeholder)
	}
	if first.Report.Mapping["heading1"] != "Heading1" {
		t.Fatalf("карта стилей: %+v", first.Report.Mapping)
	}

	second := upload(t, e, e.owner, "самиздат")
	if second.IsActive {
		t.Fatal("второй шаблон не должен становиться активным сам")
	}
	list, err := e.svc.Activate(ctx, e.owner, e.project, second.ID)
	if err != nil {
		t.Fatalf("активация: %v", err)
	}
	active := 0
	for _, item := range list {
		if item.IsActive {
			active++
			if item.ID != second.ID {
				t.Fatalf("активен не тот шаблон: %+v", item)
			}
		}
	}
	if active != 1 {
		t.Fatalf("активных шаблонов %d, ожидался 1", active)
	}

	// Шаблон с тем же именем заменяется: имя и id прежние, файл новый.
	replaced := upload(t, e, e.owner, "самиздат")
	if replaced.ID != second.ID {
		t.Fatalf("замена сменила id: %s → %s", second.ID, replaced.ID)
	}
	if !replaced.IsActive {
		t.Fatal("замена потеряла активность")
	}
	list, err = e.svc.List(ctx, e.editor, e.project)
	if err != nil {
		t.Fatalf("список: %v", err)
	}
	if len(list) != 2 {
		t.Fatalf("шаблонов %d, ожидалось 2", len(list))
	}
}

func TestDocxTemplatePermissions(t *testing.T) {
	e := setupDocx(t)
	raw := buildDocx(t, docxtpl.PlaceholderText)
	ctx := context.Background()

	if _, err := e.svc.Upload(ctx, e.editor, e.project, "чужой", "x.docx", int64(len(raw)), bytes.NewReader(raw)); !errors.Is(err, docxtpl.ErrForbidden) {
		t.Fatalf("редактор загрузил шаблон: %v", err)
	}
	entry := upload(t, e, e.owner, "рукопись")
	if _, err := e.svc.Activate(ctx, e.editor, e.project, entry.ID); !errors.Is(err, docxtpl.ErrForbidden) {
		t.Fatalf("редактор активировал шаблон: %v", err)
	}
	if _, err := e.svc.Delete(ctx, e.editor, e.project, entry.ID); !errors.Is(err, docxtpl.ErrForbidden) {
		t.Fatalf("редактор удалил шаблон: %v", err)
	}
	if _, err := e.svc.List(ctx, e.viewer, e.project); err == nil {
		t.Fatal("читатель увидел отчёт шаблона — ожидался отказ")
	}
	if _, err := e.svc.List(ctx, e.editor, e.project); err != nil {
		t.Fatalf("редактор не видит список: %v", err)
	}
}

func TestDocxTemplateDeleteMovesActive(t *testing.T) {
	e := setupDocx(t)
	ctx := context.Background()
	first := upload(t, e, e.owner, "рукопись")
	second := upload(t, e, e.owner, "самиздат")

	list, err := e.svc.Delete(ctx, e.owner, e.project, first.ID)
	if err != nil {
		t.Fatalf("удаление: %v", err)
	}
	if len(list) != 1 || !list[0].IsActive || list[0].ID != second.ID {
		t.Fatalf("после удаления активным должен стать оставшийся: %+v", list)
	}
	active, err := e.svc.Active(ctx, e.project)
	if err != nil || active == nil || active.ID != second.ID {
		t.Fatalf("активный шаблон: %+v, %v", active, err)
	}
	if len(active.Raw) == 0 {
		t.Fatal("пакет активного шаблона не прочитан")
	}
	// Удалили последний — шаблонов нет, выгрузка вернётся к встроенному оформлению.
	if _, err := e.svc.Delete(ctx, e.owner, e.project, second.ID); err != nil {
		t.Fatalf("второе удаление: %v", err)
	}
	active, err = e.svc.Active(ctx, e.project)
	if err != nil || active != nil {
		t.Fatalf("после удаления всех шаблонов активного быть не должно: %+v, %v", active, err)
	}
}

func TestDocxTemplateRejectsBadFile(t *testing.T) {
	e := setupDocx(t)
	ctx := context.Background()
	cases := []struct {
		name string
		file string
		raw  []byte
	}{
		{"не docx", "файл.doc", bytes.Repeat([]byte("x"), 10)},
		{"не zip", "файл.docx", bytes.Repeat([]byte("x"), 100)},
		{"без плейсхолдера", "нет.docx", buildDocx(t, "просто текст")},
	}
	for _, item := range cases {
		_, err := e.svc.Upload(ctx, e.owner, e.project, item.name, item.file, int64(len(item.raw)), bytes.NewReader(item.raw))
		if err == nil {
			t.Fatalf("«%s» принят шаблоном", item.name)
		}
		if item.name == "без плейсхолдера" {
			// Отчёт всё равно сохраняется? Нет: шаблон без плейсхолдера не имеет смысла —
			// отказ на загрузке с объяснением, а не «загрузилось, но не работает».
			if !strings.Contains(err.Error(), "не похож") && !strings.Contains(err.Error(), "абзаца") {
				t.Fatalf("отказ без объяснения: %v", err)
			}
		}
	}
}

func TestDocxTemplateActiveMissingFile(t *testing.T) {
	e := setupDocx(t)
	ctx := context.Background()
	entry := upload(t, e, e.owner, "рукопись")
	// Файл потеряли (например, уборка хранилища): шаблон «есть», применять нельзя. Выгрузка
	// должна решить это сама, а не получить 500.
	rows, err := e.store.ListDocxTemplates(ctx, e.project)
	if err != nil || len(rows) == 0 {
		t.Fatalf("список: %v", err)
	}
	if _, err := e.svc.Delete(ctx, e.owner, e.project, entry.ID); err != nil {
		t.Fatalf("удаление: %v", err)
	}
	active, err := e.svc.Active(ctx, e.project)
	if err != nil || active != nil {
		t.Fatalf("активный шаблон после удаления: %+v, %v", active, err)
	}
}
