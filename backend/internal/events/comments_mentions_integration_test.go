package events_test

// comments_mentions_integration_test.go — упоминания людей в обсуждении (миграция 0024).
//
// Что именно проверяется и почему. Упоминание — это не «в тексте есть собака», а «этот
// человек участник проекта и его позвали». Поэтому проверяются границы: чужой (не участник)
// не получает упоминания — иначе уведомление выдавало бы существование закрытого проекта;
// свой ник — не упоминание; повтор внутри текста даёт одну строку, а не три; в колокольчике
// по проекту появляется счётчик «меня упомянули», и он гаснет вместе с прочтением кадра.

import (
	"context"
	"testing"

	"github.com/google/uuid"

	"github.com/skyfraze/backend/internal/events"
	"github.com/skyfraze/backend/internal/store"
)

// Разбор `@ник` в тексте: без склейки слов, без повторов, с длиной, при которой ник реально
// существует.
func TestParseMentions(t *testing.T) {
	cases := []struct {
		name string
		text string
		want []string
	}{
		{"один", "Смотри @editor, тут дыра", []string{"editor"}},
		{"два и повтор", "@editor и ещё @editor, а потом @nic-2", []string{"editor", "nic-2"}},
		{"регистр", "@Editor", []string{"Editor"}},
		{"слишком короткий", "@ok", nil},
		{"без собаки", "editor посмотри", nil},
		{"знаки препинания", "@editor.", []string{"editor"}},
		{"в почте не упоминание", "пиши на editor@example.com", nil},
		{"кириллица в нике", "@Серёжа, посмотри", nil},
		{"пусто", "", nil},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got := events.ParseMentions(tc.text)
			if len(got) != len(tc.want) {
				t.Fatalf("%q → %v, ожидалось %v", tc.text, got, tc.want)
			}
			for i := range tc.want {
				if got[i] != tc.want[i] {
					t.Errorf("%q → %v, ожидалось %v", tc.text, got, tc.want)
					break
				}
			}
		})
	}
}

// Упоминание сохраняется только для участников проекта и только в свой адрес.
func TestCommentsMentionsOnlyParticipants(t *testing.T) {
	e := setupComments(t)
	ctx := context.Background()
	projectID, first, _ := e.project(t)
	editor := e.member(t, projectID, store.RoleEditor)

	// Ники подбираются из email: editor@example.com → "editor".
	if _, err := e.svc.AddComment(ctx, e.owner, projectID, first,
		"@editor, посмотри второй абзац", nil); err != nil {
		t.Fatalf("комментарий с упоминанием: %v", err)
	}
	list, err := e.svc.ListComments(ctx, e.owner, projectID, first, 0)
	if err != nil || len(list) != 1 {
		t.Fatalf("список: %v (err=%v)", list, err)
	}
	mentioned, err := e.st.CommentMentionedUsers(ctx, list[0].ID)
	if err != nil {
		t.Fatalf("упоминания: %v", err)
	}
	if len(mentioned) != 1 || mentioned[0] != editor {
		t.Fatalf("упомянутые: %v, ожидался %s", mentioned, editor)
	}

	// Посторонний, ник которого в проекте не встречается, не получает уведомления: ник в
	// тексте остаётся текстом. Ошибки нет — опечатка в нике не должна отменять замечание.
	if _, err := e.svc.AddComment(ctx, e.owner, projectID, first,
		"@stranger, и тебе привет", nil); err != nil {
		t.Fatalf("комментарий с чужим ником: %v", err)
	}
	list, err = e.svc.ListComments(ctx, e.owner, projectID, first, 0)
	if err != nil {
		t.Fatalf("список: %v", err)
	}
	for _, comment := range list {
		users, uerr := e.st.CommentMentionedUsers(ctx, comment.ID)
		if uerr != nil {
			t.Fatalf("упоминания: %v", uerr)
		}
		for _, id := range users {
			if id != editor {
				t.Errorf("упомянут посторонний: %s", id)
			}
		}
	}

	// Свой ник — подпись, а не просьба: себя в списке упоминаний нет.
	if _, err := e.svc.AddComment(ctx, e.owner, projectID, first, "@owner, я поправил", nil); err != nil {
		t.Fatalf("комментарий со своим ником: %v", err)
	}
	list, err = e.svc.ListComments(ctx, e.owner, projectID, first, 0)
	if err != nil {
		t.Fatalf("список: %v", err)
	}
	own, _ := e.st.CommentMentionedUsers(ctx, list[len(list)-1].ID)
	if len(own) != 0 {
		t.Errorf("себя упомянули: %v", own)
	}
}

// Колокольчик: «в проекте новое» и «в проекте позвали меня» — разные числа.
func TestCommentsMentionsCountedInUnread(t *testing.T) {
	e := setupComments(t)
	ctx := context.Background()
	projectID, first, second := e.project(t)
	editor := e.member(t, projectID, store.RoleEditor)

	// Два замечания: одно с упоминанием редактора, второе — без.
	if _, err := e.svc.AddComment(ctx, e.owner, projectID, first, "@editor, глянь", nil); err != nil {
		t.Fatalf("первое: %v", err)
	}
	if _, err := e.svc.AddComment(ctx, e.owner, projectID, second, "Просто замечание", nil); err != nil {
		t.Fatalf("второе: %v", err)
	}
	unread, err := e.svc.UnseenCommentsByProject(ctx, editor)
	if err != nil {
		t.Fatalf("непрочитанное: %v", err)
	}
	if len(unread) != 1 {
		t.Fatalf("проектов с непрочитанным: %+v", unread)
	}
	if unread[0].Unread != 2 || unread[0].Mentions != 1 {
		t.Errorf("непрочитанных %d, из них с упоминанием %d; ожидалось 2 и 1",
			unread[0].Unread, unread[0].Mentions)
	}

	// Прочитал кадр с упоминанием — упоминание гасится вместе с остальными непрочитанными
	// этого кадра: отдельной «вечной» отметки у упоминаний нет.
	if err := e.svc.MarkCommentsSeen(ctx, editor, projectID, first); err != nil {
		t.Fatalf("отметка прочитанного: %v", err)
	}
	unread, err = e.svc.UnseenCommentsByProject(ctx, editor)
	if err != nil {
		t.Fatalf("непрочитанное после отметки: %v", err)
	}
	if len(unread) != 1 || unread[0].Unread != 1 || unread[0].Mentions != 0 {
		t.Errorf("после прочтения: %+v (ожидалось 1 непрочитанное без упоминаний)", unread)
	}
}

// Ответ тоже может кого-то звать: упоминание в ответе работает как в замечании.
func TestCommentsMentionsInReply(t *testing.T) {
	e := setupComments(t)
	ctx := context.Background()
	projectID, first, _ := e.project(t)
	editor := e.member(t, projectID, store.RoleEditor)

	root, err := e.svc.AddComment(ctx, e.owner, projectID, first, "Замечание", nil)
	if err != nil {
		t.Fatalf("замечание: %v", err)
	}
	reply, err := e.svc.AddComment(ctx, e.owner, projectID, first, "Ответ: @editor, ты как?", &root.ID)
	if err != nil {
		t.Fatalf("ответ: %v", err)
	}
	mentioned, err := e.st.CommentMentionedUsers(ctx, reply.ID)
	if err != nil {
		t.Fatalf("упоминания ответа: %v", err)
	}
	if len(mentioned) != 1 || mentioned[0] != editor {
		t.Fatalf("упомянутые в ответе: %v", mentioned)
	}
}

// Кандидаты для подсказки — участники проекта с ником, без посторонних.
func TestProjectMentionCandidates(t *testing.T) {
	e := setupComments(t)
	ctx := context.Background()
	projectID, _, _ := e.project(t)
	editor := e.member(t, projectID, store.RoleEditor)
	// Посторонний: зарегистрирован, но в проект не добавлен.
	if _, err := e.st.CreateUser(ctx, "stranger@example.com", "hash", "Посторонний"); err != nil {
		t.Fatalf("посторонний: %v", err)
	}

	candidates, err := e.st.ProjectMentionCandidates(ctx, projectID)
	if err != nil {
		t.Fatalf("кандидаты: %v", err)
	}
	ids := make(map[uuid.UUID]bool, len(candidates))
	for _, candidate := range candidates {
		if candidate.Username == "" {
			t.Errorf("кандидат без ника: %+v", candidate)
		}
		ids[candidate.UserID] = true
	}
	if !ids[e.owner] || !ids[editor] {
		t.Errorf("в кандидатах нет участников: %+v", candidates)
	}
	if len(ids) != 2 {
		t.Errorf("кандидатов %d, ожидалось 2 (владелец и редактор): %+v", len(ids), candidates)
	}
}
