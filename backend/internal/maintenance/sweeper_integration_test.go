package maintenance_test

// sweeper_integration_test.go — уборка хранилища на настоящей базе и настоящем
// каталоге файлов.
//
// Проверяем ровно те обещания, ради которых уборка и написана: файл проекта
// уходит вместе с проектом, файл без строки в `assets` удаляется (но только
// старый — свежий может быть серединой чужого импорта), а строка без файла не
// удаляется, о ней только сообщают.
//
// Нужна Postgres (TEST_DATABASE_URL), как и остальным интеграционным тестам.

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"

	"github.com/skyfraze/backend/internal/assets"
	"github.com/skyfraze/backend/internal/maintenance"
	"github.com/skyfraze/backend/internal/platform/testdb"
	"github.com/skyfraze/backend/internal/projects"
	"github.com/skyfraze/backend/internal/storage"
	"github.com/skyfraze/backend/internal/store"
)

type env struct {
	st     *store.Store
	proj   *projects.Service
	assets *assets.Service
	obj    *storage.LocalStore
	dir    string
}

func setup(t *testing.T) *env {
	t.Helper()
	pool := testdb.Setup(t, "maintenance")
	testdb.Truncate(t, pool,
		"project_ratings", "project_views", "registration_requests", "app_settings",
		"project_event_state", "sessions", "invitations", "event_assets", "assets",
		"events", "team_memberships", "projects", "users")

	dir := t.TempDir()
	obj, err := storage.NewLocal(dir)
	if err != nil {
		t.Fatalf("хранилище: %v", err)
	}
	st := store.New(pool)
	proj := projects.New(st)
	assetsSvc := assets.New(st, obj, proj)
	proj.UseFiles(assetsSvc)
	return &env{st: st, proj: proj, assets: assetsSvc, obj: obj, dir: dir}
}

func (e *env) user(t *testing.T, email string) uuid.UUID {
	t.Helper()
	u, err := e.st.CreateUser(context.Background(), email, "hash", email)
	if err != nil {
		t.Fatalf("пользователь: %v", err)
	}
	return u.ID
}

// putObject кладёт файл в хранилище и, если age > 0, «состаривает» его: уборка
// удаляет только файлы старше карантина, и без сдвига времени проверять было бы
// нечего.
func (e *env) putObject(t *testing.T, key string, body string, age time.Duration) {
	t.Helper()
	data := []byte(body)
	if err := e.obj.Put(context.Background(), key, "image/png", bytes.NewReader(data), int64(len(data))); err != nil {
		t.Fatalf("файл %s: %v", key, err)
	}
	if age > 0 {
		when := time.Now().Add(-age)
		if err := os.Chtimes(filepath.Join(e.dir, filepath.FromSlash(key)), when, when); err != nil {
			t.Fatalf("время файла %s: %v", key, err)
		}
	}
}

func (e *env) keys(t *testing.T) []string {
	t.Helper()
	files, err := e.obj.List(context.Background(), "")
	if err != nil {
		t.Fatalf("список файлов: %v", err)
	}
	out := make([]string, 0, len(files))
	for _, file := range files {
		out = append(out, file.Key)
	}
	return out
}

// sweepDaysAgo — возраст «заведомо старого» файла: больше карантина по умолчанию.
const sweepDaysAgo = 48 * time.Hour

// Свежий файл без строки в `assets` — это середина импорта (файлы записаны,
// строки ещё нет), поэтому он переживает уборку; старый — удаляется.
func TestSweepRemovesOnlyOldOrphans(t *testing.T) {
	e := setup(t)
	ctx := context.Background()
	owner := e.user(t, "owner@example.com")

	project, err := e.proj.Create(ctx, owner, "Проект с файлами", "")
	if err != nil {
		t.Fatalf("проект: %v", err)
	}
	asset, err := e.assets.Upload(ctx, owner, project.ID, assets.UploadOpts{
		Filename: "схема.png", ContentType: "image/png", Size: 4, Reader: strings.NewReader("PNG1"),
	})
	if err != nil {
		t.Fatalf("вложение: %v", err)
	}

	oldOrphan := project.ID.String() + "/" + uuid.NewString() + ".png"
	freshOrphan := project.ID.String() + "/" + uuid.NewString() + ".png"
	e.putObject(t, oldOrphan, "мусор", sweepDaysAgo)
	e.putObject(t, freshOrphan, "ещё пишется", 0)

	sweeper := maintenance.New(e.st, e.obj, testLogger(t), maintenance.Options{})
	report, err := sweeper.Report(ctx)
	if err != nil {
		t.Fatalf("отчёт: %v", err)
	}
	if report.FileCount != 3 {
		t.Fatalf("файлов в хранилище %d, ожидалось 3: %v", report.FileCount, e.keys(t))
	}
	if report.OrphanFiles != 1 || report.PendingFiles != 1 {
		t.Errorf("отчёт: осиротевших %d, свежих %d (ожидалось 1 и 1)", report.OrphanFiles, report.PendingFiles)
	}
	if report.MissingFiles != 0 {
		t.Errorf("пропавших файлов %d, ожидалось 0", report.MissingFiles)
	}
	if len(report.OrphanExamples) != 1 || report.OrphanExamples[0].Key != oldOrphan {
		t.Errorf("пример осиротевшего файла: %+v", report.OrphanExamples)
	}
	// Отчёт ничего не удаляет.
	if len(e.keys(t)) != 3 {
		t.Fatalf("отчёт удалил файлы: %v", e.keys(t))
	}

	swept, err := sweeper.Sweep(ctx)
	if err != nil {
		t.Fatalf("уборка: %v", err)
	}
	if swept.RemovedFiles != 1 || swept.RemovedBytes != int64(len("мусор")) {
		t.Errorf("уборка: удалено %d файлов на %d байт", swept.RemovedFiles, swept.RemovedBytes)
	}
	if swept.FailedFiles != 0 {
		t.Errorf("ошибок удаления: %d", swept.FailedFiles)
	}
	keys := e.keys(t)
	if len(keys) != 2 {
		t.Fatalf("после уборки файлов %d, ожидалось 2: %v", len(keys), keys)
	}
	for _, key := range keys {
		if key == oldOrphan {
			t.Errorf("старый сирота остался: %v", keys)
		}
	}
	// Файл вложения и свежий файл на месте.
	if _, err := e.obj.Stat(ctx, asset.S3Key); err != nil {
		t.Errorf("файл вложения удалён: %v", err)
	}
	if _, err := e.obj.Stat(ctx, freshOrphan); err != nil {
		t.Errorf("свежий файл удалён: %v", err)
	}
}

// Строка `assets` без файла — это содержимое проекта, а не мусор: о ней сообщают,
// но не удаляют (решение за человеком).
func TestSweepReportsMissingFilesWithoutDeleting(t *testing.T) {
	e := setup(t)
	ctx := context.Background()
	owner := e.user(t, "owner@example.com")

	project, err := e.proj.Create(ctx, owner, "Проект без файла", "")
	if err != nil {
		t.Fatalf("проект: %v", err)
	}
	key := project.ID.String() + "/" + uuid.NewString() + ".png"
	if err := e.st.InsertAsset(ctx, &store.Asset{
		ProjectID: project.ID, OwnerID: owner, Filename: "потерянный.png",
		Mime: "image/png", Size: 10, S3Key: key, Kind: "image",
	}); err != nil {
		t.Fatalf("строка вложения: %v", err)
	}

	sweeper := maintenance.New(e.st, e.obj, testLogger(t), maintenance.Options{})
	report, err := sweeper.Sweep(ctx)
	if err != nil {
		t.Fatalf("уборка: %v", err)
	}
	if report.MissingFiles != 1 {
		t.Fatalf("пропавших файлов %d, ожидался 1: %+v", report.MissingFiles, report.MissingExamples)
	}
	if len(report.MissingExamples) != 1 || report.MissingExamples[0].Key != key {
		t.Errorf("пример пропавшего файла: %+v", report.MissingExamples)
	}
	if report.MissingExamples[0].Project != project.ID.String() {
		t.Errorf("проект в примере: %q", report.MissingExamples[0].Project)
	}
	if report.RemovedFiles != 0 {
		t.Errorf("уборка удалила %d файлов, хотя удалять было нечего", report.RemovedFiles)
	}
	// Строка осталась: её удаление — это удаление вложения из проекта.
	list, err := e.st.ListAssets(ctx, project.ID)
	if err != nil || len(list) != 1 {
		t.Fatalf("вложения проекта: %+v (err=%v)", list, err)
	}
}

// Удаление проекта уносит его файлы (и не трогает чужие).
func TestDeleteProjectRemovesFiles(t *testing.T) {
	e := setup(t)
	ctx := context.Background()
	owner := e.user(t, "owner@example.com")

	victim, err := e.proj.Create(ctx, owner, "Удаляемый", "")
	if err != nil {
		t.Fatalf("проект: %v", err)
	}
	keeper, err := e.proj.Create(ctx, owner, "Остаётся", "")
	if err != nil {
		t.Fatalf("второй проект: %v", err)
	}

	gone, err := e.assets.Upload(ctx, owner, victim.ID, assets.UploadOpts{
		Filename: "уйдёт.png", ContentType: "image/png", Size: 4, Reader: strings.NewReader("PNG1"),
	})
	if err != nil {
		t.Fatalf("вложение удаляемого: %v", err)
	}
	kept, err := e.assets.Upload(ctx, owner, keeper.ID, assets.UploadOpts{
		Filename: "останется.png", ContentType: "image/png", Size: 4, Reader: strings.NewReader("PNG2"),
	})
	if err != nil {
		t.Fatalf("вложение остающегося: %v", err)
	}

	if err := e.proj.Delete(ctx, owner, victim.ID); err != nil {
		t.Fatalf("удаление проекта: %v", err)
	}

	if _, err := e.obj.Stat(ctx, gone.S3Key); err == nil {
		t.Errorf("файл удалённого проекта остался: %s", gone.S3Key)
	}
	if _, err := e.obj.Stat(ctx, kept.S3Key); err != nil {
		t.Errorf("файл другого проекта пострадал: %v", err)
	}
	if keys := e.keys(t); len(keys) != 1 || keys[0] != kept.S3Key {
		t.Errorf("в хранилище: %v, ожидался только %s", keys, kept.S3Key)
	}
}

// Отчёт называет тяжёлые проекты поимённо: «база выросла» — не ответ на вопрос
// «что с этим делать», а имя проекта в отчёте — ответ.
func TestStorageReportNamesHeavySnapshots(t *testing.T) {
	e := setup(t)
	ctx := context.Background()
	owner := e.user(t, "owner@example.com")

	light, err := e.proj.Create(ctx, owner, "Лёгкий проект", "")
	if err != nil {
		t.Fatalf("проект: %v", err)
	}
	heavy, err := e.proj.Create(ctx, owner, "Тяжёлый проект", "")
	if err != nil {
		t.Fatalf("второй проект: %v", err)
	}
	if _, err := e.st.SaveProjectEventStateServer(ctx, light.ID, owner, []byte("маленький снапшот")); err != nil {
		t.Fatalf("снапшот: %v", err)
	}
	if _, err := e.st.SaveProjectEventStateServer(ctx, heavy.ID, owner, bytes.Repeat([]byte("x"), 4096)); err != nil {
		t.Fatalf("снапшот: %v", err)
	}

	sweeper := maintenance.New(e.st, e.obj, testLogger(t), maintenance.Options{})
	report, err := sweeper.Report(ctx)
	if err != nil {
		t.Fatalf("отчёт: %v", err)
	}
	if len(report.ProjectsUsage) != 2 {
		t.Fatalf("проектов в отчёте %d, ожидалось 2: %+v", len(report.ProjectsUsage), report.ProjectsUsage)
	}
	if report.ProjectsUsage[0].ID != heavy.ID || report.ProjectsUsage[0].Title != "Тяжёлый проект" {
		t.Errorf("первым должен быть самый тяжёлый: %+v", report.ProjectsUsage[0])
	}
	if report.ProjectsUsage[0].Total() < report.ProjectsUsage[1].Total() {
		t.Errorf("порядок по весу нарушен: %+v", report.ProjectsUsage)
	}
	// Вес показан по частям: у тяжёлого проекта он из снапшота, вложений нет.
	if report.ProjectsUsage[0].Snapshot == 0 || report.ProjectsUsage[0].Assets != 0 {
		t.Errorf("вес по частям: %+v", report.ProjectsUsage[0])
	}
}

// Отчёт о размерах показывает то, что нужно для решений: размер базы, снапшоты,
// текст проекции и вложения.
func TestStorageReportCounts(t *testing.T) {
	e := setup(t)
	ctx := context.Background()
	owner := e.user(t, "owner@example.com")

	project, err := e.proj.Create(ctx, owner, "Проект со снапшотом", "")
	if err != nil {
		t.Fatalf("проект: %v", err)
	}
	if err := e.st.InsertEventTree(ctx, project.ID, owner, []store.Event{
		{ID: uuid.New(), ProjectID: project.ID, Position: 0, Depth: 0, Title: "Глава", Body: "Текст главы."},
	}); err != nil {
		t.Fatalf("событие: %v", err)
	}
	if _, err := e.st.SaveProjectEventStateServer(ctx, project.ID, owner, []byte("yjs-состояние")); err != nil {
		t.Fatalf("снапшот: %v", err)
	}
	if _, err := e.assets.Upload(ctx, owner, project.ID, assets.UploadOpts{
		Filename: "карта.png", ContentType: "image/png", Size: 3, Reader: strings.NewReader("PNG"),
	}); err != nil {
		t.Fatalf("вложение: %v", err)
	}

	sweeper := maintenance.New(e.st, e.obj, testLogger(t), maintenance.Options{})
	report, err := sweeper.Report(ctx)
	if err != nil {
		t.Fatalf("отчёт: %v", err)
	}
	if report.DatabaseBytes <= 0 {
		t.Error("размер базы не измерен")
	}
	if report.Projects != 1 || report.SnapshotCount != 1 || report.SnapshotBytes == 0 {
		t.Errorf("проекты/снапшоты: %+v", report)
	}
	if report.EventRows != 1 || report.EventTextSize == 0 {
		t.Errorf("текст проекции: строк %d, байт %d", report.EventRows, report.EventTextSize)
	}
	if report.AssetRows != 1 || report.AssetBytes != 3 || report.FileCount != 1 || report.FileBytes != 3 {
		t.Errorf("вложения: строк %d, байт %d, файлов %d, байт %d",
			report.AssetRows, report.AssetBytes, report.FileCount, report.FileBytes)
	}
	if len(report.Tables) == 0 {
		t.Error("размеры таблиц не собраны")
	}
	// Отчёт по вложениям должен видеть хотя бы таблицу вложений.
	found := false
	for _, table := range report.Tables {
		if table.Name == "assets" && table.Bytes > 0 {
			found = true
		}
	}
	if !found {
		t.Errorf("в таблицах нет assets: %+v", report.Tables)
	}
}

// Ручки админки: отчёт отдаётся как JSON, уборка по требованию возвращает тот же
// отчёт с числами удалённого. Права проверяет админ-роутер, здесь — только тело.
func TestStorageHandlers(t *testing.T) {
	e := setup(t)
	ctx := context.Background()
	owner := e.user(t, "owner@example.com")

	project, err := e.proj.Create(ctx, owner, "Проект с сиротой", "")
	if err != nil {
		t.Fatalf("проект: %v", err)
	}
	orphan := project.ID.String() + "/" + uuid.NewString() + ".png"
	e.putObject(t, orphan, "мусор", sweepDaysAgo)

	sweeper := maintenance.New(e.st, e.obj, testLogger(t), maintenance.Options{})

	// GET: ничего не удаляет.
	rec := httptest.NewRecorder()
	sweeper.Storage(rec, httptest.NewRequest(http.MethodGet, "/api/admin/storage", nil))
	if rec.Code != http.StatusOK {
		t.Fatalf("отчёт: код %d, тело %s", rec.Code, rec.Body.String())
	}
	var report maintenance.Report
	if err := json.Unmarshal(rec.Body.Bytes(), &report); err != nil {
		t.Fatalf("json отчёта: %v (%s)", err, rec.Body.String())
	}
	if report.OrphanFiles != 1 || report.FileCount != 1 {
		t.Errorf("отчёт по HTTP: %+v", report)
	}
	if len(e.keys(t)) != 1 {
		t.Errorf("отчёт удалил файл: %v", e.keys(t))
	}

	// POST: убирает и рассказывает, что убрал.
	rec = httptest.NewRecorder()
	sweeper.SweepStorage(rec, httptest.NewRequest(http.MethodPost, "/api/admin/storage/sweep", nil))
	if rec.Code != http.StatusOK {
		t.Fatalf("уборка: код %d, тело %s", rec.Code, rec.Body.String())
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &report); err != nil {
		t.Fatalf("json уборки: %v (%s)", err, rec.Body.String())
	}
	if report.RemovedFiles != 1 || report.OrphanFiles != 1 {
		t.Errorf("уборка по HTTP: %+v", report)
	}
	if len(e.keys(t)) != 0 {
		t.Errorf("после уборки остались файлы: %v", e.keys(t))
	}
}
