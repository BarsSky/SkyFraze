package storage_test

// walk_test.go — потоковый обход хранилища.
//
// Зачем отдельные тесты. Walk — не «удобная обёртка над List»: он нужен, чтобы уборка не
// собирала в память список всех объектов бакета. Поэтому проверяется не только «всё нашлось»,
// но и то, что (а) обход можно остановить ошибкой из колбэка, (б) префикс не выводит за
// пределы каталога, (в) у S3 страницы действительно запрашиваются по одной.

import (
	"context"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"sort"
	"strings"
	"sync"
	"testing"

	"github.com/skyfraze/backend/internal/storage"
)

// localStore собирает хранилище на диске с тремя файлами в двух «проектах».
func localStore(t *testing.T) *storage.LocalStore {
	t.Helper()
	store, err := storage.NewLocal(t.TempDir())
	if err != nil {
		t.Fatalf("хранилище: %v", err)
	}
	ctx := context.Background()
	for key, body := range map[string]string{
		"p1/a.webp":       "первый",
		"p1/b.webp":       "второй",
		"p2/nested/c.webp": "третий",
	} {
		if err := store.Put(ctx, key, "image/webp", strings.NewReader(body), int64(len(body))); err != nil {
			t.Fatalf("put %s: %v", key, err)
		}
	}
	return store
}

func TestLocalWalkYieldsAllKeys(t *testing.T) {
	store := localStore(t)
	var keys []string
	if err := store.Walk(context.Background(), "", func(info storage.ObjectInfo) error {
		keys = append(keys, info.Key)
		if info.Size == 0 || info.ModTime.IsZero() {
			t.Errorf("объект без размера или времени: %+v", info)
		}
		return nil
	}); err != nil {
		t.Fatalf("обход: %v", err)
	}
	sort.Strings(keys)
	want := []string{"p1/a.webp", "p1/b.webp", "p2/nested/c.webp"}
	if strings.Join(keys, ",") != strings.Join(want, ",") {
		t.Fatalf("ключи: %v", keys)
	}
}

func TestLocalWalkAppliesPrefix(t *testing.T) {
	store := localStore(t)
	var keys []string
	if err := store.Walk(context.Background(), "p1/", func(info storage.ObjectInfo) error {
		keys = append(keys, info.Key)
		return nil
	}); err != nil {
		t.Fatalf("обход: %v", err)
	}
	if len(keys) != 2 {
		t.Fatalf("по префиксу p1/ ожидалось 2 объекта, получено %v", keys)
	}
	// Префикс с выходом из каталога — ошибка, а не обход всего хранилища.
	if err := store.Walk(context.Background(), "../", func(storage.ObjectInfo) error { return nil }); err == nil {
		t.Fatal("обход с «../» должен быть отвергнут")
	}
	// Несуществующий префикс — пусто и без ошибки (файлов просто нет).
	count := 0
	if err := store.Walk(context.Background(), "нет-такого/", func(storage.ObjectInfo) error {
		count++
		return nil
	}); err != nil {
		t.Fatalf("несуществующий префикс: %v", err)
	}
	if count != 0 {
		t.Fatalf("в несуществующем префиксе что-то нашлось: %d", count)
	}
}

func TestLocalWalkStopsOnCallbackError(t *testing.T) {
	store := localStore(t)
	stop := errors.New("хватит")
	seen := 0
	err := store.Walk(context.Background(), "", func(storage.ObjectInfo) error {
		seen++
		return stop
	})
	if !errors.Is(err, stop) {
		t.Fatalf("ошибка колбэка должна вернуться, получено %v", err)
	}
	if seen != 1 {
		t.Fatalf("после ошибки обход должен остановиться, обработано %d", seen)
	}
}

// s3WalkServer — поддельный S3, который отдаёт объекты СТРАНИЦАМИ и записывает, сколько
// раз запрашивали продолжение. Так проверяется, что Walk не «сложил всё в память, а потом
// отдал», а именно идёт по страницам.
func s3WalkServer(t *testing.T, objects []string, pageSize int) (*httptest.Server, *[]string) {
	t.Helper()
	var mu sync.Mutex
	tokens := []string{}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") == "" {
			http.Error(w, "missing signature", http.StatusForbidden)
			return
		}
		if r.URL.Query().Get("list-type") != "2" {
			http.Error(w, "unsupported", http.StatusBadRequest)
			return
		}
		mu.Lock()
		tokens = append(tokens, r.URL.Query().Get("continuation-token"))
		mu.Unlock()

		start := 0
		if token := r.URL.Query().Get("continuation-token"); token != "" {
			fmt.Sscanf(token, "offset-%d", &start)
		}
		end := start + pageSize
		if end > len(objects) {
			end = len(objects)
		}
		var b strings.Builder
		b.WriteString(`<?xml version="1.0" encoding="UTF-8"?><ListBucketResult>`)
		if end < len(objects) {
			b.WriteString("<IsTruncated>true</IsTruncated>")
			fmt.Fprintf(&b, "<NextContinuationToken>offset-%d</NextContinuationToken>", end)
		}
		for _, key := range objects[start:end] {
			fmt.Fprintf(&b, "<Contents><Key>%s</Key><Size>7</Size><LastModified>2026-10-25T08:00:00Z</LastModified></Contents>", key)
		}
		b.WriteString(`</ListBucketResult>`)
		w.Header().Set("Content-Type", "application/xml")
		_, _ = w.Write([]byte(b.String()))
	}))
	t.Cleanup(server.Close)
	return server, &tokens
}

func TestS3WalkPaginatesWithoutCollecting(t *testing.T) {
	objects := []string{"stand/a.webp", "stand/b.webp", "stand/c.webp", "stand/d.webp", "stand/e.webp"}
	server, tokens := s3WalkServer(t, objects, 2)
	store, err := storage.NewS3(storage.S3Config{
		Endpoint: server.URL, Bucket: "b", Prefix: "stand",
		AccessKey: "k", SecretKey: "s",
	})
	if err != nil {
		t.Fatalf("хранилище: %v", err)
	}

	var seen []string
	firstPage := 0
	err = store.Walk(context.Background(), "", func(info storage.ObjectInfo) error {
		seen = append(seen, info.Key)
		// Первая страница — два объекта; остальные Walk тянет после обработки этих.
		if len(seen) == 2 {
			firstPage = len(*tokens)
		}
		return nil
	})
	if err != nil {
		t.Fatalf("обход: %v", err)
	}
	sort.Strings(seen)
	want := []string{"a.webp", "b.webp", "c.webp", "d.webp", "e.webp"}
	if strings.Join(seen, ",") != strings.Join(want, ",") {
		t.Fatalf("ключи: %v", seen)
	}
	// Пять объектов по два на страницу — три запроса, и продолжение просили дважды.
	if len(*tokens) != 3 {
		t.Fatalf("запросов списка: %d, ожидалось 3 (страницы по 2)", len(*tokens))
	}
	if firstPage != 1 {
		t.Fatalf("вторая страница запрошена слишком рано (запросов к этому моменту: %d)", firstPage)
	}
}

// Ошибка в колбэке обходит S3 так же, как локальное хранилище: останавливает обход.
func TestS3WalkStopsOnCallbackError(t *testing.T) {
	server, _ := s3WalkServer(t, []string{"stand/a.webp", "stand/b.webp"}, 1)
	store, err := storage.NewS3(storage.S3Config{
		Endpoint: server.URL, Bucket: "b", Prefix: "stand", AccessKey: "k", SecretKey: "s",
	})
	if err != nil {
		t.Fatalf("хранилище: %v", err)
	}
	stop := errors.New("стоп")
	seen := 0
	err = store.Walk(context.Background(), "", func(storage.ObjectInfo) error {
		seen++
		return stop
	})
	if !errors.Is(err, stop) {
		t.Fatalf("ожидалась ошибка колбэка, получено %v", err)
	}
	if seen != 1 {
		t.Fatalf("обработано объектов после ошибки: %d", seen)
	}
	_ = io.Discard
}
