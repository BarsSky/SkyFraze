package feed_test

import (
	"bytes"
	"context"
	"testing"

	"github.com/google/uuid"

	"github.com/skyfraze/backend/internal/feed"
)

/**
 * Публичная история берёт ЖИВУЮ комнату, а не прошлый снапшот (0.136.0).
 *
 * Зачем проверка. Снапшот базы пишется раз в несколько секунд, поэтому «опубликовал проект и
 * сразу открыл ссылку» показывало читателю прошлый текст — а ссылку на историю пересылают сразу
 * после правки. Живая комната держит свежий документ в памяти, и публичный ответ обязан брать его.
 *
 * Подменяем комнату интерфейсом `feed.LiveState`: сервису не нужен настоящий хаб, чтобы это
 * проверить. База при этом пуста — значит без живой комнаты состояние было бы пустым, и тест бы
 * упал.
 */
type fakeLive struct {
	state []byte
	calls int
}

func (f *fakeLive) LiveState(_ context.Context, _ uuid.UUID) []byte {
	f.calls++
	return f.state
}

func TestStoryBySlugPrefersLiveState(t *testing.T) {
	e := setup(t)
	ctx := context.Background()
	owner := e.user(t, "owner-live@example.com")
	pid := e.project(t, owner, "Live Story")
	pub, err := e.svc.SetPublication(ctx, owner, pid, true)
	if err != nil {
		t.Fatalf("публикация: %v", err)
	}
	if pub.PublicSlug == nil || *pub.PublicSlug == "" {
		t.Fatal("у опубликованного проекта нет slug")
	}

	live := &fakeLive{state: []byte{1, 2, 3, 4}}
	e.svc.UseLiveState(live)

	story, err := e.svc.StoryBySlug(ctx, *pub.PublicSlug, uuid.Nil)
	if err != nil {
		t.Fatalf("история: %v", err)
	}
	if live.calls == 0 {
		t.Error("живая комната не была спрошена: публичный ответ пошёл по снапшоту")
	}
	if !bytes.Equal(story.State, live.state) {
		t.Fatalf("в историю попало не состояние комнаты: %v", story.State)
	}
}

func TestStoryBySlugFallsBackWhenRoomIsGone(t *testing.T) {
	e := setup(t)
	ctx := context.Background()
	owner := e.user(t, "owner-nolive@example.com")
	pid := e.project(t, owner, "No Live Story")
	pub, err := e.svc.SetPublication(ctx, owner, pid, true)
	if err != nil {
		t.Fatalf("публикация: %v", err)
	}

	// Комнаты нет: публичный ответ собирается как раньше и не падает.
	live := &fakeLive{}
	e.svc.UseLiveState(live)
	story, err := e.svc.StoryBySlug(ctx, *pub.PublicSlug, uuid.Nil)
	if err != nil {
		t.Fatalf("история без комнаты: %v", err)
	}
	if len(story.State) != 0 {
		t.Fatalf("без комнаты и снапшота состояния быть не должно, получено %d байт", len(story.State))
	}
	if live.calls == 0 {
		t.Error("живая комната не была спрошена")
	}
}

var _ feed.LiveState = (*fakeLive)(nil)
