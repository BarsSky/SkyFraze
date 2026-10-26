package events_test

// comments_anchors_integration_test.go — замечание к фрагменту текста (миграция 0026).
//
// Что проверяется. Якорь — это байты `Y.RelativePosition`, присланные клиентом; сервер их не
// резолвит (снапшот отстаёт до ~5 с), но обязан проверить, что они читаются, что цитата есть
// и что фрагмент не «вся глава». Плюс главное: замечание к фрагменту — это ТОТ ЖЕ комментарий
// (ветки, реакции, упоминания), а не отдельная сущность; отдельная таблица лишь отвечает на
// вопрос «к чему именно».

import (
	"context"
	"errors"
	"strings"
	"testing"

	ygo "github.com/Deln0r/ygo"
	"github.com/google/uuid"

	"github.com/skyfraze/backend/internal/collab/yjs"
	"github.com/skyfraze/backend/internal/events"
	"github.com/skyfraze/backend/internal/store"
)

// anchorFor строит настоящий якорь по документу кадра — так же, как это делает клиент.
// Тело кадра: «Первый абзац.\n» + quote + «\nТретий абзац.», поэтому quote стоит ровно
// с указанных смещений.
func (e *commentEnv) anchorFor(t *testing.T, eventID uuid.UUID, quote string) *store.CommentAnchor {
	t.Helper()
	doc := yjs.NewDoc()
	if err := doc.SeedEvents([]yjs.EventSeed{{
		ID: eventID.String(), Title: "Глава", Body: "Первый абзац.\n" + quote + "\nТретий абзац.",
	}}); err != nil {
		t.Fatalf("документ: %v", err)
	}
	text, ok := doc.TextOf(eventID.String(), "body")
	if !ok {
		t.Fatal("текста кадра нет в документе")
	}
	from := len([]rune("Первый абзац.\n"))
	to := from + len([]rune(quote))
	start, err := ygo.CreateRelativePositionFromTypeIndex(text, uint64(from), 1)
	if err != nil {
		t.Fatalf("якорь начала: %v", err)
	}
	end, err := ygo.CreateRelativePositionFromTypeIndex(text, uint64(to), -1)
	if err != nil {
		t.Fatalf("якорь конца: %v", err)
	}
	startBytes, err := ygo.EncodeRelativePosition(start)
	if err != nil {
		t.Fatalf("кодирование начала: %v", err)
	}
	endBytes, err := ygo.EncodeRelativePosition(end)
	if err != nil {
		t.Fatalf("кодирование конца: %v", err)
	}
	return &store.CommentAnchor{Field: "body", Start: startBytes, End: endBytes, Quote: quote}
}

// Замечание к фрагменту сохраняется и возвращается вместе с обсуждением.
func TestCommentsAnchorRoundTrip(t *testing.T) {
	e := setupComments(t)
	ctx := context.Background()
	projectID, first, _ := e.project(t)

	const quote = "Второй абзац."
	anchor := e.anchorFor(t, first, quote)

	comment, err := e.svc.AddComment(ctx, e.owner, projectID, first, "Здесь провал в логике.", nil, anchor)
	if err != nil {
		t.Fatalf("комментарий с якорем: %v", err)
	}
	if comment.Anchor == nil || comment.Anchor.Quote != quote {
		t.Fatalf("якорь не вернулся в ответе: %+v", comment.Anchor)
	}

	list, err := e.svc.ListComments(ctx, e.owner, projectID, first, 0)
	if err != nil || len(list) != 1 {
		t.Fatalf("список: %+v (err=%v)", list, err)
	}
	saved := list[0].Anchor
	if saved == nil {
		t.Fatal("якорь не сохранился")
	}
	if saved.Field != "body" || saved.Quote != quote {
		t.Errorf("якорь: %+v", saved)
	}
	// Байты — те же, что прислали: сервер их не переписывает (иначе якорь перестал бы
	// указывать на тот же фрагмент в документе).
	if string(saved.Start) != string(anchor.Start) || string(saved.End) != string(anchor.End) {
		t.Error("позиции якоря изменились при сохранении")
	}
	// И они действительно читаются как Y.RelativePosition.
	if _, err := ygo.DecodeRelativePosition(saved.Start); err != nil {
		t.Errorf("сохранённое начало не читается: %v", err)
	}
}

// Обычное замечание к кадру остаётся обычным: якоря у него нет.
func TestCommentsWithoutAnchorStayFrameLevel(t *testing.T) {
	e := setupComments(t)
	ctx := context.Background()
	projectID, first, _ := e.project(t)

	if _, err := e.svc.AddComment(ctx, e.owner, projectID, first, "Замечание к кадру.", nil, nil); err != nil {
		t.Fatalf("комментарий: %v", err)
	}
	list, err := e.svc.ListComments(ctx, e.owner, projectID, first, 0)
	if err != nil {
		t.Fatalf("список: %v", err)
	}
	if len(list) != 1 || list[0].Anchor != nil {
		t.Fatalf("у замечания к кадру появился якорь: %+v", list[0].Anchor)
	}
}

// Отказы: мусор вместо позиции, пустая цитата, слишком длинный фрагмент, чужое поле.
func TestCommentsAnchorValidation(t *testing.T) {
	e := setupComments(t)
	ctx := context.Background()
	projectID, first, _ := e.project(t)
	indices := e.anchorFor(t, first, "Первый абзац.")

	cases := []struct {
		name   string
		anchor *store.CommentAnchor
	}{
		{"нет позиции начала", &store.CommentAnchor{Field: "body", End: indices.End, Quote: "текст"}},
		{"мусор в позиции", &store.CommentAnchor{Field: "body", Start: []byte("не relpos"), End: indices.End, Quote: "текст"}},
		{"пустая цитата", &store.CommentAnchor{Field: "body", Start: indices.Start, End: indices.End, Quote: "  "}},
		{"чужое поле", &store.CommentAnchor{Field: "event_date", Start: indices.Start, End: indices.End, Quote: "текст"}},
		{"слишком длинный фрагмент", &store.CommentAnchor{
			Field: "body", Start: indices.Start, End: indices.End,
			Quote: strings.Repeat("я", events.MaxAnchorRunes+1),
		}},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if _, err := e.svc.AddComment(ctx, e.owner, projectID, first, "Замечание.", nil, tc.anchor); !errors.Is(err, events.ErrValidation) {
				t.Fatalf("ожидался отказ валидации, получено %v", err)
			}
		})
	}
	// После отказов в обсуждении пусто: отклонённый якорь не оставляет полусохранённого
	// комментария без якоря.
	list, err := e.svc.ListComments(ctx, e.owner, projectID, first, 0)
	if err != nil {
		t.Fatalf("список: %v", err)
	}
	if len(list) != 0 {
		t.Fatalf("после отказов остались комментарии: %+v", list)
	}
}

// Ответ на замечание к фрагменту — тоже комментарий с якорем или без: ветка не обязана
// наследовать якорь, и это проверяется явно, чтобы «ответ привязан к тому же абзацу» не
// появилось само собой.
func TestCommentsAnchorReplyIsIndependent(t *testing.T) {
	e := setupComments(t)
	ctx := context.Background()
	projectID, first, _ := e.project(t)
	anchor := e.anchorFor(t, first, "Первый абзац.")

	root, err := e.svc.AddComment(ctx, e.owner, projectID, first, "Здесь провал.", nil, anchor)
	if err != nil {
		t.Fatalf("замечание: %v", err)
	}
	reply, err := e.svc.AddComment(ctx, e.owner, projectID, first, "Согласен.", &root.ID, nil)
	if err != nil {
		t.Fatalf("ответ: %v", err)
	}
	if reply.Anchor != nil {
		t.Errorf("ответ получил якорь сам по себе: %+v", reply.Anchor)
	}
}
