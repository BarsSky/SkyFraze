package assistant

// sse.go — поток ответа в браузер (Server-Sent Events).
//
// Почему SSE, а не WebSocket. Поток здесь односторонний: сервер рассказывает, что
// происходит, а вопрос уже ушёл обычным POST-ом с токеном. WebSocket потребовал бы
// отдельного канала, своей авторизации и восстановления после обрыва — за то же самое.
// Браузер читает поток через fetch + ReadableStream, а «стоп» — это обрыв запроса,
// который сразу отменяет и генерацию у провайдера.
//
// Два свойства, без которых поток бесполезен:
//
//   - **заголовки отдаются лениво.** Пока ничего не отправлено, ошибку (нет прав,
//     нужно согласие, нет ключа) ещё можно отдать обычным JSON с кодом — интерфейс по
//     коду понимает, что показать. После первого события код уже не отправить, и сбой
//     уходит событием `error`;
//   - **тишина не длиннее 15 секунд.** Пока модель думает, в сокет не уходит ничего, и
//     молчащий поток закрывают прокси (nginx, корпоративные шлюзы). Поэтому раз в
//     15 секунд уходит комментарий-«пинг»: для браузера он пустой, для прокси — признак
//     живого соединения.

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"sync"
	"time"
)

// ssePingEvery — как часто напоминать о себе, пока модель молчит.
const ssePingEvery = 15 * time.Second

type sseStream struct {
	mu      sync.Mutex
	w       http.ResponseWriter
	flusher http.Flusher
	started bool
	closed  bool
}

func newSSEStream(w http.ResponseWriter) *sseStream {
	s := &sseStream{w: w}
	// Flusher есть у настоящего сервера; в тестах его может не быть, и тогда поток
	// просто собирается целиком — на события это не влияет.
	if f, ok := w.(http.Flusher); ok {
		s.flusher = f
	}
	return s
}

// send отдаёт одно событие. Ошибка записи означает, что соединение закрыто: вызывающий
// прекращает работу (см. Emitter).
func (s *sseStream) send(event Event) error {
	raw, err := json.Marshal(event)
	if err != nil {
		return err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.closed {
		return errStreamStopped
	}
	s.startLocked()
	if _, err := fmt.Fprintf(s.w, "data: %s\n\n", raw); err != nil {
		return errStreamStopped
	}
	s.flushLocked()
	return nil
}

// started — отправлено ли уже хоть что-то человеку.
func (s *sseStream) startedNow() bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.started
}

// close запрещает дальнейшую запись: обработчик закончил, и «пинг» больше не нужен.
func (s *sseStream) close() {
	s.mu.Lock()
	s.closed = true
	s.mu.Unlock()
}

// ping шлёт комментарии, пока модель думает. Комментарий (строка, начинающаяся с
// двоеточия) по формату SSE не событие: браузер его не увидит, а прокси увидит, что
// соединение живое.
func (s *sseStream) ping(ctx context.Context, every time.Duration) {
	ticker := time.NewTicker(every)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			s.mu.Lock()
			if s.closed {
				s.mu.Unlock()
				return
			}
			s.startLocked()
			_, err := io.WriteString(s.w, ": ping\n\n")
			s.flushLocked()
			s.mu.Unlock()
			if err != nil {
				return
			}
		}
	}
}

func (s *sseStream) startLocked() {
	if s.started {
		return
	}
	s.started = true
	h := s.w.Header()
	h.Set("Content-Type", "text/event-stream; charset=utf-8")
	h.Set("Cache-Control", "no-cache")
	h.Set("Connection", "keep-alive")
	// Без этого nginx копит поток в буфере и отдаёт его целиком в конце — ровно то,
	// от чего поток и спасает.
	h.Set("X-Accel-Buffering", "no")
	s.w.WriteHeader(http.StatusOK)
	s.flushLocked()
}

func (s *sseStream) flushLocked() {
	if s.flusher != nil {
		s.flusher.Flush()
	}
}
