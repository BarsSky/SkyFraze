package storage_test

// conformance_test.go — один набор проверок для ВСЕХ реализаций ObjectStore.
//
// Зачем отдельный набор, а если хватает тестов на каждую реализацию. Потому что реализаций
// две (`LocalStore` и `S3Store`), и они обязаны вести себя одинаково: сервисы вложений,
// уборка и пережатие ходят через интерфейс и о том, где лежат байты, не знают. Пока каждая
// реализация проверялась своими тестами, «одинаково» держалось на памяти автора: например,
// `Walk` на S3 обрезает префикс стенда, а на диске — нет, и это заметил бы не тест, а уборка,
// начавшая считать ключи чужими.
//
// Поэтому здесь описан КОНТРАКТ, и он прогоняется по обеим реализациям:
//
//	RunConformance(t, localStore)   — всегда;
//	RunConformance(t, s3Store)      — когда есть настоящий S3/MinIO (в CI есть всегда).
//
// Настоящий сервер, а не поддельный HTTP: поддельный проверяет, что клиент послал то, что мы
// думаем, и ничего не говорит о том, принимает ли это S3. Расхождение вылезает в мелочах —
// кодирование юникода в ключе, `Content-Type` без charset, `Last-Modified` с точностью до
// секунды, `404` против `NoSuchKey`, обрезка префикса при листинге.

import (
	"bytes"
	"context"
	"crypto/rand"
	"errors"
	"io"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"

	"github.com/skyfraze/backend/internal/storage"
)

// storeFactory — «чистое хранилище для одного теста».
type storeFactory func(t *testing.T) storage.ObjectStore

// RunConformance прогоняет контракт по одной реализации. Каждый подтест получает своё
// чистое хранилище: иначе удаление в одном подтесте меняло бы список в другом.
func RunConformance(t *testing.T, newStore storeFactory) {
	t.Helper()

	t.Run("запись-чтение", func(t *testing.T) {
		store, ctx := newStore(t), context.Background()
		body := []byte("картинка проекта: ёжик, «кавычки», эмодзи 🦔")
		if err := store.Put(ctx, "proj/a.webp", "image/webp", bytes.NewReader(body), int64(len(body))); err != nil {
			t.Fatalf("put: %v", err)
		}
		reader, err := store.Get(ctx, "proj/a.webp")
		if err != nil {
			t.Fatalf("get: %v", err)
		}
		got, readErr := io.ReadAll(reader)
		reader.Close()
		if readErr != nil {
			t.Fatalf("чтение тела: %v", readErr)
		}
		if !bytes.Equal(got, body) {
			t.Fatalf("содержимое не совпало: получено %q, записано %q", got, body)
		}
	})

	// Файлы по 100 КБ — не «проверка скорости», а проверка того, что тело не обрезается
	// на буфере: S3Store сначала пишет во временный файл и шлёт его потоком, и ошибка там
	// видна только на содержимом больше одного чтения.
	t.Run("двоичное-тело-целиком", func(t *testing.T) {
		store, ctx := newStore(t), context.Background()
		body := make([]byte, 100*1024)
		if _, err := rand.Read(body); err != nil {
			t.Fatalf("случайные байты: %v", err)
		}
		if err := store.Put(ctx, "proj/big.bin", "application/octet-stream", bytes.NewReader(body), int64(len(body))); err != nil {
			t.Fatalf("put: %v", err)
		}
		reader, err := store.Get(ctx, "proj/big.bin")
		if err != nil {
			t.Fatalf("get: %v", err)
		}
		got, _ := io.ReadAll(reader)
		reader.Close()
		if !bytes.Equal(got, body) {
			t.Fatalf("двоичное тело искажено: %d байт из %d", len(got), len(body))
		}
	})

	t.Run("размер-и-тип-содержимого", func(t *testing.T) {
		store, ctx := newStore(t), context.Background()
		body := []byte("0123456789")
		if err := store.Put(ctx, "proj/c.webp", "image/webp", bytes.NewReader(body), int64(len(body))); err != nil {
			t.Fatalf("put: %v", err)
		}
		info, err := store.Stat(ctx, "proj/c.webp")
		if err != nil {
			t.Fatalf("stat: %v", err)
		}
		if info.Key != "proj/c.webp" {
			t.Errorf("ключ в Stat: %q", info.Key)
		}
		if info.Size != int64(len(body)) {
			t.Errorf("размер: %d, ожидался %d", info.Size, len(body))
		}
		if info.ModTime.IsZero() {
			t.Error("время объекта не заполнено")
		} else if diff := time.Since(info.ModTime); diff > 5*time.Minute || diff < -5*time.Minute {
			t.Errorf("время объекта не похоже на «сейчас»: %s", info.ModTime)
		}
		// Content-Type обязан пережить запись там, где реализация его хранит. LocalStore его
		// не хранит (тип живёт в `assets.mime`), и это записано в контракте, а не забыто:
		// пустая строка допустима, а вот чужая — нет.
		if info.ContentType != "" && !strings.HasPrefix(info.ContentType, "image/webp") {
			t.Errorf("content-type: %q", info.ContentType)
		}
	})

	// Перезапись тем же ключом — обычное дело: пережатие картинок пишет файл повторно.
	t.Run("перезапись-заменяет-содержимое", func(t *testing.T) {
		store, ctx := newStore(t), context.Background()
		long := []byte("длинное содержимое первого варианта файла")
		if err := store.Put(ctx, "proj/d.webp", "image/webp", bytes.NewReader(long), int64(len(long))); err != nil {
			t.Fatalf("первый put: %v", err)
		}
		short := []byte("коротко")
		if err := store.Put(ctx, "proj/d.webp", "image/webp", bytes.NewReader(short), int64(len(short))); err != nil {
			t.Fatalf("второй put: %v", err)
		}
		info, err := store.Stat(ctx, "proj/d.webp")
		if err != nil {
			t.Fatalf("stat: %v", err)
		}
		if info.Size != int64(len(short)) {
			t.Errorf("после перезаписи размер %d, ожидался %d (файл не обрезан?)", info.Size, len(short))
		}
		reader, err := store.Get(ctx, "proj/d.webp")
		if err != nil {
			t.Fatalf("get: %v", err)
		}
		got, _ := io.ReadAll(reader)
		reader.Close()
		if !bytes.Equal(got, short) {
			t.Errorf("после перезаписи содержимое %q", got)
		}
	})

	// Отсутствующий ключ — это ErrNotFound, а не «сломалось»: на этом различии держится
	// отдача файлов (404 против 500) и решение уборки «файл уже удалён, не трогать».
	t.Run("отсутствующий-это-ErrNotFound", func(t *testing.T) {
		store, ctx := newStore(t), context.Background()
		if _, err := store.Get(ctx, "proj/нет.webp"); !errors.Is(err, storage.ErrNotFound) {
			t.Errorf("get: %v, ожидался ErrNotFound", err)
		}
		if _, err := store.Stat(ctx, "proj/нет.webp"); !errors.Is(err, storage.ErrNotFound) {
			t.Errorf("stat: %v, ожидался ErrNotFound", err)
		}
		// Удаление отсутствующего — не ошибка: уборщик удаляет то, что могло исчезнуть
		// между обходом и удалением.
		if err := store.Delete(ctx, "proj/нет.webp"); err != nil {
			t.Errorf("delete отсутствующего: %v", err)
		}
	})

	t.Run("удаление-убирает-из-списка", func(t *testing.T) {
		store, ctx := newStore(t), context.Background()
		body := []byte("удали меня")
		if err := store.Put(ctx, "proj/e.webp", "image/webp", bytes.NewReader(body), int64(len(body))); err != nil {
			t.Fatalf("put: %v", err)
		}
		if err := store.Delete(ctx, "proj/e.webp"); err != nil {
			t.Fatalf("delete: %v", err)
		}
		if _, err := store.Get(ctx, "proj/e.webp"); !errors.Is(err, storage.ErrNotFound) {
			t.Errorf("после удаления get: %v", err)
		}
		list, err := store.List(ctx, "proj/")
		if err != nil {
			t.Fatalf("list: %v", err)
		}
		if len(list) != 0 {
			t.Errorf("после удаления в списке %+v", list)
		}
	})

	// Список и обход — одна и та же правда, два способа её получить.
	t.Run("список-и-обход-совпадают", func(t *testing.T) {
		store, ctx := newStore(t), context.Background()
		want := map[string]int64{
			"p1/a.webp":        6,
			"p1/b.webp":        6,
			"p2/nested/c.webp": 7,
		}
		for key, size := range want {
			body := []byte(strings.Repeat("x", int(size)))
			if err := store.Put(ctx, key, "image/webp", bytes.NewReader(body), size); err != nil {
				t.Fatalf("put %s: %v", key, err)
			}
		}
		list, err := store.List(ctx, "")
		if err != nil {
			t.Fatalf("list: %v", err)
		}
		if len(list) != len(want) {
			t.Fatalf("list: %+v", list)
		}
		for _, info := range list {
			size, ok := want[info.Key]
			if !ok {
				t.Errorf("в списке чужой ключ: %q", info.Key)
				continue
			}
			if info.Size != size {
				t.Errorf("%s: размер %d, ожидался %d", info.Key, info.Size, size)
			}
		}
		walked := map[string]int64{}
		if err := store.Walk(ctx, "", func(info storage.ObjectInfo) error {
			walked[info.Key] = info.Size
			return nil
		}); err != nil {
			t.Fatalf("walk: %v", err)
		}
		if len(walked) != len(want) {
			t.Fatalf("walk: %+v", walked)
		}
		for key, size := range want {
			if walked[key] != size {
				t.Errorf("walk: %s → %d, ожидалось %d", key, walked[key], size)
			}
		}
	})

	// Префикс — это граница, а не подсказка: «p1/» не должен приносить «p1x/…», иначе
	// уборка одного проекта считала бы чужие файлы своими.
	t.Run("префикс-не-пересекает-границу", func(t *testing.T) {
		store, ctx := newStore(t), context.Background()
		for _, key := range []string{"p1/a.webp", "p1x/b.webp", "p2/c.webp"} {
			if err := store.Put(ctx, key, "image/webp", strings.NewReader("x"), 1); err != nil {
				t.Fatalf("put %s: %v", key, err)
			}
		}
		list, err := store.List(ctx, "p1/")
		if err != nil {
			t.Fatalf("list: %v", err)
		}
		if len(list) != 1 || list[0].Key != "p1/a.webp" {
			t.Fatalf("по префиксу p1/: %+v", list)
		}
		// Префикс, которого нет, — пусто и без ошибки: файлов с таким префиксом не бывает.
		if list, err := store.List(ctx, "нет-такого/"); err != nil || len(list) != 0 {
			t.Fatalf("несуществующий префикс: %+v, %v", list, err)
		}
	})

	// Пустое хранилище — законное состояние, а не ошибка: новый стенд стартует именно так,
	// и уборка на нём не должна падать.
	t.Run("пустое-хранилище", func(t *testing.T) {
		store, ctx := newStore(t), context.Background()
		list, err := store.List(ctx, "")
		if err != nil {
			t.Fatalf("list пустого: %v", err)
		}
		if len(list) != 0 {
			t.Fatalf("в пустом хранилище что-то есть: %+v", list)
		}
		count := 0
		if err := store.Walk(ctx, "", func(storage.ObjectInfo) error {
			count++
			return nil
		}); err != nil {
			t.Fatalf("walk пустого: %v", err)
		}
		if count != 0 {
			t.Fatalf("обход пустого хранилища отдал %d объектов", count)
		}
		if _, err := store.Stat(ctx, "proj/нет.webp"); !errors.Is(err, storage.ErrNotFound) {
			t.Errorf("stat в пустом: %v", err)
		}
	})

	// Юникод в ключе: кадры и проекты называются по-русски, и ключ вида
	// «проект/кадр 1.webp» не должен теряться в кодировании пути.
	t.Run("юникод-в-ключе", func(t *testing.T) {
		store, ctx := newStore(t), context.Background()
		key := "проект-ёж/кадр 1 — начало.webp"
		body := []byte("тело")
		if err := store.Put(ctx, key, "image/webp", bytes.NewReader(body), int64(len(body))); err != nil {
			t.Fatalf("put: %v", err)
		}
		reader, err := store.Get(ctx, key)
		if err != nil {
			t.Fatalf("get: %v", err)
		}
		got, _ := io.ReadAll(reader)
		reader.Close()
		if !bytes.Equal(got, body) {
			t.Errorf("содержимое: %q", got)
		}
		info, err := store.Stat(ctx, key)
		if err != nil {
			t.Fatalf("stat: %v", err)
		}
		if info.Size != int64(len(body)) {
			t.Errorf("размер: %d", info.Size)
		}
		if err := store.Delete(ctx, key); err != nil {
			t.Fatalf("delete: %v", err)
		}
	})

	// Ошибка из колбэка останавливает обход и возвращается вызывающему: уборка полагается
	// на это, прекращая проход при сбое базы, а не «досматривая» остаток вслепую.
	t.Run("обход-останавливается-ошибкой", func(t *testing.T) {
		store, ctx := newStore(t), context.Background()
		for _, key := range []string{"stop/a.webp", "stop/b.webp", "stop/c.webp"} {
			if err := store.Put(ctx, key, "image/webp", strings.NewReader("x"), 1); err != nil {
				t.Fatalf("put %s: %v", key, err)
			}
		}
		stop := errors.New("хватит")
		seen := 0
		err := store.Walk(ctx, "stop/", func(storage.ObjectInfo) error {
			seen++
			return stop
		})
		if !errors.Is(err, stop) {
			t.Fatalf("ожидалась ошибка колбэка, получено %v", err)
		}
		if seen != 1 {
			t.Errorf("после ошибки обработано объектов: %d", seen)
		}
	})

	// Ключи с выходом из каталога отвергаются на входе: «../» не должен попадать ни в
	// файловую систему, ни в путь бакета.
	t.Run("недопустимый-ключ", func(t *testing.T) {
		store, ctx := newStore(t), context.Background()
		for _, key := range []string{"", "../вне", "/абсолютный", "a/../../b"} {
			if err := store.Put(ctx, key, "text/plain", strings.NewReader("x"), 1); err == nil {
				t.Errorf("put %q принят, а не отвергнут", key)
			}
		}
	})
}

// localStoreFactory — LocalStore в свежем временном каталоге.
func localStoreFactory(t *testing.T) storage.ObjectStore {
	t.Helper()
	store, err := storage.NewLocal(t.TempDir())
	if err != nil {
		t.Fatalf("локальное хранилище: %v", err)
	}
	return store
}

// TestLocalStoreConformance — контракт на файловой системе. Выполняется всегда.
func TestLocalStoreConformance(t *testing.T) {
	RunConformance(t, localStoreFactory)
}

// TestS3StoreConformance — тот же контракт на НАСТОЯЩЕМ S3/MinIO.
//
// Стенд задаётся окружением:
//
//	S3_TEST_ENDPOINT=http://127.0.0.1:9000
//	S3_TEST_ACCESS_KEY=…
//	S3_TEST_SECRET_KEY=…
//	S3_TEST_BUCKET=skyfraze-conformance     # бакет должен существовать
//
// Не задан endpoint — подтест пропускается: локально MinIO есть не у всех, а «зелёный
// прогон, в котором ничего не проверили» хуже пропуска, поэтому в CI эту проверку запускает
// отдельный job, где MinIO поднят, и пропустить её там нельзя (см. .github/workflows/ci.yml).
func TestS3StoreConformance(t *testing.T) {
	endpoint := strings.TrimSpace(os.Getenv("S3_TEST_ENDPOINT"))
	if endpoint == "" {
		t.Skip("S3_TEST_ENDPOINT не задан: набор против настоящего S3/MinIO не запускался")
	}
	bucket := strings.TrimSpace(os.Getenv("S3_TEST_BUCKET"))
	if bucket == "" {
		bucket = "skyfraze-conformance"
	}
	accessKey := os.Getenv("S3_TEST_ACCESS_KEY")
	secretKey := os.Getenv("S3_TEST_SECRET_KEY")
	region := strings.TrimSpace(os.Getenv("S3_TEST_REGION"))

	RunConformance(t, func(t *testing.T) storage.ObjectStore {
		t.Helper()
		// Свой префикс на каждый подтест: подтесты идут параллельно внутри одного бакета,
		// и общий префикс означал бы «список одного теста — это файлы другого». Заодно
		// проверяется, что префикс стенда одинаково работает на запись и на чтение.
		prefix := "conf-" + uuid.NewString()[:8]
		store, err := storage.NewS3(storage.S3Config{
			Endpoint: endpoint, Bucket: bucket, Prefix: prefix, Region: region,
			AccessKey: accessKey, SecretKey: secretKey,
		})
		if err != nil {
			t.Fatalf("S3: %v", err)
		}
		t.Cleanup(func() {
			// За собой убираем: бакет общий с другими запусками, а мусор в нём однажды
			// станет «осиротевшими файлами» в отчёте о хранилище.
			cleanupPrefix(t, store, prefix)
		})
		return store
	})
}

// cleanupPrefix удаляет всё, что осталось под префиксом теста.
func cleanupPrefix(t *testing.T, store storage.ObjectStore, prefix string) {
	t.Helper()
	ctx := context.Background()
	var keys []string
	if err := store.Walk(ctx, "", func(info storage.ObjectInfo) error {
		keys = append(keys, info.Key)
		return nil
	}); err != nil {
		t.Logf("уборка после теста (%s): обход не удался: %v", prefix, err)
		return
	}
	for _, key := range keys {
		if err := store.Delete(ctx, key); err != nil {
			t.Logf("уборка после теста (%s): %s: %v", prefix, key, err)
		}
	}
}
