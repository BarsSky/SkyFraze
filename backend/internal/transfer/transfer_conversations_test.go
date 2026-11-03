package transfer_test

// transfer_conversations_test.go — история бесед с помощником в архиве проекта (0.148.0).
//
// Проверяем обе половины обещания: переписка уезжает вместе с проектом и приезжает в новый
// проект, а чужие беседы в архив НЕ попадают — переписка личная.
//
// Ошибка этого файла была бы молчаливой: без файла истории импорт просто создал бы проект без
// разговоров, и «перенос прошёл» осталось бы правдой лишь наполовину.

import (
	"archive/zip"
	"bytes"
	"context"
	"encoding/json"
	"io"
	"log/slog"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"

	"github.com/skyfraze/backend/internal/auth"
	"github.com/skyfraze/backend/internal/store"
	"github.com/skyfraze/backend/internal/transfer"
)

// seedConversation заводит беседу с репликами и служебной строкой инструмента.
func seedConversation(
	t *testing.T, e *transferEnv, ctx context.Context,
	projectID, userID uuid.UUID, title, question, answer string,
) *store.AIConversation {
	t.Helper()
	conversation, err := e.st.CreateAIConversation(ctx, projectID, userID, title, "stub:1")
	if err != nil {
		t.Fatalf("беседа: %v", err)
	}
	for _, message := range []store.AIMessage{
		{ConversationID: conversation.ID, Role: "user", Content: question},
		// Служебная строка: в архив она попадать не должна.
		{ConversationID: conversation.ID, Role: "tool", Content: `{"events":[]}`},
		{ConversationID: conversation.ID, Role: "assistant", Content: answer},
	} {
		if _, err := e.st.AppendAIMessage(ctx, message); err != nil {
			t.Fatalf("сообщение: %v", err)
		}
	}
	return conversation
}

// exportArchive выгружает проект и возвращает карту «файл → содержимое».
func exportArchive(t *testing.T, e *transferEnv, projectID uuid.UUID) map[string][]byte {
	t.Helper()
	var buf bytes.Buffer
	if _, err := e.svc.Export(context.Background(), e.user, projectID, &buf); err != nil {
		t.Fatalf("экспорт: %v", err)
	}
	reader, err := zip.NewReader(bytes.NewReader(buf.Bytes()), int64(buf.Len()))
	if err != nil {
		t.Fatalf("zip: %v", err)
	}
	files := make(map[string][]byte, len(reader.File))
	for _, file := range reader.File {
		rc, err := file.Open()
		if err != nil {
			t.Fatalf("файл архива %s: %v", file.Name, err)
		}
		data, err := io.ReadAll(rc)
		rc.Close()
		if err != nil {
			t.Fatalf("чтение %s: %v", file.Name, err)
		}
		files[file.Name] = data
	}
	return files
}

// Переписка выгружается вместе с проектом — и только своя.
func TestArchiveCarriesOwnConversationsOnly(t *testing.T) {
	e := setupTransfer(t)
	ctx := context.Background()
	project, err := e.proj.Create(ctx, e.user, "Роман", "")
	if err != nil {
		t.Fatalf("проект: %v", err)
	}
	// Своя беседа — уезжает.
	seedConversation(t, e, ctx, project.ID, e.user, "Правки главы", "Поправь абзац", "Предлагаю правку.")
	// Чужая беседа в том же проекте — не уезжает.
	other, err := e.st.CreateUser(ctx, "other@example.com", "$2a$10$notarealhash", "Другой")
	if err != nil {
		t.Fatalf("второй пользователь: %v", err)
	}
	seedConversation(t, e, ctx, project.ID, other.ID, "Чужая беседа", "чужой вопрос", "чужой ответ")

	files := exportArchive(t, e, project.ID)
	data, ok := files["ai-history.json"]
	if !ok {
		t.Fatal("в архиве нет ai-history.json")
	}
	var history transfer.ConversationsFile
	if err := json.Unmarshal(data, &history); err != nil {
		t.Fatalf("ai-history.json не разобран: %v", err)
	}
	if len(history.Conversations) != 1 {
		t.Fatalf("бесед в архиве %d, ожидалась 1: %+v", len(history.Conversations), history.Conversations)
	}
	record := history.Conversations[0]
	if record.Title != "Правки главы" {
		t.Errorf("заголовок: %q", record.Title)
	}
	if len(record.Messages) != 3 {
		t.Fatalf("реплик в архиве %d, ожидалось 3 (включая строку инструмента): %+v", len(record.Messages), record.Messages)
	}
	if record.Messages[0].Role != "user" || record.Messages[1].Role != "tool" || record.Messages[2].Role != "assistant" {
		t.Errorf("порядок ролей: %+v", record.Messages)
	}
	// Протокол вызова переносится (0.154.0): по нему видно, что именно читал помощник.
	if len(record.Messages[1].ToolCalls) == 0 || len(record.Messages[1].ToolResults) == 0 {
		t.Errorf("протокол инструмента не попал в архив: %+v", record.Messages[1])
	}
}

// Проект без бесед не создаёт пустой файл: старый формат остаётся старым.
func TestArchiveWithoutConversationsHasNoFile(t *testing.T) {
	e := setupTransfer(t)
	project, err := e.proj.Create(context.Background(), e.user, "Пустой", "")
	if err != nil {
		t.Fatalf("проект: %v", err)
	}
	files := exportArchive(t, e, project.ID)
	if _, ok := files["ai-history.json"]; ok {
		t.Fatal("файл истории появился без единой беседы")
	}
}

// Импорт возвращает переписку в новый проект — реплики по порядку.
func TestImportRestoresConversations(t *testing.T) {
	e := setupTransfer(t)
	ctx := context.Background()
	project, err := e.proj.Create(ctx, e.user, "Роман", "")
	if err != nil {
		t.Fatalf("проект: %v", err)
	}
	seedConversation(t, e, ctx, project.ID, e.user, "Правки главы", "Поправь абзац", "Предлагаю правку.")

	var buf bytes.Buffer
	if _, err := e.svc.Export(ctx, e.user, project.ID, &buf); err != nil {
		t.Fatalf("экспорт: %v", err)
	}
	bundle, err := transfer.ParseBundle(bytes.NewReader(buf.Bytes()), int64(buf.Len()))
	if err != nil {
		t.Fatalf("разбор архива: %v", err)
	}
	if bundle.Conversations == nil {
		t.Fatal("архив не принёс историю бесед")
	}

	importer, err := e.st.CreateUser(ctx, "importer@example.com", "$2a$10$notarealhash", "Импортёр")
	if err != nil {
		t.Fatalf("импортёр: %v", err)
	}
	result, err := e.svc.Import(ctx, importer.ID, bundle)
	if err != nil {
		t.Fatalf("импорт: %v", err)
	}
	if result.Conversations != 1 {
		t.Fatalf("перенесено бесед %d, ожидалась 1", result.Conversations)
	}

	list, err := e.st.ListAIConversations(ctx, result.Project.ID, importer.ID)
	if err != nil {
		t.Fatalf("беседы нового проекта: %v", err)
	}
	if len(list) != 1 {
		t.Fatalf("бесед в новом проекте %d, ожидалась 1", len(list))
	}
	if list[0].Title != "Правки главы" {
		t.Errorf("заголовок новой беседы: %q", list[0].Title)
	}
	messages, err := e.st.ListAIMessages(ctx, list[0].ID, 10)
	if err != nil {
		t.Fatalf("реплики: %v", err)
	}
	if len(messages) != 3 {
		t.Fatalf("реплик %d, ожидалось 3", len(messages))
	}
	if messages[0].Role != "user" || messages[0].Content != "Поправь абзац" {
		t.Errorf("первая реплика: %+v", messages[0])
	}
	if messages[1].Role != "tool" || len(messages[1].ToolCalls) == 0 {
		t.Errorf("строка инструмента не восстановилась: %+v", messages[1])
	}
	if messages[2].Role != "assistant" || messages[2].Content != "Предлагаю правку." {
		t.Errorf("последняя реплика: %+v", messages[2])
	}
}

// Ответ импорта — часть контракта интерфейса (0.148.1).
//
// Поля собирались руками в карте, и «забыть» их было легко: entities не отдавался с 0.69.0,
// conversations — с 0.148.0. Интерфейс молчал о перенесённых карточках и беседах, хотя сервер
// их переносил.
func TestImportHTTPReportsConversations(t *testing.T) {
	e := setup(t)
	ctx := context.Background()
	owner := e.user(t, "owner@example.com")
	projectID := e.seedStoryProject(t, owner)
	seedConversation(t, &transferEnv{st: e.st}, ctx, projectID, owner, "Правки главы", "Поправь абзац", "Предлагаю правку.")

	var archive bytes.Buffer
	if _, err := e.transfer.Export(ctx, owner, projectID, &archive); err != nil {
		t.Fatalf("экспорт: %v", err)
	}
	// Импорт создаёт НОВЫЙ проект, но идентификаторы событий сохраняет — значит, исходный
	// проект надо убрать, как это делает человек при переносе между стендами (иначе 409).
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
		Conversations int  `json:"conversations"`
		Entities      *int `json:"entities"`
		Events        int  `json:"events"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &payload); err != nil {
		t.Fatalf("ответ не разобран: %v (%s)", err, rec.Body.String())
	}
	if payload.Conversations != 1 {
		t.Errorf("conversations в ответе: %d, ожидалось 1 (тело %s)", payload.Conversations, rec.Body.String())
	}
	if payload.Entities == nil {
		t.Errorf("в ответе нет поля entities: %s", rec.Body.String())
	}
	if payload.Events < 1 {
		t.Errorf("events: %d, ожидалось хотя бы одно событие", payload.Events)
	}
}

// conversationRoutesSecret — секрет подписи токенов для HTTP-проверки импорта.
const conversationRoutesSecret = "conversations-test-secret"
