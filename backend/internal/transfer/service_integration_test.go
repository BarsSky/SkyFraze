package transfer_test

import (
	"archive/zip"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"testing"

	"github.com/google/uuid"

	"github.com/skyfraze/backend/internal/events"
	"github.com/skyfraze/backend/internal/platform/testdb"
	"github.com/skyfraze/backend/internal/projects"
	"github.com/skyfraze/backend/internal/storage"
	"github.com/skyfraze/backend/internal/store"
	"github.com/skyfraze/backend/internal/transfer"
)

func newZip(w io.Writer) *zip.Writer { return zip.NewWriter(w) }

func writeFile(t *testing.T, zw *zip.Writer, name string, data []byte) {
	t.Helper()
	f, err := zw.Create(name)
	if err != nil {
		t.Fatalf("zip create %s: %v", name, err)
	}
	if _, err := f.Write(data); err != nil {
		t.Fatalf("zip write %s: %v", name, err)
	}
}

func closeZip(t *testing.T, zw *zip.Writer) {
	t.Helper()
	if err := zw.Close(); err != nil {
		t.Fatalf("zip close: %v", err)
	}
}

func mustJSON(t *testing.T, v any) []byte {
	t.Helper()
	data, err := json.Marshal(v)
	if err != nil {
		t.Fatalf("json: %v", err)
	}
	return data
}

type env struct {
	st       *store.Store
	proj     *projects.Service
	transfer *transfer.Service
	obj      storage.ObjectStore
}

func setup(t *testing.T) *env {
	t.Helper()
	pool := testdb.Setup(t, "transfer")
	testdb.Truncate(t, pool,
		"project_ratings", "project_views", "registration_requests", "app_settings",
		"project_event_state", "sessions", "invitations", "event_assets", "assets",
		"events", "team_memberships", "projects", "users")

	obj, err := storage.NewLocal(t.TempDir())
	if err != nil {
		t.Fatalf("storage: %v", err)
	}
	st := store.New(pool)
	proj := projects.New(st)
	return &env{st: st, proj: proj, transfer: transfer.New(st, obj, proj), obj: obj}
}

func (e *env) user(t *testing.T, email string) uuid.UUID {
	t.Helper()
	u, err := e.st.CreateUser(context.Background(), email, "hash", email)
	if err != nil {
		t.Fatalf("create user: %v", err)
	}
	return u.ID
}

// seedProject собирает проект «как у пользователя»: глава + под-событие, вложение
// с реальным файлом и CRDT-снапшот с фоном кадра.
func (e *env) seedProject(t *testing.T, owner uuid.UUID) (uuid.UUID, uuid.UUID, []byte) {
	t.Helper()
	ctx := context.Background()
	p, err := e.proj.Create(ctx, owner, "Мой проект", "описание проекта")
	if err != nil {
		t.Fatalf("create project: %v", err)
	}

	chapter := uuid.New()
	child := uuid.New()
	if err := e.st.ReplaceEventTree(ctx, p.ID, owner, []store.Event{
		{ID: chapter, ProjectID: p.ID, Position: 0, Depth: 0, Title: "Глава 1", Body: "текст главы"},
		{ID: child, ProjectID: p.ID, ParentID: &chapter, Position: 0, Depth: 1, Title: "Под-событие", Body: "текст под-события"},
	}); err != nil {
		t.Fatalf("events: %v", err)
	}

	assetID := uuid.New()
	content := []byte("PNG-данные-вложения")
	key := p.ID.String() + "/" + assetID.String() + ".png"
	if err := e.obj.Put(ctx, key, "image/png", bytes.NewReader(content), int64(len(content))); err != nil {
		t.Fatalf("put asset: %v", err)
	}
	if err := e.st.InsertAsset(ctx, &store.Asset{
		ID: assetID, ProjectID: p.ID, OwnerID: owner, Filename: "схема.png",
		Mime: "image/png", Size: int64(len(content)), S3Key: key, Kind: "image",
	}); err != nil {
		t.Fatalf("insert asset: %v", err)
	}

	state := []byte("yjs-update-bytes")
	if _, err := e.st.SaveProjectEventState(ctx, p.ID, owner, state, 0); err != nil {
		t.Fatalf("state: %v", err)
	}
	return p.ID, assetID, state
}

func TestExportImport_RoundTrip(t *testing.T) {
	e := setup(t)
	ctx := context.Background()
	owner := e.user(t, "owner@example.com")
	projectID, assetID, state := e.seedProject(t, owner)

	// --- экспорт
	var buf bytes.Buffer
	info, err := e.transfer.Export(ctx, owner, projectID, &buf)
	if err != nil {
		t.Fatalf("export: %v", err)
	}
	if info.Events != 2 || info.Assets != 1 || !info.HasState {
		t.Fatalf("в архиве ожидалось 2 события, 1 вложение и снапшот, получено %+v", info)
	}
	if info.Filename != "project.skyfraze.zip" {
		t.Errorf("кириллический заголовок должен давать нейтральное имя файла, получено %q", info.Filename)
	}

	parsed, err := transfer.ParseBundle(bytes.NewReader(buf.Bytes()), int64(buf.Len()))
	if err != nil {
		t.Fatalf("parse: %v", err)
	}
	if parsed.Manifest.Project.Title != "Мой проект" {
		t.Errorf("заголовок проекта в манифесте: %q", parsed.Manifest.Project.Title)
	}

	// --- повторный импорт в ту же базу: понятная ошибка, а не перезапись
	if _, err := e.transfer.Import(ctx, owner, parsed); !errors.Is(err, transfer.ErrAlreadyImported) {
		t.Fatalf("повторный импорт должен распознаваться как уже импортированный, получено %v", err)
	}

	// --- «другой стенд»: удаляем исходный проект и импортируем архив заново
	if err := e.st.DeleteProject(ctx, projectID); err != nil {
		t.Fatalf("delete source: %v", err)
	}
	res, err := e.transfer.Import(ctx, owner, parsed)
	if err != nil {
		t.Fatalf("import: %v", err)
	}
	if res.Events != 2 || res.Assets != 1 || !res.HasState {
		t.Fatalf("после импорта ожидалось 2 события, 1 вложение и снапшот, получено %+v", res)
	}
	newID := res.Project.ID
	if newID == projectID {
		t.Fatal("импорт должен создавать НОВЫЙ проект, а не тот же самый")
	}
	if res.Project.Title != "Мой проект" || res.Project.Description != "описание проекта" {
		t.Errorf("метаданные проекта не перенеслись: %+v", res.Project)
	}
	if res.Project.OwnerID != owner {
		t.Errorf("владельцем импортированного проекта должен стать импортирующий, получено %s", res.Project.OwnerID)
	}

	// дерево событий и вложенность
	evs, err := e.st.ListEvents(ctx, newID)
	if err != nil {
		t.Fatalf("list events: %v", err)
	}
	if len(evs) != 2 {
		t.Fatalf("событий после импорта: %d", len(evs))
	}
	var nested bool
	for _, ev := range evs {
		if ev.ID == assetID {
			t.Error("id вложения не должен попадать в события")
		}
		if ev.Depth == 1 && ev.ParentID != nil {
			nested = true
		}
	}
	if !nested {
		t.Error("вложенность (parent_id/depth) не сохранилась")
	}

	// вложение: строка + сам файл в хранилище
	assets, err := e.st.ListAssets(ctx, newID)
	if err != nil || len(assets) != 1 {
		t.Fatalf("вложений после импорта: %d (err=%v)", len(assets), err)
	}
	if assets[0].ID != assetID {
		t.Errorf("id вложения должен сохраняться (на него ссылается CRDT), получено %s", assets[0].ID)
	}
	rc, err := e.obj.Get(ctx, assets[0].S3Key)
	if err != nil {
		t.Fatalf("файл вложения не перенёсся: %v", err)
	}
	got, _ := io.ReadAll(rc)
	rc.Close()
	if string(got) != "PNG-данные-вложения" {
		t.Errorf("содержимое вложения изменилось: %q", string(got))
	}

	// CRDT-снапшот: без него пропали бы тексты и фон кадров
	st, err := e.st.GetProjectEventState(ctx, newID)
	if err != nil || st == nil {
		t.Fatalf("снапшот не перенёсся: %v", err)
	}
	if !bytes.Equal(st.YjsState, state) {
		t.Errorf("снапшот изменился: %q", string(st.YjsState))
	}
}

func TestExportImport_GuardsAndPermissions(t *testing.T) {
	e := setup(t)
	ctx := context.Background()
	owner := e.user(t, "owner@example.com")
	stranger := e.user(t, "stranger@example.com")
	projectID, _, _ := e.seedProject(t, owner)

	// Посторонний не выгружает чужой проект
	var buf bytes.Buffer
	if _, err := e.transfer.Export(ctx, stranger, projectID, &buf); !errors.Is(err, transfer.ErrForbidden) {
		t.Fatalf("экспорт чужого проекта должен запрещаться, получено %v", err)
	}

	// Мусор вместо архива — понятная ошибка, ничего не создаётся
	junk := []byte("это не zip")
	if _, err := transfer.ParseBundle(bytes.NewReader(junk), int64(len(junk))); !errors.Is(err, transfer.ErrBadBundle) {
		t.Fatalf("мусорный файл должен отклоняться как ErrBadBundle, получено %v", err)
	}

	// Слишком большой архив отклоняется до чтения
	if _, err := transfer.ParseBundle(bytes.NewReader(junk), transfer.MaxBundleSize+1); !errors.Is(err, transfer.ErrTooLarge) {
		t.Fatalf("превышение размера должно отклоняться, получено %v", err)
	}

	// Архив с чужим форматом
	var alien bytes.Buffer
	zw := newZip(&alien)
	writeFile(t, zw, "manifest.json", []byte(`{"format":"other","version":1}`))
	closeZip(t, zw)
	if _, err := transfer.ParseBundle(bytes.NewReader(alien.Bytes()), int64(alien.Len())); !errors.Is(err, transfer.ErrUnsupportedFormat) {
		t.Fatalf("чужой формат должен отклоняться, получено %v", err)
	}
}

// Проверяем, что импорт валидирует структуру дерева теми же правилами, что и
// обычная синхронизация: цикл в архиве не должен попасть в базу.
func TestImport_RejectsInvalidTree(t *testing.T) {
	e := setup(t)
	ctx := context.Background()
	owner := e.user(t, "owner@example.com")

	a, b := uuid.New(), uuid.New()
	manifest := map[string]any{
		"format":  transfer.FormatName,
		"version": transfer.FormatVersion,
		"project": map[string]string{"title": "Цикл", "description": ""},
		"events": []map[string]any{
			{"id": a, "parent_id": b, "position": 0, "title": "A", "body": ""},
			{"id": b, "parent_id": a, "position": 0, "title": "B", "body": ""},
		},
		"assets": []any{},
	}
	raw := mustJSON(t, manifest)
	var buf bytes.Buffer
	zw := newZip(&buf)
	writeFile(t, zw, "manifest.json", raw)
	closeZip(t, zw)

	parsed, err := transfer.ParseBundle(bytes.NewReader(buf.Bytes()), int64(buf.Len()))
	if err != nil {
		t.Fatalf("parse: %v", err)
	}
	if _, err := e.transfer.Import(ctx, owner, parsed); !errors.Is(err, transfer.ErrBadBundle) {
		t.Fatalf("цикл в дереве должен отклоняться, получено %v", err)
	}
	// Проект не должен остаться после неудачного импорта.
	list, err := e.proj.List(ctx, owner)
	if err != nil {
		t.Fatalf("list: %v", err)
	}
	if len(list) != 0 {
		t.Fatalf("после неудачного импорта не должно оставаться проектов, найдено %d", len(list))
	}
}

func TestSlugifyFileName(t *testing.T) {
	cases := map[string]string{
		"Galactic Story": "galactic-story",
		"Млечный путь":   "project",
		"":               "project",
	}
	for in, want := range cases {
		if got := transfer.SlugifyFileName(in); got != want {
			t.Errorf("SlugifyFileName(%q) = %q, ожидалось %q", in, got, want)
		}
	}
}

// Проверяем, что NormalizeTree из events действительно сортирует родителей раньше
// детей: на этом держится вставка дерева при импорте (FK parent_id).
func TestNormalize_OrderIsParentsFirst(t *testing.T) {
	parent, child := uuid.New(), uuid.New()
	nodes := []events.NodeInput{
		{ID: child, ParentID: &parent, Position: 0, Title: "child"},
		{ID: parent, Position: 0, Title: "parent"},
	}
	out, err := events.NormalizeTree(nodes)
	if err != nil {
		t.Fatalf("normalize: %v", err)
	}
	if len(out) != 2 || out[0].ID != parent {
		t.Fatalf("родитель должен идти первым, получено %+v", out)
	}
}
