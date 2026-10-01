package assets_test

// heic_integration_test.go — HEIC (формат айфонов) на уровне вложений проекта.
//
// Правило отличается от остальных картинок: HEIC нельзя «оставить как есть». Браузеры
// (кроме Safari) его не показывают, поэтому либо разбираем и храним WebP, либо
// отказываем с понятным текстом. Проверяем оба исхода и то, что имя файла меняется
// вместе с содержимым.
//
// Нужна Postgres (TEST_DATABASE_URL), как и остальным интеграционным тестам.

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"testing"

	"github.com/skyfraze/backend/internal/assets"
	"github.com/skyfraze/backend/internal/media"
	"github.com/skyfraze/backend/internal/platform/testimage"
)

// heicStubPhoto — то, что «вернёт» конвертер: настоящий JPEG, снятый как фото.
func heicStubPhoto(t *testing.T) func(context.Context, []byte) ([]byte, error) {
	t.Helper()
	photo := testimage.JPEG(t, testimage.Photo(1600, 1200), 95)
	return func(_ context.Context, data []byte) ([]byte, error) {
		if len(data) == 0 {
			return nil, errors.New("пустой HEIC")
		}
		return photo, nil
	}
}

func TestUploadConvertsHEIC(t *testing.T) {
	e := setup(t)
	ctx := context.Background()
	owner := e.user(t, "owner@example.com")
	project, err := e.proj.Create(ctx, owner, "Проект с айфоном", "")
	if err != nil {
		t.Fatalf("проект: %v", err)
	}
	media.UseHEICConverter(heicStubPhoto(t))
	defer media.ResetHEICConverter()

	asset, err := e.assets.Upload(ctx, owner, project.ID, assets.UploadOpts{
		Filename: "IMG_1234.HEIC", ContentType: "image/heic", Size: 12,
		Reader: bytes.NewReader([]byte("heic-данные")),
	})
	if err != nil {
		t.Fatalf("загрузка HEIC: %v", err)
	}
	if asset.Mime != "image/webp" || asset.Filename != "IMG_1234.webp" {
		t.Errorf("вложение: %s / %s", asset.Mime, asset.Filename)
	}
	if asset.Width == nil || *asset.Width != 1600 {
		t.Errorf("ширина: %v", asset.Width)
	}
	// Файл в хранилище — webp, а не исходный HEIC.
	file := e.files(t)
	if len(file) != 1 || file[0].Key != asset.S3Key {
		t.Fatalf("файлы: %+v", file)
	}
	if data := readObject(t, e, asset.S3Key); !bytes.HasPrefix(data, []byte("RIFF")) {
		t.Errorf("в хранилище не webp: % x", data[:min(8, len(data))])
	}
}

// Импорт папки с md идёт тем же путём: HEIC из набора превращается в WebP.
func TestStoreFileConvertsHEIC(t *testing.T) {
	e := setup(t)
	ctx := context.Background()
	owner := e.user(t, "owner@example.com")
	project, err := e.proj.Create(ctx, owner, "Проект из архива", "")
	if err != nil {
		t.Fatalf("проект: %v", err)
	}
	media.UseHEICConverter(heicStubPhoto(t))
	defer media.ResetHEICConverter()

	asset, err := e.assets.StoreFile(ctx, assets.StoreFileOptions{
		ProjectID: project.ID, OwnerID: owner, Filename: "фото.heic",
		Mime: "image/heic", Data: []byte("heic-данные"),
	})
	if err != nil {
		t.Fatalf("сохранение HEIC из набора: %v", err)
	}
	if asset.Mime != "image/webp" || asset.Filename != "фото.webp" {
		t.Errorf("вложение: %s / %s", asset.Mime, asset.Filename)
	}
}

// Без конвертера HEIC не принимается: файл, который никто не увидит, хранить нельзя.
func TestUploadHEICWithoutConverterRefused(t *testing.T) {
	e := setup(t)
	ctx := context.Background()
	owner := e.user(t, "owner@example.com")
	project, err := e.proj.Create(ctx, owner, "Проект без конвертера", "")
	if err != nil {
		t.Fatalf("проект: %v", err)
	}
	media.ResetHEICConverter()
	if media.HEICAvailable() {
		t.Skip("в среде есть настоящий heif-convert — отказ не проверить")
	}

	_, err = e.assets.Upload(ctx, owner, project.ID, assets.UploadOpts{
		Filename: "IMG_1.heic", ContentType: "image/heic", Size: 6,
		Reader: bytes.NewReader([]byte("heic!!")),
	})
	if !errors.Is(err, assets.ErrHEICUndecodable) {
		t.Fatalf("ожидался отказ по HEIC, получено: %v", err)
	}
	// Ни файла, ни строки: отказ не оставляет следов.
	if files := e.files(t); len(files) != 0 {
		t.Errorf("после отказа остались файлы: %+v", files)
	}
	if rows, err := e.st.ListAssets(ctx, project.ID); err != nil || len(rows) != 0 {
		t.Errorf("после отказа остались строки: %+v (err=%v)", rows, err)
	}
}

// Через HTTP человек получает понятный текст, а не «upload failed».
func TestUploadHEICOverHTTP(t *testing.T) {
	e := setup(t)
	ctx := context.Background()
	owner := e.user(t, "owner@example.com")
	project, err := e.proj.Create(ctx, owner, "Проект с HEIC по HTTP", "")
	if err != nil {
		t.Fatalf("проект: %v", err)
	}
	media.ResetHEICConverter()
	h := assetsRouter(t, e.assets)
	base := "/api/projects/" + project.ID.String() + "/assets"

	body, ctype := multipartFile(t, "IMG_1.heic", "heic-данные")
	rec := doAsset(t, h, http.MethodPost, base, owner, body, ctype)
	if media.HEICAvailable() {
		// С конвертером сервер обязан принять файл — проверим это, а не отказ.
		if rec.Code != http.StatusCreated {
			t.Fatalf("с конвертером: код %d, тело %s", rec.Code, rec.Body.String())
		}
		return
	}
	if rec.Code != http.StatusUnsupportedMediaType {
		t.Fatalf("без конвертера: код %d, тело %s", rec.Code, rec.Body.String())
	}
	var body2 struct {
		Error string `json:"error"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &body2); err != nil {
		t.Fatalf("json отказа: %v (%s)", err, rec.Body.String())
	}
	if !bytes.Contains([]byte(body2.Error), []byte("HEIC")) || !bytes.Contains([]byte(body2.Error), []byte("JPEG")) {
		t.Errorf("текст отказа непонятен: %q", body2.Error)
	}
}

// Тип по имени: в таблице Go нет HEIC, а браузер может не прислать Content-Type
// вовсе — тогда файл с телефона отвергался бы как «неизвестный тип».
func TestHEICMimeFromFilename(t *testing.T) {
	cases := map[string]string{
		"IMG_1234.HEIC": "image/heic",
		"снимок.heif":   "image/heif",
		"фото.jpg":      "image/jpeg",
	}
	for name, want := range cases {
		if got := assets.MimeOf(name); got != want {
			t.Errorf("%s → %q, ожидался %q", name, got, want)
		}
		if got := assets.NormalizeMime("application/octet-stream", name); got != want {
			t.Errorf("%s с octet-stream → %q, ожидался %q", name, got, want)
		}
	}
}
