package transfer_test

// transfer_knowledge_test.go — знания проекта в архиве (0.149.0).
//
// Знания — содержимое проекта, а не личные заметки, поэтому в отличие от истории бесед в
// архив едут знания ВСЕХ авторов. Дата создания едет вместе с ними: «решили в марте» —
// часть работы, и импорт не должен превращать всё в «вчера».

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"log/slog"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"

	"github.com/skyfraze/backend/internal/auth"
	"github.com/skyfraze/backend/internal/store"
	"github.com/skyfraze/backend/internal/transfer"
)

func TestArchiveCarriesKnowledgeWithAuthorAndDate(t *testing.T) {
	e := setupTransfer(t)
	ctx := context.Background()
	project, err := e.proj.Create(ctx, e.user, "Роман", "")
	if err != nil {
		t.Fatalf("проект: %v", err)
	}
	// Второй автор: его знание тоже часть проекта и тоже должно уехать.
	coauthor, err := e.st.CreateUser(ctx, "coauthor@example.com", "$2a$10$notarealhash", "Соавтор")
	if err != nil {
		t.Fatalf("второй пользователь: %v", err)
	}
	if _, err := e.st.CreateAIKnowledge(ctx, project.ID, e.user,
		store.KnowledgeInput{Title: "Моё знание", Summary: "про меня", Body: "тезис", Chars: 5}, nil); err != nil {
		t.Fatalf("знание: %v", err)
	}
	if _, err := e.st.CreateAIKnowledge(ctx, project.ID, coauthor.ID,
		store.KnowledgeInput{Title: "Знание соавтора", Body: "чужое", Chars: 5}, nil); err != nil {
		t.Fatalf("знание соавтора: %v", err)
	}

	files := exportArchive(t, e, project.ID)
	data, ok := files["ai-knowledge.json"]
	if !ok {
		t.Fatal("в архиве нет ai-knowledge.json")
	}
	var file transfer.KnowledgeFile
	if err := json.Unmarshal(data, &file); err != nil {
		t.Fatalf("ai-knowledge.json не разобран: %v", err)
	}
	if len(file.Knowledge) != 2 {
		t.Fatalf("знаний в архиве %d, ожидалось 2: %+v", len(file.Knowledge), file.Knowledge)
	}
	var found *transfer.KnowledgeRecord
	authors := make(map[string]bool, len(file.Knowledge))
	for i := range file.Knowledge {
		authors[file.Knowledge[i].Author] = true
		if file.Knowledge[i].Title == "Моё знание" {
			found = &file.Knowledge[i]
		}
	}
	if found == nil {
		t.Fatalf("своего знания в архиве нет: %+v", file.Knowledge)
	}
	if found.Body != "тезис" || found.Summary != "про меня" {
		t.Errorf("тело и пометка не перенеслись: %+v", found)
	}
	if !authors["Перенос"] || !authors["Соавтор"] {
		t.Errorf("авторы в архиве: %v, ожидались «Перенос» и «Соавтор»", authors)
	}
	if found.CreatedAt.IsZero() {
		t.Error("у знания нет даты создания")
	}
}

func TestArchiveWithoutKnowledgeHasNoFile(t *testing.T) {
	e := setupTransfer(t)
	project, err := e.proj.Create(context.Background(), e.user, "Пустой", "")
	if err != nil {
		t.Fatalf("проект: %v", err)
	}
	files := exportArchive(t, e, project.ID)
	if _, ok := files["ai-knowledge.json"]; ok {
		t.Fatal("файл знаний появился без единого знания")
	}
}

func TestImportRestoresKnowledgeWithDateAndAuthor(t *testing.T) {
	e := setupTransfer(t)
	ctx := context.Background()
	project, err := e.proj.Create(ctx, e.user, "Роман", "")
	if err != nil {
		t.Fatalf("проект: %v", err)
	}
	original, err := e.st.CreateAIKnowledge(ctx, project.ID, e.user,
		store.KnowledgeInput{Title: "Решения по миру", Summary: "канон", Body: "драконы спят", Chars: 13}, nil)
	if err != nil {
		t.Fatalf("знание: %v", err)
	}

	var buf bytes.Buffer
	if _, err := e.svc.Export(ctx, e.user, project.ID, &buf); err != nil {
		t.Fatalf("экспорт: %v", err)
	}
	bundle, err := transfer.ParseBundle(bytes.NewReader(buf.Bytes()), int64(buf.Len()))
	if err != nil {
		t.Fatalf("разбор архива: %v", err)
	}
	if bundle.Knowledge == nil {
		t.Fatal("архив не принёс знания")
	}

	importer, err := e.st.CreateUser(ctx, "importer@example.com", "$2a$10$notarealhash", "Импортёр")
	if err != nil {
		t.Fatalf("импортёр: %v", err)
	}
	result, err := e.svc.Import(ctx, importer.ID, bundle)
	if err != nil {
		t.Fatalf("импорт: %v", err)
	}
	if result.Knowledge != 1 {
		t.Fatalf("перенесено знаний %d, ожидалось 1", result.Knowledge)
	}
	list, err := e.st.ListAIKnowledge(ctx, result.Project.ID, "", 10)
	if err != nil {
		t.Fatalf("знания нового проекта: %v", err)
	}
	if len(list) != 1 {
		t.Fatalf("знаний в новом проекте %d, ожидалось 1", len(list))
	}
	restored, err := e.st.AIKnowledgeByID(ctx, result.Project.ID, list[0].ID)
	if err != nil {
		t.Fatalf("знание целиком: %v", err)
	}
	if restored.Title != "Решения по миру" || restored.Body != "драконы спят" {
		t.Errorf("содержимое не перенеслось: %+v", restored)
	}
	// Дата создания — исходная, а не «момент импорта».
	if diff := restored.CreatedAt.Sub(original.CreatedAt); diff > 5*time.Second || diff < -5*time.Second {
		t.Errorf("дата создания не сохранилась: было %s, стало %s", original.CreatedAt, restored.CreatedAt)
	}
	if restored.AuthorName != "Перенос" {
		t.Errorf("автор не сохранился: %q", restored.AuthorName)
	}
}

// Ответ импорта — часть контракта интерфейса (0.149.0): число знаний в JSON.
func TestImportHTTPReportsKnowledge(t *testing.T) {
	e := setup(t)
	ctx := context.Background()
	owner := e.user(t, "owner@example.com")
	projectID := e.seedStoryProject(t, owner)
	if _, err := e.st.CreateAIKnowledge(ctx, projectID, owner,
		store.KnowledgeInput{Title: "Выводы", Body: "решили так", Chars: 10}, nil); err != nil {
		t.Fatalf("знание: %v", err)
	}

	var archive bytes.Buffer
	if _, err := e.transfer.Export(ctx, owner, projectID, &archive); err != nil {
		t.Fatalf("экспорт: %v", err)
	}
	if err := e.st.DeleteProject(ctx, projectID); err != nil {
		t.Fatalf("удаление источника: %v", err)
	}

	body := &bytes.Buffer{}
	writer := multipart.NewWriter(body)
	part, err := writer.CreateFormFile("file", "project.skyfraze.zip")
	if err != nil {
		t.Fatalf("multipart: %v", err)
	}
	if _, err := part.Write(archive.Bytes()); err != nil {
		t.Fatalf("multipart: %v", err)
	}
	writer.Close()

	authSvc := auth.New(nil, conversationRoutesSecret)
	handler := transfer.NewHandler(e.transfer, slog.New(slog.NewTextHandler(io.Discard, nil)))
	router := chi.NewRouter()
	router.With(authSvc.WithUser).Post("/api/projects/import", handler.Import)

	token, err := auth.IssueAccess(conversationRoutesSecret, owner)
	if err != nil {
		t.Fatalf("token: %v", err)
	}
	req := httptest.NewRequest(http.MethodPost, "/api/projects/import", body)
	req.Header.Set("Authorization", "Bearer "+token)
	req.Header.Set("Content-Type", writer.FormDataContentType())
	rec := httptest.NewRecorder()
	router.ServeHTTP(rec, req)
	if rec.Code != http.StatusCreated {
		t.Fatalf("код %d, тело %s", rec.Code, rec.Body.String())
	}

	var payload struct {
		Knowledge int  `json:"knowledge"`
		Events    int  `json:"events"`
		Entities  *int `json:"entities"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &payload); err != nil {
		t.Fatalf("ответ не разобран: %v (%s)", err, rec.Body.String())
	}
	if payload.Knowledge != 1 {
		t.Errorf("knowledge в ответе: %d, ожидалось 1 (тело %s)", payload.Knowledge, rec.Body.String())
	}
	if payload.Entities == nil {
		t.Errorf("в ответе нет поля entities: %s", rec.Body.String())
	}
}
