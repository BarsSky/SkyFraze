package assistant_test

// knowledge_integration_test.go — знания проекта и срок хранения бесед (0.149.0).
//
// Что проверяем и почему именно это:
//
//   - пачка знаний пишется целиком или не пишется вовсе: половина уложенной беседы —
//     худший исход, ради которого и затевалась транзакция;
//   - знание переживает удаление беседы: ровно за этим его и сохраняют;
//   - приложенные знания уходят модели в порядке выбора, а чужое (из другого проекта)
//     знание — отказ, а не молчаливый пропуск;
//   - срок хранения меняет только владелец, а очистка удаляет старые беседы и обходит
//     помеченные «не удалять».

import (
	"context"
	"errors"
	"strings"
	"testing"

	"github.com/google/uuid"

	"github.com/skyfraze/backend/internal/ai"
	"github.com/skyfraze/backend/internal/assistant"
	"github.com/skyfraze/backend/internal/store"
)

func saveKnowledge(t *testing.T, e *env, ctx context.Context, projectID, userID uuid.UUID, title string) *store.AIKnowledge {
	t.Helper()
	saved, err := e.asst.SaveKnowledgeEntries(ctx, userID, projectID, nil, []assistant.KnowledgeInput{{
		Title: title, Summary: "пометка: о чём это", Body: "тезисы: " + title,
	}})
	if err != nil {
		t.Fatalf("знание: %v", err)
	}
	if len(saved) != 1 {
		t.Fatalf("сохранено %d знаний, ожидалось 1", len(saved))
	}
	return &saved[0]
}

func TestSaveKnowledgeEntriesIsAllOrNothing(t *testing.T) {
	e := setup(t)
	ctx := context.Background()
	owner := e.user(t, "owner@example.com")
	projectID, _, _ := e.seedProject(t, owner)

	// Предел уменьшен тестом: проверяем разбиение и отказ с ЧИСЛОМ, а не на 4 000 знаков.
	limits := assistant.DefaultLimits(10)
	limits.KnowledgeChars = 50
	limits.KnowledgeEntries = 2
	e.asst.SetLimits(limits)

	// Первое знание в пределе, второе — нет: не должно записаться НИЧЕГО.
	_, err := e.asst.SaveKnowledgeEntries(ctx, owner, projectID, nil, []assistant.KnowledgeInput{
		{Title: "Первое", Body: strings.Repeat("а", 40)},
		{Title: "Второе", Body: strings.Repeat("б", 200)},
	})
	if err == nil {
		t.Fatal("длинное знание принято")
	}
	if !strings.Contains(err.Error(), "200") || !strings.Contains(err.Error(), "50") {
		t.Fatalf("в ошибке нет чисел предела и длины: %v", err)
	}
	list, err := e.asst.KnowledgeList(ctx, owner, projectID, "")
	if err != nil {
		t.Fatalf("список: %v", err)
	}
	if len(list) != 0 {
		t.Fatalf("после отказа записалось %d знаний — пачка не атомарна", len(list))
	}

	// Два коротких — записываются оба, с автором-снимком и датой.
	saved, err := e.asst.SaveKnowledgeEntries(ctx, owner, projectID, nil, []assistant.KnowledgeInput{
		{Title: "Первое", Summary: "раз", Body: "тезис"},
		{Title: "Второе", Summary: "два", Body: "тезис"},
	})
	if err != nil {
		t.Fatalf("пачка: %v", err)
	}
	if len(saved) != 2 {
		t.Fatalf("сохранено %d, ожидалось 2", len(saved))
	}
	if saved[0].AuthorName != "owner@example.com" {
		t.Fatalf("имя автора не снимок из users: %q", saved[0].AuthorName)
	}
	if saved[0].Chars != len([]rune("тезис")) {
		t.Fatalf("знаков %d, ожидалось %d", saved[0].Chars, len([]rune("тезис")))
	}

	// Больше предела за раз — отказ до записи.
	if _, err := e.asst.SaveKnowledgeEntries(ctx, owner, projectID, nil, []assistant.KnowledgeInput{
		{Title: "1", Body: "т"}, {Title: "2", Body: "т"}, {Title: "3", Body: "т"},
	}); err == nil {
		t.Fatal("пачка больше предела принята")
	}
}

// Знание должно пережить удаление беседы — в этом весь смысл.
func TestKnowledgeSurvivesConversationDeletion(t *testing.T) {
	e := setup(t)
	ctx := context.Background()
	owner := e.user(t, "owner@example.com")
	projectID, _, _ := e.seedProject(t, owner)

	conversation := ownConversation(t, e, ctx, projectID, owner, "Беседа о выводах")
	saved, err := e.asst.SaveKnowledgeEntries(ctx, owner, projectID, &conversation.ID,
		[]assistant.KnowledgeInput{{Title: "Вывод", Summary: "что решили", Body: "решили вот так"}})
	if err != nil {
		t.Fatalf("знание: %v", err)
	}
	if err := e.asst.DeleteConversation(ctx, owner, projectID, conversation.ID); err != nil {
		t.Fatalf("удаление беседы: %v", err)
	}
	item, err := e.asst.KnowledgeGet(ctx, owner, projectID, saved[0].ID)
	if err != nil {
		t.Fatalf("знание исчезло вместе с беседой: %v", err)
	}
	if item.SourceConversationID != nil {
		// Беседу удалили — ссылка на источник обнулилась (ON DELETE SET NULL).
		t.Fatalf("источник знания не обнулился: %v", *item.SourceConversationID)
	}
}

func TestAttachedKnowledgeGoesToModelAndStoredMessage(t *testing.T) {
	e := setup(t, ai.Reply{Content: "ответ по знаниям"})
	ctx := context.Background()
	owner := e.user(t, "owner@example.com")
	projectID, _, _ := e.seedProject(t, owner)

	first := saveKnowledge(t, e, ctx, projectID, owner, "Первое")
	second := saveKnowledge(t, e, ctx, projectID, owner, "Второе")

	// Порядок выбора — второй, первый: карточки в вопросе должны идти так, как приложили.
	turn, err := e.asst.SendStreamKnowledge(ctx, owner, projectID, uuid.Nil, "stub:1",
		"напомни, что решили", []uuid.UUID{second.ID, first.ID}, nil, nil)
	if err != nil {
		t.Fatalf("вопрос со знаниями: %v", err)
	}
	if turn.Answer == "" {
		t.Fatal("модель не ответила")
	}
	messages, err := e.st.ListAIMessages(ctx, turn.ConversationID, 10)
	if err != nil {
		t.Fatalf("история: %v", err)
	}
	var user *store.AIMessage
	for i := range messages {
		if messages[i].Role == "user" {
			user = &messages[i]
			break
		}
	}
	if user == nil {
		t.Fatal("вопрос не записан в историю")
	}
	raw := string(user.Knowledge)
	firstPos := strings.Index(raw, first.ID.String())
	secondPos := strings.Index(raw, second.ID.String())
	if firstPos < 0 || secondPos < 0 {
		t.Fatalf("вложения не сохранились в сообщении: %s", raw)
	}
	if secondPos > firstPos {
		t.Fatalf("порядок вложений не сохранён: %s", raw)
	}
	// Текст модели видел знания: у заглушки сохраняется тело последнего запроса как есть.
	last := e.stub.lastRaw()
	if !strings.Contains(last, "Первое") || !strings.Contains(last, "Второе") {
		t.Fatalf("знания не попали в запрос к модели: %s", last)
	}
}

func TestAttachedKnowledgeFromAnotherProjectIsRejected(t *testing.T) {
	e := setup(t)
	ctx := context.Background()
	owner := e.user(t, "owner@example.com")
	projectID, _, _ := e.seedProject(t, owner)
	knowledge := saveKnowledge(t, e, ctx, projectID, owner, "Своё")

	other, err := e.proj.Create(ctx, owner, "Другой проект", "")
	if err != nil {
		t.Fatalf("проект: %v", err)
	}
	if _, err := e.asst.SendStreamKnowledge(ctx, owner, other.ID, uuid.Nil, "stub:1",
		"вопрос", []uuid.UUID{knowledge.ID}, nil, nil); !errors.Is(err, store.ErrNotFound) {
		t.Fatalf("чужое знание принято: %v", err)
	}
}

// Живой прогон на стенде (0.149.1) показал: настоящая gemma E4B положила тезисы в
// `content`, а `body` оставила пустым — и знание отклонилось как «без текста». Тест
// закрепляет терпимость к этой форме: от «сохрани выводы» человек должен получить знание,
// а не объяснение, что модель перепутала поле.
func TestSaveKnowledgeToolToleratesModelFieldNames(t *testing.T) {
	e := setup(t,
		ai.Reply{ToolCalls: []ai.ToolCall{{
			ID:   "call-1",
			Name: assistant.ToolSaveKnowledge,
			Arguments: map[string]any{"entries": []any{map[string]any{
				"name":    "Канон мира",
				"content": "Драконы спят до весны.",
			}}},
		}}},
		ai.Reply{Content: "Сохранил в знания."},
	)
	ctx := context.Background()
	owner := e.user(t, "owner@example.com")
	projectID, _, _ := e.seedProject(t, owner)

	turn, err := e.asst.Send(ctx, owner, projectID, uuid.Nil, "stub:1", "Сохрани выводы")
	if err != nil {
		t.Fatalf("вопрос: %v", err)
	}
	if len(turn.Knowledge) != 1 {
		t.Fatalf("сохранено знаний %d, ожидалось 1 (ответ: %+v)", len(turn.Knowledge), turn.Calls)
	}
	if turn.Knowledge[0].Title != "Канон мира" {
		t.Errorf("заголовок: %q", turn.Knowledge[0].Title)
	}
	list, err := e.asst.KnowledgeList(ctx, owner, projectID, "")
	if err != nil || len(list) != 1 {
		t.Fatalf("список знаний: %v, %d", err, len(list))
	}
	item, err := e.asst.KnowledgeGet(ctx, owner, projectID, list[0].ID)
	if err != nil {
		t.Fatalf("знание: %v", err)
	}
	if item.Body != "Драконы спят до весны." {
		t.Errorf("тело знания: %q", item.Body)
	}
}

// Знания — черновые исследования соавторов (0.150.0): читатель проекта их не видит.
func TestKnowledgeHiddenFromViewer(t *testing.T) {
	e := setup(t)
	ctx := context.Background()
	owner := e.user(t, "owner@example.com")
	projectID, _, _ := e.seedProject(t, owner)
	viewer := e.user(t, "viewer@example.com")
	if err := e.st.AddMembership(ctx, projectID, viewer, store.RoleViewer); err != nil {
		t.Fatalf("участие: %v", err)
	}
	item := saveKnowledge(t, e, ctx, projectID, owner, "Черновые выводы")

	if _, err := e.asst.KnowledgeList(ctx, viewer, projectID, ""); !errors.Is(err, assistant.ErrForbidden) {
		t.Fatalf("читатель увидел список знаний: %v", err)
	}
	if _, err := e.asst.KnowledgeGet(ctx, viewer, projectID, item.ID); !errors.Is(err, assistant.ErrForbidden) {
		t.Fatalf("читатель прочитал знание: %v", err)
	}
	// А соавтор-редактор — видит.
	editor := e.user(t, "editor@example.com")
	if err := e.st.AddMembership(ctx, projectID, editor, store.RoleEditor); err != nil {
		t.Fatalf("участие редактора: %v", err)
	}
	if _, err := e.asst.KnowledgeList(ctx, editor, projectID, ""); err != nil {
		t.Fatalf("редактор не увидел знания: %v", err)
	}
	// Признак для интерфейса: у читателя false, у редактора true.
	viewerSettings, err := e.asst.ProjectSettings(ctx, viewer, projectID)
	if err != nil {
		t.Fatalf("настройки читателя: %v", err)
	}
	if viewerSettings.CanUseKnowledge {
		t.Fatal("читателю разрешены знания")
	}
	editorSettings, err := e.asst.ProjectSettings(ctx, editor, projectID)
	if err != nil {
		t.Fatalf("настройки редактора: %v", err)
	}
	if !editorSettings.CanUseKnowledge {
		t.Fatal("редактору знания запрещены")
	}
}

// Дубли (0.150.0): «Решения по миру» поверх «Решения по миру проекта» — шум в списке.
func TestSaveKnowledgeToolSkipsDuplicates(t *testing.T) {
	e := setup(t,
		ai.Reply{ToolCalls: []ai.ToolCall{{
			ID:   "call-1",
			Name: assistant.ToolSaveKnowledge,
			Arguments: map[string]any{"entries": []any{
				map[string]any{"title": "Решения по миру проекта", "body": "почти то же"},
				map[string]any{"title": "Новое про героев", "body": "отдельное знание"},
			}},
		}}},
		ai.Reply{Content: "Одно знание уже было."},
	)
	ctx := context.Background()
	owner := e.user(t, "owner@example.com")
	projectID, _, _ := e.seedProject(t, owner)
	saveKnowledge(t, e, ctx, projectID, owner, "Решения по миру")

	turn, err := e.asst.Send(ctx, owner, projectID, uuid.Nil, "stub:1", "Сохрани выводы")
	if err != nil {
		t.Fatalf("вопрос: %v", err)
	}
	// Похожее знание не записано, новое — записано.
	if len(turn.Knowledge) != 1 || turn.Knowledge[0].Title != "Новое про героев" {
		t.Fatalf("сохранено: %+v", turn.Knowledge)
	}
	list, err := e.asst.KnowledgeList(ctx, owner, projectID, "")
	if err != nil {
		t.Fatalf("список: %v", err)
	}
	if len(list) != 2 {
		t.Fatalf("знаний %d, ожидалось 2", len(list))
	}

	// Пачка ТОЛЬКО из дублей — отказ с объяснением, а не тихое «сохранено».
	e.stub.setReplies(
		ai.Reply{ToolCalls: []ai.ToolCall{{
			ID:   "call-2",
			Name: assistant.ToolSaveKnowledge,
			Arguments: map[string]any{"entries": []any{
				map[string]any{"title": "Решения по миру", "body": "дубль"},
			}},
		}}},
		ai.Reply{Content: "Такое знание уже есть."},
	)
	turn, err = e.asst.Send(ctx, owner, projectID, uuid.Nil, "stub:1", "Сохрани ещё раз")
	if err != nil {
		t.Fatalf("второй вопрос: %v", err)
	}
	if len(turn.Knowledge) != 0 {
		t.Fatalf("дубль записался: %+v", turn.Knowledge)
	}
	if len(turn.Calls) == 0 || turn.Calls[0].OK {
		t.Fatalf("вызов не отмечен как отказ: %+v", turn.Calls)
	}
	if !strings.Contains(turn.Calls[0].Error, "уже есть") {
		t.Fatalf("модели не объяснили причину: %q", turn.Calls[0].Error)
	}
}

// Предупреждение автоочистки (0.150.0): сколько бесед уже за пределами срока.
func TestRetentionPreviewCountsDue(t *testing.T) {
	e := setup(t)
	ctx := context.Background()
	owner := e.user(t, "owner@example.com")
	projectID, _, _ := e.seedProject(t, owner)

	ownConversation(t, e, ctx, projectID, owner, "Свежая")
	old := ownConversation(t, e, ctx, projectID, owner, "Старая")
	if _, err := e.st.Pool.Exec(ctx,
		`UPDATE ai_conversations SET updated_at = now() - interval '9 days' WHERE id = $1`, old.ID); err != nil {
		t.Fatalf("старение: %v", err)
	}
	if _, err := e.asst.SetRetention(ctx, owner, projectID, 7); err != nil {
		t.Fatalf("срок: %v", err)
	}
	settings, err := e.asst.ProjectSettings(ctx, owner, projectID)
	if err != nil {
		t.Fatalf("настройки: %v", err)
	}
	if settings.RetentionDue != 1 {
		t.Fatalf("за пределами срока %d бесед, ожидалась 1", settings.RetentionDue)
	}
	// Ближайшая (свежая) удалится не сразу: ей ещё жить почти весь срок.
	if settings.RetentionNextDays < 6 {
		t.Fatalf("до ближайшего удаления %d дней, ожидалось около 7", settings.RetentionNextDays)
	}
}

func TestRetentionOwnerOnlyAndCleanupHonoursKept(t *testing.T) {
	e := setup(t)
	ctx := context.Background()
	owner := e.user(t, "owner@example.com")
	projectID, _, _ := e.seedProject(t, owner)
	editor := e.user(t, "editor@example.com")
	if err := e.st.AddMembership(ctx, projectID, editor, store.RoleEditor); err != nil {
		t.Fatalf("участие: %v", err)
	}

	// Срок меняет только владелец: он касается бесед всех соавторов.
	if _, err := e.asst.SetRetention(ctx, editor, projectID, 7); !errors.Is(err, assistant.ErrForbidden) {
		t.Fatalf("редактор поменял срок: %v", err)
	}
	settings, err := e.asst.SetRetention(ctx, owner, projectID, 7)
	if err != nil {
		t.Fatalf("владелец не смог: %v", err)
	}
	if settings.RetentionDays != 7 {
		t.Fatalf("срок %d, ожидалось 7", settings.RetentionDays)
	}
	// Недопустимый срок — отказ.
	if _, err := e.asst.SetRetention(ctx, owner, projectID, -1); err == nil {
		t.Fatal("отрицательный срок принят")
	}

	old := ownConversation(t, e, ctx, projectID, owner, "Старая")
	fresh := ownConversation(t, e, ctx, projectID, owner, "Свежая")
	kept := ownConversation(t, e, ctx, projectID, owner, "Оставленная")
	// Старим две беседы: без этого очистка ничего не тронет.
	for _, id := range []uuid.UUID{old.ID, kept.ID} {
		if _, err := e.st.Pool.Exec(ctx,
			`UPDATE ai_conversations SET updated_at = now() - interval '10 days' WHERE id = $1`,
			id); err != nil {
			t.Fatalf("старение беседы: %v", err)
		}
	}
	if err := e.asst.KeepConversation(ctx, owner, projectID, kept.ID, true); err != nil {
		t.Fatalf("пометка «не удалять»: %v", err)
	}

	deleted, err := e.asst.CleanupConversations(ctx)
	if err != nil {
		t.Fatalf("очистка: %v", err)
	}
	if deleted != 1 {
		t.Fatalf("удалено %d бесед, ожидалась 1", deleted)
	}
	list, err := e.st.ListAIConversations(ctx, projectID, owner)
	if err != nil {
		t.Fatalf("список бесед: %v", err)
	}
	got := make(map[uuid.UUID]bool, len(list))
	for _, conversation := range list {
		got[conversation.ID] = true
	}
	if got[old.ID] {
		t.Fatal("старая беседа не удалена")
	}
	if !got[fresh.ID] {
		t.Fatal("свежая беседа удалена")
	}
	if !got[kept.ID] {
		t.Fatal("помеченная «не удалять» беседа удалена")
	}

	// Срок «не удалять» (0) — очистка не трогает ничего, даже старое.
	if _, err := e.asst.SetRetention(ctx, owner, projectID, 0); err != nil {
		t.Fatalf("срок 0: %v", err)
	}
	if _, err := e.st.Pool.Exec(ctx,
		`UPDATE ai_conversations SET updated_at = now() - interval '30 days' WHERE id = $1`,
		fresh.ID); err != nil {
		t.Fatalf("старение: %v", err)
	}
	if n, err := e.asst.CleanupConversations(ctx); err != nil || n != 0 {
		t.Fatalf("при сроке 0 удалено %d (%v)", n, err)
	}
	if _, err := e.asst.KnowledgeGet(ctx, owner, projectID, uuid.New()); !errors.Is(err, store.ErrNotFound) {
		t.Fatalf("чужое знание: %v", err)
	}
}
