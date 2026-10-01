package admin_test

import (
	"context"
	"errors"
	"testing"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/skyfraze/backend/internal/admin"
	"github.com/skyfraze/backend/internal/auth"
	"github.com/skyfraze/backend/internal/platform/testdb"
	"github.com/skyfraze/backend/internal/store"
)

// ---------- инфраструктура тестовой БД ----------
//
// Своя база (<TEST_DATABASE_URL>_admin): go test запускает пакеты параллельно, а
// интеграционные тесты соседних пакетов трункейтят свои таблицы.

type env struct {
	st   *store.Store
	auth *auth.Service
	svc  *admin.Service
	pool *pgxpool.Pool
}

func setup(t *testing.T) *env {
	t.Helper()
	ctx := context.Background()
	pool := testdb.Setup(t, "admin")
	testdb.Truncate(t, pool,
		"registration_requests", "app_settings", "project_ratings", "project_views",
		"project_event_state", "sessions", "invitations", "event_assets", "assets",
		"events", "team_memberships", "projects", "users")

	// Миграция кладёт дефолт; для чистоты каждого теста возвращаем его руками.
	if _, err := pool.Exec(ctx,
		`INSERT INTO app_settings (key, value) VALUES ($1,$2)
		 ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value, updated_by=NULL`,
		store.SettingRegistrationMode, store.RegistrationModeRequest); err != nil {
		t.Fatalf("seed mode: %v", err)
	}

	st := store.New(pool)
	authSvc := auth.New(st, "test-secret")
	return &env{st: st, auth: authSvc, svc: admin.New(st, authSvc), pool: pool}
}

// adminUser создаёт администратора и возвращает его id.
func (e *env) adminUser(t *testing.T, email string) uuid.UUID {
	t.Helper()
	u, err := e.st.CreateUser(context.Background(), email, "hash", email)
	if err != nil {
		t.Fatalf("create admin %s: %v", email, err)
	}
	if err := e.st.SetUserAdmin(context.Background(), u.Email, true); err != nil {
		t.Fatalf("grant admin: %v", err)
	}
	return u.ID
}

// ---------- тесты ----------

func TestDefaultModeIsByRequest(t *testing.T) {
	e := setup(t)
	ctx := context.Background()

	if got := e.auth.RegistrationMode(ctx); got != store.RegistrationModeRequest {
		t.Fatalf("по умолчанию режим должен быть «по заявке», получено %q", got)
	}
	// Инсталляция не пустая: на пустой действует окно первого администратора,
	// поэтому «закрытость» проверяем на инсталляции, где аккаунты уже есть.
	if _, err := e.st.CreateUser(ctx, "existing@e.com", "hash", "Existing"); err != nil {
		t.Fatalf("подготовка пользователя: %v", err)
	}
	if _, _, err := e.auth.Register(ctx, "anyone@e.com", "hunter22!", "Anyone"); !errors.Is(err, auth.ErrRegistrationClosed) {
		t.Fatalf("прямая регистрация в режиме «по заявке» должна отклоняться, получено %v", err)
	}
	// Заявку при этом принять можно.
	req, err := e.auth.SubmitRegistrationRequest(ctx, "anyone@e.com", "hunter22!", "Anyone", "хочу доступ")
	if err != nil {
		t.Fatalf("заявка: %v", err)
	}
	if req.Status != "pending" {
		t.Fatalf("новая заявка должна быть pending, получено %q", req.Status)
	}
	// Повторная заявка тем же email — конфликт, а не вторая строка.
	if _, err := e.auth.SubmitRegistrationRequest(ctx, "anyone@e.com", "hunter22!", "Anyone", ""); !errors.Is(err, store.ErrPendingRequestExists) {
		t.Fatalf("повторная заявка должна отклоняться, получено %v", err)
	}
	// До одобрения входа нет, но причина понятна.
	if _, _, err := e.auth.Login(ctx, "anyone@e.com", "hunter22!"); !errors.Is(err, auth.ErrRequestPending) {
		t.Fatalf("вход по неодобренной заявке должен сообщать о рассмотрении, получено %v", err)
	}
	// Чужой пароль не должен раскрывать наличие заявки.
	if _, _, err := e.auth.Login(ctx, "anyone@e.com", "wrong-password"); !errors.Is(err, auth.ErrInvalidCreds) {
		t.Fatalf("неверный пароль должен давать обычную ошибку входа, получено %v", err)
	}
}

func TestApproveCreatesAccountAndRejectBlocks(t *testing.T) {
	e := setup(t)
	ctx := context.Background()
	adminID := e.adminUser(t, "admin@e.com")

	approved, err := e.auth.SubmitRegistrationRequest(ctx, "yes@e.com", "hunter22!", "Yes", "")
	if err != nil {
		t.Fatalf("заявка: %v", err)
	}
	rejected, err := e.auth.SubmitRegistrationRequest(ctx, "no@e.com", "hunter22!", "No", "")
	if err != nil {
		t.Fatalf("заявка: %v", err)
	}

	u, err := e.svc.Approve(ctx, adminID, approved.ID)
	if err != nil {
		t.Fatalf("одобрение: %v", err)
	}
	if u.Email != "yes@e.com" {
		t.Fatalf("одобрен не тот пользователь: %+v", u)
	}
	if u.IsAdmin {
		t.Error("одобренный заявкой пользователь не должен становиться администратором")
	}
	// Повторное одобрение не должно создать второго пользователя.
	if _, err := e.svc.Approve(ctx, adminID, approved.ID); !errors.Is(err, admin.ErrNotFound) {
		t.Fatalf("повторное одобрение должно отклоняться, получено %v", err)
	}
	// Пароль, указанный при подаче заявки, работает.
	if _, _, err := e.auth.Login(ctx, "yes@e.com", "hunter22!"); err != nil {
		t.Fatalf("одобренный пользователь должен войти своим паролем: %v", err)
	}

	if err := e.svc.Reject(ctx, adminID, rejected.ID, "нет квоты"); err != nil {
		t.Fatalf("отклонение: %v", err)
	}
	if _, _, err := e.auth.Login(ctx, "no@e.com", "hunter22!"); !errors.Is(err, auth.ErrRequestRejected) {
		t.Fatalf("отклонённая заявка должна сообщать об отказе, получено %v", err)
	}

	// Список заявок виден админу и различается по статусу.
	pending, err := e.svc.Requests(ctx, "pending")
	if err != nil {
		t.Fatalf("список заявок: %v", err)
	}
	if len(pending) != 0 {
		t.Fatalf("необработанных заявок быть не должно, получено %d", len(pending))
	}
	all, err := e.svc.Requests(ctx, "")
	if err != nil || len(all) != 2 {
		t.Fatalf("ожидалось 2 заявки, получено %d (err=%v)", len(all), err)
	}
	if _, err := e.svc.Requests(ctx, "wat"); !errors.Is(err, admin.ErrBadDecision) {
		t.Fatalf("неизвестный статус должен отклоняться, получено %v", err)
	}
}

func TestAdminRightsRequiredAndModeSwitch(t *testing.T) {
	e := setup(t)
	adminID := e.adminUser(t, "admin@e.com")
	ctx := context.Background()

	plain, err := e.st.CreateUser(ctx, "user@e.com", "hash", "User")
	if err != nil {
		t.Fatalf("create user: %v", err)
	}
	if _, err := e.svc.RequireAdmin(ctx, plain.ID); !errors.Is(err, admin.ErrForbidden) {
		t.Fatalf("обычный пользователь не должен получать админ-права, получено %v", err)
	}
	if _, err := e.svc.SetRegistrationMode(ctx, adminID, "sometimes"); !errors.Is(err, admin.ErrBadMode) {
		t.Fatalf("неизвестный режим должен отклоняться, получено %v", err)
	}

	if _, err := e.svc.SetRegistrationMode(ctx, adminID, store.RegistrationModeOpen); err != nil {
		t.Fatalf("переключение в open: %v", err)
	}
	if _, _, err := e.auth.Register(ctx, "free@e.com", "hunter22!", "Free"); err != nil {
		t.Fatalf("в режиме open регистрация должна работать: %v", err)
	}
	// Решение админа фиксируется автором — значит, env больше не перебивает режим.
	changed, err := e.st.SeedSettingIfUnchanged(ctx, store.SettingRegistrationMode, store.RegistrationModeRequest)
	if err != nil {
		t.Fatalf("seed: %v", err)
	}
	if changed {
		t.Error("после решения администратора значение из окружения не должно применяться")
	}
	if mode := e.auth.RegistrationMode(ctx); mode != store.RegistrationModeOpen {
		t.Errorf("режим должен остаться open, получено %q", mode)
	}

	if _, err := e.svc.SetRegistrationMode(ctx, adminID, store.RegistrationModeRequest); err != nil {
		t.Fatalf("возврат в request: %v", err)
	}
	if _, _, err := e.auth.Register(ctx, "late@e.com", "hunter22!", "Late"); !errors.Is(err, auth.ErrRegistrationClosed) {
		t.Fatalf("после возврата в request регистрация должна закрываться, получено %v", err)
	}
}

func TestBootstrapAndConfiguredAdminRegistration(t *testing.T) {
	e := setup(t)
	ctx := context.Background()

	// Пустая инсталляция в режиме «по заявке»: первый аккаунт создать можно,
	// иначе одобрять заявки было бы некому.
	if mode, bootstrap := e.auth.RegistrationInfo(ctx); mode != store.RegistrationModeRequest || !bootstrap {
		t.Fatalf("пустая инсталляция должна сообщать bootstrap=true, получено mode=%q bootstrap=%v", mode, bootstrap)
	}
	first, _, err := e.auth.Register(ctx, "first@e.com", "hunter22!", "First")
	if err != nil {
		t.Fatalf("первый аккаунт должен создаваться даже в режиме «по заявке»: %v", err)
	}
	if !first.IsAdmin {
		t.Error("первый аккаунт становится администратором")
	}

	// Инсталляция больше не пустая — окно bootstrap закрылось.
	if _, bootstrap := e.auth.RegistrationInfo(ctx); bootstrap {
		t.Error("после первого аккаунта bootstrap должен быть false")
	}
	if _, _, err := e.auth.Register(ctx, "second@e.com", "hunter22!", "Second"); !errors.Is(err, auth.ErrRegistrationClosed) {
		t.Fatalf("второй аккаунт в режиме «по заявке» должен требовать заявку, получено %v", err)
	}

	// Администратор из ADMIN_EMAILS заводит себе аккаунт независимо от режима.
	e.auth.SetAdminEmails([]string{"knagaenko@mail.ru"})
	admin, _, err := e.auth.Register(ctx, "knagaenko@mail.ru", "hunter22!", "Owner")
	if err != nil {
		t.Fatalf("email из ADMIN_EMAILS должен уметь регистрироваться: %v", err)
	}
	if !admin.IsAdmin {
		t.Error("email из ADMIN_EMAILS получает права администратора сразу")
	}
	// А обычный email — по-прежнему нет.
	if _, _, err := e.auth.Register(ctx, "stranger@e.com", "hunter22!", "Stranger"); !errors.Is(err, auth.ErrRegistrationClosed) {
		t.Fatalf("посторонний должен получать заявку, а не аккаунт, получено %v", err)
	}
}

func TestFirstUserBecomesAdminAndEnvGrantsRights(t *testing.T) {
	e := setup(t)
	ctx := context.Background()

	// Пустая инсталляция: первый зарегистрированный — администратор, иначе
	// управлять развёртыванием было бы некому.
	if _, err := e.svc.SetRegistrationMode(ctx, uuid.Nil, store.RegistrationModeOpen); err != nil {
		t.Fatalf("режим open: %v", err)
	}
	first, _, err := e.auth.Register(ctx, "first@e.com", "hunter22!", "First")
	if err != nil {
		t.Fatalf("register first: %v", err)
	}
	if !first.IsAdmin {
		t.Error("первый пользователь инсталляции должен стать администратором")
	}

	// Второй — обычный, но ADMIN_EMAILS выдаёт ему права при входе.
	if _, _, err := e.auth.Register(ctx, "ops@e.com", "hunter22!", "Ops"); err != nil {
		t.Fatalf("register ops: %v", err)
	}
	e.auth.SetAdminEmails([]string{" OPS@e.com ", ""})
	ops, _, err := e.auth.Login(ctx, "ops@e.com", "hunter22!")
	if err != nil {
		t.Fatalf("login ops: %v", err)
	}
	if !ops.IsAdmin {
		t.Error("email из ADMIN_EMAILS должен получать права администратора при входе")
	}
	if got := e.auth.AdminEmails(); len(got) != 1 || got[0] != "ops@e.com" {
		t.Errorf("список админов должен быть нормализован, получено %v", got)
	}

	settings, err := e.svc.Settings(ctx)
	if err != nil {
		t.Fatalf("settings: %v", err)
	}
	if settings.Admins != 2 || settings.Users != 2 {
		t.Errorf("ожидалось 2 админа и 2 пользователя, получено %+v", settings)
	}
}
