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

// docSource — подделка «живой комнаты»: документ, который видит сервер.
type docSource struct{ doc *yjs.Doc }

func (d docSource) DocForRead(context.Context, uuid.UUID) *yjs.Doc { return d.doc }

// Якорь сверяется по ЖИВОМУ документу: если фрагмент успели переписать, замечание к старому
// тексту не принимается — иначе оно привязалось бы к чужому абзацу.
//
// Важная деталь, которую этот тест и выявил: `Y.RelativePosition` разрешается только в
// ДОКУМЕНТЕ ТОЙ ЖЕ ЛИНИИ (идентификаторы элементов общие). Поэтому якорь здесь строится по
// документу комнаты — ровно как у клиента, чей документ приехал из снапшота сервера.
// Свежесобранный документ из другого набора байтов якоря не разрешит: для него это чужие id.
func TestCommentsAnchorCheckedAgainstLiveDoc(t *testing.T) {
	e := setupComments(t)
	ctx := context.Background()
	projectID, first, _ := e.project(t)

	live := yjs.NewDoc()
	if err := live.SeedEvents([]yjs.EventSeed{{
		ID: first.String(), Title: "Глава", Body: "Первый абзац.\nВторой абзац.\nТретий абзац.",
	}}); err != nil {
		t.Fatalf("живой документ: %v", err)
	}
	e.svc.UseDocSource(docSource{doc: live})
	anchor := e.anchorForDoc(t, live, first, "Второй абзац.")

	// Якорь совпадает с текстом документа — замечание принимается.
	if _, err := e.svc.AddComment(ctx, e.owner, projectID, first, "Замечание.", nil, anchor); err != nil {
		t.Fatalf("замечание к совпадающему фрагменту отвергнуто: %v", err)
	}

	// Случай 1: внутри фрагмента дописали слова. Якорь по-прежнему разрешается, но текст в
	// нём другой — замечание к «старому» тексту не принимается.
	span, ok := live.ResolveSpan(first.String(), "body", anchor.Start, anchor.End)
	if !ok {
		t.Fatal("якорь не разрешился в своём документе")
	}
	inside := span.From + 6 // после слова «Второй»
	if found, err := live.ReplaceEventSpan(first.String(), "body", inside, inside, " самый"); err != nil || !found {
		t.Fatalf("вставка внутри фрагмента: found=%v err=%v", found, err)
	}
	if text, _ := live.SpanText(first.String(), "body", span); text == anchor.Quote {
		t.Fatalf("фрагмент не изменился: %q", text)
	}
	if _, err := e.svc.AddComment(ctx, e.owner, projectID, first, "Замечание к старому тексту.", nil, anchor); !errors.Is(err, events.ErrValidation) {
		t.Fatalf("замечание к изменённому фрагменту принято: %v", err)
	}

	// Случай 2: фрагмент заменили целиком (так делает правка ассистента и восстановление
	// версии). Что мы знаем измеренного: якорь может остаться разрешимым (Yjs/ygo
	// восстанавливают позицию по соседям) — тогда сработает сверка цитаты и замечание будет
	// отвергнуто; может перестать разрешаться — тогда замечание принимается, но привязки к
	// тексту уже нет (в интерфейсе «фрагмент не найден»). Нарушение — третье: принять
	// замечание, привязав его к ИЗМЕНЁННОМУ тексту. Это и проверяем.
	span, ok = live.ResolveSpan(first.String(), "body", anchor.Start, anchor.End)
	if !ok {
		t.Fatal("якорь перестал разрешаться до замены фрагмента")
	}
	if found, err := live.ReplaceEventSpan(first.String(), "body", span.From, span.To, "Правка."); err != nil || !found {
		t.Fatalf("замена фрагмента: found=%v err=%v", found, err)
	}
	_, addErr := e.svc.AddComment(ctx, e.owner, projectID, first, "Замечание к исчезнувшему фрагменту.", nil, anchor)
	if addErr == nil {
		// Приняли — значит привязки к ЧУЖОМУ тексту нет: либо якорь больше не разрешается,
		// либо разрешается в пустой фрагмент («удалён»). Слова о другом тексте не должно быть.
		if after, ok := live.ResolveSpan(first.String(), "body", anchor.Start, anchor.End); ok {
			if text := mustSpan(t, live, first, after); text != "" && text != anchor.Quote {
				t.Fatalf("замечание принято и привязано к изменённому тексту %q", text)
			}
		}
	} else if !errors.Is(addErr, events.ErrValidation) {
		t.Fatalf("неожиданный отказ: %v", addErr)
	}
}

// mustSpan достаёт текст фрагмента (для сообщения о провале).
func mustSpan(t *testing.T, doc *yjs.Doc, eventID uuid.UUID, span yjs.Span) string {
	t.Helper()
	text, _ := doc.SpanText(eventID.String(), "body", span)
	return text
}

// anchorForDoc строит якорь по КОНКРЕТНОМУ документу (а не по собственному) — иначе
// идентификаторы элементов не совпадут, и якорь не разрешится ни на клиенте, ни на сервере.
func (e *commentEnv) anchorForDoc(t *testing.T, doc *yjs.Doc, eventID uuid.UUID, quote string) *store.CommentAnchor {
	t.Helper()
	text, ok := doc.TextOf(eventID.String(), "body")
	if !ok {
		t.Fatal("текста кадра нет в документе")
	}
	content := text.String()
	from := strings.Index(content, quote)
	if from < 0 {
		t.Fatalf("цитата %q не найдена", quote)
	}
	startPos, err := ygo.CreateRelativePositionFromTypeIndex(text, uint64(len([]rune(content[:from]))), 1)
	if err != nil {
		t.Fatalf("якорь начала: %v", err)
	}
	to := from + len(quote)
	endPos, err := ygo.CreateRelativePositionFromTypeIndex(text, uint64(len([]rune(content[:to]))), -1)
	if err != nil {
		t.Fatalf("якорь конца: %v", err)
	}
	start, err := ygo.EncodeRelativePosition(startPos)
	if err != nil {
		t.Fatalf("кодирование начала: %v", err)
	}
	end, err := ygo.EncodeRelativePosition(endPos)
	if err != nil {
		t.Fatalf("кодирование конца: %v", err)
	}
	return &store.CommentAnchor{Field: "body", Start: start, End: end, Quote: quote}
}
