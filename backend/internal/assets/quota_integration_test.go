package assets_test

// quota_integration_test.go — квота на вложения проекта и удаление файла.
//
// Квота появилась вместе с пережатием и считается по строкам `assets`, то есть по
// весу ПОСЛЕ пережатия: картинка на 8 МБ приезжает как 300 КБ и занимает 300 КБ.
// Проверяем три вещи, которые легко сделать неправильно:
//
//	считается именно записанный вес, а не вес исходника;
//	дедупликация квоту не уменьшает — файл в двух проектах занимает место в обоих;
//	упёршийся в предел проект может освободить место: файл удаляется, но только
//	  если он не прикреплён к кадрам (иначе в документе осталась бы ссылка в никуда).
//
// Нужна Postgres (TEST_DATABASE_URL), как и остальным интеграционным тестам.

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"

	"github.com/skyfraze/backend/internal/assets"
	"github.com/skyfraze/backend/internal/auth"
	"github.com/skyfraze/backend/internal/platform/testimage"
	"github.com/skyfraze/backend/internal/store"
)

// stubUsage — расход файла по документу. Настоящий расход считает хаб по CRDT
// (collab.Hub.AssetUsage); здесь важно только решение сервиса: 0 — удалять можно,
// больше нуля — нельзя.
type stubUsage struct {
	events int
	err    error
	calls  int
}

func (s *stubUsage) AssetUsage(context.Context, uuid.UUID, uuid.UUID) (int, error) {
	s.calls++
	return s.events, s.err
}

// uploadText кладёт в проект текстовый файл заданного размера: не-картиночный путь
// удобен тем, что вес файла не меняется при пережатии, и квоту видно «в чистом виде».
func uploadText(t *testing.T, e *env, owner, projectID uuid.UUID, name string, size int) *store.Asset {
	t.Helper()
	content := bytes.Repeat([]byte("x"), size)
	a, err := e.assets.Upload(context.Background(), owner, projectID, assets.UploadOpts{
		Filename: name, ContentType: "text/plain", Size: int64(len(content)),
		Reader: bytes.NewReader(content),
	})
	if err != nil {
		t.Fatalf("загрузка %s: %v", name, err)
	}
	return a
}

func TestUploadRefusesWhenProjectIsFull(t *testing.T) {
	e := setup(t)
	ctx := context.Background()
	owner := e.user(t, "owner@example.com")
	project, err := e.proj.Create(ctx, owner, "Проект с квотой", "")
	if err != nil {
		t.Fatalf("проект: %v", err)
	}
	e.assets.UseQuota(1000)

	uploadText(t, e, owner, project.ID, "первый.txt", 600)

	// Второй файл не помещается: 600 + 600 > 1000.
	content := bytes.Repeat([]byte("y"), 600)
	_, err = e.assets.Upload(ctx, owner, project.ID, assets.UploadOpts{
		Filename: "второй.txt", ContentType: "text/plain", Size: int64(len(content)),
		Reader: bytes.NewReader(content),
	})
	var quota *assets.QuotaError
	if !errors.As(err, &quota) {
		t.Fatalf("ожидался отказ по квоте, получено: %v", err)
	}
	if quota.Used != 600 || quota.Limit != 1000 || quota.Incoming != 600 {
		t.Errorf("числа в отказе: %+v", quota)
	}
	// Сообщение показывают человеку: в нём должны быть и занятое место, и предел.
	if !strings.Contains(quota.Error(), "600 Б") || !strings.Contains(quota.Error(), "1000 Б") {
		t.Errorf("текст отказа непонятен: %q", quota.Error())
	}
	if !assets.QuotaExceeded(err) {
		t.Error("QuotaExceeded не распознал отказ")
	}

	// Отказ не оставляет ни строки, ни файла.
	rows, err := e.st.ListAssets(ctx, project.ID)
	if err != nil {
		t.Fatalf("строки вложений: %v", err)
	}
	if len(rows) != 1 {
		t.Errorf("строк вложений %d, ожидалась 1", len(rows))
	}
	if files := e.files(t); len(files) != 1 {
		t.Errorf("файлов в хранилище %d, ожидался 1", len(files))
	}

	used, limit, err := e.assets.Usage(ctx, owner, project.ID)
	if err != nil || used != 600 || limit != 1000 {
		t.Errorf("занято/предел: %d/%d (err=%v)", used, limit, err)
	}
}

// Квота считает ЗАПИСАННЫЙ вес: jpeg на 255 КБ приезжает как 122 КБ, и в проект
// помещается ещё 100 КБ — при подсчёте по исходнику не поместилось бы ничего.
func TestQuotaCountsStoredSizeAfterCompression(t *testing.T) {
	e := setup(t)
	ctx := context.Background()
	owner := e.user(t, "owner@example.com")
	project, err := e.proj.Create(ctx, owner, "Проект с фото", "")
	if err != nil {
		t.Fatalf("проект: %v", err)
	}

	photo := testimage.JPEG(t, testimage.Photo(1200, 800), 92)
	e.assets.UseQuota(200_000)
	if int64(len(photo)) <= 200_000 {
		t.Fatalf("фикстура слишком мала для проверки: %d байт", len(photo))
	}

	image, err := e.assets.Upload(ctx, owner, project.ID, assets.UploadOpts{
		Filename: "фото.jpg", ContentType: "image/jpeg", Size: int64(len(photo)),
		Reader: bytes.NewReader(photo),
	})
	if err != nil {
		t.Fatalf("картинка должна поместиться после пережатия: %v", err)
	}
	if image.Size >= int64(len(photo)) {
		t.Fatalf("картинка не пережалась: %d из %d", image.Size, len(photo))
	}

	// А вот текстовый файл на 100 КБ уже не влезает: 122 КБ + 100 КБ > 200 КБ.
	content := bytes.Repeat([]byte("z"), 100_000)
	if _, err := e.assets.Upload(ctx, owner, project.ID, assets.UploadOpts{
		Filename: "заметки.txt", ContentType: "text/plain", Size: int64(len(content)),
		Reader: bytes.NewReader(content),
	}); !assets.QuotaExceeded(err) {
		t.Fatalf("ожидался отказ по квоте, получено: %v", err)
	}
	if used, _, _ := e.assets.Usage(ctx, owner, project.ID); used != image.Size {
		t.Errorf("занято %d, ожидалось %d (вес пережатого файла)", used, image.Size)
	}
}

// Дедупликация квоту не уменьшает: файл, который уже лежит в хранилище, всё равно
// становится вложением проекта — проект получает его в своё содержимое.
func TestQuotaCountsDeduplicatedUploads(t *testing.T) {
	e := setup(t)
	ctx := context.Background()
	owner := e.user(t, "owner@example.com")
	project, err := e.proj.Create(ctx, owner, "Проект с копиями", "")
	if err != nil {
		t.Fatalf("проект: %v", err)
	}
	e.assets.UseQuota(700)

	content := bytes.Repeat([]byte("d"), 400)
	upload := func(name string) error {
		_, err := e.assets.Upload(ctx, owner, project.ID, assets.UploadOpts{
			Filename: name, ContentType: "text/plain", Size: int64(len(content)),
			Reader: bytes.NewReader(content),
		})
		return err
	}
	if err := upload("копия-1.txt"); err != nil {
		t.Fatalf("первая загрузка: %v", err)
	}
	if err := upload("копия-2.txt"); !assets.QuotaExceeded(err) {
		t.Fatalf("вторая копия должна упереться в квоту: %v", err)
	}
	// Файл в хранилище по-прежнему один: вторая загрузка до записи не дошла.
	if files := e.files(t); len(files) != 1 {
		t.Errorf("файлов в хранилище %d, ожидался 1", len(files))
	}
}

func TestDeleteAssetRemovesRowAndFile(t *testing.T) {
	e := setup(t)
	ctx := context.Background()
	owner := e.user(t, "owner@example.com")
	project, err := e.proj.Create(ctx, owner, "Проект с файлом", "")
	if err != nil {
		t.Fatalf("проект: %v", err)
	}
	usage := &stubUsage{}
	e.assets.UseUsage(usage)

	asset := uploadText(t, e, owner, project.ID, "черновик.txt", 300)
	if err := e.assets.Delete(ctx, owner, asset.ID); err != nil {
		t.Fatalf("удаление: %v", err)
	}
	if usage.calls != 1 {
		t.Errorf("расход файла не спросили: вызовов %d", usage.calls)
	}
	if _, err := e.st.GetAsset(ctx, asset.ID); !errors.Is(err, store.ErrNotFound) {
		t.Errorf("строка осталась: %v", err)
	}
	if files := e.files(t); len(files) != 0 {
		t.Errorf("файл остался в хранилище: %v", files)
	}
	if used, _, _ := e.assets.Usage(ctx, owner, project.ID); used != 0 {
		t.Errorf("после удаления занято %d", used)
	}
}

// Файл, которым пользуется второй проект (дедупликация), удаление одной строки не
// уносит: он уходит только с последней ссылкой.
func TestDeleteAssetKeepsFileSharedByOtherProject(t *testing.T) {
	e := setup(t)
	ctx := context.Background()
	owner := e.user(t, "owner@example.com")
	first, err := e.proj.Create(ctx, owner, "Первый", "")
	if err != nil {
		t.Fatalf("проект: %v", err)
	}
	second, err := e.proj.Create(ctx, owner, "Второй", "")
	if err != nil {
		t.Fatalf("проект: %v", err)
	}
	e.assets.UseUsage(&stubUsage{})

	content := []byte("общие байты двух проектов")
	upload := func(projectID uuid.UUID, name string) *store.Asset {
		t.Helper()
		a, err := e.assets.Upload(ctx, owner, projectID, assets.UploadOpts{
			Filename: name, ContentType: "text/plain", Size: int64(len(content)),
			Reader: bytes.NewReader(content),
		})
		if err != nil {
			t.Fatalf("загрузка %s: %v", name, err)
		}
		return a
	}
	one := upload(first.ID, "файл.txt")
	two := upload(second.ID, "копия.txt")
	if one.S3Key != two.S3Key {
		t.Fatalf("дедупликация не сработала: %s и %s", one.S3Key, two.S3Key)
	}

	if err := e.assets.Delete(ctx, owner, one.ID); err != nil {
		t.Fatalf("удаление первой строки: %v", err)
	}
	if files := e.files(t); len(files) != 1 {
		t.Fatalf("общий файл удалён вместе со строкой: %v", files)
	}
	if err := e.assets.Delete(ctx, owner, two.ID); err != nil {
		t.Fatalf("удаление второй строки: %v", err)
	}
	if files := e.files(t); len(files) != 0 {
		t.Errorf("после последней ссылки файл должен уйти: %v", files)
	}
}

func TestDeleteAssetRefusesWhileAttached(t *testing.T) {
	e := setup(t)
	ctx := context.Background()
	owner := e.user(t, "owner@example.com")
	project, err := e.proj.Create(ctx, owner, "Проект с кадрами", "")
	if err != nil {
		t.Fatalf("проект: %v", err)
	}
	e.assets.UseUsage(&stubUsage{events: 3})

	asset := uploadText(t, e, owner, project.ID, "обложка.txt", 100)
	err = e.assets.Delete(ctx, owner, asset.ID)
	var inUse *assets.InUseError
	if !errors.As(err, &inUse) {
		t.Fatalf("ожидался отказ «файл прикреплён», получено: %v", err)
	}
	if inUse.Events != 3 {
		t.Errorf("кадров в отказе %d, ожидалось 3", inUse.Events)
	}
	if !strings.Contains(inUse.Error(), "3 кадрам") {
		t.Errorf("текст отказа непонятен: %q", inUse.Error())
	}
	if _, err := e.st.GetAsset(ctx, asset.ID); err != nil {
		t.Errorf("строка удалена, хотя файл прикреплён: %v", err)
	}
	if files := e.files(t); len(files) != 1 {
		t.Errorf("файл удалён, хотя он прикреплён: %v", files)
	}
}

// Посторонний не удаляет файл проекта: 403 и ничего не меняется.
func TestDeleteAssetRequiresEditor(t *testing.T) {
	e := setup(t)
	ctx := context.Background()
	owner := e.user(t, "owner@example.com")
	stranger := e.user(t, "stranger@example.com")
	project, err := e.proj.Create(ctx, owner, "Чужой проект", "")
	if err != nil {
		t.Fatalf("проект: %v", err)
	}
	e.assets.UseUsage(&stubUsage{})

	asset := uploadText(t, e, owner, project.ID, "файл.txt", 100)
	if err := e.assets.Delete(ctx, stranger, asset.ID); err == nil {
		t.Fatal("посторонний удалил файл")
	}
	if _, err := e.st.GetAsset(ctx, asset.ID); err != nil {
		t.Errorf("строка исчезла после отказа: %v", err)
	}
}

// ---------- HTTP: коды и текст отказа ----------

const assetsRoutesSecret = "test-secret-assets"

func assetsRouter(t *testing.T, svc *assets.Service) http.Handler {
	authSvc := auth.New(nil, assetsRoutesSecret)
	h := assets.NewHandler(svc, slog.New(slog.NewTextHandler(io.Discard, nil)))
	r := chi.NewRouter()
	r.Route("/api/projects/{id}", func(r chi.Router) {
		r.Use(authSvc.WithUser)
		r.Post("/assets", h.Upload(authSvc))
		r.Get("/assets", h.List(authSvc))
		r.Get("/assets/usage", h.Usage(authSvc))
		r.Delete("/assets/{assetID}", h.Delete(authSvc))
	})
	return r
}

func doAsset(t *testing.T, h http.Handler, method, path string, user uuid.UUID, body io.Reader, contentType string) *httptest.ResponseRecorder {
	t.Helper()
	token, err := auth.IssueAccess(assetsRoutesSecret, user)
	if err != nil {
		t.Fatalf("токен: %v", err)
	}
	req := httptest.NewRequest(method, path, body)
	req.Header.Set("Authorization", "Bearer "+token)
	if contentType != "" {
		req.Header.Set("Content-Type", contentType)
	}
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	return rec
}

// multipartFile — тело multipart/form-data с одним полем «file»: ровно то, что
// отправляет браузер.
func multipartFile(t *testing.T, filename, content string) (io.Reader, string) {
	t.Helper()
	var body bytes.Buffer
	w := multipart.NewWriter(&body)
	part, err := w.CreateFormFile("file", filename)
	if err != nil {
		t.Fatalf("multipart: %v", err)
	}
	if _, err := part.Write([]byte(content)); err != nil {
		t.Fatalf("multipart: %v", err)
	}
	if err := w.Close(); err != nil {
		t.Fatalf("multipart: %v", err)
	}
	return &body, w.FormDataContentType()
}

func TestAssetHandlersQuotaAndDelete(t *testing.T) {
	e := setup(t)
	ctx := context.Background()
	owner := e.user(t, "owner@example.com")
	project, err := e.proj.Create(ctx, owner, "Проект через HTTP", "")
	if err != nil {
		t.Fatalf("проект: %v", err)
	}
	e.assets.UseQuota(500)
	usage := &stubUsage{}
	e.assets.UseUsage(usage)
	h := assetsRouter(t, e.assets)
	base := "/api/projects/" + project.ID.String() + "/assets"

	// Первый файл (400 Б) помещается.
	body, ctype := multipartFile(t, "первый.txt", strings.Repeat("a", 400))
	if rec := doAsset(t, h, http.MethodPost, base, owner, body, ctype); rec.Code != http.StatusCreated {
		t.Fatalf("первая загрузка: код %d, тело %s", rec.Code, rec.Body.String())
	}

	// Расход отдаётся интерфейсу: «занято 400 Б из 500 Б» видно до отказа.
	rec := doAsset(t, h, http.MethodGet, base+"/usage", owner, nil, "")
	if rec.Code != http.StatusOK {
		t.Fatalf("расход: код %d, тело %s", rec.Code, rec.Body.String())
	}
	var usageBody struct {
		Used      int64  `json:"used"`
		Limit     int64  `json:"limit"`
		UsedText  string `json:"used_text"`
		LimitText string `json:"limit_text"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &usageBody); err != nil {
		t.Fatalf("json расхода: %v (%s)", err, rec.Body.String())
	}
	if usageBody.Used != 400 || usageBody.Limit != 500 {
		t.Errorf("расход: %+v", usageBody)
	}
	if usageBody.UsedText != "400 Б" || usageBody.LimitText != "500 Б" {
		t.Errorf("текст расхода: %q из %q", usageBody.UsedText, usageBody.LimitText)
	}
	// Постороннему расход не показываем: это состояние чужого проекта.
	stranger := e.user(t, "stranger@example.com")
	if rec := doAsset(t, h, http.MethodGet, base+"/usage", stranger, nil, ""); rec.Code != http.StatusForbidden {
		t.Errorf("расход для постороннего: код %d", rec.Code)
	}

	// Второй — 413 и человеческий текст: его показывает панель редактора.
	body, ctype = multipartFile(t, "второй.txt", strings.Repeat("b", 400))
	rec = doAsset(t, h, http.MethodPost, base, owner, body, ctype)
	if rec.Code != http.StatusRequestEntityTooLarge {
		t.Fatalf("вторая загрузка: код %d, тело %s", rec.Code, rec.Body.String())
	}
	var quotaBody struct {
		Error string `json:"error"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &quotaBody); err != nil {
		t.Fatalf("json отказа: %v (%s)", err, rec.Body.String())
	}
	if !strings.Contains(quotaBody.Error, "не помещается") {
		t.Errorf("текст отказа: %q", quotaBody.Error)
	}

	// Удаление: файл прикреплён — 409 с объяснением.
	asset := uploadText(t, e, owner, project.ID, "нужный.txt", 50)
	usage.events = 2
	rec = doAsset(t, h, http.MethodDelete, base+"/"+asset.ID.String(), owner, nil, "")
	if rec.Code != http.StatusConflict {
		t.Fatalf("удаление прикреплённого: код %d, тело %s", rec.Code, rec.Body.String())
	}

	// Открепили — 204, и повторное удаление уже 404.
	usage.events = 0
	rec = doAsset(t, h, http.MethodDelete, base+"/"+asset.ID.String(), owner, nil, "")
	if rec.Code != http.StatusNoContent {
		t.Fatalf("удаление: код %d, тело %s", rec.Code, rec.Body.String())
	}
	rec = doAsset(t, h, http.MethodDelete, base+"/"+asset.ID.String(), owner, nil, "")
	if rec.Code != http.StatusNotFound {
		t.Fatalf("повторное удаление: код %d, тело %s", rec.Code, rec.Body.String())
	}
}
