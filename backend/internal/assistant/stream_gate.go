package assistant

// stream_gate.go — что из потока модели можно показывать человеку.
//
// Зачем это вообще. Модель отвечает не всегда текстом: слабые локальные модели
// (проверено на gemma-4) вываливают в ответ вызов инструмента — блок
// ```skyfraze-tools или просто JSON-массив, — а некоторые ещё и рассуждения в
// служебном канале `<|channel>thought … <channel|>`.
//
// В обычном ответе этого не видно: блок протокола вырезается при разборе
// (`ParseTextToolCalls`), а человеку показывается ответ следующего раунда. В потоке
// всё это уходило бы человеку по мере генерации: он читал бы служебный JSON и «мысли»
// модели, написанные не для него.
//
// Правило простое и без магии:
//
//   - пока начало ответа не опознано, куски ПРИДЕРЖИВАЮТСЯ (обычно это первые
//     считанные символы: русский текст не похож на служебный, и решение принимается
//     сразу);
//   - опознали протокол — молчим до конца раунда (это не ответ человеку);
//   - опознали рассуждения — молчим до `<channel|>`, дальше отдаём как обычно;
//   - протокол начался посреди ответа — отдаём сказанное до него и замолкаем.
//
// Цена ошибки в обе стороны невелика: ответ, начинающийся с «{», человек увидит одним
// куском в конце, а не по мере генерации; придержанное, оказавшееся протоколом, не
// показывается вовсе и не попадает в сохранённый ответ.

import "strings"

// Маркеры служебного текста в ответе модели.
const (
	// fenceProtocol — текстовый протокол инструментов.
	fenceProtocol = "```skyfraze-tools"
	// thoughtOpen/thoughtClose — служебный канал рассуждений.
	thoughtOpen  = "<|channel>thought"
	thoughtClose = "<channel|>"
	// arrayStart — вызовы инструментов массивом JSON, без ограды.
	arrayStart = "[{"
)

// tailKeep — сколько последних символов отданного текста помним: маркер протокола
// может разрезаться между двумя кусками потока.
const tailKeep = 32

// streamGate решает, что отдавать человеку, и помнит, что уже отдано.
type streamGate struct {
	// emit отправляет кусок человеку (ошибка означает «писать больше некуда»).
	emit func(string) error
	// mode: deciding — ещё не поняли, что это; prose — обычный ответ;
	// protocol — служебный текст (молчим); thought — рассуждения (молчим).
	mode string
	// held — придержанное начало ответа (пока не решили, текст это или протокол).
	held strings.Builder
	// tail — последние символы уже отданного текста.
	tail strings.Builder
	// visible — то, что человек действительно видел. Нужно при остановке: сохранять
	// надо увиденное, а не сырой поток модели со служебными блоками.
	visible strings.Builder
}

func newStreamGate(emit func(string) error) *streamGate {
	return &streamGate{emit: emit, mode: "deciding"}
}

// feed принимает кусок потока и, если можно, отдаёт его человеку.
func (g *streamGate) feed(piece string) error {
	if piece == "" {
		return nil
	}
	switch g.mode {
	case "prose":
		return g.feedProse(piece)
	case "protocol":
		return nil
	case "thought":
		return g.feedThought(piece)
	default:
		return g.feedDeciding(piece)
	}
}

// finish — раунд кончился. Придержанное, так и не опознанное протоколом, — это ответ
// (например, короткое «Да.»): его надо показать, иначе человек увидит ответ только в
// итоговом сообщении.
func (g *streamGate) finish() error {
	if g.mode != "deciding" || g.held.Len() == 0 {
		return nil
	}
	out := g.held.String()
	g.held.Reset()
	g.mode = "prose"
	return g.deliver(out)
}

// visibleText — то, что человек видел (для сохранения при остановке).
func (g *streamGate) visibleText() string { return g.visible.String() }

func (g *streamGate) feedDeciding(piece string) error {
	g.held.WriteString(piece)
	text := g.held.String()
	trimmed := strings.TrimLeft(text, " \t\r\n")
	if trimmed == "" {
		return nil
	}
	switch {
	case strings.HasPrefix(thoughtOpen, trimmed):
		// Похоже на начало канала рассуждений — ждём продолжения.
		return nil
	case strings.HasPrefix(trimmed, thoughtOpen):
		g.held.Reset()
		g.mode = "thought"
		return g.feedThought(trimmed)
	case strings.HasPrefix(trimmed, fenceProtocol), strings.HasPrefix(trimmed, arrayStart):
		g.held.Reset()
		g.mode = "protocol"
		return nil
	case couldBeProtocolStart(trimmed):
		// Данных мало: ждём ещё кусок, чтобы не показать человеку первый символ
		// служебного JSON.
		return nil
	default:
		g.held.Reset()
		g.mode = "prose"
		return g.deliver(text)
	}
}

// feedThought молчит, пока не увидит закрытие служебного канала.
func (g *streamGate) feedThought(piece string) error {
	g.held.WriteString(piece)
	text := g.held.String()
	idx := strings.Index(text, thoughtClose)
	if idx < 0 {
		return nil
	}
	rest := text[idx+len(thoughtClose):]
	g.held.Reset()
	g.held.WriteString(rest)
	g.mode = "deciding"
	// Остаток после канала — обычный ответ (или, если модель странная, ещё протокол):
	// прогоняем его через то же решение.
	if rest == "" {
		return nil
	}
	g.held.Reset()
	return g.feedDeciding(rest)
}

func (g *streamGate) feedProse(piece string) error {
	combined := g.tail.String() + piece
	idx := protocolIndex(combined)
	if idx < 0 {
		return g.deliver(piece)
	}
	// Маркер нашёлся. Всё до него, что человеку ещё НЕ отдано, — конец ответа.
	// Начало combined — это уже отданный хвост, и второй раз его отдавать нельзя
	// (иначе текст ответа задвоился бы на стыке кусков).
	tailLen := g.tail.Len()
	g.mode = "protocol"
	g.tail.Reset()
	if idx > tailLen {
		head := combined[tailLen:idx]
		if strings.TrimSpace(head) != "" {
			return g.deliver(head)
		}
	}
	return nil
}

// deliver отдаёт кусок человеку и запоминает его (и хвост для поиска протокола).
func (g *streamGate) deliver(text string) error {
	if text == "" {
		return nil
	}
	g.visible.WriteString(text)
	keepTail(g, g.tail.String()+text)
	return g.emit(text)
}

// keepTail хранит последние символы текста, чтобы замечать маркер протокола,
// разрезанный между кусками.
func keepTail(g *streamGate, text string) {
	g.tail.Reset()
	if len(text) > tailKeep {
		text = text[len(text)-tailKeep:]
	}
	g.tail.WriteString(text)
}

// protocolIndex — где в тексте начинается служебный блок (или -1).
func protocolIndex(text string) int {
	best := -1
	for _, marker := range []string{fenceProtocol, "\n" + arrayStart, arrayStart} {
		if idx := strings.Index(text, marker); idx >= 0 && (best < 0 || idx < best) {
			best = idx
		}
	}
	return best
}

// couldBeProtocolStart — может ли придержанное начало оказаться началом служебного
// блока. «{» — ещё не протокол, а «[{» уже он; «`» может начать ограду.
func couldBeProtocolStart(text string) bool {
	if text == "[" || text == "`" || strings.HasPrefix(text, "``") {
		return true
	}
	return strings.HasPrefix(fenceProtocol, text) || strings.HasPrefix(arrayStart, text)
}
