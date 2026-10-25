// Package ratelimit — ограничение частоты запросов на публичных ручках входа.
//
// Зачем. Пароль на входе — единственный фактор, и до этой правки его можно было перебирать
// без ограничений: сервер отвечал 401 столько раз, сколько попросишь. Это не «усиление
// безопасности ради галочки», а закрытие единственного участка, где у сервиса не было
// никакой защиты от простого скрипта.
//
// Две границы, а не одна:
//
//   - по адресу клиента (Allow) — против веера попыток по разным аккаунтам с одного IP;
//   - по email (AllowKey) — против перебора ОДНОГО аккаунта с разных адресов.
//
// Только по IP нельзя: за обратным прокси все клиенты приходят с одного адреса, и общий
// счётчик заблокировал бы вход всем. Только по email тоже мало: он не мешает перебирать
// много разных аккаунтов с одной машины.
//
// Окно фиксированное (минута), хранилище — память процесса. Несколько инстансов backend
// счётчики не разделяют; для стенда это верно (один backend), и сказано в docs, чтобы не
// выглядело упущением.
package ratelimit

import (
	"net"
	"net/http"
	"strconv"
	"strings"
	"sync"
	"time"
)

// Limit — сколько раз за окно можно обратиться. Нулевое или отрицательное значение
// означает «не ограничивать»: 0 в настройках выключает границу, а не запрещает всё.
type Limit struct {
	PerWindow int
	Window    time.Duration
}

// Enabled — задана ли граница.
func (l Limit) Enabled() bool { return l.PerWindow > 0 && l.Window > 0 }

// Limiter — счётчики по ключам с окном.
type Limiter struct {
	mu      sync.Mutex
	request Limit
	key     Limit
	buckets map[string]*bucket
	now     func() time.Time
}

type bucket struct {
	start time.Time
	count int
}

// New создаёт ограничитель: request — по адресу клиента, key — по произвольному ключу
// (например, email из тела запроса).
func New(request, key Limit) *Limiter {
	return &Limiter{request: request, key: key, buckets: map[string]*bucket{}, now: time.Now}
}

// Allow проверяет границу по адресу клиента.
func (l *Limiter) Allow(r *http.Request) (bool, time.Duration) {
	if !l.request.Enabled() {
		return true, 0
	}
	return l.hit("ip:"+ClientIP(r), l.request)
}

// AllowKey проверяет границу по ключу (email аккаунта).
func (l *Limiter) AllowKey(key string) (bool, time.Duration) {
	if !l.key.Enabled() || strings.TrimSpace(key) == "" {
		return true, 0
	}
	return l.hit("key:"+strings.ToLower(strings.TrimSpace(key)), l.key)
}

// hit — общая арифметика окна: сначала проверка, счётчик растёт только при успехе, иначе
// заблокированный клиент продолжал бы продлевать себе ожидание.
func (l *Limiter) hit(id string, limit Limit) (bool, time.Duration) {
	l.mu.Lock()
	defer l.mu.Unlock()
	now := l.now()
	b, ok := l.buckets[id]
	if !ok || now.Sub(b.start) >= limit.Window {
		b = &bucket{start: now}
		l.buckets[id] = b
	}
	if b.count >= limit.PerWindow {
		wait := limit.Window - now.Sub(b.start)
		if wait < 0 {
			wait = 0
		}
		return false, wait
	}
	b.count++
	return true, 0
}

// Cleanup выбрасывает истёкшие окна: без этого карта росла бы вместе с числом адресов, а
// сервис, открытый в интернет, получает их немало.
func (l *Limiter) Cleanup() int {
	l.mu.Lock()
	defer l.mu.Unlock()
	now := l.now()
	longest := time.Minute
	if l.request.Window > longest {
		longest = l.request.Window
	}
	if l.key.Window > longest {
		longest = l.key.Window
	}
	removed := 0
	for id, b := range l.buckets {
		if now.Sub(b.start) >= 2*longest {
			delete(l.buckets, id)
			removed++
		}
	}
	return removed
}

// Middleware ограничивает запросы по адресу клиента и отвечает 429 с Retry-After.
func (l *Limiter) Middleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		ok, wait := l.Allow(r)
		if !ok {
			writeLimited(w, wait)
			return
		}
		next.ServeHTTP(w, r)
	})
}

// writeLimited — общий ответ «слишком часто» (его же отдаёт ручка входа по email).
func writeLimited(w http.ResponseWriter, wait time.Duration) {
	seconds := int(wait.Seconds()) + 1
	w.Header().Set("Retry-After", strconv.Itoa(seconds))
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusTooManyRequests)
	_, _ = w.Write([]byte(`{"error":"слишком много попыток входа — подождите и попробуйте снова"}` + "\n"))
}

// WriteLimited — тот же ответ наружу: ручке входа он нужен после разбора email.
func WriteLimited(w http.ResponseWriter, wait time.Duration) { writeLimited(w, wait) }

// ClientIP — адрес клиента с учётом обратного прокси.
//
// X-Forwarded-For принимается ТОЛЬКО когда непосредственный сосед — локальный или приватный
// адрес: снаружи до backend не достучаться (порт опубликован у nginx), и доверять заголовку
// от публичного клиента было бы подарком для обхода ограничения. Из цепочки берётся
// ПОСЛЕДНИЙ элемент: nginx в `$proxy_add_x_forwarded_for` сохраняет присланное клиентом и
// дописывает настоящий адрес в конец — значит последний подделать нельзя.
func ClientIP(r *http.Request) string {
	peer, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		peer = r.RemoteAddr
	}
	if !isLocalOrPrivate(peer) {
		return peer
	}
	if forwarded := strings.TrimSpace(r.Header.Get("X-Forwarded-For")); forwarded != "" {
		parts := strings.Split(forwarded, ",")
		if last := strings.TrimSpace(parts[len(parts)-1]); last != "" {
			return last
		}
	}
	return peer
}

func isLocalOrPrivate(host string) bool {
	ip := net.ParseIP(host)
	if ip == nil {
		return false
	}
	return ip.IsLoopback() || ip.IsPrivate()
}
