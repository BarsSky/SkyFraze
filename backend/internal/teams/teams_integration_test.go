package teams_test

// teams_integration_test.go — участие в проекте: приглашения, роли, удаление (0.153.1).
//
// Почему отдельный файл. `internal/teams` был единственным пакетом с логикой прав без
// тестов: приглашение, принятие по ссылке, смена роли и удаление участника проверялись
// только руками. Ошибка здесь тихая и дорогая — «редактор удалил владельца» или
// «приглашение принял не тот человек» не видны до момента, когда это случилось.

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/google/uuid"

	"github.com/skyfraze/backend/internal/platform/testdb"
	"github.com/skyfraze/backend/internal/projects"
	"github.com/skyfraze/backend/internal/store"
	"github.com/skyfraze/backend/internal/teams"
)

type env struct {
	st      *store.Store
	proj    *projects.Service
	svc     *teams.Service
	project uuid.UUID
	owner   uuid.UUID
	editor  uuid.UUID
	viewer  uuid.UUID
	other   uuid.UUID
}

func setupTeams(t *testing.T) *env {
	t.Helper()
	pool := testdb.Setup(t, "teams")
	testdb.Truncate(t, pool, "invitations", "project_ratings", "project_views",
		"registration_requests", "app_settings", "project_event_state", "sessions",
		"event_assets", "assets", "events", "team_memberships", "projects", "users")

	ctx := context.Background()
	st := store.New(pool)
	proj := projects.New(st)
	mk := func(email, name string) uuid.UUID {
		u, err := st.CreateUser(ctx, email, "hash", name)
		if err != nil {
			t.Fatalf("пользователь %s: %v", email, err)
		}
		return u.ID
	}
	e := &env{
		st: st, proj: proj, svc: teams.New(st, proj),
		owner:  mk("owner@example.com", "Владелец"),
		editor: mk("editor@example.com", "Редактор"),
		viewer: mk("viewer@example.com", "Читатель"),
		other:  mk("other@example.com", "Посторонний"),
	}
	project, err := proj.Create(ctx, e.owner, "Роман", "")
	if err != nil {
		t.Fatalf("проект: %v", err)
	}
	e.project = project.ID
	if err := st.AddMembership(ctx, e.project, e.editor, store.RoleEditor); err != nil {
		t.Fatalf("редактор: %v", err)
	}
	if err := st.AddMembership(ctx, e.project, e.viewer, store.RoleViewer); err != nil {
		t.Fatalf("читатель: %v", err)
	}
	return e
}

func TestInviteOnlyOwnerAndOnlyMemberRoles(t *testing.T) {
	e := setupTeams(t)
	ctx := context.Background()

	inv, err := e.svc.Invite(ctx, e.owner, e.project, "new@example.com", store.RoleEditor)
	if err != nil {
		t.Fatalf("владелец пригласил: %v", err)
	}
	if inv.Token == "" || len(inv.Token) < 20 {
		t.Fatalf("токен приглашения: %q", inv.Token)
	}
	if !inv.ExpiresAt.After(time.Now()) {
		t.Fatalf("приглашение уже просрочено: %v", inv.ExpiresAt)
	}

	// Редактор приглашать не может: это решение владельца.
	if _, err := e.svc.Invite(ctx, e.editor, e.project, "x@example.com", store.RoleViewer); !errors.Is(err, teams.ErrForbidden) {
		t.Fatalf("редактор пригласил: %v", err)
	}
	// Роль владельца через приглашение не выдаётся.
	if _, err := e.svc.Invite(ctx, e.owner, e.project, "y@example.com", store.RoleOwner); err == nil {
		t.Fatal("приглашение с ролью owner принято")
	}
	// Себя приглашать нечего.
	if _, err := e.svc.Invite(ctx, e.owner, e.project, "owner@example.com", store.RoleEditor); !errors.Is(err, teams.ErrSelfInviteOnly) {
		t.Fatalf("самоприглашение: %v", err)
	}
}

func TestAcceptInvitationFlow(t *testing.T) {
	e := setupTeams(t)
	ctx := context.Background()

	// Приглашение по адресу принимает именно этот человек.
	inv, err := e.svc.Invite(ctx, e.owner, e.project, "other@example.com", store.RoleViewer)
	if err != nil {
		t.Fatalf("приглашение: %v", err)
	}
	membership, err := e.svc.Accept(ctx, e.other, inv.Token)
	if err != nil {
		t.Fatalf("принятие: %v", err)
	}
	if membership.Role != store.RoleViewer {
		t.Fatalf("роль после принятия: %q", membership.Role)
	}
	// Второй раз — «уже принято», а не тихое повторное добавление.
	if _, err := e.svc.Accept(ctx, e.other, inv.Token); !errors.Is(err, teams.ErrInvitationUsed) {
		t.Fatalf("повторное принятие: %v", err)
	}
	// Чужой адрес — отказ: приглашение адресное.
	foreign, err := e.svc.Invite(ctx, e.owner, e.project, "someone@example.com", store.RoleEditor)
	if err != nil {
		t.Fatalf("второе приглашение: %v", err)
	}
	if _, err := e.svc.Accept(ctx, e.viewer, foreign.Token); !errors.Is(err, teams.ErrForbidden) {
		t.Fatalf("принятие чужого приглашения: %v", err)
	}
	// Просроченное — «истекло».
	expired := &store.Invitation{
		ProjectID: e.project, Email: "late@example.com", Role: store.RoleViewer,
		Token: "expired-token", InvitedBy: e.owner, ExpiresAt: time.Now().Add(-time.Hour),
	}
	if err := e.st.CreateInvitation(ctx, expired); err != nil {
		t.Fatalf("просроченное приглашение: %v", err)
	}
	if _, err := e.svc.Accept(ctx, e.other, "expired-token"); !errors.Is(err, teams.ErrInvitationGone) {
		t.Fatalf("просроченное принято: %v", err)
	}
}

func TestAddMemberRules(t *testing.T) {
	e := setupTeams(t)
	ctx := context.Background()

	membership, err := e.svc.AddMember(ctx, e.owner, e.project, e.other, store.RoleEditor)
	if err != nil {
		t.Fatalf("добавление: %v", err)
	}
	if membership.Role != store.RoleEditor {
		t.Fatalf("роль: %q", membership.Role)
	}
	if _, err := e.svc.AddMember(ctx, e.owner, e.project, e.owner, store.RoleEditor); !errors.Is(err, teams.ErrSelfInviteOnly) {
		t.Fatalf("добавление владельца: %v", err)
	}
	if _, err := e.svc.AddMember(ctx, e.editor, e.project, e.viewer, store.RoleEditor); !errors.Is(err, teams.ErrForbidden) {
		t.Fatalf("редактор добавил участника: %v", err)
	}
	if _, err := e.svc.AddMember(ctx, e.owner, e.project, uuid.New(), store.RoleViewer); !errors.Is(err, store.ErrNotFound) {
		t.Fatalf("добавление несуществующего: %v", err)
	}
}

func TestRemoveAndChangeRoleRules(t *testing.T) {
	e := setupTeams(t)
	ctx := context.Background()

	// Владелец убирает участника.
	if err := e.svc.Remove(ctx, e.owner, e.project, e.editor); err != nil {
		t.Fatalf("удаление редактора: %v", err)
	}
	if _, err := e.st.GetMembership(ctx, e.project, e.editor); !errors.Is(err, store.ErrNotFound) {
		t.Fatalf("редактор остался: %v", err)
	}
	// Себя — нельзя.
	if err := e.svc.Remove(ctx, e.owner, e.project, e.owner); err == nil {
		t.Fatal("владелец удалил себя")
	}
	// Не владелец — не может.
	if err := e.svc.Remove(ctx, e.viewer, e.project, e.owner); !errors.Is(err, teams.ErrForbidden) {
		t.Fatalf("читатель удалил владельца: %v", err)
	}

	// Смена роли — только владелец.
	if err := e.svc.ChangeRole(ctx, e.owner, e.project, e.viewer, store.RoleEditor); err != nil {
		t.Fatalf("смена роли: %v", err)
	}
	membership, err := e.st.GetMembership(ctx, e.project, e.viewer)
	if err != nil || membership.Role != store.RoleEditor {
		t.Fatalf("роль после смены: %v, %v", err, membership)
	}
	if err := e.svc.ChangeRole(ctx, e.viewer, e.project, e.other, store.RoleEditor); !errors.Is(err, teams.ErrForbidden) {
		t.Fatalf("редактор сменил роль: %v", err)
	}
	if err := e.svc.ChangeRole(ctx, e.owner, e.project, e.viewer, store.RoleOwner); err == nil {
		t.Fatal("роль owner выдана сменой роли")
	}
}

func TestListMembersAndInvitations(t *testing.T) {
	e := setupTeams(t)
	ctx := context.Background()

	members, err := e.svc.ListMembers(ctx, e.viewer, e.project)
	if err != nil {
		t.Fatalf("список участников: %v", err)
	}
	if len(members) < 3 {
		t.Fatalf("участников %d, ожидалось минимум 3", len(members))
	}
	// Посторонний не видит ни участников, ни приглашений.
	if _, err := e.svc.ListMembers(ctx, e.other, e.project); err == nil {
		t.Fatal("посторонний увидел участников")
	}
	if _, err := e.svc.Invite(ctx, e.owner, e.project, "pending@example.com", store.RoleViewer); err != nil {
		t.Fatalf("приглашение: %v", err)
	}
	pending, err := e.svc.ListInvitations(ctx, e.viewer, e.project)
	if err != nil || len(pending) != 1 {
		t.Fatalf("приглашения: %v, %d", err, len(pending))
	}
	if pending[0].Email != "pending@example.com" {
		t.Fatalf("не то приглашение: %+v", pending[0])
	}
	if _, err := e.svc.ListInvitations(ctx, e.other, e.project); err == nil {
		t.Fatal("посторонний увидел приглашения")
	}
}
