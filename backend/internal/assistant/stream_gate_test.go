package assistant

// stream_gate_test.go — что показывается человеку из потока модели.
//
// Проверяем случаи, которые ломали живой прогон: вызов инструмента пришёл ТЕКСТОМ
// (JSON-массивом или блоком в ограде) и рассуждения в служебном канале. Человеку
// ничего из этого видеть не нужно, а обычный текст должен идти по кускам сразу, без
// подмены «покажем в конце».

import (
	"strings"
	"testing"
)

// feedAll кормит шлюз кусками и возвращает то, что увидел бы человек.
func feedAll(t *testing.T, pieces ...string) string {
	t.Helper()
	var out strings.Builder
	gate := newStreamGate(func(text string) error {
		out.WriteString(text)
		return nil
	})
	for _, piece := range pieces {
		if err := gate.feed(piece); err != nil {
			t.Fatalf("feed(%q): %v", piece, err)
		}
	}
	if err := gate.finish(); err != nil {
		t.Fatalf("finish: %v", err)
	}
	return out.String()
}

func TestStreamGatePassesPlainTextPieceByPiece(t *testing.T) {
	var pieces []string
	gate := newStreamGate(func(text string) error {
		pieces = append(pieces, text)
		return nil
	})
	for _, piece := range []string{"Создал ", "главу ", "«Пролог»."} {
		if err := gate.feed(piece); err != nil {
			t.Fatal(err)
		}
	}
	if err := gate.finish(); err != nil {
		t.Fatal(err)
	}
	// Обычный текст уходит кусками, а не одним куском в конце: иначе поток бесполезен.
	if len(pieces) != 3 || strings.Join(pieces, "") != "Создал главу «Пролог»." {
		t.Fatalf("куски: %#v", pieces)
	}
}

func TestStreamGateHidesTextualToolCalls(t *testing.T) {
	// Так ответила gemma-4: вызов инструмента пришёл текстом, JSON-массивом.
	visible := feedAll(t,
		`[{"id": "call-1", "name": "create_sub_event", `,
		`"arguments": {"title": "Ежедневный ритуал", "body_md": "Жизнь смотрителя"}}]`,
	)
	if visible != "" {
		t.Fatalf("служебный JSON показан человеку: %q", visible)
	}
}

func TestStreamGateHidesFencedProtocol(t *testing.T) {
	visible := feedAll(t,
		"```skyfraze-tools\n",
		`[{"name":"create_chapter","arguments":{"title":"Пролог"}}]`+"\n```",
	)
	if visible != "" {
		t.Fatalf("блок протокола показан человеку: %q", visible)
	}
}

func TestStreamGateHidesThoughtChannel(t *testing.T) {
	var pieces []string
	gate := newStreamGate(func(text string) error {
		pieces = append(pieces, text)
		return nil
	})
	// Рассуждения в служебном канале: их модель писала не для человека.
	for _, piece := range []string{"<|channel>thou", "ght\nНадо ответить кратко.", "\n<channel|>", "История о маяке."} {
		if err := gate.feed(piece); err != nil {
			t.Fatal(err)
		}
	}
	if err := gate.finish(); err != nil {
		t.Fatal(err)
	}
	got := strings.Join(pieces, "")
	if got != "История о маяке." {
		t.Fatalf("после канала рассуждений показано: %q", got)
	}
	if strings.Contains(got, "Надо ответить") {
		t.Error("рассуждения модели попали в ответ")
	}
}

func TestStreamGateHidesProtocolInTheMiddle(t *testing.T) {
	// Сначала проза, потом модель «сорвалась» в протокол: прозу показываем, JSON — нет.
	visible := feedAll(t,
		"Сейчас добавлю главу. ",
		`[{"name":"create_chapter",`,
		`"arguments":{"title":"Пролог"}}]`,
	)
	if visible != "Сейчас добавлю главу. " {
		t.Fatalf("показано: %q", visible)
	}
}

func TestStreamGateFlushesShortAnswerAtRoundEnd(t *testing.T) {
	// Короткий ответ целиком придержан, потому что начинается с «{»? Нет: он просто
	// короткий, и решение «это текст» принимается на первом же символе.
	if got := feedAll(t, "Да."); got != "Да." {
		t.Fatalf("показано: %q", got)
	}
	// А вот ответ, начинающийся с «[», до конца остаётся неопознанным — и всё равно
	// должен быть показан, пусть и одним куском.
	if got := feedAll(t, "[", "Тихо]"); got != "[Тихо]" {
		t.Fatalf("показано: %q", got)
	}
}

// TestStreamGateHidesTextEditFence — блок нового текста кадра не попадает в ответ модели.
//
// ```skyfraze-text — это вызов инструмента, внутри которого лежит весь новый текст главы.
// В РЕПЛИКУ он попадать не должен (0.144.0): текст идёт отдельным событием-черновиком,
// иначе человек увидел бы его в переписке как слова помощника. Проверяем обе половины:
// в ответе блока нет, а в черновик он пришёл целиком.
func TestStreamGateHidesTextEditFence(t *testing.T) {
	var draft, answer strings.Builder
	gate := newStreamGate(func(text string) error {
		answer.WriteString(text)
		return nil
	})
	gate.useDraft(func(text string) error {
		draft.WriteString(text)
		return nil
	})
	for _, piece := range []string{
		"Предлагаю новую редакцию.\n\n```skyfraze-text id=17b25a13-1c32-4d15-838f-01da583b2f4a\n",
		"Жил смотритель у маяка.\n\n",
		"Он не любил корабли.\n```",
	} {
		if err := gate.feed(piece); err != nil {
			t.Fatalf("feed(%q): %v", piece, err)
		}
	}
	if err := gate.finish(); err != nil {
		t.Fatal(err)
	}
	got := draft.String()
	if !strings.Contains(got, "смотритель") || !strings.Contains(got, "корабли") {
		t.Fatalf("черновик не доехал: %q", got)
	}
	if strings.Contains(got, "skyfraze-text") || strings.Contains(got, "id=") {
		t.Fatalf("в черновик попала строка параметров ограды: %q", got)
	}
	// В реплике — только проза модели, ни строки нового текста кадра.
	if answer.String() != "Предлагаю новую редакцию.\n\n" {
		t.Fatalf("ответ: %q", answer.String())
	}
	if strings.Contains(answer.String(), "смотритель") {
		t.Fatal("новый текст главы попал в ответ как реплика помощника")
	}
	if gate.draftUnfinished() {
		t.Fatal("черновик закрылся, а шлюз считает его оборванным")
	}
}

// TestStreamGateDraftStreamsPieceByPiece — черновик идёт по мере написания, а не одним
// куском в конце: смысл потокового ответа именно в этом.
func TestStreamGateDraftStreamsPieceByPiece(t *testing.T) {
	var draft []string
	gate := newStreamGate(func(string) error { return nil })
	gate.useDraft(func(text string) error {
		draft = append(draft, text)
		return nil
	})
	head := "```skyfraze-text id=17b25a13-1c32-4d15-838f-01da583b2f4a\n"
	for _, piece := range []string{head, "Первый абзац. ", "Второй абзац."} {
		if err := gate.feed(piece); err != nil {
			t.Fatal(err)
		}
	}
	if len(draft) < 2 {
		t.Fatalf("черновик пришёл одним куском: %#v", draft)
	}
	if strings.Join(draft, "") != "Первый абзац. Второй абзац." {
		t.Fatalf("черновик: %q", strings.Join(draft, ""))
	}
}

// TestStreamGateDraftUnfinished — модель оборвалась на середине нового текста.
func TestStreamGateDraftUnfinished(t *testing.T) {
	var draft strings.Builder
	gate := newStreamGate(func(string) error { return nil })
	gate.useDraft(func(text string) error {
		draft.WriteString(text)
		return nil
	})
	for _, piece := range []string{
		"```skyfraze-text id=17b25a13-1c32-4d15-838f-01da583b2f4a\nЖил смотритель у ",
		"маяка и не любил",
	} {
		if err := gate.feed(piece); err != nil {
			t.Fatal(err)
		}
	}
	if err := gate.finish(); err != nil {
		t.Fatal(err)
	}
	if !gate.draftUnfinished() {
		t.Fatal("оборванный черновик не помечен")
	}
	if !strings.Contains(draft.String(), "не любил") {
		t.Fatalf("сказанное до обрыва потерялось: %q", draft.String())
	}
}

// TestStreamGateDraftNextLineFence — живой вид блока gemma: ограда отдельной строкой,
// «skyfraze-text» следующей (0.144.1). Плюс проза перед блоком — она остаётся репликой.
func TestStreamGateDraftNextLineFence(t *testing.T) {
	var draft, answer strings.Builder
	gate := newStreamGate(func(text string) error {
		answer.WriteString(text)
		return nil
	})
	gate.useDraft(func(text string) error {
		draft.WriteString(text)
		return nil
	})
	for _, piece := range []string{
		"Сейчас перепишу главу.\n\n",
		"```\n",
		"skyfraze-text id=17b25a13-1c32-4d15-838f-01da583b2f4a\n",
		"Демо-сцена: посадка.\n\n",
		"Объекты демо-сцены.\n```",
		"\nПредлагаю сокращённый вариант.",
	} {
		if err := gate.feed(piece); err != nil {
			t.Fatalf("feed(%q): %v", piece, err)
		}
	}
	if err := gate.finish(); err != nil {
		t.Fatal(err)
	}
	if strings.TrimSpace(draft.String()) != "Демо-сцена: посадка.\n\nОбъекты демо-сцены." {
		t.Fatalf("черновик: %q", draft.String())
	}
	want := "Сейчас перепишу главу.\n\nПредлагаю сокращённый вариант."
	if answer.String() != want {
		t.Fatalf("ответ: %q, ожидался %q", answer.String(), want)
	}
	if gate.draftUnfinished() {
		t.Fatal("блок закрылся, а шлюз считает черновик оборванным")
	}
}

// TestStreamGateProseCodeBlockStaysVisible — обычный блок кода посреди ответа остаётся
// видимым: зонд не должен молча съедать кусок ответа.
func TestStreamGateProseCodeBlockStaysVisible(t *testing.T) {
	visible := feedAll(t, "Вот пример:\n```json\n{\"a\": 1}\n```\nГотово.")
	if !strings.Contains(visible, "Вот пример:") || !strings.Contains(visible, "Готово.") {
		t.Fatalf("ответ потерял куски: %q", visible)
	}
	if !strings.Contains(visible, "```json") {
		t.Fatalf("обычный блок кода пропал из ответа: %q", visible)
	}
}

// TestStreamGateDraftThenProse — после закрытия блока обычный ответ идёт в реплику.
func TestStreamGateDraftThenProse(t *testing.T) {
	var answer, draft strings.Builder
	gate := newStreamGate(func(text string) error {
		answer.WriteString(text)
		return nil
	})
	gate.useDraft(func(text string) error {
		draft.WriteString(text)
		return nil
	})
	for _, piece := range []string{
		"```skyfraze-text id=17b25a13-1c32-4d15-838f-01da583b2f4a\nНовый текст.\n```",
		"Готово: предлагаю заменить.",
	} {
		if err := gate.feed(piece); err != nil {
			t.Fatal(err)
		}
	}
	if err := gate.finish(); err != nil {
		t.Fatal(err)
	}
	if draft.String() != "Новый текст.\n" {
		t.Fatalf("черновик: %q", draft.String())
	}
	if answer.String() != "Готово: предлагаю заменить." {
		t.Fatalf("ответ: %q", answer.String())
	}
}

func TestStreamGateKeepsVisibleTextForStop(t *testing.T) {
	gate := newStreamGate(func(string) error { return nil })
	for _, piece := range []string{"Первая ", "фраза. ", `[{"name":"create_chapter"}]`} {
		if err := gate.feed(piece); err != nil {
			t.Fatal(err)
		}
	}
	// При остановке сохраняем УВИДЕННОЕ, а не сырой поток: служебный JSON в историю
	// попадать не должен.
	if got := gate.visibleText(); got != "Первая фраза. " {
		t.Fatalf("видимый текст: %q", got)
	}
}
