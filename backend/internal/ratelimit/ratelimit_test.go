package ratelimit_test

// ratelimit_test.go — ограничение попыток входа.
//
// Проверяем арифметику окна и два свойства, из-за которых это вообще имеет смысл:
// заблокированный клиент не продлевает себе ожидание своими же попытками, и адрес клиента
// за прокси берётся так, что подделать его снаружи нельзя.

import (
	"net/http/httptest"
	"testing"
	"time"

	"github.com/skyfraze/backend/internal/ratelimit"
)


func TestLimitBlocksAfterThreshold(t *testing.T) {
	limiter := ratelimit.New(ratelimit.Limit{PerWindow: 3, Window: time.Minute}, ratelimit.Limit{})
	makeRequest := func() bool {
		r := httptest.NewRequest("POST", "/api/auth/login", nil)
		r.RemoteAddr = "203.0.113.10:5555"
		ok, _ := limiter.Allow(r)
		return ok
	}
	for i := 0; i < 3; i++ {
		if !makeRequest() {
			t.Fatalf("попытка %d должна проходить", i+1)
		}
	}
	ok, wait := limiter.Allow(httptest.NewRequest("POST", "/api/auth/login", nil))
	_ = ok
	// Четвёртая с того же адреса — отказ, и ожидание положительное.
	r := httptest.NewRequest("POST", "/api/auth/login", nil)
	r.RemoteAddr = "203.0.113.10:5555"
	ok, wait = limiter.Allow(r)
	if ok {
		t.Fatal("четвёртая попытка должна быть отвергнута")
	}
	if wait <= 0 || wait > time.Minute {
		t.Fatalf("ожидание: %v", wait)
	}
	// Другой адрес — своя граница.
	other := httptest.NewRequest("POST", "/api/auth/login", nil)
	other.RemoteAddr = "203.0.113.11:5555"
	if ok, _ := limiter.Allow(other); !ok {
		t.Fatal("другой адрес не должен быть заблокирован")
	}
	// Блокировка не продлевается: спустя почти всё окно ожидание меньше, чем было в начале.
	waitLater := func() time.Duration {
		r := httptest.NewRequest("POST", "/api/auth/login", nil)
		r.RemoteAddr = "203.0.113.10:5555"
		_, w := limiter.Allow(r)
		return w
	}
	first := waitLater()
	time.Sleep(10 * time.Millisecond)
	second := waitLater()
	if second >= first {
		t.Fatalf("ожидание не сокращается: было %v, стало %v", first, second)
	}
}

func TestKeyLimitSeparatesAccounts(t *testing.T) {
	limiter := ratelimit.New(ratelimit.Limit{}, ratelimit.Limit{PerWindow: 2, Window: time.Minute})
	for i := 0; i < 2; i++ {
		if ok, _ := limiter.AllowKey("victim@example.com"); !ok {
			t.Fatalf("попытка %d по аккаунту должна проходить", i+1)
		}
	}
	if ok, _ := limiter.AllowKey("victim@example.com"); ok {
		t.Fatal("третья попытка по аккаунту должна быть отвергнута")
	}
	if ok, _ := limiter.AllowKey("other@example.com"); !ok {
		t.Fatal("другой аккаунт не должен быть заблокирован")
	}
	// Регистр и пробелы не должны давать новый счётчик.
	if ok, _ := limiter.AllowKey("  VICTIM@example.com "); ok {
		t.Fatal("ключ должен нормализоваться: регистр и пробелы не обходят ограничение")
	}
}

func TestZeroLimitDisablesProtection(t *testing.T) {
	limiter := ratelimit.New(ratelimit.Limit{}, ratelimit.Limit{})
	for i := 0; i < 100; i++ {
		r := httptest.NewRequest("POST", "/api/auth/login", nil)
		r.RemoteAddr = "203.0.113.10:5555"
		if ok, _ := limiter.Allow(r); !ok {
			t.Fatal("с нулевой настройкой ограничения нет")
		}
	}
	if ok, _ := limiter.AllowKey("x@example.com"); !ok {
		t.Fatal("с нулевой настройкой ограничения по ключу нет")
	}
}

// За обратным прокси адрес берётся из X-Forwarded-For, но только если сосед — приватный.
func TestClientIPTrustsProxyOnlyFromPrivatePeer(t *testing.T) {
	behindProxy := httptest.NewRequest("POST", "/api/auth/login", nil)
	behindProxy.RemoteAddr = "172.18.0.4:40000"
	behindProxy.Header.Set("X-Forwarded-For", "198.51.100.7")
	if got := ratelimit.ClientIP(behindProxy); got != "198.51.100.7" {
		t.Fatalf("за прокси: %q", got)
	}
	// Клиент с публичного адреса заголовку не верит: он мог его подделать.
	direct := httptest.NewRequest("POST", "/api/auth/login", nil)
	direct.RemoteAddr = "203.0.113.99:5000"
	direct.Header.Set("X-Forwarded-For", "198.51.100.7")
	if got := ratelimit.ClientIP(direct); got != "203.0.113.99" {
		t.Fatalf("без прокси: %q", got)
	}
	// Цепочка: последний элемент — тот, что дописал ближайший прокси, его клиент не подделает.
	chain := httptest.NewRequest("POST", "/api/auth/login", nil)
	chain.RemoteAddr = "127.0.0.1:41234"
	chain.Header.Set("X-Forwarded-For", "1.2.3.4, 198.51.100.7")
	if got := ratelimit.ClientIP(chain); got != "198.51.100.7" {
		t.Fatalf("цепочка: %q", got)
	}
}

func TestCleanupDropsExpiredBuckets(t *testing.T) {
	limiter := ratelimit.New(ratelimit.Limit{PerWindow: 5, Window: time.Minute}, ratelimit.Limit{})
	for i := 0; i < 10; i++ {
		r := httptest.NewRequest("POST", "/api/auth/login", nil)
		r.RemoteAddr = "203.0.113." + string(rune('0'+i)) + ":5000"
		limiter.Allow(r)
	}
	// Окна живут две длины окна; без ожидания их ещё нечего убирать — проверяем, что
	// уборка не удаляет активные (иначе счётчик обнулялся бы под нагрузкой).
	if removed := limiter.Cleanup(); removed != 0 {
		t.Fatalf("уборка тронула активные окна: %d", removed)
	}
}
