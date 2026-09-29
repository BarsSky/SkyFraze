package people_test

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"testing"

	"github.com/google/uuid"

	"github.com/skyfraze/backend/internal/auth"
	"github.com/skyfraze/backend/internal/coauthors"
	"github.com/skyfraze/backend/internal/feed"
	"github.com/skyfraze/backend/internal/people"
	"github.com/skyfraze/backend/internal/platform/testdb"
	"github.com/skyfraze/backend/internal/projects"
	"github.com/skyfraze/backend/internal/store"
)

type env struct {
	st   *store.Store
	svc  *people.Service
	auth *auth.Service
	co   *coauthors.Service
	feed *feed.Service
	proj *projects.Service

	alice uuid.UUID
	bob   uuid.UUID
	carol uuid.UUID
}

func setup(t *testing.T) *env {
	t.Helper()
	pool := testdb.Setup(t, "people")
	testdb.Truncate(t, pool, "coauthor_links", "project_ratings", "project_views",
		"registration_requests", "app_settings", "project_event_state", "sessions",
		"invitations", "event_assets", "assets", "events", "team_memberships",
		"projects", "users")

	st := store.New(pool)
	proj := projects.New(st)
	e := &env{
		st:   st,
		svc:  people.New(st),
		auth: auth.New(st, "test-secret-please-change"),
		co:   coauthors.New(st),
		feed: feed.New(st, proj),
		proj: proj,
	}
	e.alice = e.user(t, "alice@example.com", "Алиса")
	e.bob = e.user(t, "bob@example.com", "Борис")
	e.carol = e.user(t, "carol@example.com", "Каролина")
	return e
}

func (e *env) user(t *testing.T, email, name string) uuid.UUID {
	t.Helper()
	u, err := e.st.CreateUser(context.Background(), email, "hash", name)
	if err != nil {
		t.Fatalf("create %s: %v", email, err)
	}
	return u.ID
}

// setProfile — правка профиля тем же путём, что и интерфейс: PATCH /api/auth/me.
func (e *env) setProfile(t *testing.T, id uuid.UUID, upd auth.ProfileUpdate) *store.User {
	t.Helper()
	u, err := e.auth.UpdateProfile(context.Background(), id, upd)
	if err != nil {
		t.Fatalf("update profile: %v", err)
	}
	return u
}

func strPtr(s string) *string         { return &s }
func boolPtr(b bool) *bool            { return &b }
func craftsPtr(c ...string) *[]string { return &c }

// find — карточка человека в выдаче каталога.
func find(items []store.UserPublic, id uuid.UUID) *store.UserPublic {
	for i := range items {
		if items[i].ID == id {
			return &items[i]
		}
	}
	return nil
}

func TestCatalog_OnlyDiscoverableAndNeverSelf(t *testing.T) {
	e := setup(t)
	ctx := context.Background()

	page, err := e.svc.Catalog(ctx, e.alice, people.Filter{})
	if err != nil {
		t.Fatalf("catalog: %v", err)
	}
	if page.Total != 2 || len(page.Items) != 2 {
		t.Fatalf("каталог вернул %d/%d, ожидались оба других человека", len(page.Items), page.Total)
	}
	if find(page.Items, e.alice) != nil {
		t.Fatal("себя в каталоге быть не должно: карточка «это я» живёт в профиле")
	}
	if page.Limit != 24 || page.Offset != 0 {
		t.Fatalf("страница по умолчанию: limit=%d offset=%d", page.Limit, page.Offset)
	}

	// Галочка «не показывать меня» убирает человека из каталога…
	e.setProfile(t, e.bob, auth.ProfileUpdate{Discoverable: boolPtr(false)})
	page, err = e.svc.Catalog(ctx, e.alice, people.Filter{})
	if err != nil {
		t.Fatalf("catalog after hide: %v", err)
	}
	if find(page.Items, e.bob) != nil || page.Total != 1 {
		t.Fatalf("скрытый человек остался в каталоге: %+v", page.Items)
	}

	// …и из поиска соавторов: спрятаться должно быть можно целиком, иначе
	// галочка означала бы «не показывать в одном месте из двух».
	found, err := e.st.SearchUsers(ctx, e.alice, "bob", 20)
	if err != nil {
		t.Fatalf("search: %v", err)
	}
	if len(found) != 0 {
		t.Fatalf("скрытый человек находится поиском соавторов: %+v", found)
	}
}

func TestCatalog_SearchByNickPrefixAndName(t *testing.T) {
	e := setup(t)
	ctx := context.Background()
	// Ник barnaby сортируется РАНЬШЕ bob, но совпадает только по имени: каталог
	// обязан поднять наверх того, кого набирают по @nick.
	e.user(t, "barnaby@example.com", "Bobby")

	page, err := e.svc.Catalog(ctx, e.alice, people.Filter{Q: "bo"})
	if err != nil {
		t.Fatalf("catalog q=bo: %v", err)
	}
	if len(page.Items) != 2 || page.Total != 2 {
		t.Fatalf("по «bo» найдено %d/%d: %+v", len(page.Items), page.Total, page.Items)
	}
	if page.Items[0].ID != e.bob {
		t.Fatalf("первым должен идти ник-префикс bob, получено %+v", page.Items)
	}

	// По имени — по вхождению, а не только с начала строки.
	page, err = e.svc.Catalog(ctx, e.alice, people.Filter{Q: "орис"})
	if err != nil {
		t.Fatalf("catalog q=орис: %v", err)
	}
	if len(page.Items) != 1 || page.Items[0].ID != e.bob {
		t.Fatalf("по имени найдено %+v", page.Items)
	}

	// Одна буква — ещё не запрос: пустая страница вместо почти всего каталога.
	page, err = e.svc.Catalog(ctx, e.alice, people.Filter{Q: "б"})
	if err != nil {
		t.Fatalf("catalog short q: %v", err)
	}
	if len(page.Items) != 0 || page.Total != 0 {
		t.Fatalf("короткий запрос вернул %+v", page.Items)
	}

	// Спецсимволы LIKE не должны превращать поиск в «показать всех».
	page, err = e.svc.Catalog(ctx, e.alice, people.Filter{Q: "%%"})
	if err != nil {
		t.Fatalf("catalog wildcard: %v", err)
	}
	if len(page.Items) != 0 {
		t.Fatalf("«%%%%» не должен находить всех: %+v", page.Items)
	}
}

func TestCatalog_FilterByCraft(t *testing.T) {
	e := setup(t)
	ctx := context.Background()
	e.setProfile(t, e.bob, auth.ProfileUpdate{Crafts: craftsPtr("Правописание", "Арт")})
	e.setProfile(t, e.carol, auth.ProfileUpdate{Crafts: craftsPtr("Арт")})

	page, err := e.svc.Catalog(ctx, e.alice, people.Filter{Craft: "Арт"})
	if err != nil {
		t.Fatalf("catalog craft: %v", err)
	}
	if len(page.Items) != 2 || page.Total != 2 {
		t.Fatalf("по специализации «Арт» найдено %+v", page.Items)
	}

	page, err = e.svc.Catalog(ctx, e.alice, people.Filter{Craft: "Правописание"})
	if err != nil {
		t.Fatalf("catalog craft: %v", err)
	}
	if len(page.Items) != 1 || page.Items[0].ID != e.bob {
		t.Fatalf("по «Правописание» найдено %+v", page.Items)
	}
	if len(page.Items[0].Crafts) != 2 {
		t.Fatalf("специализации должны приезжать в карточке: %+v", page.Items[0].Crafts)
	}

	// Совпадение точное: другой регистр — другая строка каталога подсказок.
	page, err = e.svc.Catalog(ctx, e.alice, people.Filter{Craft: "правописание"})
	if err != nil {
		t.Fatalf("catalog craft lower: %v", err)
	}
	if len(page.Items) != 0 {
		t.Fatalf("фильтр по специализации сматчил другой регистр: %+v", page.Items)
	}

	// Слишком длинная строка — ошибка параметров, а не тихая пустая выдача.
	if _, err := e.svc.Catalog(ctx, e.alice, people.Filter{Craft: strings.Repeat("я", 61)}); !errors.Is(err, people.ErrBadArgument) {
		t.Fatalf("длинная специализация ожидала ErrBadArgument, получено %v", err)
	}
}

func TestCatalog_PaginationAndTotal(t *testing.T) {
	e := setup(t)
	ctx := context.Background()
	for i := 0; i < 5; i++ {
		e.user(t, fmt.Sprintf("user%d@example.com", i), fmt.Sprintf("Человек %d", i))
	}

	first, err := e.svc.Catalog(ctx, e.alice, people.Filter{Limit: 3})
	if err != nil {
		t.Fatalf("catalog page 1: %v", err)
	}
	if len(first.Items) != 3 {
		t.Fatalf("на странице %d карточек, ожидалось 3", len(first.Items))
	}
	if first.Total != 7 {
		t.Fatalf("total=%d, ожидалось 7 (bob, carol и пятеро новых)", first.Total)
	}

	second, err := e.svc.Catalog(ctx, e.alice, people.Filter{Limit: 3, Offset: 3})
	if err != nil {
		t.Fatalf("catalog page 2: %v", err)
	}
	if len(second.Items) != 3 || second.Total != 7 {
		t.Fatalf("вторая страница %d карточек, total=%d", len(second.Items), second.Total)
	}
	for _, a := range first.Items {
		if find(second.Items, a.ID) != nil {
			t.Fatalf("страницы пересекаются на %s: порядок нестабилен", a.Username)
		}
	}

	// limit сверх максимума подрезается, а не отдаёт всю инсталляцию.
	big, err := e.svc.Catalog(ctx, e.alice, people.Filter{Limit: 500})
	if err != nil {
		t.Fatalf("catalog big limit: %v", err)
	}
	if big.Limit != 50 {
		t.Fatalf("limit=500 не подрезан до 50, получено %d", big.Limit)
	}

	// Отрицательная страница — ошибка параметров.
	if _, err := e.svc.Catalog(ctx, e.alice, people.Filter{Offset: -1}); !errors.Is(err, people.ErrBadArgument) {
		t.Fatalf("offset=-1 ожидал ErrBadArgument, получено %v", err)
	}
}

func TestCatalog_RelationFollowsCoauthorLink(t *testing.T) {
	e := setup(t)
	ctx := context.Background()

	page, err := e.svc.Catalog(ctx, e.alice, people.Filter{Q: "bob"})
	if err != nil {
		t.Fatalf("catalog: %v", err)
	}
	if p := find(page.Items, e.bob); p == nil || p.Relation != "" {
		t.Fatalf("без связи relation должен быть пустым: %+v", p)
	}

	// Заявка: у отправителя — outgoing, у адресата — incoming.
	link, err := e.co.Invite(ctx, e.alice, e.bob, "пишем вместе", []string{"Диалоги"})
	if err != nil {
		t.Fatalf("invite: %v", err)
	}
	page, _ = e.svc.Catalog(ctx, e.alice, people.Filter{Q: "bob"})
	if p := find(page.Items, e.bob); p == nil || p.Relation != "request-outgoing" {
		t.Fatalf("для отправленной заявки relation=%+v", p)
	}
	page, _ = e.svc.Catalog(ctx, e.bob, people.Filter{Q: "alice"})
	if p := find(page.Items, e.alice); p == nil || p.Relation != "request-incoming" {
		t.Fatalf("для входящей заявки relation=%+v", p)
	}

	// Согласие — соавторы, и профиль показывает то же отношение.
	if _, err := e.co.Decide(ctx, e.bob, link.ID, true); err != nil {
		t.Fatalf("accept: %v", err)
	}
	page, _ = e.svc.Catalog(ctx, e.alice, people.Filter{Q: "bob"})
	if p := find(page.Items, e.bob); p == nil || p.Relation != "coauthor" {
		t.Fatalf("для соавтора relation=%+v", p)
	}
	profile, err := e.svc.Profile(ctx, e.alice, e.bob)
	if err != nil {
		t.Fatalf("profile: %v", err)
	}
	if profile.Relation != "coauthor" {
		t.Fatalf("в профиле relation=%q, ожидалось coauthor", profile.Relation)
	}
}

func TestProfile_HiddenIsVisibleOnlyToSelf(t *testing.T) {
	e := setup(t)
	ctx := context.Background()
	e.setProfile(t, e.bob, auth.ProfileUpdate{
		Bio:          strPtr("Пишу по ночам"),
		Crafts:       craftsPtr("Диалоги"),
		Discoverable: boolPtr(false),
	})

	// Чужому — 404, а не 403: по ответу нельзя отличить «скрылся» от «не существует».
	if _, err := e.svc.Profile(ctx, e.alice, e.bob); !errors.Is(err, people.ErrNotFound) {
		t.Fatalf("профиль скрытого для чужого ожидал ErrNotFound, получено %v", err)
	}
	if _, err := e.svc.Profile(ctx, e.alice, uuid.New()); !errors.Is(err, people.ErrNotFound) {
		t.Fatalf("несуществующий профиль ожидал ErrNotFound, получено %v", err)
	}

	// Себе — виден: иначе не посмотреть, как выглядит карточка, пока скрыт.
	own, err := e.svc.Profile(ctx, e.bob, e.bob)
	if err != nil {
		t.Fatalf("свой профиль скрытого: %v", err)
	}
	if own.Bio != "Пишу по ночам" || own.Discoverable {
		t.Fatalf("свой профиль вернул %+v", own.UserPublic)
	}
	if len(own.Crafts) != 1 || own.Crafts[0] != "Диалоги" {
		t.Fatalf("специализации в своём профиле: %+v", own.Crafts)
	}
	if own.Stories == nil {
		t.Fatal("stories должны уезжать пустым массивом, а не null")
	}
}

func TestProfile_PublicStoriesOnly(t *testing.T) {
	e := setup(t)
	ctx := context.Background()

	published, err := e.proj.Create(ctx, e.bob, "Опубликованный роман", "")
	if err != nil {
		t.Fatalf("project: %v", err)
	}
	draft, err := e.proj.Create(ctx, e.bob, "Черновик", "")
	if err != nil {
		t.Fatalf("draft: %v", err)
	}
	if _, err := e.feed.SetPublication(ctx, e.bob, published.ID, true); err != nil {
		t.Fatalf("publish: %v", err)
	}

	profile, err := e.svc.Profile(ctx, e.alice, e.bob)
	if err != nil {
		t.Fatalf("profile: %v", err)
	}
	if profile.PublicStories != 1 || len(profile.Stories) != 1 {
		t.Fatalf("публичных историй %d/%d, ожидалась одна", len(profile.Stories), profile.PublicStories)
	}
	if profile.Stories[0].ID != published.ID || profile.Stories[0].ID == draft.ID {
		t.Fatalf("в профиль попала не та история: %+v", profile.Stories)
	}
	if profile.Stories[0].Slug == "" || profile.Stories[0].Title != "Опубликованный роман" {
		t.Fatalf("история без ссылки или заголовка: %+v", profile.Stories[0])
	}

	// Счётчик в каталоге — тот же: интерфейс рисует его в строке списка.
	page, err := e.svc.Catalog(ctx, e.alice, people.Filter{Q: "bob"})
	if err != nil {
		t.Fatalf("catalog: %v", err)
	}
	if p := find(page.Items, e.bob); p == nil || p.PublicStories != 1 {
		t.Fatalf("public_stories в каталоге: %+v", p)
	}
}

func TestAuthUpdateProfile_DrivesCatalogAndSearch(t *testing.T) {
	e := setup(t)
	ctx := context.Background()

	// Пустые значения отбрасываются, дубли — без учёта регистра.
	u := e.setProfile(t, e.bob, auth.ProfileUpdate{
		Bio:    strPtr("  Пишу фэнтези  "),
		Crafts: craftsPtr("Диалоги", "   ", "диалоги", "Арт"),
	})
	if u.Bio != "Пишу фэнтези" {
		t.Fatalf("резюме не очищено от пробелов: %q", u.Bio)
	}
	if len(u.Crafts) != 2 || u.Crafts[0] != "Диалоги" || u.Crafts[1] != "Арт" {
		t.Fatalf("специализации почищены неверно: %+v", u.Crafts)
	}

	page, err := e.svc.Catalog(ctx, e.alice, people.Filter{Q: "bob"})
	if err != nil {
		t.Fatalf("catalog: %v", err)
	}
	if p := find(page.Items, e.bob); p == nil || p.Bio != "Пишу фэнтези" || len(p.Crafts) != 2 {
		t.Fatalf("карточка каталога не обновилась: %+v", p)
	}

	// Пределы: 600 рун на резюме, 12 специализаций по 60 рун.
	if _, err := e.auth.UpdateProfile(ctx, e.bob, auth.ProfileUpdate{Bio: strPtr(strings.Repeat("я", 601))}); !errors.Is(err, auth.ErrInvalidProfile) {
		t.Fatalf("резюме длиннее 600 рун ожидало ErrInvalidProfile, получено %v", err)
	}
	many := make([]string, 0, 13)
	for i := 0; i < 13; i++ {
		many = append(many, fmt.Sprintf("навык %d", i))
	}
	if _, err := e.auth.UpdateProfile(ctx, e.bob, auth.ProfileUpdate{Crafts: &many}); !errors.Is(err, auth.ErrInvalidProfile) {
		t.Fatalf("13 специализаций ожидали ErrInvalidProfile, получено %v", err)
	}
	if _, err := e.auth.UpdateProfile(ctx, e.bob, auth.ProfileUpdate{Crafts: craftsPtr(strings.Repeat("я", 61))}); !errors.Is(err, auth.ErrInvalidProfile) {
		t.Fatalf("специализация длиннее 60 рун ожидала ErrInvalidProfile, получено %v", err)
	}
	// Отклонённая правка ничего не записала.
	if fresh, err := e.st.GetUserByID(ctx, e.bob); err != nil || fresh.Bio != "Пишу фэнтези" || len(fresh.Crafts) != 2 {
		t.Fatalf("после ошибки профиль изменился: %+v (%v)", fresh, err)
	}

	// Частичная правка не стирает остальное: меняем имя — резюме на месте.
	u = e.setProfile(t, e.bob, auth.ProfileUpdate{DisplayName: "Борис Новый"})
	if u.DisplayName != "Борис Новый" || u.Bio != "Пишу фэнтези" || len(u.Crafts) != 2 || !u.Discoverable {
		t.Fatalf("частичная правка снесла поля: %+v", u)
	}

	// Галочка «не показывать меня» убирает из каталога и из поиска соавторов.
	e.setProfile(t, e.bob, auth.ProfileUpdate{Discoverable: boolPtr(false)})
	page, err = e.svc.Catalog(ctx, e.alice, people.Filter{Q: "bob"})
	if err != nil {
		t.Fatalf("catalog hidden: %v", err)
	}
	if len(page.Items) != 0 {
		t.Fatalf("скрытый человек остался в каталоге: %+v", page.Items)
	}
	found, err := e.st.SearchUsers(ctx, e.alice, "bob", 20)
	if err != nil {
		t.Fatalf("search hidden: %v", err)
	}
	if len(found) != 0 {
		t.Fatalf("скрытый человек находится поиском: %+v", found)
	}

	// Вернули видимость — снова находим обоими путями.
	e.setProfile(t, e.bob, auth.ProfileUpdate{Discoverable: boolPtr(true)})
	if found, err = e.st.SearchUsers(ctx, e.alice, "bob", 20); err != nil || len(found) != 1 {
		t.Fatalf("после возврата видимости поиск вернул %+v (%v)", found, err)
	}
	if page, err = e.svc.Catalog(ctx, e.alice, people.Filter{Q: "bob"}); err != nil || len(page.Items) != 1 {
		t.Fatalf("после возврата видимости каталог вернул %+v (%v)", page.Items, err)
	}

	// Явное опустошение: пустой список специализаций — это «убрать все», иначе
	// из профиля нельзя было бы убрать ни одну специализацию.
	u = e.setProfile(t, e.bob, auth.ProfileUpdate{Crafts: craftsPtr()})
	if len(u.Crafts) != 0 {
		t.Fatalf("пустой список должен убирать специализации: %+v", u.Crafts)
	}
}
