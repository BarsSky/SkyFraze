package ai

// stall.go — сторож молчания сервера моделей (0.145.0).
//
// Зачем отдельный сторож, если у http.Client есть Timeout. Timeout — это предел на ВСЁ
// обращение. С потоковым ответом так нельзя: холодный старт (сервер поднимает выгруженную
// модель) и сама генерация — разные фазы, и один общий предел либо рвёт загрузку, либо
// позволяет зависшему соединению висеть бесконечно.
//
// Поэтому у потока два сторожа, оба через отмену контекста:
//
//	LoadWait — ожидание ПЕРВЫХ байт (модель может ещё грузиться);
//	Idle     — тишина уже после начала ответа (сервер завис или умер).
//
// Отмена контекста — единственный способ прервать чтение тела ответа: net/http не умеет
// «таймаут на Read» для уже открытого соединения.

import (
	"io"
	"sync/atomic"
	"time"
)

// stallWatch отменяет запрос, если сервер молчит дольше предела.
type stallWatch struct {
	limit  time.Duration
	cancel func()
	timer  *time.Timer
	fired  atomic.Bool
}

// newStallWatch заводит сторожа, который отменит запрос через limit молчания.
func newStallWatch(limit time.Duration, cancel func()) *stallWatch {
	w := &stallWatch{limit: limit, cancel: cancel}
	if limit > 0 {
		w.timer = time.AfterFunc(limit, w.fire)
	}
	return w
}

func (w *stallWatch) fire() {
	w.fired.Store(true)
	w.cancel()
}

// touch отмечает активность сервера: отсчёт молчания начинается заново.
func (w *stallWatch) touch() {
	if w.timer != nil && !w.fired.Load() {
		w.timer.Reset(w.limit)
	}
}

// setLimit меняет предел на ходу: до первых байт — LoadWait, после — Idle.
func (w *stallWatch) setLimit(limit time.Duration) {
	w.limit = limit
	w.touch()
}

// stop снимает сторожа (запрос закончился сам).
func (w *stallWatch) stop() {
	if w.timer != nil {
		w.timer.Stop()
	}
}

// stalled — сработал ли сторож. Нужен, чтобы отличить нашу отмену от отмены человеком.
func (w *stallWatch) stalled() bool { return w.fired.Load() }

// watchedBody отмечает активность на каждом чтении тела ответа.
type watchedBody struct {
	io.ReadCloser
	watch *stallWatch
}

func (b *watchedBody) Read(p []byte) (int, error) {
	n, err := b.ReadCloser.Read(p)
	if n > 0 {
		b.watch.touch()
	}
	return n, err
}
