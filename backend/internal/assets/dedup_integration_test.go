package assets_test

// dedup_integration_test.go — дедупликация файлов по содержимому (миграция 0007).
//
// Один и тот же файл попадает в проект не раз: картинку загружают повторно, ту же
// папку импортируют в два проекта, копию архива переносят на стенд. Байты одни и
// те же, и хранить их дважды незачем — но имя файла, владелец и проект у каждой
// строки вложений остаются свои.
//
// Проверяем и обратную сторону: файл, которым пользуются два проекта, переживает
// удаление одного из них и уходит только с последней ссылкой.
//
// Нужна Postgres (TEST_DATABASE_URL), как и остальным интеграционным тестам.

import (
	"bytes"
	"context"
	"io"
	"testing"

	"github.com/google/uuid"

	"github.com/skyfraze/backend/internal/assets"
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
}

func setup(t *testing.T) *env {
	t.Helper()
	pool := testdb.Setup(t, "assets")
	testdb.Truncate(t, pool,
		"project_ratings", "project_views", "registration_requests", "app_settings",
		"project_event_state", "sessions", "invitations", "event_assets", "assets",
		"events", "team_memberships", "projects", "users")

	obj, err := storage.NewLocal(t.TempDir())
	if err != nil {
		t.Fatalf("хранилище: %v", err)
	}
	st := store.New(pool)
	proj := projects.New(st)
	assetsSvc := assets.New(st, obj, proj)
	proj.UseFiles(assetsSvc)
	return &env{st: st, proj: proj, assets: assetsSvc, obj: obj}
}

func (e *env) user(t *testing.T, email string) uuid.UUID {
	t.Helper()
	u, err := e.st.CreateUser(context.Background(), email, "hash", email)
	if err != nil {
		t.Fatalf("пользователь: %v", err)
	}
	return u.ID
}

func (e *env) files(t *testing.T) []storage.ObjectInfo {
	t.Helper()
	files, err := e.obj.List(context.Background(), "")
	if err != nil {
		t.Fatalf("список файлов: %v", err)
	}
	return files
}

// Один и тот же файл под разными именами в двух проектах лежит в хранилище один раз.
func TestUploadDeduplicatesSameContent(t *testing.T) {
	e := setup(t)
	ctx := context.Background()
	owner := e.user(t, "owner@example.com")

	first, err := e.proj.Create(ctx, owner, "Первый проект", "")
	if err != nil {
		t.Fatalf("проект: %v", err)
	}
	second, err := e.proj.Create(ctx, owner, "Второй проект", "")
	if err != nil {
		t.Fatalf("второй проект: %v", err)
	}

	content := []byte("одинаковые байты картинки")
	one, err := e.assets.Upload(ctx, owner, first.ID, assets.UploadOpts{
		Filename: "схема.png", ContentType: "image/png", Size: int64(len(content)),
		Reader: bytes.NewReader(content),
	})
	if err != nil {
		t.Fatalf("загрузка в первый проект: %v", err)
	}
	// Имя другое — содержимое то же: дедупликация идёт по байтам, а не по имени.
	two, err := e.assets.Upload(ctx, owner, second.ID, assets.UploadOpts{
		Filename: "копия-схемы.png", ContentType: "image/png", Size: int64(len(content)),
		Reader: bytes.NewReader(content),
	})
	if err != nil {
		t.Fatalf("загрузка во второй проект: %v", err)
	}

	if one.ID == two.ID {
		t.Fatal("две загрузки должны давать две строки вложений: имя, владелец и проект у каждой свои")
	}
	if one.S3Key != two.S3Key {
		t.Errorf("файл записан дважды: %q и %q", one.S3Key, two.S3Key)
	}
	if one.ContentHash == nil || two.ContentHash == nil || *one.ContentHash != *two.ContentHash {
		t.Errorf("хеши содержимого: %v и %v", one.ContentHash, two.ContentHash)
	}
	if two.Filename != "копия-схемы.png" {
		t.Errorf("имя второго вложения своё: %q", two.Filename)
	}
	if files := e.files(t); len(files) != 1 {
		t.Fatalf("в хранилище %d файлов, ожидался один: %+v", len(files), files)
	}

	// Разное содержимое дедупликации не подлежит.
	other := []byte("совсем другие байты")
	third, err := e.assets.Upload(ctx, owner, second.ID, assets.UploadOpts{
		Filename: "другая.png", ContentType: "image/png", Size: int64(len(other)),
		Reader: bytes.NewReader(other),
	})
	if err != nil {
		t.Fatalf("загрузка другого файла: %v", err)
	}
	if third.S3Key == one.S3Key {
		t.Error("разные файлы не должны делить один ключ")
	}
	if files := e.files(t); len(files) != 2 {
		t.Fatalf("в хранилище %d файлов, ожидалось два: %+v", len(files), files)
	}
}

// Общий файл живёт, пока на него ссылается хотя бы один проект.
func TestDeleteProjectKeepsSharedFile(t *testing.T) {
	e := setup(t)
	ctx := context.Background()
	owner := e.user(t, "owner@example.com")

	keeper, err := e.proj.Create(ctx, owner, "Остаётся", "")
	if err != nil {
		t.Fatalf("проект: %v", err)
	}
	victim, err := e.proj.Create(ctx, owner, "Удаляемый", "")
	if err != nil {
		t.Fatalf("второй проект: %v", err)
	}

	content := []byte("общая картинка")
	shared, err := e.assets.Upload(ctx, owner, keeper.ID, assets.UploadOpts{
		Filename: "общая.png", ContentType: "image/png", Size: int64(len(content)),
		Reader: bytes.NewReader(content),
	})
	if err != nil {
		t.Fatalf("загрузка: %v", err)
	}
	if _, err := e.assets.Upload(ctx, owner, victim.ID, assets.UploadOpts{
		Filename: "та же.png", ContentType: "image/png", Size: int64(len(content)),
		Reader: bytes.NewReader(content),
	}); err != nil {
		t.Fatalf("вторая загрузка: %v", err)
	}
	only := []byte("файл только удаляемого проекта")
	if _, err := e.assets.Upload(ctx, owner, victim.ID, assets.UploadOpts{
		Filename: "личный.png", ContentType: "image/png", Size: int64(len(only)),
		Reader: bytes.NewReader(only),
	}); err != nil {
		t.Fatalf("личная загрузка: %v", err)
	}
	if files := e.files(t); len(files) != 2 {
		t.Fatalf("в хранилище %d файлов, ожидалось два: %+v", len(files), files)
	}

	if err := e.proj.Delete(ctx, owner, victim.ID); err != nil {
		t.Fatalf("удаление проекта: %v", err)
	}

	// Общий файл на месте (им пользуется оставшийся проект), личный — удалён.
	files := e.files(t)
	if len(files) != 1 || files[0].Key != shared.S3Key {
		t.Fatalf("после удаления в хранилище %+v, ожидался только общий файл %s", files, shared.S3Key)
	}
	if _, err := e.obj.Stat(ctx, shared.S3Key); err != nil {
		t.Errorf("общий файл пропал: %v", err)
	}

	// Последняя ссылка ушла — уходит и файл.
	if err := e.proj.Delete(ctx, owner, keeper.ID); err != nil {
		t.Fatalf("удаление второго проекта: %v", err)
	}
	if files := e.files(t); len(files) != 0 {
		t.Fatalf("после последней ссылки файлы остались: %+v", files)
	}
}

// Импорт папки с md идёт тем же путём: файл, уже загруженный в другой проект, не
// пишется второй раз.
func TestStoreFileDeduplicates(t *testing.T) {
	e := setup(t)
	ctx := context.Background()
	owner := e.user(t, "owner@example.com")

	first, err := e.proj.Create(ctx, owner, "Проект с загрузкой", "")
	if err != nil {
		t.Fatalf("проект: %v", err)
	}
	second, err := e.proj.Create(ctx, owner, "Проект с импортом", "")
	if err != nil {
		t.Fatalf("второй проект: %v", err)
	}

	content := []byte("картинка из папки с историей")
	uploaded, err := e.assets.Upload(ctx, owner, first.ID, assets.UploadOpts{
		Filename: "карта.png", ContentType: "image/png", Size: int64(len(content)),
		Reader: bytes.NewReader(content),
	})
	if err != nil {
		t.Fatalf("загрузка: %v", err)
	}

	imported, err := e.assets.StoreFile(ctx, assets.StoreFileOptions{
		ProjectID: second.ID, OwnerID: owner, Filename: "карта.png",
		Mime: "image/png", Kind: "image", Data: content,
	})
	if err != nil {
		t.Fatalf("запись из импорта: %v", err)
	}
	if imported.S3Key != uploaded.S3Key {
		t.Errorf("импорт записал файл заново: %q против %q", imported.S3Key, uploaded.S3Key)
	}
	if files := e.files(t); len(files) != 1 {
		t.Fatalf("в хранилище %d файлов, ожидался один: %+v", len(files), files)
	}

	// Файлы импортируются пачкой: если запись сорвалась, убираются только те, на
	// которые больше нет ссылок (общий файл чужого проекта не трогаем).
	if _, err := e.assets.DeleteUnreferencedFiles(ctx, []string{uploaded.S3Key}); err != nil {
		t.Fatalf("уборка: %v", err)
	}
	if _, err := e.obj.Stat(ctx, uploaded.S3Key); err != nil {
		t.Fatalf("файл, на который есть ссылки, удалён: %v", err)
	}
}

// Дедупликация не мешает отдавать файл: он читается и по своей строке, и по
// «копии» в другом проекте.
func TestDeduplicatedFileIsReadable(t *testing.T) {
	e := setup(t)
	ctx := context.Background()
	owner := e.user(t, "owner@example.com")

	first, err := e.proj.Create(ctx, owner, "Первый", "")
	if err != nil {
		t.Fatalf("проект: %v", err)
	}
	second, err := e.proj.Create(ctx, owner, "Второй", "")
	if err != nil {
		t.Fatalf("второй проект: %v", err)
	}

	content := []byte("содержимое, которое должно читаться одинаково")
	if _, err := e.assets.Upload(ctx, owner, first.ID, assets.UploadOpts{
		Filename: "файл.png", ContentType: "image/png", Size: int64(len(content)),
		Reader: bytes.NewReader(content),
	}); err != nil {
		t.Fatalf("загрузка: %v", err)
	}
	copyAsset, err := e.assets.Upload(ctx, owner, second.ID, assets.UploadOpts{
		Filename: "файл.png", ContentType: "image/png", Size: int64(len(content)),
		Reader: bytes.NewReader(content),
	})
	if err != nil {
		t.Fatalf("вторая загрузка: %v", err)
	}

	read, _, err := e.assets.Open(ctx, owner, copyAsset.ID)
	if err != nil {
		t.Fatalf("чтение по строке-копии: %v", err)
	}
	defer read.Close()
	got, err := io.ReadAll(read)
	if err != nil {
		t.Fatalf("чтение содержимого: %v", err)
	}
	if string(got) != string(content) {
		t.Errorf("содержимое: %q", string(got))
	}
}
