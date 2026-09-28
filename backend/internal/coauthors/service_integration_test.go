package coauthors_test

import (
	"context"
	"errors"
	"testing"

	"github.com/google/uuid"

	"github.com/skyfraze/backend/internal/coauthors"
	"github.com/skyfraze/backend/internal/platform/testdb"
	"github.com/skyfraze/backend/internal/projects"
	"github.com/skyfraze/backend/internal/store"
	"github.com/skyfraze/backend/internal/teams"
)

type env struct {
	st     *store.Store
	co     *coauthors.Service
	proj   *projects.Service
	alice  uuid.UUID
	bob    uuid.UUID
	closed uuid.UUID
}

func setup(t *testing.T) *env {
	t.Helper()
	pool := testdb.Setup(t, "coauthors")
	testdb.Truncate(t, pool, "coauthor_links", "project_ratings", "project_views",
		"registration_requests", "app_settings", "project_event_state", "sessions",
		"invitations", "event_assets", "assets", "events", "team_memberships",
		"projects", "users")

	ctx := context.Background()
	st := store.New(pool)
	proj := projects.New(st)

	alice, err := st.CreateUser(ctx, "alice@example.com", "hash", "Алиса")
	if err != nil {
		t.Fatalf("user alice: %v", err)
	}
	bob, err := st.CreateUser(ctx, "bob@example.com", "hash", "Борис")
	if err != nil {
		t.Fatalf("user bob: %v", err)
	}
	closed, err := proj.Create(ctx, alice.ID, "Закрытый роман", "черновик")
	if err != nil {
		t.Fatalf("project: %v", err)
	}
	return &env{st: st, co: coauthors.New(st), proj: proj, alice: alice.ID, bob: bob.ID, closed: closed.ID}
}

// becomeCoauthors — обычный путь: заявка от Алисы, согласие Бориса.
func (e *env) becomeCoauthors(t *testing.T) *store.CoauthorLink {
	t.Helper()
	ctx := context.Background()
	link, err := e.co.Invite(ctx, e.alice, e.bob, "пишем вместе", []string{"Правописание", "Проработка героя"})
	if err != nil {
		t.Fatalf("invite: %v", err)
	}
	if link.Status != store.CoauthorPending {
		t.Fatalf("после заявки статус %q, ожидался pending", link.Status)
	}
	accepted, err := e.co.Decide(ctx, e.bob, link.ID, true)
	if err != nil {
		t.Fatalf("accept: %v", err)
	}
	if accepted.Status != store.CoauthorAccepted {
		t.Fatalf("после согласия статус %q, ожидался accepted", accepted.Status)
	}
	return accepted
}

func TestCoauthor_ReadAccessFollowsOwnerToggle(t *testing.T) {
	e := setup(t)
	ctx := context.Background()
	link := e.becomeCoauthors(t)

	// Соавторство без разрешения: закрытый проект по-прежнему закрыт.
	if _, err := e.proj.Get(ctx, e.bob, e.closed); !errors.Is(err, projects.ErrForbidden) {
		t.Fatalf("без разрешения ожидался forbidden, получено %v", err)
	}

	// Разрешение даёт ВЛАДЕЛЕЦ проекта и только за себя.
	yes := true
	if _, err := e.co.Update(ctx, e.alice, link.ID, nil, &yes); err != nil {
		t.Fatalf("owner shares closed: %v", err)
	}

	access, err := e.proj.AccessOf(ctx, e.bob, e.closed)
	if err != nil {
		t.Fatalf("соавтор должен читать закрытый проект: %v", err)
	}
	if access.Role != store.RoleViewer || !access.Coauthor {
		t.Fatalf("доступ соавтора = %+v, ожидалась роль viewer с пометкой Coauthor", access)
	}

	// И это ровно чтение: правки закрыты на бэкенде.
	if err := e.proj.RequireEditor(ctx, e.bob, e.closed); !errors.Is(err, projects.ErrForbidden) {
		t.Fatalf("RequireEditor для соавтора ожидал forbidden, получено %v", err)
	}
	if err := e.proj.Update(ctx, e.bob, e.closed, "Переписал", ""); !errors.Is(err, projects.ErrForbidden) {
		t.Fatalf("Update соавтором ожидал forbidden, получено %v", err)
	}

	// Проект виден в списке «открытые соавторами».
	shared, err := e.proj.ListSharedByCoauthors(ctx, e.bob)
	if err != nil {
		t.Fatalf("list shared: %v", err)
	}
	if len(shared) != 1 || shared[0].ID != e.closed {
		t.Fatalf("в списке соавторских проектов %d записей, ожидался один закрытый роман", len(shared))
	}

	// Разрешение можно снять — доступ исчезает.
	no := false
	if _, err := e.co.Update(ctx, e.alice, link.ID, nil, &no); err != nil {
		t.Fatalf("owner revokes: %v", err)
	}
	if _, err := e.proj.Get(ctx, e.bob, e.closed); !errors.Is(err, projects.ErrForbidden) {
		t.Fatalf("после снятия разрешения ожидался forbidden, получено %v", err)
	}
}

// Добавление соавтора в проект — второй путь, ради которого круг и нужен:
// владелец выбирает человека из списка и сразу выдаёт роль, без ссылки-приглашения.
func TestCoauthor_AddedToProjectGetsRole(t *testing.T) {
	e := setup(t)
	ctx := context.Background()
	e.becomeCoauthors(t)
	teamsSvc := teams.New(e.st, e.proj)

	m, err := teamsSvc.AddMember(ctx, e.alice, e.closed, e.bob, store.RoleEditor)
	if err != nil {
		t.Fatalf("add member: %v", err)
	}
	if m.Role != store.RoleEditor {
		t.Fatalf("роль добавленного %q, ожидалась editor", m.Role)
	}
	if err := e.proj.RequireEditor(ctx, e.bob, e.closed); err != nil {
		t.Fatalf("редактор должен писать в проект: %v", err)
	}

	// Участник проекта больше не числится в «открытых соавторами» — иначе проект
	// дублировался бы в двух блоках списка.
	shared, err := e.proj.ListSharedByCoauthors(ctx, e.bob)
	if err != nil {
		t.Fatalf("list shared: %v", err)
	}
	if len(shared) != 0 {
		t.Fatalf("проект-участие не должен попадать в соавторские: %+v", shared)
	}

	// Добавлять участников может только владелец.
	if _, err := teamsSvc.AddMember(ctx, e.bob, e.closed, e.alice, store.RoleViewer); !errors.Is(err, teams.ErrForbidden) {
		t.Fatalf("не владелец не должен добавлять участников, получено %v", err)
	}
}

func TestCoauthor_PermissionsArePerSide(t *testing.T) {
	e := setup(t)
	ctx := context.Background()
	link := e.becomeCoauthors(t)

	// Борис тоже владелец закрытого проекта. Алиса пустила Бориса к себе — это
	// НЕ значит, что Борис пустил Алису к себе.
	bobProject, err := e.proj.Create(ctx, e.bob, "Заметки Бориса", "")
	if err != nil {
		t.Fatalf("project bob: %v", err)
	}
	yes := true
	if _, err := e.co.Update(ctx, e.alice, link.ID, nil, &yes); err != nil {
		t.Fatalf("alice shares: %v", err)
	}
	if _, err := e.proj.Get(ctx, e.bob, e.closed); err != nil {
		t.Fatalf("Борис должен читать проект Алисы: %v", err)
	}
	if _, err := e.proj.Get(ctx, e.alice, bobProject.ID); !errors.Is(err, projects.ErrForbidden) {
		t.Fatalf("разрешение Алисы не должно открывать проекты Бориса, получено %v", err)
	}

	// Обратное разрешение ставит Борис — и оно тоже только про его проекты.
	if _, err := e.co.Update(ctx, e.bob, link.ID, nil, &yes); err != nil {
		t.Fatalf("bob shares: %v", err)
	}
	if _, err := e.proj.Get(ctx, e.alice, bobProject.ID); err != nil {
		t.Fatalf("Алиса должна читать проект Бориса: %v", err)
	}
}

func TestCoauthor_MutualInviteAcceptsItself(t *testing.T) {
	e := setup(t)
	ctx := context.Background()

	if _, err := e.co.Invite(ctx, e.alice, e.bob, "Пойдёшь соавтором?", nil); err != nil {
		t.Fatalf("invite alice→bob: %v", err)
	}
	// Борис в ответ зовёт Алису: оба хотят — заявка принимается сразу.
	link, err := e.co.Invite(ctx, e.bob, e.alice, "Давай!", []string{"Ландшафты"})
	if err != nil {
		t.Fatalf("встречная заявка: %v", err)
	}
	if link.Status != store.CoauthorAccepted {
		t.Fatalf("встречная заявка должна становиться принятой, получено %q", link.Status)
	}
	list, err := e.co.List(ctx, e.alice)
	if err != nil {
		t.Fatalf("list: %v", err)
	}
	if len(list.Coauthors) != 1 || len(list.Incoming) != 0 || len(list.Outgoing) != 0 {
		t.Fatalf("ожидался один соавтор без висящих заявок: %+v", list)
	}

	// Повторно звать уже принятого соавтора нельзя.
	if _, err := e.co.Invite(ctx, e.alice, e.bob, "", nil); !errors.Is(err, coauthors.ErrAlreadyCoauthors) {
		t.Fatalf("повторная заявка ожидала ErrAlreadyCoauthors, получено %v", err)
	}
}

func TestCoauthor_DeclineAndRevoke(t *testing.T) {
	e := setup(t)
	ctx := context.Background()

	link, err := e.co.Invite(ctx, e.alice, e.bob, "", nil)
	if err != nil {
		t.Fatalf("invite: %v", err)
	}
	declined, err := e.co.Decide(ctx, e.bob, link.ID, false)
	if err != nil {
		t.Fatalf("decline: %v", err)
	}
	if declined.Status != store.CoauthorDeclined {
		t.Fatalf("после отказа статус %q", declined.Status)
	}
	// Отказ не мешает новой заявке: строка та же, статус снова pending.
	again, err := e.co.Invite(ctx, e.alice, e.bob, "ещё раз", nil)
	if err != nil {
		t.Fatalf("повторная заявка после отказа: %v", err)
	}
	if again.Status != store.CoauthorPending {
		t.Fatalf("статус повторной заявки %q, ожидался pending", again.Status)
	}

	// Соавторство можно разорвать с любой стороны.
	if _, err := e.co.Decide(ctx, e.bob, again.ID, true); err != nil {
		t.Fatalf("accept: %v", err)
	}
	if err := e.co.Remove(ctx, e.bob, again.ID); err != nil {
		t.Fatalf("remove: %v", err)
	}
	list, err := e.co.List(ctx, e.alice)
	if err != nil {
		t.Fatalf("list: %v", err)
	}
	if len(list.Coauthors)+len(list.Incoming)+len(list.Outgoing) != 0 {
		t.Fatalf("после разрыва связей быть не должно: %+v", list)
	}
	if err := e.co.Remove(ctx, e.bob, again.ID); !errors.Is(err, coauthors.ErrNotFound) {
		t.Fatalf("повторное удаление ожидало ErrNotFound, получено %v", err)
	}
}

func TestCoauthor_OnlyInviteeDecides(t *testing.T) {
	e := setup(t)
	ctx := context.Background()
	link, err := e.co.Invite(ctx, e.alice, e.bob, "", nil)
	if err != nil {
		t.Fatalf("invite: %v", err)
	}
	// Приглашающий не может сам принять свою заявку.
	if _, err := e.co.Decide(ctx, e.alice, link.ID, true); !errors.Is(err, coauthors.ErrNotFound) {
		t.Fatalf("приглашающий не должен принимать заявку, получено %v", err)
	}
}

func TestCoauthor_SearchByNickAndName(t *testing.T) {
	e := setup(t)
	ctx := context.Background()

	// Ники подобрались из email автоматически.
	bob, err := e.st.GetUserByID(ctx, e.bob)
	if err != nil {
		t.Fatalf("get bob: %v", err)
	}
	if bob.Username != "bob" {
		t.Fatalf("ник из email: %q, ожидался bob", bob.Username)
	}

	found, err := e.co.Search(ctx, e.alice, "bo")
	if err != nil {
		t.Fatalf("search: %v", err)
	}
	if len(found) != 1 || found[0].ID != e.bob || found[0].Relation != "" {
		t.Fatalf("поиск по нику вернул %+v", found)
	}

	// Поиск по имени — по вхождению, а не только с начала.
	found, err = e.co.Search(ctx, e.alice, "орис")
	if err != nil {
		t.Fatalf("search by name: %v", err)
	}
	if len(found) != 1 || found[0].ID != e.bob {
		t.Fatalf("поиск по имени вернул %+v", found)
	}

	// Себя в поиске не показываем.
	found, err = e.co.Search(ctx, e.alice, "alice")
	if err != nil {
		t.Fatalf("search self: %v", err)
	}
	if len(found) != 0 {
		t.Fatalf("себя в поиске быть не должно: %+v", found)
	}

	// Отношения видны в выдаче: сначала заявка, потом соавторство.
	if _, err := e.co.Invite(ctx, e.alice, e.bob, "", []string{"Магические системы"}); err != nil {
		t.Fatalf("invite: %v", err)
	}
	found, _ = e.co.Search(ctx, e.alice, "bob")
	if found[0].Relation != "request-outgoing" {
		t.Fatalf("для отправленной заявки отношение %q", found[0].Relation)
	}
	found, _ = e.co.Search(ctx, e.bob, "alice")
	if found[0].Relation != "request-incoming" {
		t.Fatalf("для входящей заявки отношение %q", found[0].Relation)
	}
	link, _ := e.st.GetCoauthorLink(ctx, e.alice, e.bob)
	if _, err := e.co.Decide(ctx, e.bob, link.ID, true); err != nil {
		t.Fatalf("accept: %v", err)
	}
	found, _ = e.co.Search(ctx, e.alice, "bob")
	if found[0].Relation != "coauthor" {
		t.Fatalf("для соавтора отношение %q", found[0].Relation)
	}
	if len(found[0].Crafts) != 1 || found[0].Crafts[0] != "Магические системы" {
		t.Fatalf("специализации в поиске: %+v", found[0].Crafts)
	}

	// Спецсимволы LIKE не должны превращать поиск в «показать всех».
	found, err = e.co.Search(ctx, e.alice, "%")
	if err != nil {
		t.Fatalf("search wildcard: %v", err)
	}
	if len(found) != 0 {
		t.Fatalf("«%%» не должен находить всех: %+v", found)
	}
}

func TestCoauthor_CraftsLimits(t *testing.T) {
	e := setup(t)
	ctx := context.Background()
	if _, err := e.co.Invite(ctx, e.alice, e.bob, "", []string{"  ", "Правописание", "правописание", "Арт"}); err != nil {
		t.Fatalf("invite: %v", err)
	}
	link, err := e.st.GetCoauthorLink(ctx, e.alice, e.bob)
	if err != nil {
		t.Fatalf("link: %v", err)
	}
	if len(link.Crafts) != 2 || link.Crafts[0] != "Правописание" || link.Crafts[1] != "Арт" {
		t.Fatalf("специализации почищены неверно: %+v", link.Crafts)
	}

	long := make([]string, 0, 13)
	for i := 0; i < 13; i++ {
		long = append(long, "навык")
	}
	if _, err := e.co.Invite(ctx, e.bob, e.alice, "", long); !errors.Is(err, coauthors.ErrInvalidCrafts) {
		t.Fatalf("слишком много специализаций ожидало ErrInvalidCrafts, получено %v", err)
	}
}
