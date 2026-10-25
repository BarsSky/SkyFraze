package projects_test

// trash_integration_test.go — корзина проектов (0.54.0).
//
// Удаление проекта стало мягким: строка помечается deleted_at, проект пропадает из списка,
// из API и из публичной ленты, но 30 дней его можно вернуть одной кнопкой — с текстом,
// вложениями и историей. Проверяется не «есть ли колонка», а обещания интерфейса:
//
//   - удалённый проект не виден НИКОМУ, включая команду (иначе «удалил» значило бы
//     «спрятал от себя, оставил соавторам»);
//   - вернуть может только владелец, и возврат полный;
//   - окончательное удаление необратимо и уносит файлы;
//   - «через 30 дней» выполняет уборщик, а не человек.
//
// Нужна Postgres (TEST_DATABASE_URL), как и остальным интеграционным тестам.

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"

	"github.com/skyfraze/backend/internal/assets"
	"github.com/skyfraze/backend/internal/auth"
	"github.com/skyfraze/backend/internal/platform/testdb"
	"github.com/skyfraze/backend/internal/projects"
	"github.com/skyfraze/backend/internal/storage"
	"github.com/skyfraze/backend/internal/store"
)

const trashSecret = "test-secret-projects-trash"

// trashTables — всё, что нужно вычистить между тестами корзины. Список тот же, что у
// остальных тестов пакета: база на пакет одна.
var trashTables = []string{
	"project_ratings", "project_views", "registration_requests", "app_settings",
	"project_event_state", "sessions", "invitations", "event_assets", "assets",
	"events", "team_memberships", "projects", "users",
}

// trashEnv — то, что нужно каждому тесту корзины: база, сервисы и локальное хранилище.
type trashEnv struct {
	ctx   context.Context
	st    *store.Store
	svc   *projects.Service
	obj   storage.ObjectStore
	auth  *auth.Service
	owner *store.User
	other *store.User
}

func newTrashEnv(t *testing.T) *trashEnv {
	t.Helper()
	pool := testdb.Setup(t, "projects")
	testdb.Truncate(t, pool, trashTables...)

	obj, err := storage.NewLocal(t.TempDir())
	if err != nil {
		t.Fatalf("хранилище: %v", err)
	}
	st := store.New(pool)
	svc := projects.New(st)

	ctx := context.Background()
	authSvc := auth.New(st, trashSecret)
	owner, _, err := authSvc.Register(ctx, "owner@example.com", "hunter22!", "Владелец")
	if err != nil {
		t.Fatalf("владелец: %v", err)
	}
	// Второй человек — это команда: он в проекте, и удаление должно закрыть проект и ему.
	// Заводим его строкой в базе, а не регистрацией: после первого аккаунта регистрация
	// закрыта (режим «по заявке»), и это правильно — тест не должен её открывать.
	hash, err := auth.HashPassword("hunter22!")
	if err != nil {
		t.Fatalf("пароль: %v", err)
	}
	other, err := st.CreateUserWithHash(ctx, "coauthor@example.com", hash, "Соавтор", false)
	if err != nil {
		t.Fatalf("соавтор: %v", err)
	}
	return &trashEnv{ctx: ctx, st: st, svc: svc, obj: obj, auth: authSvc, owner: owner, other: other}
}

// mustProject создаёт проект владельца и добавляет в него второго человека с ролью role.
func (e *trashEnv) mustProject(t *testing.T, title string, role store.Role) *store.Project {
	t.Helper()
	p, err := e.svc.Create(e.ctx, e.owner.ID, title, "описание")
	if err != nil {
		t.Fatalf("проект %q: %v", title, err)
	}
	if err := e.st.AddMembership(e.ctx, p.ID, e.other.ID, role); err != nil {
		t.Fatalf("участие в %q: %v", title, err)
	}
	return p
}

// TestProjectTrashHidesFromEveryoneAndRestores — главное обещание корзины: «удалил» значит
// «не видно никому», а «вернул» значит «всё на месте».
func TestProjectTrashHidesFromEveryoneAndRestores(t *testing.T) {
	e := newTrashEnv(t)
	p := e.mustProject(t, "Рукопись", store.RoleEditor)

	// Удалить может только владелец: у редактора кнопки «удалить» в интерфейсе нет, и API
	// не должен разрешать то, чего нет в интерфейсе.
	if err := e.svc.Delete(e.ctx, e.other.ID, p.ID); err != projects.ErrForbidden {
		t.Fatalf("удаление редактором: %v, ожидалось ErrForbidden", err)
	}
	if err := e.svc.Delete(e.ctx, e.owner.ID, p.ID); err != nil {
		t.Fatalf("удаление владельцем: %v", err)
	}
	// Повторное удаление — не ошибка (человек мог нажать дважды), но срок хранения не
	// сдвигается: иначе повторные нажатия продлевали бы корзину бесконечно.
	first, err := e.st.DeletedProject(e.ctx, p.ID)
	if err != nil {
		t.Fatalf("запись корзины: %v", err)
	}
	if first.DeletedAt == nil {
		t.Fatal("у проекта в корзине нет deleted_at")
	}
	if err := e.svc.Delete(e.ctx, e.owner.ID, p.ID); err != nil {
		t.Fatalf("повторное удаление: %v", err)
	}
	again, err := e.st.DeletedProject(e.ctx, p.ID)
	if err != nil {
		t.Fatalf("запись корзины после повтора: %v", err)
	}
	if !again.DeletedAt.Equal(*first.DeletedAt) {
		t.Errorf("срок хранения сдвинулся: было %s, стало %s", first.DeletedAt, again.DeletedAt)
	}

	// Проекта нет ни у владельца, ни у команды.
	for _, uid := range []uuid.UUID{e.owner.ID, e.other.ID} {
		list, err := e.svc.List(e.ctx, uid)
		if err != nil {
			t.Fatalf("список %s: %v", uid, err)
		}
		if len(list) != 0 {
			t.Errorf("у %s в списке %d проектов, ожидалось 0", uid, len(list))
		}
	}
	// И читать/править его нельзя даже по прямому идентификатору: фильтр стоит на членстве,
	// а не на списке. Иначе удалённый проект открывался бы по ссылке из истории браузера.
	if _, err := e.svc.Get(e.ctx, e.owner.ID, p.ID); err == nil {
		t.Fatal("удалённый проект читается владельцем")
	}
	if err := e.svc.RequireEditor(e.ctx, e.other.ID, p.ID); err != projects.ErrForbidden {
		t.Errorf("редактор пишет в удалённый проект: %v", err)
	}

	// Корзина — личное хозяйство владельца: у соавтора её нет.
	if trash, err := e.svc.Trash(e.ctx, e.other.ID); err != nil {
		t.Fatalf("корзина соавтора: %v", err)
	} else if len(trash) != 0 {
		t.Errorf("в корзине соавтора %d проектов, ожидалось 0", len(trash))
	}
	trash, err := e.svc.Trash(e.ctx, e.owner.ID)
	if err != nil {
		t.Fatalf("корзина владельца: %v", err)
	}
	if len(trash) != 1 || trash[0].ID != p.ID {
		t.Fatalf("корзина владельца: %+v", trash)
	}
	if trash[0].DeletedAt == nil {
		t.Fatal("в корзине проект без deleted_at")
	}

	// Вернуть может только владелец.
	if err := e.svc.Restore(e.ctx, e.other.ID, p.ID); err != projects.ErrForbidden {
		t.Errorf("возврат редактором: %v, ожидалось ErrForbidden", err)
	}
	if err := e.svc.Restore(e.ctx, e.owner.ID, p.ID); err != nil {
		t.Fatalf("возврат владельцем: %v", err)
	}
	// Возврат полный: заголовок и описание те же, участие второго человека сохранилось.
	back, err := e.svc.Get(e.ctx, e.owner.ID, p.ID)
	if err != nil {
		t.Fatalf("проект после возврата: %v", err)
	}
	if back.Title != "Рукопись" || back.Description != "описание" {
		t.Errorf("после возврата проект другой: %q / %q", back.Title, back.Description)
	}
	if err := e.svc.RequireEditor(e.ctx, e.other.ID, p.ID); err != nil {
		t.Errorf("после возврата редактор потерял доступ: %v", err)
	}
	if trash, err := e.svc.Trash(e.ctx, e.owner.ID); err != nil || len(trash) != 0 {
		t.Errorf("корзина после возврата: %d проектов, %v", len(trash), err)
	}
	// Возврат проекта, которого нет в корзине, — «не найдено», а не тихий успех.
	if err := e.svc.Restore(e.ctx, e.owner.ID, p.ID); err != projects.ErrNotFound {
		t.Errorf("возврат активного проекта: %v, ожидалось ErrNotFound", err)
	}
}

// TestProjectTrashHTTP — то, что видит браузер: срок, дни до конца, коды ответов.
func TestProjectTrashHTTP(t *testing.T) {
	e := newTrashEnv(t)
	p := e.mustProject(t, "Черновик", store.RoleEditor)

	h := projects.NewHandler(e.svc, slog.New(slog.NewTextHandler(io.Discard, nil)))
	r := chi.NewRouter()
	r.With(e.auth.WithUser).Get("/api/projects/trash", h.Trash)
	r.With(e.auth.WithUser).Post("/api/projects/{id}/restore", h.RestoreTrash)
	r.With(e.auth.WithUser).Delete("/api/projects/{id}/purge", h.PurgeTrash)

	if err := e.svc.Delete(e.ctx, e.owner.ID, p.ID); err != nil {
		t.Fatalf("удаление: %v", err)
	}

	// delete — помощник: выполняет запрос с токеном указанного человека.
	call := func(method, path string, u *store.User) *httptest.ResponseRecorder {
		t.Helper()
		req := httptest.NewRequest(method, path, nil)
		req.Header.Set("Authorization", "Bearer "+accessToken(t, e, u))
		rec := httptest.NewRecorder()
		r.ServeHTTP(rec, req)
		return rec
	}

	rec := call(http.MethodGet, "/api/projects/trash", e.owner)
	if rec.Code != http.StatusOK {
		t.Fatalf("корзина: код %d, тело %s", rec.Code, rec.Body.String())
	}
	var body struct {
		RetentionDays int `json:"retention_days"`
		Projects      []struct {
			ID        uuid.UUID `json:"id"`
			Title     string    `json:"title"`
			DeletedAt *string   `json:"deleted_at"`
			DaysLeft  *int      `json:"days_left"`
		} `json:"projects"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatalf("json корзины: %v (%s)", err, rec.Body.String())
	}
	if body.RetentionDays != 30 {
		t.Errorf("срок хранения в ответе %d, ожидалось 30", body.RetentionDays)
	}
	if len(body.Projects) != 1 {
		t.Fatalf("проектов в корзине %d, ожидался 1 (%s)", len(body.Projects), rec.Body.String())
	}
	item := body.Projects[0]
	if item.ID != p.ID || item.Title != "Черновик" || item.DeletedAt == nil {
		t.Errorf("строка корзины: %+v", item)
	}
	// Удалённый минуту назад проект должен обещать «ещё 30 дней», а не 29: интерфейс
	// показывает это число как срок восстановления.
	if item.DaysLeft == nil || *item.DaysLeft != 30 {
		t.Errorf("дней осталось %v, ожидалось 30", item.DaysLeft)
	}

	// Команде проекта в корзине не видно, и вернуть его она не может.
	if rec := call(http.MethodGet, "/api/projects/trash", e.other); rec.Code != http.StatusOK {
		t.Fatalf("корзина соавтора: код %d", rec.Code)
	} else if !bytes.Contains(rec.Body.Bytes(), []byte(`"projects":[]`)) {
		t.Errorf("в корзине соавтора что-то есть: %s", rec.Body.String())
	}
	if rec := call(http.MethodPost, "/api/projects/"+p.ID.String()+"/restore", e.other); rec.Code != http.StatusForbidden {
		t.Errorf("возврат редактором: код %d, ожидался 403", rec.Code)
	}
	if rec := call(http.MethodPost, "/api/projects/"+p.ID.String()+"/restore", e.owner); rec.Code != http.StatusNoContent {
		t.Fatalf("возврат: код %d, тело %s", rec.Code, rec.Body.String())
	}

	// Окончательное удаление — только из корзины: активный проект «навсегда» не удаляется,
	// иначе корзина была бы декорацией.
	if rec := call(http.MethodDelete, "/api/projects/"+p.ID.String()+"/purge", e.owner); rec.Code != http.StatusNotFound {
		t.Errorf("purge активного проекта: код %d, ожидался 404", rec.Code)
	}
	if err := e.svc.Delete(e.ctx, e.owner.ID, p.ID); err != nil {
		t.Fatalf("удаление в корзину: %v", err)
	}
	if rec := call(http.MethodDelete, "/api/projects/"+p.ID.String()+"/purge", e.owner); rec.Code != http.StatusNoContent {
		t.Fatalf("purge: код %d, тело %s", rec.Code, rec.Body.String())
	}
	if _, err := e.st.DeletedProject(e.ctx, p.ID); err == nil {
		t.Error("после purge проект всё ещё в корзине")
	}
}

// TestProjectPurgeRemovesFiles — окончательное удаление необратимо: строки проекта, вложения
// и сами файлы в хранилище.
func TestProjectPurgeRemovesFiles(t *testing.T) {
	e := newTrashEnv(t)
	p := e.mustProject(t, "С файлом", store.RoleViewer)
	assetsSvc := assets.New(e.st, e.obj, e.svc)
	e.svc.UseFiles(assetsSvc)

	content := []byte("черновик главы")
	up, err := assetsSvc.Upload(e.ctx, e.owner.ID, p.ID, assets.UploadOpts{
		Filename: "глава.txt", ContentType: "text/plain",
		Size: int64(len(content)), Reader: bytes.NewReader(content),
	})
	if err != nil {
		t.Fatalf("вложение: %v", err)
	}
	if _, err := e.obj.Stat(e.ctx, up.S3Key); err != nil {
		t.Fatalf("файл не записан: %v", err)
	}

	if err := e.svc.Delete(e.ctx, e.owner.ID, p.ID); err != nil {
		t.Fatalf("удаление: %v", err)
	}
	// Пока проект в корзине, файл на месте: возврат должен быть полным, а не «почти».
	if _, err := e.obj.Stat(e.ctx, up.S3Key); err != nil {
		t.Fatalf("файл удалён вместе с корзиной: %v", err)
	}
	if err := e.svc.Purge(e.ctx, e.other.ID, p.ID); err != projects.ErrForbidden {
		t.Errorf("purge редактором: %v, ожидалось ErrForbidden", err)
	}
	if err := e.svc.Purge(e.ctx, e.owner.ID, p.ID); err != nil {
		t.Fatalf("purge владельцем: %v", err)
	}
	if _, err := e.obj.Stat(e.ctx, up.S3Key); err == nil {
		t.Error("файл остался в хранилище после purge")
	}
	if list, err := e.st.ListAssets(e.ctx, p.ID); err != nil {
		t.Fatalf("вложения: %v", err)
	} else if len(list) != 0 {
		t.Errorf("строк вложений после purge: %d", len(list))
	}
	if _, err := e.svc.Get(e.ctx, e.owner.ID, p.ID); err == nil {
		t.Error("проект читается после purge")
	}
}

// TestProjectTrashExpires — «восстановить можно 30 дней» выполняет уборщик. Тест проверяет
// границу: просроченное уходит, свежее и активное остаётся.
func TestProjectTrashExpires(t *testing.T) {
	e := newTrashEnv(t)
	active := e.mustProject(t, "Активный", store.RoleViewer)
	fresh := e.mustProject(t, "Свежее удаление", store.RoleViewer)
	old := e.mustProject(t, "Давнее удаление", store.RoleViewer)

	for _, id := range []uuid.UUID{fresh.ID, old.ID} {
		if err := e.svc.Delete(e.ctx, e.owner.ID, id); err != nil {
			t.Fatalf("удаление %s: %v", id, err)
		}
	}
	// Сорок дней в корзине: срок хранения — 30, значит проект должен уйти.
	if _, err := e.st.Pool.Exec(e.ctx,
		`UPDATE projects SET deleted_at = now() - interval '40 days' WHERE id = $1`, old.ID); err != nil {
		t.Fatalf("состарить проект: %v", err)
	}

	purged, err := e.st.PurgeExpiredProjects(e.ctx, projects.TrashRetention)
	if err != nil {
		t.Fatalf("уборка корзины: %v", err)
	}
	if len(purged) != 1 {
		t.Fatalf("убрано проектов %d, ожидался 1: %+v", len(purged), purged)
	}
	if _, ok := purged[old.ID]; !ok {
		t.Errorf("уборка тронула не тот проект: %+v", purged)
	}
	if _, err := e.st.DeletedProject(e.ctx, old.ID); err == nil {
		t.Error("просроченный проект остался в корзине")
	}
	if _, err := e.st.DeletedProject(e.ctx, fresh.ID); err != nil {
		t.Errorf("свежее удаление убрано раньше срока: %v", err)
	}
	if _, err := e.svc.Get(e.ctx, e.owner.ID, active.ID); err != nil {
		t.Errorf("активный проект пострадал от уборки: %v", err)
	}
	// Второй проход ничего не находит: уборка идемпотентна и не должна «дочищать» свежее.
	if purged, err := e.st.PurgeExpiredProjects(e.ctx, projects.TrashRetention); err != nil {
		t.Fatalf("второй проход: %v", err)
	} else if len(purged) != 0 {
		t.Errorf("второй проход убрал %d проектов", len(purged))
	}
	// Нулевой срок — «убрать всё из корзины»: так работает вызов с выключенным хранением,
	// и это не должно превращаться в панику или в отказ.
	if purged, err := e.st.PurgeExpiredProjects(e.ctx, 0); err != nil {
		t.Fatalf("нулевой срок: %v", err)
	} else if len(purged) != 1 {
		t.Errorf("нулевой срок убрал %d проектов, ожидался 1 (свежий)", len(purged))
	}
	// Отметка о времени не должна интерпретироваться как «в будущем»: только что удалённое
	// с нулевым сроком уходит, потому что срок отсчитывается от now(), а не от эпохи.
	if purged, err := e.st.PurgeExpiredProjects(e.ctx, 0); err != nil || len(purged) != 0 {
		t.Errorf("третий проход: %d проектов, %v", len(purged), err)
	}
}

// accessToken выдаёт токен доступа: хендлеры корзины работают через auth.WithUser, и токен
// нужен настоящий, а не подделанный контекст.
func accessToken(t *testing.T, e *trashEnv, u *store.User) string {
	t.Helper()
	_, tokens, err := e.auth.Login(e.ctx, u.Email, "hunter22!")
	if err != nil {
		t.Fatalf("вход %s: %v", u.Email, err)
	}
	return tokens.Access
}
