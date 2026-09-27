package feed_test

import (
	"context"
	"errors"
	"testing"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/skyfraze/backend/internal/feed"
	"github.com/skyfraze/backend/internal/platform/testdb"
	"github.com/skyfraze/backend/internal/projects"
	"github.com/skyfraze/backend/internal/store"
)

// ---------- чистые функции (без БД) ----------

func TestParseSort(t *testing.T) {
	cases := map[string]store.FeedSort{
		"":       store.FeedSortNew,
		"new":    store.FeedSortNew,
		"rating": store.FeedSortRating,
		"views":  store.FeedSortViews,
		"RATING": store.FeedSortRating,
	}
	for in, want := range cases {
		got, err := feed.ParseSortForTest(in)
		if err != nil {
			t.Fatalf("sort %q: unexpected error %v", in, err)
		}
		if got != want {
			t.Errorf("sort %q: expected %q, got %q", in, want, got)
		}
	}
	if _, err := feed.ParseSortForTest("popular"); err == nil {
		t.Error("неизвестная сортировка должна отклоняться, а не молча падать в дефолт")
	}
}

func TestSlugify(t *testing.T) {
	cases := map[string]string{
		"Galactic Story":       "galactic-story",
		"Млечный путь":         "", // кириллица → пустая основа, ссылку даст суффикс
		"Млечный путь 2207":    "2207",
		"Alpha-7: Launch!":     "alpha-7-launch",
		"":                     "",
		"---":                  "",
	}
	for in, want := range cases {
		if got := feed.SlugifyForTest(in); got != want {
			t.Errorf("slugify(%q) = %q, want %q", in, got, want)
		}
	}
}

// ---------- интеграционные (нужна тестовая БД) ----------

type env struct {
	svc  *feed.Service
	proj *projects.Service
	st   *store.Store
	pool *pgxpool.Pool
}

func setup(t *testing.T) *env {
	t.Helper()
	pool := testdb.Setup(t, "feed")
	testdb.Truncate(t, pool,
		"project_ratings", "project_views", "project_event_state", "sessions",
		"invitations", "event_assets", "assets", "events", "team_memberships",
		"projects", "users")

	st := store.New(pool)
	return &env{svc: feed.New(st, projects.New(st)), proj: projects.New(st), st: st, pool: pool}
}

func (e *env) user(t *testing.T, email string) uuid.UUID {
	t.Helper()
	u, err := e.st.CreateUser(context.Background(), email, "hash", email)
	if err != nil {
		t.Fatalf("create user %s: %v", email, err)
	}
	return u.ID
}

func (e *env) project(t *testing.T, owner uuid.UUID, title string) uuid.UUID {
	t.Helper()
	p, err := e.proj.Create(context.Background(), owner, title, "описание")
	if err != nil {
		t.Fatalf("create project: %v", err)
	}
	return p.ID
}

func TestPublication_OnlyOwnerAndOnlyPublishedInFeed(t *testing.T) {
	e := setup(t)
	ctx := context.Background()

	owner := e.user(t, "owner@example.com")
	editor := e.user(t, "editor@example.com")
	stranger := e.user(t, "stranger@example.com")
	pid := e.project(t, owner, "Alpha Launch")

	if err := e.st.AddMembership(ctx, pid, editor, store.RoleEditor); err != nil {
		t.Fatalf("membership: %v", err)
	}

	// По умолчанию всё закрыто: проекта нет ни в ленте, ни по ссылке.
	items, _, err := e.svc.Feed(ctx, "new", 10, 0)
	if err != nil {
		t.Fatalf("feed: %v", err)
	}
	if len(items) != 0 {
		t.Fatalf("до публикации лента должна быть пуста, получено %d", len(items))
	}

	// Редактор публиковать не может — это право владельца.
	if _, err := e.svc.SetPublication(ctx, editor, pid, true); !errors.Is(err, feed.ErrForbidden) {
		t.Fatalf("редактор не должен публиковать, получено %v", err)
	}
	// Посторонний — тем более.
	if _, err := e.svc.SetPublication(ctx, stranger, pid, true); !errors.Is(err, feed.ErrForbidden) {
		t.Fatalf("посторонний не должен публиковать, получено %v", err)
	}

	pub, err := e.svc.SetPublication(ctx, owner, pid, true)
	if err != nil {
		t.Fatalf("publish: %v", err)
	}
	if !pub.IsPublic || pub.PublicSlug == nil || *pub.PublicSlug == "" {
		t.Fatalf("после публикации ожидались is_public и slug, получено %+v", pub)
	}
	slug := *pub.PublicSlug

	// В ленте появился ровно один проект — опубликованный.
	items, _, err = e.svc.Feed(ctx, "new", 10, 0)
	if err != nil {
		t.Fatalf("feed: %v", err)
	}
	if len(items) != 1 || items[0].ID != pid {
		t.Fatalf("в ленте ожидался только опубликованный проект, получено %+v", items)
	}
	if items[0].AuthorName == "" {
		t.Error("в карточке ленты должно быть имя автора")
	}

	// Закрытый проект недоступен по slug и не появляется в ленте.
	if _, err := e.svc.StoryBySlug(ctx, "closed-story-0000", uuid.Nil); !errors.Is(err, feed.ErrNotFound) {
		t.Errorf("закрытая история должна давать ErrNotFound, получено %v", err)
	}

	// Снятие с публикации убирает историю из ленты, но slug сохраняется.
	unpub, err := e.svc.SetPublication(ctx, owner, pid, false)
	if err != nil {
		t.Fatalf("unpublish: %v", err)
	}
	if unpub.IsPublic {
		t.Error("после снятия с публикации is_public должен быть false")
	}
	if unpub.PublicSlug == nil || *unpub.PublicSlug != slug {
		t.Errorf("slug должен сохраняться между публикациями: было %q, стало %v", slug, unpub.PublicSlug)
	}
	if _, err := e.svc.StoryBySlug(ctx, slug, uuid.Nil); !errors.Is(err, feed.ErrNotFound) {
		t.Errorf("снятая с публикации история должна давать ErrNotFound, получено %v", err)
	}
	items, _, _ = e.svc.Feed(ctx, "new", 10, 0)
	if len(items) != 0 {
		t.Errorf("лента должна опустеть после снятия с публикации, получено %d", len(items))
	}

	// Повторная публикация использует тот же slug.
	again, err := e.svc.SetPublication(ctx, owner, pid, true)
	if err != nil {
		t.Fatalf("republish: %v", err)
	}
	if again.PublicSlug == nil || *again.PublicSlug != slug {
		t.Errorf("повторная публикация должна сохранить slug %q, получено %v", slug, again.PublicSlug)
	}
}

func TestViews_AreDedupedPerVisitorPerDay(t *testing.T) {
	e := setup(t)
	ctx := context.Background()

	owner := e.user(t, "owner@example.com")
	pid := e.project(t, owner, "Views Story")
	pub, err := e.svc.SetPublication(ctx, owner, pid, true)
	if err != nil {
		t.Fatalf("publish: %v", err)
	}
	slug := *pub.PublicSlug

	counted, total, err := e.svc.RecordView(ctx, slug, "visitor-1")
	if err != nil {
		t.Fatalf("view: %v", err)
	}
	if !counted || total != 1 {
		t.Fatalf("первый просмотр должен считаться: counted=%v total=%d", counted, total)
	}

	counted, total, err = e.svc.RecordView(ctx, slug, "visitor-1")
	if err != nil {
		t.Fatalf("view: %v", err)
	}
	if counted || total != 1 {
		t.Fatalf("повторный просмотр тем же посетителем не должен считаться: counted=%v total=%d", counted, total)
	}

	counted, total, err = e.svc.RecordView(ctx, slug, "visitor-2")
	if err != nil {
		t.Fatalf("view: %v", err)
	}
	if !counted || total != 2 {
		t.Fatalf("новый посетитель должен увеличить счётчик: counted=%v total=%d", counted, total)
	}

	// Счётчик в ленте совпадает с числом засчитанных просмотров.
	item, err := e.st.GetFeedItemBySlug(ctx, slug)
	if err != nil {
		t.Fatalf("feed item: %v", err)
	}
	if item.ViewsCount != 2 {
		t.Errorf("в ленте ожидалось views=2, получено %d", item.ViewsCount)
	}

	if _, _, err := e.svc.RecordView(ctx, "no-such-slug", "visitor-1"); !errors.Is(err, feed.ErrNotFound) {
		t.Errorf("просмотр несуществующей истории: ожидался ErrNotFound, получено %v", err)
	}
}

func TestRatings_OnePerUserAndNotFromAuthor(t *testing.T) {
	e := setup(t)
	ctx := context.Background()

	owner := e.user(t, "owner@example.com")
	reader := e.user(t, "reader@example.com")
	reader2 := e.user(t, "reader2@example.com")
	pid := e.project(t, owner, "Rated Story")
	pub, err := e.svc.SetPublication(ctx, owner, pid, true)
	if err != nil {
		t.Fatalf("publish: %v", err)
	}
	slug := *pub.PublicSlug

	// Автор не оценивает собственную историю.
	if _, _, err := e.svc.Rate(ctx, slug, owner, 5); !errors.Is(err, feed.ErrSelfRating) {
		t.Fatalf("самооценка должна отклоняться, получено %v", err)
	}
	// Звёзды вне 1..5 — ошибка аргумента.
	for _, bad := range []int{0, 6, -1} {
		if _, _, err := e.svc.Rate(ctx, slug, reader, bad); !errors.Is(err, feed.ErrBadRating) {
			t.Errorf("stars=%d должен отклоняться, получено %v", bad, err)
		}
	}

	sum, mine, err := e.svc.Rate(ctx, slug, reader, 5)
	if err != nil {
		t.Fatalf("rate: %v", err)
	}
	if mine != 5 || sum.Count != 1 || sum.Avg != 5 {
		t.Fatalf("после первой оценки ожидалось avg=5 count=1, получено %+v", sum)
	}

	// Повторный голос заменяет предыдущий, а не добавляет второй.
	sum, _, err = e.svc.Rate(ctx, slug, reader, 3)
	if err != nil {
		t.Fatalf("re-rate: %v", err)
	}
	if sum.Count != 1 {
		t.Fatalf("одна оценка на пользователя: count=%d", sum.Count)
	}
	if sum.Avg != 3 {
		t.Fatalf("после замены оценки ожидалось avg=3, получено %v", sum.Avg)
	}

	sum, _, err = e.svc.Rate(ctx, slug, reader2, 4)
	if err != nil {
		t.Fatalf("rate: %v", err)
	}
	if sum.Count != 2 || sum.Avg != 3.5 {
		t.Fatalf("две оценки 3 и 4 → avg=3.5 count=2, получено avg=%v count=%d", sum.Avg, sum.Count)
	}

	// Личная оценка видна только этому пользователю.
	story, err := e.svc.StoryBySlug(ctx, slug, reader)
	if err != nil {
		t.Fatalf("story: %v", err)
	}
	if !story.HasMy || story.MyRate != 3 {
		t.Errorf("читатель должен видеть свою оценку 3, получено has=%v rate=%d", story.HasMy, story.MyRate)
	}
	anon, err := e.svc.StoryBySlug(ctx, slug, uuid.Nil)
	if err != nil {
		t.Fatalf("story anon: %v", err)
	}
	if anon.HasMy {
		t.Error("аноним не должен получать чужую оценку")
	}

	// Снятие оценки возвращает счётчик к одной.
	sum, err = e.svc.Unrate(ctx, slug, reader2)
	if err != nil {
		t.Fatalf("unrate: %v", err)
	}
	if sum.Count != 1 || sum.Avg != 3 {
		t.Fatalf("после снятия оценки ожидалось avg=3 count=1, получено %+v", sum)
	}

	// Сортировка «по оценке» ставит на первое место более высокую.
	second := e.project(t, owner, "Second Story")
	pub2, err := e.svc.SetPublication(ctx, owner, second, true)
	if err != nil {
		t.Fatalf("publish second: %v", err)
	}
	if _, _, err := e.svc.Rate(ctx, *pub2.PublicSlug, reader, 5); err != nil {
		t.Fatalf("rate second: %v", err)
	}
	items, _, err := e.svc.Feed(ctx, "rating", 10, 0)
	if err != nil {
		t.Fatalf("feed rating: %v", err)
	}
	if len(items) != 2 || items[0].ID != second {
		t.Fatalf("по оценке первым должен быть проект с 5★, получено %+v", items)
	}
}

func TestStory_PublicPayloadHasContentAndAssets(t *testing.T) {
	e := setup(t)
	ctx := context.Background()

	owner := e.user(t, "owner@example.com")
	pid := e.project(t, owner, "Story With Content")

	// Дерево событий: глава + вложенное под-событие (запасной источник, когда
	// CRDT-снапшота ещё нет).
	chapter := uuid.New()
	child := uuid.New()
	if _, err := e.pool.Exec(ctx,
		`INSERT INTO events (id, project_id, parent_id, position, depth, title, body) VALUES
		 ($1,$2,NULL,0,0,'Глава 1','Текст главы'),
		 ($3,$2,$1,0,1,'Под-событие','Текст под-события')`, chapter, pid, child); err != nil {
		t.Fatalf("insert events: %v", err)
	}

	pub, err := e.svc.SetPublication(ctx, owner, pid, true)
	if err != nil {
		t.Fatalf("publish: %v", err)
	}
	story, err := e.svc.StoryBySlug(ctx, *pub.PublicSlug, uuid.Nil)
	if err != nil {
		t.Fatalf("story: %v", err)
	}
	if len(story.Events) != 2 {
		t.Fatalf("без CRDT-снапшота история должна отдавать дерево events, получено %d", len(story.Events))
	}
	var nested bool
	for _, ev := range story.Events {
		if ev.ParentID != nil && *ev.ParentID == chapter {
			nested = true
		}
	}
	if !nested {
		t.Error("вложенность (parent_id) должна сохраняться в публичном ответе")
	}
	if story.Item.Title != "Story With Content" {
		t.Errorf("в публичной истории ожидался заголовок проекта, получено %q", story.Item.Title)
	}

	// Появился CRDT-снапшот — он приоритетнее таблицы events.
	if _, err := e.pool.Exec(ctx,
		`INSERT INTO project_event_state (project_id, yjs_state, revision) VALUES ($1,$2,1)`,
		pid, []byte{1, 2, 3}); err != nil {
		t.Fatalf("insert state: %v", err)
	}
	story, err = e.svc.StoryBySlug(ctx, *pub.PublicSlug, uuid.Nil)
	if err != nil {
		t.Fatalf("story: %v", err)
	}
	if len(story.State) == 0 {
		t.Error("при наличии снапшота публичная история должна отдавать его")
	}
	if len(story.Events) != 0 {
		t.Error("при наличии снапшота дерево events не нужно")
	}
}
