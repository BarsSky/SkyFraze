package yjs

// anchor.go — якоря замечаний к фрагменту: резолв и правка спана на СЕРВЕРЕ.
//
// Зачем серверу то, что делает клиент. Клиент резолвит якорь для показа; серверу это нужно,
// чтобы (а) проверить якорь при создании замечания по свежему документу и (б) применить
// правку фрагмента по подтверждению человека — правка ассистента идёт этим путём, а не
// перезаписью кадра целиком (docs/fragment-comments.md §4: перезапись убивает якоря).
//
// Индексы Yjs — единицы UTF-16. В Go строки считаются в байтах, поэтому режем текст через
// явную конвертацию: иначе на эмодзи (две единицы UTF-16 на символ) фрагмент съезжает на
// 1–2 знака, и это ровно тот класс ошибок, который молчит.

import (
	"fmt"

	ygo "github.com/Deln0r/ygo"
)

// Span — диапазон в тексте кадра, полученный из якоря. `From == To` — якорь схлопнулся
// (фрагмент удалён): замечание сохраняет цитату, но править уже нечего.
type Span struct {
	From uint64
	To   uint64
}

// Collapsed — фрагмента больше нет.
func (s Span) Collapsed() bool { return s.To <= s.From }

// ResolveSpan разворачивает якорь в индексы текущего документа.
//
// false означает «фрагмент не находится»: кадр удалён, текст переписан целиком или якорь
// испорчен. Это не ошибка — это факт, который вызывающий обязан показать человеку.
func (d *Doc) ResolveSpan(eventID, field string, start, end []byte) (Span, bool) {
	text, ok := d.TextOf(eventID, field)
	if !ok {
		return Span{}, false
	}
	startPos, err := ygo.DecodeRelativePosition(start)
	if err != nil {
		return Span{}, false
	}
	endPos, err := ygo.DecodeRelativePosition(end)
	if err != nil {
		return Span{}, false
	}
	startAbs, ok1 := ygo.CreateAbsolutePositionFromRelativePosition(d.inner, startPos)
	endAbs, ok2 := ygo.CreateAbsolutePositionFromRelativePosition(d.inner, endPos)
	if !ok1 || !ok2 {
		return Span{}, false
	}
	// Якорь обязан указывать в ЭТОТ текст: иначе он чужой (например, скопированный из
	// другого кадра), и «правка» затронула бы не то место. Сравниваем ветки типов напрямую:
	// у одного документа один и тот же `Y.Text` даёт одну и ту же ветку. Тип ветки объявлен
	// во внутреннем пакете ygo, поэтому имя не пишем — только сравниваем значения.
	target := text.Branch()
	if startAbs.Branch != target || endAbs.Branch != target {
		return Span{}, false
	}
	from := startAbs.Index
	to := endAbs.Index
	if from > to {
		from, to = to, from
	}
	return Span{From: from, To: to}, true
}

// SpanText — текущий текст фрагмента (для проверки «фрагмент не изменился»).
func (d *Doc) SpanText(eventID, field string, span Span) (string, bool) {
	text, ok := d.TextOf(eventID, field)
	if !ok {
		return "", false
	}
	return utf16Slice(text.String(), span.From, span.To), true
}

// ReplaceEventSpan заменяет фрагмент текста кадра — Delete + Insert ВНУТРИ `Y.Text`.
//
// Почему не `SetEventText`: тот удаляет весь текст и вставляет новый, а вместе с текстом
// умирают все привязки к нему — в том числе якоря соседних замечаний. Здесь меняется ровно
// фрагмент, и открытые вкладки видят обычную правку (те же операции, что делает курсор
// человека).
//
// found=false — кадра нет (или в нём ещё нет `Y.Text`): вызывающий идёт своим путём, как и
// у остальных правок документа.
func (d *Doc) ReplaceEventSpan(
	eventID, field string, from, to uint64, replacement string,
) (bool, error) {
	text, ok := d.TextOf(eventID, field)
	if !ok {
		return false, nil
	}
	length := text.Length()
	if from > to {
		from, to = to, from
	}
	if to > length {
		return false, fmt.Errorf("фрагмент %d..%d вне текста кадра (длина %d)", from, to, length)
	}
	txn := d.inner.WriteTxn()
	defer txn.Commit()
	if to > from {
		if err := text.Delete(txn, from, to-from); err != nil {
			return true, err
		}
	}
	if replacement != "" {
		if err := text.Insert(txn, from, replacement); err != nil {
			return true, err
		}
	}
	return true, nil
}

// utf16Slice вырезает подстроку по индексам UTF-16 — так, как их считает Yjs.
//
// Суррогатная пара (эмодзи) занимает две единицы; разрезать её пополам нельзя, поэтому
// граница внутри пары сдвигается наружу — лучше показать символ целиком, чем половину.
func utf16Slice(s string, from, to uint64) string {
	runes := []rune(s)
	// Префикс в единицах UTF-16: сумма длин в UTF-16 по рунам.
	idxFrom := runeIndexAtUnit(runes, from)
	idxTo := runeIndexAtUnit(runes, to)
	if idxFrom >= idxTo {
		return ""
	}
	return string(runes[idxFrom:idxTo])
}

func runeIndexAtUnit(runes []rune, unit uint64) int {
	var seen uint64
	for i, r := range runes {
		if seen >= unit {
			return i
		}
		seen += uint64(utf16Len(r))
	}
	return len(runes)
}

func utf16Len(r rune) int {
	if r > 0xFFFF {
		return 2
	}
	return 1
}
