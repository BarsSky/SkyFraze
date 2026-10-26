package yjs_test

// anchor_test.go — резолв якоря и правка фрагмента на СЕРВЕРЕ (миграция 0026, фаза 2).
//
// Почему эти тесты отдельные от клиентских. Клиент резолвит якоря для показа, сервер — чтобы
// проверить замечание и применить правку фрагмента. Ошибки здесь тихие: якорь, указывающий
// «почти туда», правит чужой абзац и выглядит успехом. Поэтому проверяются границы: правка
// ровно фрагмента, чужие символы на месте, схлопнувшийся якорь не правит ничего, а эмодзи
// (две единицы UTF-16) не сдвигают границы.

import (
	"testing"

	ygo "github.com/Deln0r/ygo"

	"github.com/skyfraze/backend/internal/collab/yjs"
)

// seedDoc — документ с одним кадром и якорями на фрагмент `quote`.
func seedDoc(t *testing.T, body, quote string) (*yjs.Doc, uint64, uint64, []byte, []byte) {
	t.Helper()
	doc := yjs.NewDoc()
	if err := doc.SeedEvents([]yjs.EventSeed{{ID: "e1", Title: "Глава", Body: body}}); err != nil {
		t.Fatalf("документ: %v", err)
	}
	text, ok := doc.TextOf("e1", "body")
	if !ok {
		t.Fatal("текста кадра нет")
	}
	index := unitIndex(body, quote)
	if index < 0 {
		t.Fatalf("цитата %q не найдена в тексте", quote)
	}
	from := uint64(index)
	to := from + uint64(len([]rune(quote)))
	startPos, err := ygo.CreateRelativePositionFromTypeIndex(text, from, 1)
	if err != nil {
		t.Fatalf("якорь начала: %v", err)
	}
	endPos, err := ygo.CreateRelativePositionFromTypeIndex(text, to, -1)
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
	return doc, from, to, start, end
}

// unitIndex — позиция подстроки в единицах UTF-16 (как их считает Yjs).
func unitIndex(body, quote string) int {
	byteIndex := indexOf(body, quote)
	if byteIndex < 0 {
		return -1
	}
	units := 0
	for _, r := range body[:byteIndex] {
		if r > 0xFFFF {
			units += 2
		} else {
			units++
		}
	}
	return units
}

func indexOf(haystack, needle string) int {
	for i := 0; i+len(needle) <= len(haystack); i++ {
		if haystack[i:i+len(needle)] == needle {
			return i
		}
	}
	return -1
}

func TestResolveSpanRoundTrip(t *testing.T) {
	body := "Первый абзац.\nВторой абзац.\nТретий абзац."
	doc, from, to, start, end := seedDoc(t, body, "Второй абзац.")

	span, ok := doc.ResolveSpan("e1", "body", start, end)
	if !ok {
		t.Fatal("якорь не разрешился")
	}
	if span.From != from || span.To != to {
		t.Fatalf("диапазон %d..%d, ожидался %d..%d", span.From, span.To, from, to)
	}
	text, ok := doc.SpanText("e1", "body", span)
	if !ok || text != "Второй абзац." {
		t.Fatalf("текст фрагмента: %q (ok=%v)", text, ok)
	}
}

// Вставка до фрагмента: якорь едет вместе с текстом, а не остаётся на номере.
func TestResolveSpanAfterInsertBefore(t *testing.T) {
	doc, _, _, start, end := seedDoc(t, "Первый.\nВторой абзац.", "Второй абзац.")
	// Вставка — та же правка спана, только пустого: это операции Delete+Insert в Y.Text.
	if found, err := doc.ReplaceEventSpan("e1", "body", 0, 0, "Заставка.\n"); err != nil || !found {
		t.Fatalf("вставка: found=%v err=%v", found, err)
	}

	span, ok := doc.ResolveSpan("e1", "body", start, end)
	if !ok {
		t.Fatal("якорь не разрешился после вставки")
	}
	if got, _ := doc.SpanText("e1", "body", span); got != "Второй абзац." {
		t.Fatalf("после вставки фрагмент: %q", got)
	}
}

// Правка фрагмента: меняются ровно его символы, остальное на месте.
func TestReplaceEventSpan(t *testing.T) {
	body := "Первый абзац.\nВторой абзац.\nТретий абзац."
	doc, from, to, _, _ := seedDoc(t, body, "Второй абзац.")

	found, err := doc.ReplaceEventSpan("e1", "body", from, to, "Второй абзац, переписанный.")
	if err != nil || !found {
		t.Fatalf("правка: found=%v err=%v", found, err)
	}
	text, _ := doc.TextOf("e1", "body")
	want := "Первый абзац.\nВторой абзац, переписанный.\nТретий абзац."
	if text.String() != want {
		t.Fatalf("текст после правки:\n%q\nожидался:\n%q", text.String(), want)
	}
}

// Замена на пустую строку — это удаление фрагмента, а не «ничего не произошло».
func TestReplaceEventSpanWithEmpty(t *testing.T) {
	doc, from, to, _, _ := seedDoc(t, "Первый.\nВторой.\nТретий.", "Второй.")
	if found, err := doc.ReplaceEventSpan("e1", "body", from, to, ""); err != nil || !found {
		t.Fatalf("удаление фрагмента: found=%v err=%v", found, err)
	}
	text, _ := doc.TextOf("e1", "body")
	if text.String() != "Первый.\n\nТретий." {
		t.Fatalf("после удаления фрагмента: %q", text.String())
	}
}

// Эмодзи: две единицы UTF-16 на символ. Границы не должны съезжать на половину суррогата.
func TestReplaceEventSpanWithEmoji(t *testing.T) {
	body := "🦔 Ёжик.\nВторой абзац."
	doc, from, to, _, _ := seedDoc(t, body, "Второй абзац.")
	if found, err := doc.ReplaceEventSpan("e1", "body", from, to, "Правка."); err != nil || !found {
		t.Fatalf("правка: found=%v err=%v", found, err)
	}
	text, _ := doc.TextOf("e1", "body")
	if text.String() != "🦔 Ёжик.\nПравка." {
		t.Fatalf("после правки с эмодзи: %q", text.String())
	}
}

// Якорь на удалённый фрагмент: резолв даёт пустой диапазон, правка ничего не портит.
func TestCollapsedSpanEditsNothing(t *testing.T) {
	body := "Первый.\nВторой.\nТретий."
	doc, from, to, start, end := seedDoc(t, body, "Второй.")
	if found, err := doc.ReplaceEventSpan("e1", "body", from, to, ""); err != nil || !found {
		t.Fatalf("удаление: found=%v err=%v", found, err)
	}

	span, ok := doc.ResolveSpan("e1", "body", start, end)
	if !ok {
		t.Fatal("после удаления якорь перестал разрешаться (ожидался пустой диапазон)")
	}
	if !span.Collapsed() {
		t.Fatalf("якорь не схлопнулся: %+v", span)
	}
	if text, _ := doc.SpanText("e1", "body", span); text != "" {
		t.Fatalf("у схлопнувшегося якоря есть текст: %q", text)
	}
}

// Чужие якоря и битые байты: резолв честно отказывает, а не «примерно находит».
func TestResolveSpanRejectsGarbage(t *testing.T) {
	doc, _, _, start, end := seedDoc(t, "Первый.\nВторой.", "Второй.")
	if _, ok := doc.ResolveSpan("e1", "body", []byte("мусор"), end); ok {
		t.Error("битые байты начала разрешились")
	}
	if _, ok := doc.ResolveSpan("e1", "body", start, []byte("мусор")); ok {
		t.Error("битые байты конца разрешились")
	}
	if _, ok := doc.ResolveSpan("нет-такого", "body", start, end); ok {
		t.Error("якорь разрешился для несуществующего кадра")
	}
}

// Правка за пределами текста — ошибка, а не «обрезали и сделали вид, что всё хорошо».
func TestReplaceEventSpanOutOfRange(t *testing.T) {
	doc, _, _, _, _ := seedDoc(t, "Коротко.", "Коротко")
	if _, err := doc.ReplaceEventSpan("e1", "body", 0, 500, "нет"); err == nil {
		t.Fatal("правка за пределами текста не отвергнута")
	}
}
