package chat_test

// chat_integration_test.go — общий чат проекта (0.95.0).
//
// Проверяем то, что ломается молча:
//   - сообщение сохраняется и читается участником (включая читателя): это разговор, а не правка;
//   - ссылка на элемент текста: кадр обязан быть из этого проекта, цитата — из его текста;
//   - «спросить Нестора»: бот отвечает и ответ ложится в чат отдельным сообщением с подписью;
//   - выключенный бот не съедает вопрос участника: сообщение сохраняется, в ответе — причина;
//   - опрос «что нового» отдаёт только новые сообщения.

import (
	"context"
	"errors"
	"strings"
	"testing"

	"github.com/google/uuid"

	"github.com/skyfraze/backend/internal/auth"
	"github.com/skyfraze/backend/internal/chat"
	"github.com/skyfraze/backend/internal/platform/testdb"
	"github.com/skyfraze/backend/internal/projects"
	"github.com/skyfraze/backend/internal/store"
)

type chatEnv struct {
	st      *store.Store
	svc     *chat.Service
	proj    *projects.Service
	owner   uuid.UUID
	viewer  uuid.UUID
	project uuid.UUID
}

// stubBot — Нестор для тестов: отвечает предсказуемо и запоминает вопросы.
type stubBot struct {
	enabled   bool
	answer    string
	err       error
	questions []string
}

func (b *stubBot) Enabled() bool { return b.enabled }

func (b *stubBot) Answer(_ context.Context, _, _ uuid.UUID, question string) (string, error) {
	b.questions = append(b.questions, question)
	if b.err != nil {
		return "", b.err
	}
	return b.answer, nil
}

func setupChat(t *testing.T) *chatEnv {
	t.Helper()
	pool := testdb.Setup(t, "chat")
	testdb.Truncate(t, pool,
		"project_chat_reactions", "project_chat_messages", "project_entities",
		"login_audit", "webauthn_challenges", "user_webauthn_credentials",
		"user_recovery_codes", "user_totp", "comment_notifications", "comment_views",
		"event_comments", "project_revisions", "ai_changes", "ai_messages", "ai_conversations",
		"project_event_state", "project_ratings", "project_views", "sessions",
		"invitations", "event_assets", "assets", "events", "team_memberships",
		"projects", "users")
	st := store.New(pool)
	proj := projects.New(st)
	ctx := context.Background()

	mkUser := func(email string) uuid.UUID {
		hash, err := auth.HashPassword("hunter22!")
		if err != nil {
			t.Fatalf("хеш пароля: %v", err)
		}
		u, err := st.CreateUser(ctx, email, hash, "Человек")
		if err != nil {
			t.Fatalf("пользователь %s: %v", email, err)
		}
		return u.ID
	}
	env := &chatEnv{st: st, svc: chat.New(st, proj), proj: proj, owner: mkUser("owner@example.com")}
	env.viewer = mkUser("viewer@example.com")
	p, err := proj.Create(ctx, env.owner, "Роман", "")
	if err != nil {
		t.Fatalf("проект: %v", err)
	}
	env.project = p.ID
	if err := st.AddMembership(ctx, env.project, env.viewer, store.RoleViewer); err != nil {
		t.Fatalf("читатель: %v", err)
	}
	return env
}

// frame заводит кадр и возвращает его id.
func (e *chatEnv) frame(t *testing.T, title, body string) uuid.UUID {
	t.Helper()
	id := uuid.New()
	if err := e.st.ReplaceEventTree(context.Background(), e.project, e.owner, []store.Event{
		{ID: id, ProjectID: e.project, Position: 0, Depth: 0, Title: title, Body: body},
	}); err != nil {
		t.Fatalf("кадр: %v", err)
	}
	return id
}

func TestChatPostAndList(t *testing.T) {
	e := setupChat(t)
	ctx := context.Background()

	// Читатель тоже пишет: чат — разговор участников, а не правка текста.
	answer, err := e.svc.Post(ctx, e.viewer, e.project, chat.Input{Body: "  Как вам новая глава?  "})
	if err != nil {
		t.Fatalf("сообщение: %v", err)
	}
	if answer.Message.Body != "Как вам новая глава?" {
		t.Fatalf("текст не очищен: %q", answer.Message.Body)
	}
	if answer.Message.Kind != store.ChatKindUser || answer.Message.AuthorName == "" {
		t.Fatalf("подпись сообщения: %+v", answer.Message)
	}
	if answer.Reply != nil || answer.Note != "" {
		t.Fatalf("без просьбы бот не отвечает: %+v", answer)
	}

	list, err := e.svc.Messages(ctx, e.owner, e.project, nil, nil, 0)
	if err != nil {
		t.Fatalf("список: %v", err)
	}
	if len(list) != 1 || list[0].ID != answer.Message.ID {
		t.Fatalf("список сообщений: %+v", list)
	}

	// «Что нового» после последнего прочитанного — только новые.
	newer, err := e.svc.Post(ctx, e.owner, e.project, chat.Input{Body: "Мне нравится."})
	if err != nil {
		t.Fatalf("второе сообщение: %v", err)
	}
	after := answer.Message.ID
	fresh, err := e.svc.Messages(ctx, e.viewer, e.project, &after, nil, 0)
	if err != nil {
		t.Fatalf("новые: %v", err)
	}
	if len(fresh) != 1 || fresh[0].ID != newer.Message.ID {
		t.Fatalf("после отметки: %+v", fresh)
	}
}

func TestChatLinkToFrameAndQuote(t *testing.T) {
	e := setupChat(t)
	ctx := context.Background()
	frame := e.frame(t, "Пролог", "Анна стоит на пороге. Земля ещё спит.")

	// Ссылка на кадр целиком.
	link := frame
	if _, err := e.svc.Post(ctx, e.owner, e.project, chat.Input{Body: "Смотрите сюда", EventID: &link}); err != nil {
		t.Fatalf("ссылка на кадр: %v", err)
	}
	// Ссылка на фразу: она обязана быть в тексте кадра.
	answer, err := e.svc.Post(ctx, e.owner, e.project, chat.Input{
		Body: "Вот эта фраза", EventID: &link, Quote: "Земля ещё спит",
	})
	if err != nil {
		t.Fatalf("ссылка на фразу: %v", err)
	}
	if answer.Message.Quote != "Земля ещё спит" {
		t.Fatalf("цитата: %q", answer.Message.Quote)
	}

	// Фразы нет — отказ, а не ссылка в пустоту.
	if _, err := e.svc.Post(ctx, e.owner, e.project, chat.Input{
		Body: "Пустая ссылка", EventID: &link, Quote: "Такой фразы нет",
	}); !errors.Is(err, chat.ErrQuoteNotFound) {
		t.Fatalf("цитата не из текста принята: %v", err)
	}
	// Кадр чужого проекта — отказ.
	other, err := e.proj.Create(ctx, e.owner, "Другой", "")
	if err != nil {
		t.Fatalf("второй проект: %v", err)
	}
	foreign := uuid.New()
	if err := e.st.ReplaceEventTree(ctx, other.ID, e.owner, []store.Event{
		{ID: foreign, ProjectID: other.ID, Position: 0, Depth: 0, Title: "Чужой", Body: "текст"},
	}); err != nil {
		t.Fatalf("кадр другого проекта: %v", err)
	}
	if _, err := e.svc.Post(ctx, e.owner, e.project, chat.Input{Body: "Чужое", EventID: &foreign}); !errors.Is(err, chat.ErrEventNotFound) {
		t.Fatalf("чужой кадр принят: %v", err)
	}
}

func TestChatBotAnswer(t *testing.T) {
	e := setupChat(t)
	ctx := context.Background()
	bot := &stubBot{enabled: true, answer: "Мне кажется, сцена держит внимание."}
	e.svc.UseBot(bot, "Нестор")
	frame := e.frame(t, "Пролог", "Анна стоит на пороге.")

	if !e.svc.BotAvailable() {
		t.Fatal("включённый бот должен быть доступен")
	}
	link := frame
	answer, err := e.svc.Post(ctx, e.viewer, e.project, chat.Input{
		Body: "Нестор, что думаешь про сцену?", EventID: &link, Quote: "Анна стоит на пороге", AskBot: true,
	})
	if err != nil {
		t.Fatalf("вопрос боту: %v", err)
	}
	if answer.Reply == nil {
		t.Fatalf("ответа бота нет: %+v", answer)
	}
	if answer.Reply.Kind != store.ChatKindBot || answer.Reply.AuthorName != "Нестор" {
		t.Fatalf("подпись ответа: %+v", answer.Reply)
	}
	if !strings.Contains(answer.Reply.Body, "держит внимание") {
		t.Fatalf("текст ответа: %q", answer.Reply.Body)
	}
	// Вопрос к модели содержит контекст: без него бот отвечает «вообще».
	if len(bot.questions) != 1 {
		t.Fatalf("вопросов к модели: %d", len(bot.questions))
	}
	for _, want := range []string{"Пролог", "Анна стоит на пороге", "Нестор, что думаешь"} {
		if !strings.Contains(bot.questions[0], want) {
			t.Errorf("в вопросе модели нет %q: %s", want, bot.questions[0])
		}
	}

	// Оба сообщения в чате: вопрос участника и ответ бота.
	list, err := e.svc.Messages(ctx, e.owner, e.project, nil, nil, 0)
	if err != nil {
		t.Fatalf("список: %v", err)
	}
	if len(list) != 2 {
		t.Fatalf("сообщений в чате: %d (%+v)", len(list), list)
	}
}

func TestChatBotDisabledKeepsMessage(t *testing.T) {
	e := setupChat(t)
	ctx := context.Background()
	// Бот не подключён вовсе.
	answer, err := e.svc.Post(ctx, e.owner, e.project, chat.Input{Body: "Нестор, ау?", AskBot: true})
	if err != nil {
		t.Fatalf("сообщение: %v", err)
	}
	if answer.Reply != nil {
		t.Fatalf("выключенный бот ответил: %+v", answer.Reply)
	}
	if !strings.Contains(answer.Note, "выключен") {
		t.Fatalf("причина не объяснена: %q", answer.Note)
	}
	list, err := e.svc.Messages(ctx, e.owner, e.project, nil, nil, 0)
	if err != nil || len(list) != 1 {
		t.Fatalf("вопрос участника потерян: %+v, %v", list, err)
	}

	// Бот подключён, но ответил ошибкой — сообщение тоже остаётся.
	bot := &stubBot{enabled: true, err: errors.New("модель недоступна")}
	e.svc.UseBot(bot, "Нестор")
	answer, err = e.svc.Post(ctx, e.owner, e.project, chat.Input{Body: "И ещё вопрос", AskBot: true})
	if err != nil {
		t.Fatalf("сообщение при ошибке бота: %v", err)
	}
	if !strings.Contains(answer.Note, "не смог ответить") {
		t.Fatalf("ошибка бота не объяснена: %q", answer.Note)
	}
}

func TestChatPermissions(t *testing.T) {
	e := setupChat(t)
	ctx := context.Background()
	outsider := uuid.New()
	if _, err := e.svc.Messages(ctx, outsider, e.project, nil, nil, 0); !errors.Is(err, projects.ErrForbidden) {
		t.Fatalf("посторонний прочитал чат: %v", err)
	}
	if _, err := e.svc.Post(ctx, outsider, e.project, chat.Input{Body: "Чужой"}); !errors.Is(err, projects.ErrForbidden) {
		t.Fatalf("посторонний написал в чат: %v", err)
	}
	// Пустое сообщение — ошибка, а не пустая строка в чате.
	if _, err := e.svc.Post(ctx, e.owner, e.project, chat.Input{Body: "   "}); !errors.Is(err, chat.ErrInvalidMessage) {
		t.Fatalf("пустое сообщение принято: %v", err)
	}
}

// Бот видит последние сообщения чата (0.96.0): без них он отвечает вне обсуждения.
func TestChatBotSeesRecentMessages(t *testing.T) {
	e := setupChat(t)
	ctx := context.Background()
	bot := &stubBot{enabled: true, answer: "Отвечаю с учётом обсуждения."}
	e.svc.UseBot(bot, "Нестор")

	if _, err := e.svc.Post(ctx, e.owner, e.project, chat.Input{Body: "Начало обсуждения сцены."}); err != nil {
		t.Fatalf("первое сообщение: %v", err)
	}
	if _, err := e.svc.Post(ctx, e.viewer, e.project, chat.Input{Body: "Согласен, но с оговоркой."}); err != nil {
		t.Fatalf("второе сообщение: %v", err)
	}
	if _, err := e.svc.Post(ctx, e.owner, e.project, chat.Input{Body: "Нестор, а как же второе?", AskBot: true}); err != nil {
		t.Fatalf("вопрос боту: %v", err)
	}
	if len(bot.questions) != 1 {
		t.Fatalf("вопросов к модели: %d", len(bot.questions))
	}
	question := bot.questions[0]
	if !strings.Contains(question, "Последние сообщения чата") {
		t.Fatalf("в вопросе нет блока истории: %s", question)
	}
	for _, want := range []string{"Начало обсуждения сцены", "Согласен, но с оговоркой"} {
		if !strings.Contains(question, want) {
			t.Errorf("в истории нет %q: %s", want, question)
		}
	}
	// Автор реплики в истории — по имени, иначе модель не поймёт, кто что сказал.
	if !strings.Contains(question, "Человек:") {
		t.Errorf("в истории нет автора: %s", question)
	}
}

// Ответ на сообщение и правка своего (0.96.0).
func TestChatReplyAndEdit(t *testing.T) {
	e := setupChat(t)
	ctx := context.Background()

	first, err := e.svc.Post(ctx, e.owner, e.project, chat.Input{Body: "Первое сообщение."})
	if err != nil {
		t.Fatalf("первое сообщение: %v", err)
	}
	reply, err := e.svc.Post(ctx, e.viewer, e.project, chat.Input{
		Body: "Отвечаю на первое.", ReplyTo: &first.Message.ID,
	})
	if err != nil {
		t.Fatalf("ответ: %v", err)
	}
	if reply.Message.ReplyTo == nil || *reply.Message.ReplyTo != first.Message.ID {
		t.Fatalf("ответ не указывает на исходное: %+v", reply.Message.ReplyTo)
	}

	// Ответ на сообщение из другого проекта (или несуществующее) — отказ: ссылка в чужой
	// разговор была бы враньём.
	foreign := uuid.New()
	if _, err := e.svc.Post(ctx, e.owner, e.project, chat.Input{
		Body: "Ответ в пустоту", ReplyTo: &foreign,
	}); !errors.Is(err, chat.ErrReplyTarget) {
		t.Fatalf("ответ на чужое сообщение принят: %v", err)
	}

	// Правка своего: текст меняется, отметка «изменено» появляется, автор — прежний.
	edited, err := e.svc.Edit(ctx, e.owner, e.project, first.Message.ID, "  Первое, исправленное.  ")
	if err != nil {
		t.Fatalf("правка: %v", err)
	}
	if edited.Body != "Первое, исправленное." {
		t.Fatalf("текст не очищен: %q", edited.Body)
	}
	if edited.EditedAt == nil {
		t.Fatal("нет отметки «изменено»")
	}
	if edited.AuthorName != first.Message.AuthorName {
		t.Fatalf("правка сменила автора: %q → %q", first.Message.AuthorName, edited.AuthorName)
	}

	// Чужое сообщение править нельзя: подмена сказанного невозможна.
	if _, err := e.svc.Edit(ctx, e.viewer, e.project, first.Message.ID, "не моё"); !errors.Is(err, chat.ErrNotAuthor) {
		t.Fatalf("чужое сообщение отредактировано: %v", err)
	}
	// Сообщение бота — запись разговора, а не текст для правки.
	bot := &stubBot{enabled: true, answer: "Ответ Нестора."}
	e.svc.UseBot(bot, "Нестор")
	withBot, err := e.svc.Post(ctx, e.owner, e.project, chat.Input{Body: "Нестор, ау?", AskBot: true})
	if err != nil || withBot.Reply == nil {
		t.Fatalf("ответ бота: %v, %+v", err, withBot)
	}
	if _, err := e.svc.Edit(ctx, e.owner, e.project, withBot.Reply.ID, "подмена ответа"); !errors.Is(err, chat.ErrNotAuthor) {
		t.Fatalf("ответ бота отредактирован: %v", err)
	}
}

// «Прочитано» и непрочитанное (0.97.0): колокольчик считает по серверу.
func TestChatUnreadAndSeen(t *testing.T) {
	e := setupChat(t)
	ctx := context.Background()

	if _, err := e.svc.Post(ctx, e.viewer, e.project, chat.Input{Body: "Привет, коллеги."}); err != nil {
		t.Fatalf("сообщение: %v", err)
	}
	unread, err := e.svc.Unread(ctx, e.owner)
	if err != nil {
		t.Fatalf("непрочитанное: %v", err)
	}
	if len(unread) != 1 || unread[0].Unread != 1 || unread[0].ProjectID != e.project {
		t.Fatalf("непрочитанное владельца: %+v", unread)
	}
	if unread[0].Title != "Роман" {
		t.Errorf("название проекта: %q", unread[0].Title)
	}
	// Свои сообщения не считаются: «я написал» — прочитано.
	if own, err := e.svc.Unread(ctx, e.viewer); err != nil || len(own) != 0 {
		t.Fatalf("своё сообщение посчитано непрочитанным: %+v, %v", own, err)
	}

	if err := e.svc.MarkSeen(ctx, e.owner, e.project); err != nil {
		t.Fatalf("отметка: %v", err)
	}
	if after, err := e.svc.Unread(ctx, e.owner); err != nil || len(after) != 0 {
		t.Fatalf("после отметки осталось непрочитанное: %+v, %v", after, err)
	}

	// Новое сообщение снова непрочитано — отметка не «глушит» чат навсегда.
	if _, err := e.svc.Post(ctx, e.viewer, e.project, chat.Input{Body: "И ещё одно."}); err != nil {
		t.Fatalf("второе сообщение: %v", err)
	}
	if again, err := e.svc.Unread(ctx, e.owner); err != nil || len(again) != 1 || again[0].Unread != 1 {
		t.Fatalf("новое сообщение не посчитано: %+v, %v", again, err)
	}
}

// «@Нестор» в тексте зовёт бота без кнопки (0.97.0).
func TestChatMentionsBotInText(t *testing.T) {
	e := setupChat(t)
	ctx := context.Background()
	bot := &stubBot{enabled: true, answer: "Отвечаю по делу."}
	e.svc.UseBot(bot, "Нестор")

	answer, err := e.svc.Post(ctx, e.owner, e.project, chat.Input{Body: "@Нестор, что скажешь про сцену?"})
	if err != nil {
		t.Fatalf("сообщение с упоминанием: %v", err)
	}
	if answer.Reply == nil {
		t.Fatal("бот не ответил на «@Нестор» в тексте")
	}

	// Без собаки — просто имя в тексте, бот не отвечает: иначе он вмешивался бы в каждую главу,
	// где героя зовут Нестор.
	plain, err := e.svc.Post(ctx, e.owner, e.project, chat.Input{Body: "Нестор молчал весь вечер."})
	if err != nil {
		t.Fatalf("сообщение без упоминания: %v", err)
	}
	if plain.Reply != nil {
		t.Fatal("бот ответил на имя без собаки")
	}
}

// Письма о сообщениях чата ставятся в очередь (0.97.0): только участникам, только с согласием,
// и никогда автору.
func TestChatEnqueuesNotifications(t *testing.T) {
	e := setupChat(t)
	ctx := context.Background()

	// Согласие на письма у читателя включено, у владельца — нет.
	if _, err := e.st.Pool.Exec(ctx, `UPDATE users SET notify_comments = true WHERE id = $1`, e.viewer); err != nil {
		t.Fatalf("флаг читателя: %v", err)
	}
	if _, err := e.svc.Post(ctx, e.owner, e.project, chat.Input{Body: "Всем привет."}); err != nil {
		t.Fatalf("сообщение: %v", err)
	}
	pending, err := e.st.PendingChatNotifications(ctx, 10, 5)
	if err != nil {
		t.Fatalf("очередь: %v", err)
	}
	if len(pending) != 1 {
		t.Fatalf("писем в очереди: %d (%+v)", len(pending), pending)
	}
	if pending[0].UserID != e.viewer {
		t.Fatalf("письмо не тому: %+v", pending[0])
	}
	if pending[0].Email == "" || pending[0].ProjectTitle == "" || pending[0].AuthorName == "" {
		t.Fatalf("в письме нет данных: %+v", pending[0])
	}

	// Автору своё сообщение письмом не приходит: включили согласие обоим, пишет читатель —
	// письмо должно уйти ровно одно, владельцу.
	if _, err := e.st.Pool.Exec(ctx, `UPDATE users SET notify_comments = true WHERE id = $1`, e.owner); err != nil {
		t.Fatalf("флаг владельца: %v", err)
	}
	if _, err := e.st.Pool.Exec(ctx, `DELETE FROM chat_notifications`); err != nil {
		t.Fatalf("чистка очереди: %v", err)
	}
	second, err := e.svc.Post(ctx, e.viewer, e.project, chat.Input{Body: "Ответ владельцу."})
	if err != nil {
		t.Fatalf("второе сообщение: %v", err)
	}
	pending, err = e.st.PendingChatNotifications(ctx, 10, 5)
	if err != nil {
		t.Fatalf("очередь после второго: %v", err)
	}
	if len(pending) != 1 {
		t.Fatalf("писем после второго сообщения: %d (%+v)", len(pending), pending)
	}
	if pending[0].UserID != e.owner {
		t.Fatalf("письмо ушло не владельцу: %+v", pending[0])
	}
	if pending[0].MessageID != second.Message.ID {
		t.Fatalf("письмо о другом сообщении: %+v", pending[0])
	}
}

// TestChatReactions — отметки на сообщениях (0.98.0).
//
// Что проверяем и почему именно это:
//   - пустое состояние отдаёт пустой СПИСОК, а не nil: интерфейс читает `mine` без проверок;
//   - повторное нажатие СНИМАЕТ отметку, а не ставит вторую (иначе кнопка «залипала» бы);
//   - у двух людей разные отметки, и каждый видит своими только свои;
//   - отметки приходят вместе с лентой — окно не делает второй запрос на них;
//   - чужое сообщение отметить нельзя: иначе по идентификатору можно было бы достать чужой чат.
func TestChatReactions(t *testing.T) {
	e := setupChat(t)
	ctx := context.Background()

	answer, err := e.svc.Post(ctx, e.viewer, e.project, chat.Input{Body: "Может, переименуем главу?"})
	if err != nil {
		t.Fatalf("сообщение: %v", err)
	}
	messageID := answer.Message.ID

	// Пусто: три нуля и пустой список «моих».
	empty, err := e.svc.ReactionStats(ctx, e.owner, messageID)
	if err != nil {
		t.Fatalf("пустые отметки: %v", err)
	}
	if empty.Agree != 0 || empty.Todo != 0 || empty.Question != 0 {
		t.Fatalf("у нового сообщения есть отметки: %+v", empty)
	}
	if empty.Mine == nil {
		t.Fatalf("«мои» пришли nil, а не пустым списком: %+v", empty)
	}

	// Ставлю «надо сделать» — появляется, и это моя отметка.
	after, err := e.svc.ToggleReaction(ctx, e.owner, e.project, messageID, store.ChatReactionTodo)
	if err != nil {
		t.Fatalf("первая отметка: %v", err)
	}
	if after.Todo != 1 || len(after.Mine) != 1 || after.Mine[0] != string(store.ChatReactionTodo) {
		t.Fatalf("отметка не встала: %+v", after)
	}

	// Повторное нажатие снимает, а не добавляет вторую.
	after, err = e.svc.ToggleReaction(ctx, e.owner, e.project, messageID, store.ChatReactionTodo)
	if err != nil {
		t.Fatalf("снятие отметки: %v", err)
	}
	if after.Todo != 0 || len(after.Mine) != 0 {
		t.Fatalf("повторное нажатие не сняло отметку: %+v", after)
	}

	// Двое на одном сообщении: у каждого своё, и «мои» — только свои.
	if _, err := e.svc.ToggleReaction(ctx, e.owner, e.project, messageID, store.ChatReactionAgree); err != nil {
		t.Fatalf("владелец: %v", err)
	}
	if _, err := e.svc.ToggleReaction(ctx, e.viewer, e.project, messageID, store.ChatReactionTodo); err != nil {
		t.Fatalf("читатель: %v", err)
	}
	ownerSees, err := e.svc.ReactionStats(ctx, e.owner, messageID)
	if err != nil {
		t.Fatalf("отметки владельца: %v", err)
	}
	if ownerSees.Agree != 1 || ownerSees.Todo != 1 {
		t.Fatalf("счётчики у владельца: %+v", ownerSees)
	}
	if len(ownerSees.Mine) != 1 || ownerSees.Mine[0] != string(store.ChatReactionAgree) {
		t.Fatalf("«моё» у владельца: %+v", ownerSees.Mine)
	}
	viewerSees, err := e.svc.ReactionStats(ctx, e.viewer, messageID)
	if err != nil {
		t.Fatalf("отметки читателя: %v", err)
	}
	if len(viewerSees.Mine) != 1 || viewerSees.Mine[0] != string(store.ChatReactionTodo) {
		t.Fatalf("«моё» у читателя: %+v", viewerSees.Mine)
	}

	// Лента приносит отметки вместе с сообщениями.
	list, err := e.svc.Messages(ctx, e.viewer, e.project, nil, nil, 0)
	if err != nil {
		t.Fatalf("лента: %v", err)
	}
	if len(list) != 1 || list[0].Reactions.Agree != 1 || list[0].Reactions.Todo != 1 {
		t.Fatalf("отметки в ленте: %+v", list)
	}

	// Чужого сообщения нет — отметить нечего.
	if _, err := e.svc.ToggleReaction(ctx, e.owner, e.project, uuid.New(), store.ChatReactionAgree); !errors.Is(err, chat.ErrMessageNotFound) {
		t.Fatalf("чужое сообщение отмечено: %v", err)
	}

	// Неизвестный вид отметки не разбирается вовсе: набор фиксирован схемой.
	if _, ok := store.ParseChatReactionKind("like"); ok {
		t.Fatalf("«like» приняли за отметку")
	}
}

// TestChatHistoryPaging — «показать прежние» (0.99.2).
//
// До этого окно открывалось последними 100 сообщениями, и в живом проекте начало разговора было
// недостижимо вовсе. Проверяем страницы назад: они не пересекаются с уже показанным, идут от
// старых к новым, доходят до первого сообщения и на исчерпании отдают пусто (а не повторяют
// последнюю страницу — иначе кнопка «показать прежние» крутилась бы вечно).
func TestChatHistoryPaging(t *testing.T) {
	e := setupChat(t)
	ctx := context.Background()

	const total = 7
	posted := make([]uuid.UUID, 0, total)
	for i := 0; i < total; i++ {
		answer, err := e.svc.Post(ctx, e.owner, e.project, chat.Input{Body: "сообщение " + string(rune('A'+i))})
		if err != nil {
			t.Fatalf("сообщение %d: %v", i, err)
		}
		posted = append(posted, answer.Message.ID)
	}

	// Первая страница — три последних, как открывается окно.
	first, err := e.svc.Messages(ctx, e.owner, e.project, nil, nil, 3)
	if err != nil {
		t.Fatalf("первая страница: %v", err)
	}
	if len(first) != 3 || first[2].ID != posted[6] || first[0].ID != posted[4] {
		t.Fatalf("первая страница не та: %+v", ids(first))
	}

	// Назад от самого старого в первой странице: приходят ровно предыдущие три.
	before := first[0].ID
	older, err := e.svc.Messages(ctx, e.owner, e.project, nil, &before, 3)
	if err != nil {
		t.Fatalf("страница назад: %v", err)
	}
	if len(older) != 3 || older[2].ID != posted[3] || older[0].ID != posted[1] {
		t.Fatalf("страница назад не та: %+v", ids(older))
	}
	for _, message := range older {
		if message.ID == first[0].ID || message.ID == first[1].ID {
			t.Fatalf("страницы пересеклись: %+v", ids(older))
		}
	}

	// Ещё назад — остаётся одно сообщение, и оно первое.
	before = older[0].ID
	last, err := e.svc.Messages(ctx, e.owner, e.project, nil, &before, 3)
	if err != nil {
		t.Fatalf("последняя страница: %v", err)
	}
	if len(last) != 1 || last[0].ID != posted[0] {
		t.Fatalf("последняя страница не та: %+v", ids(last))
	}

	// Дальше истории нет: пусто, а не повтор.
	before = posted[0]
	empty, err := e.svc.Messages(ctx, e.owner, e.project, nil, &before, 3)
	if err != nil {
		t.Fatalf("пустая страница: %v", err)
	}
	if len(empty) != 0 {
		t.Fatalf("после начала истории что-то есть: %+v", ids(empty))
	}
}

func ids(messages []chat.MessageView) []uuid.UUID {
	out := make([]uuid.UUID, 0, len(messages))
	for _, message := range messages {
		out = append(out, message.ID)
	}
	return out
}
