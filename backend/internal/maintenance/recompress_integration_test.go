package maintenance_test

// recompress_integration_test.go — пережатие УЖЕ загруженных картинок через
// ручку админки (docs/storage-compression.md, шаг 2b).
//
// Загрузка пережимает картинки с самого начала, но всё, что лежало в хранилище
// раньше, осталось в исходном весе: отсюда отдельный проход. Здесь проверяем его
// обещания на настоящей базе и настоящем каталоге:
//
//	сухой прогон считает выигрыш и НИЧЕГО не пишет (по нему решают, запускать ли);
//	apply переписывает файл, и строки — в том числе чужие, делившие файл по
//	  дедупликации — начинают ссылаться на новый;
//	повторный запуск не находит, что пережать (идемпотентность);
//	без подключённого пережимателя ручка честно отвечает 503, а не пустым отчётом.
//
// Нужна Postgres (TEST_DATABASE_URL), как и остальным интеграционным тестам.

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/google/uuid"

	"github.com/skyfraze/backend/internal/assets"
	"github.com/skyfraze/backend/internal/maintenance"
	"github.com/skyfraze/backend/internal/platform/testimage"
	"github.com/skyfraze/backend/internal/store"
)

// legacyAsset кладёт картинку в хранилище «как раньше»: файл под ключом проекта,
// строка `assets` с исходными mime и размером, без content_hash. Дедупликация и
// пережатие появились позже, поэтому и фикстура должна выглядеть так же — иначе
// проверялся бы уже пережатый файл.
func (e *env) legacyAsset(t *testing.T, owner, projectID uuid.UUID, filename, mime string, data []byte) *store.Asset {
	t.Helper()
	key := assets.ObjectKey(projectID, filename)
	if err := e.obj.Put(context.Background(), key, mime, bytes.NewReader(data), int64(len(data))); err != nil {
		t.Fatalf("файл %s: %v", key, err)
	}
	row := &store.Asset{
		ProjectID: projectID,
		OwnerID:   owner,
		Filename:  filename,
		Mime:      mime,
		Size:      int64(len(data)),
		S3Key:     key,
		Kind:      assets.KindOf(mime, filename),
	}
	if err := e.st.CreateAsset(context.Background(), row); err != nil {
		t.Fatalf("строка вложения %s: %v", filename, err)
	}
	return row
}

// storeHas — есть ли файл в хранилище под таким ключом.
func storeHas(t *testing.T, e *env, key string) bool {
	t.Helper()
	for _, existing := range e.keys(t) {
		if existing == key {
			return true
		}
	}
	return false
}

func TestRecompressStoredDryRunThenApply(t *testing.T) {
	e := setup(t)
	ctx := context.Background()
	owner := e.user(t, "owner@example.com")

	first, err := e.proj.Create(ctx, owner, "Проект с фото", "")
	if err != nil {
		t.Fatalf("проект: %v", err)
	}
	second, err := e.proj.Create(ctx, owner, "Проект с тем же фото", "")
	if err != nil {
		t.Fatalf("второй проект: %v", err)
	}

	photo := testimage.JPEG(t, testimage.Photo(1200, 800), 92)
	kept := e.legacyAsset(t, owner, first.ID, "фото.jpg", "image/jpeg", photo)
	// Второй проект ссылается на ТОТ ЖЕ файл — так выглядит дедупликация: у строк
	// разные проекты, а ключ один. Пережатие обязано перевести обе строки.
	shared := &store.Asset{
		ProjectID: second.ID, OwnerID: owner, Filename: "копия.jpg", Mime: "image/jpeg",
		Size: int64(len(photo)), S3Key: kept.S3Key, Kind: assets.KindOf("image/jpeg", "копия.jpg"),
	}
	if err := e.st.CreateAsset(ctx, shared); err != nil {
		t.Fatalf("общая строка: %v", err)
	}

	sweeper := maintenance.New(e.st, e.obj, testLogger(t), maintenance.Options{})
	sweeper.UseRecompressor(e.assets)

	// Сухой прогон: выигрыш посчитан, файл и строки не тронуты.
	dry := postRecompress(t, sweeper, "")
	if dry.Files != 1 || dry.Images != 1 || dry.Changed != 1 || dry.Applied {
		t.Fatalf("сухой прогон: %+v", dry)
	}
	if dry.BytesTo >= dry.BytesFrom || dry.BytesFrom != int64(len(photo)) {
		t.Errorf("сухой прогон: %d → %d байт (ожидалось меньше %d)", dry.BytesFrom, dry.BytesTo, len(photo))
	}
	if !storeHas(t, e, kept.S3Key) {
		t.Fatalf("сухой прогон удалил исходный файл")
	}
	if row, err := e.st.GetAsset(ctx, kept.ID); err != nil || row.Mime != "image/jpeg" {
		t.Fatalf("сухой прогон изменил строку: %+v (%v)", row, err)
	}

	// Применение: файл переписан, обе строки смотрят на webp.
	applied := postRecompress(t, sweeper, "?apply=1")
	if applied.Files != 1 || applied.Changed != 1 || !applied.Applied {
		t.Fatalf("применение: %+v", applied)
	}
	if applied.BytesTo >= applied.BytesFrom {
		t.Errorf("применение: %d → %d байт", applied.BytesFrom, applied.BytesTo)
	}
	if storeHas(t, e, kept.S3Key) {
		t.Errorf("старый файл остался в хранилище: %v", e.keys(t))
	}
	if len(e.keys(t)) != 1 {
		t.Errorf("файлов в хранилище %d, ожидался один: %v", len(e.keys(t)), e.keys(t))
	}
	for _, id := range []uuid.UUID{kept.ID, shared.ID} {
		row, err := e.st.GetAsset(ctx, id)
		if err != nil {
			t.Fatalf("строка %s: %v", id, err)
		}
		if row.Mime != "image/webp" || !strings.HasSuffix(row.Filename, ".webp") {
			t.Errorf("строка %s: %s / %s", id, row.Mime, row.Filename)
		}
		if row.S3Key == kept.S3Key {
			t.Errorf("строка %s всё ещё ссылается на старый ключ", id)
		}
		if row.ContentHash == nil || *row.ContentHash == "" {
			t.Errorf("строка %s: не записан content_hash", id)
		}
		if row.Size >= int64(len(photo)) {
			t.Errorf("строка %s: размер %d не уменьшился", id, row.Size)
		}
	}
	// Новый файл действительно открывается как вложение и содержит webp: мало ли
	// что записано в строке — отдавать браузеру нужно работающий файл.
	row, err := e.st.GetAsset(ctx, kept.ID)
	if err != nil {
		t.Fatalf("строка: %v", err)
	}
	if !storeHas(t, e, row.S3Key) {
		t.Fatalf("нового файла нет в хранилище: %v", e.keys(t))
	}
	stored, served, err := e.assets.Open(ctx, owner, kept.ID)
	if err != nil {
		t.Fatalf("чтение вложения: %v", err)
	}
	defer stored.Close()
	if served.Mime != "image/webp" {
		t.Errorf("вложение отдаётся как %s", served.Mime)
	}
	body, err := io.ReadAll(stored)
	if err != nil {
		t.Fatalf("чтение тела вложения: %v", err)
	}
	if len(body) != int(row.Size) {
		t.Errorf("размер файла %d, в строке %d", len(body), row.Size)
	}
	if !bytes.HasPrefix(body, []byte("RIFF")) || !bytes.Contains(body[:min(16, len(body))], []byte("WEBP")) {
		t.Errorf("файл не похож на webp: % x", body[:min(16, len(body))])
	}

	// Повторный запуск: пережимать больше нечего — и это не ошибка. Картинок
	// подходящего типа не осталось вовсе (в хранилище webp), поэтому Images=0.
	again := postRecompress(t, sweeper, "?apply=1")
	if again.Files != 1 || again.Images != 0 || again.Changed != 0 || again.Skipped != 0 ||
		again.Damaged != 0 || again.Failed != 0 {
		t.Errorf("повторный запуск: %+v", again)
	}
}

// Битый файл и не-картинка не должны попадать в одно число с «пережатие не
// выиграло»: по отчёту решают, запускать ли проход, и «258 пропущено» на битых
// PNG читалось бы как «WebP не сжимает PNG».
func TestRecompressStoredClassifiesDamaged(t *testing.T) {
	e := setup(t)
	ctx := context.Background()
	owner := e.user(t, "owner@example.com")

	project, err := e.proj.Create(ctx, owner, "Проект с мусором", "")
	if err != nil {
		t.Fatalf("проект: %v", err)
	}
	broken := e.legacyAsset(t, owner, project.ID, "битый.png", "image/png", []byte("это не png, а текст"))
	// SVG — картинка для человека, но не растр: пережимать нечего, и в «картинки»
	// она попадать не должна.
	svg := e.legacyAsset(t, owner, project.ID, "схема.svg", "image/svg+xml",
		[]byte(`<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"/>`))

	sweeper := maintenance.New(e.st, e.obj, testLogger(t), maintenance.Options{})
	sweeper.UseRecompressor(e.assets)

	report := postRecompress(t, sweeper, "?apply=1")
	if report.Files != 2 || report.Images != 1 {
		t.Fatalf("просмотрено: %+v", report)
	}
	if report.Damaged != 1 || report.Changed != 0 || report.Skipped != 0 || report.Failed != 0 {
		t.Errorf("разбор битого файла: %+v", report)
	}
	if len(report.DamagedExamples) != 1 || report.DamagedExamples[0] != broken.S3Key {
		t.Errorf("примеры битых: %v (ожидался %s)", report.DamagedExamples, broken.S3Key)
	}
	for _, row := range []*store.Asset{broken, svg} {
		current, err := e.st.GetAsset(ctx, row.ID)
		if err != nil {
			t.Fatalf("строка %s: %v", row.ID, err)
		}
		if current.S3Key != row.S3Key || current.Mime != row.Mime {
			t.Errorf("строка %s изменена: %s / %s", row.ID, current.Mime, current.S3Key)
		}
	}
	if len(e.keys(t)) != 2 {
		t.Errorf("хранилище после прохода: %v", e.keys(t))
	}
}

// Ручка без подключённого пережимателя не должна делать вид, что всё хорошо:
// «пережато 0» читалось бы как «пережимать нечего».
func TestRecompressStorageWithoutRecompressor(t *testing.T) {
	e := setup(t)
	sweeper := maintenance.New(e.st, e.obj, testLogger(t), maintenance.Options{})
	rec := httptest.NewRecorder()
	sweeper.RecompressStorage(rec, httptest.NewRequest(http.MethodPost, "/api/admin/storage/recompress", nil))
	if rec.Code != http.StatusServiceUnavailable {
		t.Fatalf("код %d, тело %s", rec.Code, rec.Body.String())
	}
}

// postRecompress дёргает ручку админки так же, как это делает роутер: телом
// ответа интересуется отчёт, а не код (код проверяет вызывающий тест).
func postRecompress(t *testing.T, sweeper *maintenance.Sweeper, query string) *assets.RecompressReport {
	t.Helper()
	rec := httptest.NewRecorder()
	sweeper.RecompressStorage(rec, httptest.NewRequest(http.MethodPost, "/api/admin/storage/recompress"+query, nil))
	if rec.Code != http.StatusOK {
		t.Fatalf("пережатие: код %d, тело %s", rec.Code, rec.Body.String())
	}
	var report assets.RecompressReport
	if err := json.Unmarshal(rec.Body.Bytes(), &report); err != nil {
		t.Fatalf("json пережатия: %v (%s)", err, rec.Body.String())
	}
	return &report
}
