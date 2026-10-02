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
