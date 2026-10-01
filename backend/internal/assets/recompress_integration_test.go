package assets_test

// recompress_integration_test.go — пережатие картинок при загрузке и импорте.
//
// Проверяем обе стороны: файл в хранилище действительно меньше и читается (WebP),
// и при этом дедупликация продолжает работать — хеш считается по ЗАПИСАННЫМ байтам,
// поэтому две загрузки одного фото (даже под разными именами и в разные проекты)
// сходятся в один объект.
//
// Нужна Postgres (TEST_DATABASE_URL), как и остальным интеграционным тестам.

import (
	"bytes"
	"context"
	"testing"

	"github.com/KarpelesLab/gowebp"

	"github.com/skyfraze/backend/internal/assets"
	"github.com/skyfraze/backend/internal/platform/testimage"
)

func TestUploadRecompressesImages(t *testing.T) {
	e := setup(t)
	ctx := context.Background()
	owner := e.user(t, "owner@example.com")

	project, err := e.proj.Create(ctx, owner, "Проект с фото", "")
	if err != nil {
		t.Fatalf("проект: %v", err)
	}
	source := testimage.JPEG(t, testimage.Photo(1200, 800), 92)

	asset, err := e.assets.Upload(ctx, owner, project.ID, assets.UploadOpts{
		Filename: "фото.jpg", ContentType: "image/jpeg", Size: int64(len(source)),
		Reader: bytes.NewReader(source),
	})
	if err != nil {
		t.Fatalf("загрузка: %v", err)
	}
	if asset.Mime != "image/webp" || asset.Filename != "фото.webp" {
		t.Errorf("вложение: %q, %q", asset.Mime, asset.Filename)
	}
	if asset.Kind != "image" {
		t.Errorf("вид вложения: %q", asset.Kind)
	}
	if asset.Size >= int64(len(source)) {
		t.Errorf("размер не уменьшился: было %d, стало %d", len(source), asset.Size)
	}
	t.Logf("фото: %d байт на входе, %d в проекте (%.2fx)", len(source), asset.Size,
		float64(len(source))/float64(asset.Size))
	if asset.Width == nil || asset.Height == nil || *asset.Width != 1200 || *asset.Height != 800 {
		t.Errorf("размеры картинки: %v×%v", asset.Width, asset.Height)
	}

	// В хранилище лежит именно WebP — проверяем содержимое, а не только строку.
	stored := readObject(t, e, asset.S3Key)
	decoded, err := gowebp.Decode(bytes.NewReader(stored))
	if err != nil {
		t.Fatalf("файл в хранилище не читается как webp: %v", err)
	}
	if decoded.Bounds().Dx() != 1200 || decoded.Bounds().Dy() != 800 {
		t.Errorf("размеры файла в хранилище: %v", decoded.Bounds())
	}
}

// Дедупликация после пережатия: одно и то же фото дважды и в разные проекты — один
// файл, а хеш у строк один и тот же (он считается по пережатым байтам).
func TestUploadDedupAfterRecompression(t *testing.T) {
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
	source := testimage.JPEG(t, testimage.Photo(800, 600), 88)

	one, err := e.assets.Upload(ctx, owner, first.ID, assets.UploadOpts{
		Filename: "вид.jpg", ContentType: "image/jpeg", Size: int64(len(source)),
		Reader: bytes.NewReader(source),
	})
	if err != nil {
		t.Fatalf("первая загрузка: %v", err)
	}
	two, err := e.assets.Upload(ctx, owner, second.ID, assets.UploadOpts{
		Filename: "копия.jpg", ContentType: "image/jpeg", Size: int64(len(source)),
		Reader: bytes.NewReader(source),
	})
	if err != nil {
		t.Fatalf("вторая загрузка: %v", err)
	}

	if one.S3Key != two.S3Key {
		t.Errorf("одно и то же фото записано дважды: %q и %q", one.S3Key, two.S3Key)
	}
	if one.ContentHash == nil || two.ContentHash == nil || *one.ContentHash != *two.ContentHash {
		t.Errorf("хеши: %v и %v", one.ContentHash, two.ContentHash)
	}
	if files := e.files(t); len(files) != 1 {
		t.Fatalf("в хранилище %d файлов, ожидался один: %+v", len(files), files)
	}
}

// Импорт папки с md идёт тем же путём: картинка из набора тоже пережимается.
func TestStoreFileRecompressesImages(t *testing.T) {
	e := setup(t)
	ctx := context.Background()
	owner := e.user(t, "owner@example.com")

	project, err := e.proj.Create(ctx, owner, "Импорт с картинкой", "")
	if err != nil {
		t.Fatalf("проект: %v", err)
	}
	source := testimage.JPEG(t, testimage.Photo(1000, 700), 90)

	asset, err := e.assets.StoreFile(ctx, assets.StoreFileOptions{
		ProjectID: project.ID, OwnerID: owner, Filename: "карта.jpg",
		Mime: "image/jpeg", Kind: "image", Data: source,
	})
	if err != nil {
		t.Fatalf("запись из импорта: %v", err)
	}
	if asset.Mime != "image/webp" || asset.Filename != "карта.webp" {
		t.Errorf("вложение из импорта: %q, %q", asset.Mime, asset.Filename)
	}
	if asset.Size >= int64(len(source)) {
		t.Errorf("картинка из импорта не уменьшилась: %d → %d", len(source), asset.Size)
	}
	if _, err := gowebp.Decode(bytes.NewReader(readObject(t, e, asset.S3Key))); err != nil {
		t.Errorf("файл из импорта не читается как webp: %v", err)
	}
}

// То, что пережимать нечего или нельзя, остаётся как было: уже-webp, svg и pdf.
func TestUploadKeepsOtherFilesAsIs(t *testing.T) {
	e := setup(t)
	ctx := context.Background()
	owner := e.user(t, "owner@example.com")

	project, err := e.proj.Create(ctx, owner, "Разные файлы", "")
	if err != nil {
		t.Fatalf("проект: %v", err)
	}
	svg := []byte(`<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><rect width="10" height="10"/></svg>`)
	asset, err := e.assets.Upload(ctx, owner, project.ID, assets.UploadOpts{
		Filename: "значок.svg", ContentType: "image/svg+xml", Size: int64(len(svg)),
		Reader: bytes.NewReader(svg),
	})
	if err != nil {
		t.Fatalf("загрузка svg: %v", err)
	}
	if asset.Mime != "image/svg+xml" || asset.Filename != "значок.svg" || asset.Size != int64(len(svg)) {
		t.Errorf("svg изменён: %+v", asset)
	}
	if asset.Kind != "sketch" {
		t.Errorf("вид svg: %q", asset.Kind)
	}
	if stored := readObject(t, e, asset.S3Key); !bytes.Equal(stored, svg) {
		t.Error("содержимое svg изменилось")
	}
}
