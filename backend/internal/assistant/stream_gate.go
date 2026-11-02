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
//   - протокол начался посреди ответа — отдаём сказанное до него и замолкаем;
//   - опознали ограду нового текста кадра (```skyfraze-text) — дальше идёт ЧЕРНОВИК
//     (0.144.0): он уходит человеку отдельным событием, по мере написания, и не
//     считается ответом модели. Так «перепиши главу» можно получить одной генерацией:
//     текст не внутри JSON-строки, экранировать нечего и обрываться не на чем.
//
// Цена ошибки в обе стороны невелика: ответ, начинающийся с «{», человек увидит одним
// куском в конце, а не по мере генерации; придержанное, оказавшееся протоколом, не
// показывается вовсе и не попадает в сохранённый ответ.

import "strings"

// Маркеры служебного текста в ответе модели.
const (
	// fenceProtocol — текстовый протокол инструментов.
	fenceProtocol = "```skyfraze-tools"
	// textFenceMarker — ограда нового текста кадра (0.144.0). Её содержимое — черновик,
	// который человек видит по мере написания, а не ответ модели.
	textFenceMarker = "```" + textEditFence
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
	// draft отправляет кусок ЧЕРНОВИКА нового текста кадра (0.144.0). Может быть nil:
	// тогда черновик просто не показывается, а предложение правки всё равно появится.
	draft func(string) error
	// mode: deciding — ещё не поняли, что это; prose — обычный ответ;
	// protocol — служебный текст (молчим); thought — рассуждения (молчим);
	// draftHeader — читаем строку параметров ограды; draft — пишем черновик.
	mode string
	// held — придержанное начало ответа (пока не решили, текст это или протокол).
	held strings.Builder
	// tail — последние символы уже отданного текста.
	tail strings.Builder
	// visible — то, что человек действительно видел. Нужно при остановке: сохранять
	// надо увиденное, а не сырой поток модели со служебными блоками.
	visible strings.Builder
	// sawDraft/draftClosed — был ли черновик и закрылся ли он. По ним видно, что модель
	// оборвалась на середине нового текста (тогда текст не применяется).
	sawDraft    bool
	draftClosed bool
}

func newStreamGate(emit func(string) error) *streamGate {
	return &streamGate{emit: emit, mode: "deciding"}
}

// useDraft подключает получателя черновика нового текста кадра (0.144.0).
func (g *streamGate) useDraft(draft func(string) error) { g.draft = draft }

// draftUnfinished — черновик был, но не закрылся: модель оборвалась на середине текста.
//
// Это важный факт, а не подробность: такой текст нельзя превращать в правку молча — в
// нём нет конца, и человек должен увидеть, что последняя строка не финал главы.
func (g *streamGate) draftUnfinished() bool { return g.sawDraft && !g.draftClosed }

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
	case "draftHeader":
		return g.feedDraftHeader(piece)
	case "draft":
		return g.feedDraft(piece)
	default:
		return g.feedDeciding(piece)
	}
}

// finish — раунд кончился. Придержанное, так и не опознанное протоколом, — это ответ
// (например, короткое «Да.»): его надо показать, иначе человек увидит ответ только в
// итоговом сообщении. Недописанный черновик (0.144.0) тоже отдаём — но флаг
// draftUnfinished остаётся: правкой такой текст не станет.
func (g *streamGate) finish() error {
	switch g.mode {
	case "draft", "draftHeader":
		// Модель оборвалась на середине нового текста. Отдаём то, что успело прийти:
		// человек увидел эти строки по мере генерации, и отнимать их задним числом
		// странно. Применять такой черновик нельзя — об этом скажет сервис.
		held := g.held.String()
		g.held.Reset()
		if strings.TrimSpace(held) != "" && g.draft != nil {
			return g.draft(held)
		}
		return nil
	}
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
	case strings.HasPrefix(trimmed, textFenceMarker):
		// Ограда нового текста кадра (0.144.0): дальше идёт черновик, а не ответ.
		g.held.Reset()
		g.sawDraft = true
		g.mode = "draftHeader"
		return g.feedDraftHeader(trimmed[len(textFenceMarker):])
	case isTextFencePrefix(trimmed):
		// Пока это может оказаться оградой skyfraze-text — ждём ещё кусок: отдав его
		// человеку, мы показали бы «```skyf» в ответе.
		return nil
	case strings.HasPrefix(trimmed, fenceProtocol), strings.HasPrefix(trimmed, arrayStart):
		g.held.Reset()
		g.mode = "protocol"
		return nil
	case strings.HasPrefix(trimmed, fence): // ```json … ``` — тоже вызов, а не ответ (0.142.2)
		g.held.Reset()
		g.mode = "protocol"
		return nil
	case strings.HasPrefix(trimmed, "<|"): // <|tool_call|>… — служебный вызов (0.142.4)
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
		// Не отдаём кусок целиком: прозе может сразу сопутствовать служебный блок или
		// ограда нового текста кадра (модель пишет «Предлагаю…» и следом блок), а в
		// реплику это попадать не должно.
		return g.feedProse(text)
	}
}

// isTextFencePrefix — придержанное может оказаться началом ограды нового текста.
func isTextFencePrefix(text string) bool {
	if text == "" || text[0] != '`' {
		return false
	}
	return len(text) < len(textFenceMarker) && strings.HasPrefix(textFenceMarker, text)
}

// feedDraftHeader читает строку параметров ограды (```skyfraze-text id=<uuid>) и молчит:
// человеку она не нужна, а телу блока — нужна граница.
func (g *streamGate) feedDraftHeader(piece string) error {
	g.held.WriteString(piece)
	buf := g.held.String()
	idx := strings.IndexByte(buf, '\n')
	if idx < 0 {
		if len(buf) > draftHeaderMax {
			// Это не строка параметров, а обычный текст (модель начала ответ с ограды и
			// застряла): показываем как ответ, чтобы ничего не потерялось.
			g.held.Reset()
			g.mode = "prose"
			return g.deliver(textFenceMarker + buf)
		}
		return nil
	}
	body := buf[idx+1:]
	g.held.Reset()
	g.mode = "draft"
	if body == "" {
		return nil
	}
	return g.feedDraft(body)
}

// draftHeaderMax — сколько знаков строки параметров терпим, прежде чем счесть блок текстом.
const draftHeaderMax = 200

// feedDraft пишет черновик. Закрывающая ограда кончает черновик и возвращает обычный
// ответ: после блока модель может сказать «готово» — это уже реплика человеку.
//
// Хвост в 1–2 обратных кавычки придерживаем: маркер может разрезаться между кусками
// потока, и без этого человек увидел бы «“» в середине черновика.
func (g *streamGate) feedDraft(piece string) error {
	g.held.WriteString(piece)
	buf := g.held.String()
	if idx := strings.Index(buf, fence); idx >= 0 {
		if idx > 0 {
			if err := g.emitDraft(buf[:idx]); err != nil {
				return err
			}
		}
		rest := buf[idx+len(fence):]
		g.held.Reset()
		g.draftClosed = true
		g.mode = "prose"
		g.tail.Reset()
		if rest == "" {
			return nil
		}
		return g.feedProse(rest)
	}
	hold := backtickSuffix(buf)
	ready := buf[:len(buf)-hold]
	g.held.Reset()
	g.held.WriteString(buf[len(buf)-hold:])
	if ready == "" {
		return nil
	}
	return g.emitDraft(ready)
}

// backtickSuffix — сколько последних байт могут оказаться началом «```».
//
// Режем по байтам, но только по ASCII-кавычке: она не может быть частью многобайтового
// символа, поэтому русский текст на стыке не развалится.
func backtickSuffix(buf string) int {
	switch {
	case strings.HasSuffix(buf, "``"):
		return 2
	case strings.HasSuffix(buf, "`"):
		return 1
	default:
		return 0
	}
}

// emitDraft отдаёт кусок черновика, если получатель подключён.
func (g *streamGate) emitDraft(text string) error {
	if text == "" || g.draft == nil {
		return nil
	}
	return g.draft(text)
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
	protoAt := protocolIndex(combined)
	draftAt := strings.Index(combined, textFenceMarker)
	// Что началось раньше — служебный вызов или черновик нового текста кадра? Раньше
	// в этом месте был один маркер (протокол), и блок skyfraze-text просто прятался;
	// теперь он показывается человеку черновиком (0.144.0).
	at := -1
	mode := ""
	switch {
	case draftAt >= 0 && (protoAt < 0 || draftAt < protoAt):
		at, mode = draftAt, "draftHeader"
	case protoAt >= 0:
		at, mode = protoAt, "protocol"
	}
	if at < 0 {
		return g.deliver(piece)
	}
	// Маркер нашёлся. Всё до него, что человеку ещё НЕ отдано, — конец ответа.
	// Начало combined — это уже отданный хвост, и второй раз его отдавать нельзя
	// (иначе текст ответа задвоился бы на стыке кусков).
	tailLen := g.tail.Len()
	g.tail.Reset()
	head := ""
	if at > tailLen {
		head = combined[tailLen:at]
	}
	if mode == "draftHeader" {
		g.mode = "draftHeader"
		g.sawDraft = true
		if err := g.deliverIfText(head); err != nil {
			return err
		}
		return g.feedDraftHeader(combined[at+len(textFenceMarker):])
	}
	g.mode = "protocol"
	return g.deliverIfText(head)
}

// deliverIfText отдаёт человеку кусок, если в нём есть что показывать (пробелы и
// переводы строк в конце ответа показывать незачем).
func (g *streamGate) deliverIfText(text string) error {
	if strings.TrimSpace(text) == "" {
		return nil
	}
	return g.deliver(text)
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
	for _, marker := range []string{
		fenceProtocol, "\n" + arrayStart, arrayStart,
		"<|tool_call|>", "<|tool_call>",
	} {
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
