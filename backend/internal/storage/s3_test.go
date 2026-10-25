package storage

// s3_sign_test.go — проверка подписи SigV4 и самого S3Store.
//
// Почему подпись проверяется отдельно, официальным вектором AWS. Ошибка в подписи не
// выглядит как ошибка: сервер отвечает `403 SignatureDoesNotMatch`, и разбираться в этом
// на живом стенде — значит перебирать догадки (регион, порядок заголовков, кодирование).
// Вектор из документации AWS даёт точный ответ: наша канонизация либо даёт ту же подпись,
// либо нет.

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/xml"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"sort"
	"strings"
	"sync"
	"testing"
	"time"
)

// Официальный пример AWS: «GET Object» с Range, регион us-east-1, дата 20130524T000000Z.
// Ожидаемая подпись — из той же документации.
func TestSignV4AWSVector(t *testing.T) {
	req, err := http.NewRequest(http.MethodGet, "https://examplebucket.s3.amazonaws.com/test.txt", nil)
	if err != nil {
		t.Fatalf("запрос: %v", err)
	}
	req.Host = "examplebucket.s3.amazonaws.com"
	req.Header.Set("Range", "bytes=0-9")
	req.Header.Set("x-amz-content-sha256", emptySHA256)

	when := time.Date(2013, 5, 24, 0, 0, 0, 0, time.UTC)
	signV4(req, "AKIAIOSFODNN7EXAMPLE", "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY", "us-east-1", when)

	const want = "f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41"
	auth := req.Header.Get("Authorization")
	if !strings.HasSuffix(auth, "Signature="+want) {
		t.Fatalf("подпись не сошлась с вектором AWS:\nполучено: %s\nожидалось: Signature=%s", auth, want)
	}
	// Заголовки, участвующие в подписи, тоже часть контракта.
	if !strings.Contains(auth, "SignedHeaders=host;range;x-amz-content-sha256;x-amz-date") {
		t.Errorf("состав подписанных заголовков: %s", auth)
	}
	if got := req.Header.Get("x-amz-date"); got != "20130524T000000Z" {
		t.Errorf("x-amz-date: %q", got)
	}
}

// fakeS3 — минимальный S3 на память: ровно те операции, которыми пользуется S3Store.
// Подпись он не проверяет (её проверяет вектор выше), но проверяет, что клиент присылает
// согласованный хеш тела и правильные пути/префиксы.
type fakeS3 struct {
	mu      sync.Mutex
	objects map[string]fakeObject
	gets    int
}

type fakeObject struct {
	data        []byte
	contentType string
	modified    time.Time
}

func newFakeS3() (*fakeS3, *httptest.Server) {
	f := &fakeS3{objects: map[string]fakeObject{}}
	server := httptest.NewServer(http.HandlerFunc(f.handle))
	return f, server
}

func (f *fakeS3) handle(w http.ResponseWriter, r *http.Request) {
	f.mu.Lock()
	defer f.mu.Unlock()

	if auth := r.Header.Get("Authorization"); !strings.HasPrefix(auth, "AWS4-HMAC-SHA256 ") {
		http.Error(w, "missing signature", http.StatusForbidden)
		return
	}
	if r.Header.Get("x-amz-date") == "" {
		http.Error(w, "missing x-amz-date", http.StatusForbidden)
		return
	}

	key := strings.TrimPrefix(r.URL.Path, "/")
	// /bucket — список, /bucket/key — объект.
	if !strings.Contains(key, "/") {
		if r.URL.Query().Get("list-type") != "2" {
			http.Error(w, "unsupported", http.StatusBadRequest)
			return
		}
		f.list(w, key, r.URL.Query().Get("prefix"))
		return
	}
	key = strings.SplitN(key, "/", 2)[1]

	switch r.Method {
	case http.MethodPut:
		data, _ := io.ReadAll(r.Body)
		sum := sha256.Sum256(data)
		if got, want := r.Header.Get("x-amz-content-sha256"), hex.EncodeToString(sum[:]); got != want {
			http.Error(w, "bad content hash", http.StatusBadRequest)
			return
		}
		f.objects[key] = fakeObject{
			data: data, contentType: r.Header.Get("Content-Type"), modified: time.Now().UTC(),
		}
		w.WriteHeader(http.StatusOK)
	case http.MethodGet:
		obj, ok := f.objects[key]
		if !ok {
			http.Error(w, "no such key", http.StatusNotFound)
			return
		}
		f.gets++
		w.Header().Set("Content-Type", obj.contentType)
		w.Header().Set("Content-Length", fmt.Sprint(len(obj.data)))
		w.Write(obj.data)
	case http.MethodHead:
		obj, ok := f.objects[key]
		if !ok {
			w.WriteHeader(http.StatusNotFound)
			return
		}
		w.Header().Set("Content-Type", obj.contentType)
		w.Header().Set("Content-Length", fmt.Sprint(len(obj.data)))
		w.Header().Set("Last-Modified", obj.modified.Format(http.TimeFormat))
		w.WriteHeader(http.StatusOK)
	case http.MethodDelete:
		if _, ok := f.objects[key]; !ok {
			w.WriteHeader(http.StatusNotFound)
			return
		}
		delete(f.objects, key)
		w.WriteHeader(http.StatusNoContent)
	default:
		http.Error(w, "unsupported", http.StatusBadRequest)
	}
}

func (f *fakeS3) list(w http.ResponseWriter, bucket, prefix string) {
	type content struct {
		Key          string    `xml:"Key"`
		Size         int64     `xml:"Size"`
		LastModified time.Time `xml:"LastModified"`
	}
	result := struct {
		XMLName  xml.Name  `xml:"ListBucketResult"`
		Name     string    `xml:"Name"`
		Contents []content `xml:"Contents"`
	}{Name: bucket}
	keys := make([]string, 0, len(f.objects))
	for key := range f.objects {
		if prefix != "" && !strings.HasPrefix(key, prefix) {
			continue
		}
		keys = append(keys, key)
	}
	sort.Strings(keys)
	for _, key := range keys {
		obj := f.objects[key]
		result.Contents = append(result.Contents, content{
			Key: key, Size: int64(len(obj.data)), LastModified: obj.modified,
		})
	}
	w.Header().Set("Content-Type", "application/xml")
	_ = xml.NewEncoder(w).Encode(result)
}

func newTestStore(t *testing.T, prefix string) (*S3Store, *fakeS3) {
	t.Helper()
	fake, server := newFakeS3()
	t.Cleanup(server.Close)
	store, err := NewS3(S3Config{
		Endpoint: server.URL, Bucket: "skyfraze-assets", Prefix: prefix,
		AccessKey: "testkey", SecretKey: "testsecret", Region: "us-east-1",
	})
	if err != nil {
		t.Fatalf("хранилище: %v", err)
	}
	return store, fake
}

// Полный цикл на настоящем HTTP: запись → чтение → размер → список → удаление.
func TestS3StoreRoundTrip(t *testing.T) {
	store, _ := newTestStore(t, "")
	ctx := context.Background()
	key := "0f8fad5b-d9cb-469f-a165-70867728950e/1c0a7d6e.webp"
	body := []byte("картинка проекта")

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
		t.Fatalf("содержимое не совпало: %q", got)
	}
	info, err := store.Stat(ctx, key)
	if err != nil {
		t.Fatalf("stat: %v", err)
	}
	if info.Size != int64(len(body)) || info.ContentType != "image/webp" || info.ModTime.IsZero() {
		t.Fatalf("stat: %+v", info)
	}
	list, err := store.List(ctx, "")
	if err != nil {
		t.Fatalf("list: %v", err)
	}
	if len(list) != 1 || list[0].Key != key || list[0].Size != int64(len(body)) {
		t.Fatalf("list: %+v", list)
	}
	if err := store.Delete(ctx, key); err != nil {
		t.Fatalf("delete: %v", err)
	}
	if _, err := store.Get(ctx, key); err != ErrNotFound {
		t.Fatalf("после удаления ожидался ErrNotFound, получено %v", err)
	}
}

// Отсутствующий объект — ErrNotFound, а не «сломалось»: на этом различии стоит отдача
// файлов (404 против 500).
func TestS3StoreMissingIsNotFound(t *testing.T) {
	store, _ := newTestStore(t, "")
	ctx := context.Background()
	if _, err := store.Get(ctx, "нет/такого.webp"); err != ErrNotFound {
		t.Fatalf("get: %v", err)
	}
	if _, err := store.Stat(ctx, "нет/такого.webp"); err != ErrNotFound {
		t.Fatalf("stat: %v", err)
	}
	// Удаление отсутствующего — не ошибка: уборщик удаляет то, что могло исчезнуть.
	if err := store.Delete(ctx, "нет/такого.webp"); err != nil {
		t.Fatalf("delete отсутствующего: %v", err)
	}
}

// Префикс стенда: ключи в бакете отдельные, список — только свои, а вызывающий видит
// ключи без префикса (те же, что в базе).
func TestS3StorePrefixIsolation(t *testing.T) {
	store, fake := newTestStore(t, "stand")
	ctx := context.Background()

	if err := store.Put(ctx, "proj/a.webp", "image/webp", strings.NewReader("свой"), int64(len("свой"))); err != nil {
		t.Fatalf("put: %v", err)
	}
	// Чужой объект того же бакета (другой стенд, ручная выгрузка).
	fake.objects["other/proj/b.webp"] = fakeObject{data: []byte("чужой"), modified: time.Now().UTC()}

	list, err := store.List(ctx, "")
	if err != nil {
		t.Fatalf("list: %v", err)
	}
	if len(list) != 1 || list[0].Key != "proj/a.webp" {
		t.Fatalf("в список попало чужое: %+v", list)
	}
	if _, ok := fake.objects["stand/proj/a.webp"]; !ok {
		t.Fatalf("ключ записан без префикса: %v", fake.objects)
	}
}

// Ошибка сервера не маскируется под «нет файла»: иначе сбой хранилища выглядел бы как
// удалённый файл, и его тихо перезаписали бы пустотой.
func TestS3StoreServerErrorIsNotNotFound(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Error(w, "boom", http.StatusInternalServerError)
	}))
	defer server.Close()
	store, err := NewS3(S3Config{
		Endpoint: server.URL, Bucket: "b", AccessKey: "k", SecretKey: "s",
	})
	if err != nil {
		t.Fatalf("хранилище: %v", err)
	}
	if _, err := store.Get(context.Background(), "proj/a.webp"); err == nil || err == ErrNotFound {
		t.Fatalf("ожидалась ошибка хранилища, получено %v", err)
	}
}

// Настройки наполовину — ошибка на старте, а не на первой загрузке файла.
func TestNewS3ValidatesConfig(t *testing.T) {
	cases := map[string]S3Config{
		"без endpoint": {Bucket: "b", AccessKey: "k", SecretKey: "s"},
		"без бакета":   {Endpoint: "http://localhost:9000", AccessKey: "k", SecretKey: "s"},
		"без ключей":   {Endpoint: "http://localhost:9000", Bucket: "b"},
	}
	for name, cfg := range cases {
		if _, err := NewS3(cfg); err == nil {
			t.Errorf("%s: ожидалась ошибка настроек", name)
		}
	}
	// Endpoint без схемы достраивается: http по умолчанию, https при UseSSL.
	store, err := NewS3(S3Config{Endpoint: "minio.example.com", UseSSL: true, Bucket: "b", AccessKey: "k", SecretKey: "s"})
	if err != nil {
		t.Fatalf("endpoint без схемы: %v", err)
	}
	if store.endpoint.Scheme != "https" {
		t.Errorf("схема: %q", store.endpoint.Scheme)
	}
}
