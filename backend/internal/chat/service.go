package chat

// service.go — общий чат проекта (0.95.0).
//
// Зачем чат, если уже есть замечания к кадру. Замечание привязано к фрагменту ТЕКСТА и живёт в
// блоке кадра; «обсудить идею, спросить коллегу, позвать Нестора на разбор» — это разговор один
// на проект, без привязки к конкретному месту. Поэтому отдельная сущность, а не ещё один вид
// замечания.
//
// Правила живут здесь, а не в обработчике:
//   * читать может любой участник (viewer+), писать — тоже участник: это разговор, а не правка
//     текста, и запрет писать читателю выкинул бы из обсуждения ровно тех, кого обсуждают;
//   * ссылка на элемент текста — идентификатор кадра ЭТОГО проекта и (необязательно) точная фраза
//     из него; фраза проверяется по тексту кадра, чтобы «ссылка на фразу» не оказалась пустой;
//   * Нестор отвечает, только если он включён на стенде и в проекте: иначе сообщение участника
//     сохраняется, а в ответ приходит объяснение, а не выдуманный ответ.

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/google/uuid"

	"github.com/skyfraze/backend/internal/livedoc"
	"github.com/skyfraze/backend/internal/store"
)

// Ограничения сообщения.
const (
	minBodyRunes = 1
	maxBodyRunes = 4000
	// maxQuoteRunes — фраза, на которую ссылаются: абзац, а не страница.
	maxQuoteRunes = 300
	// defaultLimit — сколько последних сообщений отдавать окну чата.
	defaultLimit = 100
	maxLimit     = 300
)

// Ошибки сервиса.
var (
	// ErrInvalidMessage — пустое или слишком длинное сообщение.
	ErrInvalidMessage = errors.New("сообщение заполнено неверно")
	// ErrEventNotFound — кадр-ссылка не из этого проекта (или его нет).
	ErrEventNotFound = errors.New("кадр для ссылки не найден в проекте")
	// ErrQuoteNotFound — фразы нет в тексте кадра: ссылка вела бы в пустоту.
	ErrQuoteNotFound = errors.New("такой фразы в тексте кадра нет")
	// ErrReplyTarget — сообщение, на которое отвечают, не из этого проекта.
	ErrReplyTarget = errors.New("сообщение, на которое отвечают, не найдено в этом проекте")
	// ErrNotAuthor — править сообщение может только его автор.
	ErrNotAuthor = errors.New("править сообщение может только его автор")
	// ErrMessageNotFound — сообщения нет в этом проекте: отметить нечего (0.98.0).
	ErrMessageNotFound = errors.New("сообщение не найдено в этом проекте")
	// ErrReactionKind — неизвестный вид отметки (0.98.0). Набор фиксирован: см.
	// docs/project-chat.md §2.5.
	ErrReactionKind = errors.New("неизвестный вид отметки")
	// ErrBotDisabled — Нестор выключен на стенде или в проекте.
	ErrBotDisabled = errors.New("Нестор выключен — сообщение сохранено, ответа не будет")
)

// ProjectAccess — права на проект (реализует projects.Service).
type ProjectAccess interface {
	RequireViewer(ctx context.Context, userID, projectID uuid.UUID) error
}

// Notifier — «в проекте появилось сообщение». Реализуется хабом совместной работы (сокет
// документа уже открыт у каждого, кто в проекте): сигнал вместо второго канала и вместо ожидания
// опроса. Ошибок не возвращает: сигнал — удобство, сообщение уже в базе.
type Notifier interface {
	NotifyChat(projectID uuid.UUID)
}

// Bot — Нестор. Отдельный интерфейс, а не зависимость на пакет assistant: чату нужен один метод,
// и в тестах его должно быть так же просто подменить, как остальное.
type Bot interface {
	// Enabled — работает ли Нестор на стенде.
	Enabled() bool
	// Answer — короткий ответ текстом по вопросу из чата. Отвечает, ничего не меняя в проекте.
	Answer(ctx context.Context, userID, projectID uuid.UUID, question string) (string, error)
}

// Answer — то, что вернул чат на отправку сообщения.
type Answer struct {
	Message store.ChatMessage `json:"message"`
	// Reply — ответ Нестора, если его просили и он ответил.
	Reply *store.ChatMessage `json:"reply,omitempty"`
	// Note — почему ответа нет (бот выключен, модель недоступна). Пусто — всё хорошо.
	Note string `json:"note,omitempty"`
}

// Message — сообщение в том виде, в каком его видит интерфейс (алиас типа хранилища, чтобы
// вызывающему не приходилось импортировать store).
type Message = store.ChatMessage

// MessageView — сообщение вместе с отметками (0.98.0).
//
// Отметки лежат рядом, а не внутри сообщения: сообщение — факт текста, отметки — реакция людей на
// него, и в базе они живут в разных таблицах. Склеиваются на выходе, чтобы клиент не собирал ленту
// из двух источников и не рассинхронизировался.
type MessageView struct {
	store.ChatMessage
	Reactions store.ChatReactions `json:"reactions"`
}

// Service — общий чат проекта.
type Service struct {
	store *store.Store
	proj  ProjectAccess
	bot   Bot
	// botName — имя, которым подписан ответ бота. Пусто — «Нестор».
	botName string
	// notify — сигнал «появилось сообщение» (WebSocket документа). Необязателен.
	notify Notifier
	// logger — журнал сервиса: очередь писем и сигнал в сокет не должны ронять ответ.
	logger *slog.Logger
	// live — документ живой комнаты проекта: по нему проверяется цитата (0.139.0).
	// Может быть nil — тогда работает проекция.
	live livedoc.Live
}

// New собирает сервис чата.
func New(st *store.Store, proj ProjectAccess) *Service {
	return &Service{store: st, proj: proj, botName: "Нестор"}
}

// UseLogger подключает журнал (необязательно).
func (s *Service) UseLogger(logger *slog.Logger) { s.logger = logger }

// UseBot подключает Нестора и его имя. Без этого чат работает, но бота не предлагает.
func (s *Service) UseBot(bot Bot, name string) {
	s.bot = bot
	if strings.TrimSpace(name) != "" {
		s.botName = strings.TrimSpace(name)
	}
}

// UseNotifier подключает сигнал о новом сообщении (0.96.0): без него чат работает по опросу.
func (s *Service) UseNotifier(n Notifier) { s.notify = n }

// UseLiveState подключает документ живой комнаты (0.139.0): цитата проверяется по тексту,
// который редакторы видят сейчас, а не по проекции, которая догоняет его раз в несколько секунд.
// Иначе отправка «выделил фразу → в чат» в первые секунды после правки отвечала «такой фразы
// нет» — на глазах у человека, который эту фразу только что написал.
func (s *Service) UseLiveState(live livedoc.Live) { s.live = live }

// BotName — имя бота для интерфейса (подпись кнопки «спросить …»).
func (s *Service) BotName() string { return s.botName }

// BotAvailable — можно ли позвать бота сейчас: включён на стенде. Настройку проекта проверяет
// сам бот при ответе, а интерфейсу достаточно «кнопка есть или нет».
func (s *Service) BotAvailable() bool { return s.bot != nil && s.bot.Enabled() }

// Messages — последние сообщения проекта (viewer+).
//
// `after` — только новые после него (опрос и сокет), `before` — только прежние до него (кнопка
// «показать прежние», 0.99.2). Оба сразу не имеют смысла: окно либо догоняет ленту, либо листает
// назад, и выбирать «в обе стороны» нечего.
//
// К каждому сообщению прикладываются отметки (0.98.0): «согласен / надо сделать / вопрос» и какие
// из них мои. Считаются одним запросом на всю ленту, а не по сообщению — окно показывает до сотни
// строк, и N+1 здесь был бы заметен при каждом обновлении.
func (s *Service) Messages(
	ctx context.Context, userID, projectID uuid.UUID, after, before *uuid.UUID, limit int,
) ([]MessageView, error) {
	if err := s.proj.RequireViewer(ctx, userID, projectID); err != nil {
		return nil, err
	}
	if limit <= 0 || limit > maxLimit {
		limit = defaultLimit
	}
	var (
		messages []store.ChatMessage
		err      error
	)
	switch {
	case after != nil:
		messages, err = s.store.ChatMessagesAfter(ctx, projectID, *after, limit)
	case before != nil:
		messages, err = s.store.ChatMessagesBefore(ctx, projectID, *before, limit)
	default:
		messages, err = s.store.ListChatMessages(ctx, projectID, limit)
	}
	if err != nil {
		return nil, err
	}
	return s.withReactions(ctx, userID, messages)
}

// withReactions раскладывает отметки по сообщениям. Пустой чат — пустой результат без запроса в БД.
func (s *Service) withReactions(
	ctx context.Context, userID uuid.UUID, messages []store.ChatMessage,
) ([]MessageView, error) {
	out := make([]MessageView, 0, len(messages))
	if len(messages) == 0 {
		return out, nil
	}
	ids := make([]uuid.UUID, 0, len(messages))
	for _, message := range messages {
		ids = append(ids, message.ID)
	}
	stats, err := s.store.ChatReactionStats(ctx, ids, userID)
	if err != nil {
		return nil, err
	}
	for _, message := range messages {
		reactions, ok := stats[message.ID]
		if !ok {
			reactions = store.ChatReactions{Mine: []string{}}
		}
		out = append(out, MessageView{ChatMessage: message, Reactions: reactions})
	}
	return out, nil
}

// ToggleReaction ставит или снимает отметку (viewer+, 0.98.0).
//
// Почему переключатель, а не отдельные «поставить» и «снять»: у человека один и тот же жест — нажатие
// на плашку, и второй ручки ему знать не нужно. Состояние решает сервер по тому, что уже стоит:
// повторное нажатие снимает, а не «ставит ещё раз» (уникальный индекс не дал бы второго, и нажатие
// выглядело бы сломанным).
func (s *Service) ToggleReaction(
	ctx context.Context, userID, projectID, messageID uuid.UUID, kind store.ChatReactionKind,
) (store.ChatReactions, error) {
	if err := s.proj.RequireViewer(ctx, userID, projectID); err != nil {
		return store.ChatReactions{}, err
	}
	message, err := s.store.ChatMessageByID(ctx, projectID, messageID)
	if err != nil {
		return store.ChatReactions{}, err
	}
	if message == nil {
		return store.ChatReactions{}, ErrMessageNotFound
	}
	before, err := s.store.ChatReactionStats(ctx, []uuid.UUID{messageID}, userID)
	if err != nil {
		return store.ChatReactions{}, err
	}
	mine := false
	for _, raw := range before[messageID].Mine {
		if raw == string(kind) {
			mine = true
			break
		}
	}
	if mine {
		err = s.store.RemoveChatReaction(ctx, messageID, userID, kind)
	} else {
		err = s.store.AddChatReaction(ctx, messageID, userID, kind)
	}
	if err != nil {
		return store.ChatReactions{}, err
	}
	// Отметка — изменение ленты для всех, у кого она открыта: тот же сигнал, что у нового сообщения.
	// Содержимого в сигнале нет, каждая вкладка перечитает ленту сама.
	s.notifyChanged(projectID)
	return s.ReactionStats(ctx, userID, messageID)
}

// ReactionStats — отметки одного сообщения в том виде, в каком их показывает интерфейс.
func (s *Service) ReactionStats(
	ctx context.Context, userID, messageID uuid.UUID,
) (store.ChatReactions, error) {
	stats, err := s.store.ChatReactionStats(ctx, []uuid.UUID{messageID}, userID)
	if err != nil {
		return store.ChatReactions{}, err
	}
	if value, ok := stats[messageID]; ok {
		return value, nil
	}
	return store.ChatReactions{Mine: []string{}}, nil
}

// Unread — где человека ждут в чате: непрочитанные по проектам (0.97.0).
//
// Серверное, а не localStorage: колокольчик в шапке считает «где ждут» по всем проектам сразу, и
// про другой браузер он иначе не знал бы.
func (s *Service) Unread(ctx context.Context, userID uuid.UUID) ([]store.ProjectChatUnread, error) {
	return s.store.ProjectsChatUnread(ctx, userID)
}

// MarkSeen отмечает чат проекта прочитанным (viewer+).
func (s *Service) MarkSeen(ctx context.Context, userID, projectID uuid.UUID) error {
	if err := s.proj.RequireViewer(ctx, userID, projectID); err != nil {
		return err
	}
	return s.store.MarkChatSeen(ctx, projectID, userID)
}

// Input — что присылает участник.
type Input struct {
	Body string
	// EventID — кадр, о котором речь (ссылка на элемент текста).
	EventID *uuid.UUID
	// Quote — точная фраза из кадра; проверяется по тексту.
	Quote string
	// AskBot — позвать Нестора на это сообщение.
	AskBot bool
	// ReplyTo — сообщение, на которое это ответ (0.96.0). Ветки не строим: в ленте проекта
	// цитата-ссылка читается лучше лесенки.
	ReplyTo *uuid.UUID
}

// frame — кадр «как его видят редакторы» (0.139.0): из документа живой комнаты, если она есть,
// иначе из проекции.
//
// Почему документ главный. Проекция обновляется тиком комнаты раз в несколько секунд, и в эти
// секунды новый кадр в ней ещё «старый». Цитату при этом присылает тот, кто текст только что
// написал, — и получал отказ «такой фразы нет» на собственную правку.
//
// Если комната есть и в её документе кадра нет, проекция уже не спасает: документ не старее
// таблицы, значит кадр удалён (или id чужой). Возвращаем «не найден», а не догадку.
func (s *Service) frame(ctx context.Context, projectID, eventID uuid.UUID) (*store.Event, error) {
	if rows, ok := livedoc.RowsLive(ctx, s.live, projectID); ok {
		for i := range rows {
			if rows[i].ID == eventID {
				return &rows[i], nil
			}
		}
		return nil, store.ErrNotFound
	}
	return s.store.GetEvent(ctx, projectID, eventID)
}

// Post сохраняет сообщение участника и, если попросили, ответ Нестора.
func (s *Service) Post(
	ctx context.Context, userID, projectID uuid.UUID, in Input,
) (*Answer, error) {
	if err := s.proj.RequireViewer(ctx, userID, projectID); err != nil {
		return nil, err
	}
	body := strings.TrimSpace(in.Body)
	if utf8.RuneCountInString(body) < minBodyRunes {
		return nil, fmt.Errorf("%w: сообщение не может быть пустым", ErrInvalidMessage)
	}
	if utf8.RuneCountInString(body) > maxBodyRunes {
		return nil, fmt.Errorf("%w: сообщение не длиннее %d знаков", ErrInvalidMessage, maxBodyRunes)
	}
	quote := strings.TrimSpace(in.Quote)

	// Ссылка на кадр и цитату: кадр обязан быть из ЭТОГО проекта, фраза — из его текста.
	var frame *store.Event
	if in.EventID != nil {
		event, err := s.frame(ctx, projectID, *in.EventID)
		if err != nil {
			if errors.Is(err, store.ErrNotFound) {
				return nil, ErrEventNotFound
			}
			return nil, err
		}
		frame = event
	} else if quote != "" {
		// Цитата без кадра — бессмысленная ссылка: отклоняем, а не молча теряем.
		return nil, ErrEventNotFound
	}
	if quote != "" {
		if frame == nil {
			return nil, ErrEventNotFound
		}
		if utf8.RuneCountInString(quote) > maxQuoteRunes {
			return nil, fmt.Errorf("%w: цитата не длиннее %d знаков", ErrInvalidMessage, maxQuoteRunes)
		}
		if !strings.Contains(frame.Body, quote) && !strings.Contains(frame.Title, quote) {
			return nil, ErrQuoteNotFound
		}
	}

	author := s.authorName(ctx, userID)
	// Ответ на сообщение: оно обязано быть из этого проекта, иначе «ответ» указывал бы в чужой
	// разговор. Проверяем ДО вставки — внешний ключ не знает про проект.
	if in.ReplyTo != nil {
		target, err := s.store.ChatMessageByID(ctx, projectID, *in.ReplyTo)
		if err != nil {
			return nil, err
		}
		if target == nil {
			return nil, ErrReplyTarget
		}
	}
	saved := store.ChatMessage{
		ProjectID: projectID, AuthorID: &userID, AuthorName: author,
		Kind: store.ChatKindUser, Body: body, EventID: in.EventID, Quote: quote,
		ReplyTo: in.ReplyTo,
	}
	if err := s.store.AppendChatMessage(ctx, &saved); err != nil {
		return nil, err
	}
	// Письма участникам — в очередь (0.97.0): отправкой занимается фоновый обход, а не этот
	// запрос. Ошибку очереди не показываем: сообщение уже сохранено, и терять его нельзя.
	if _, err := s.store.EnqueueChatNotifications(ctx, projectID, saved.ID, userID); err != nil && s.logger != nil {
		s.logger.Warn("chat: письма о сообщении не поставлены в очередь", "project", projectID, "err", err)
	}
	s.notifyChanged(projectID)
	out := &Answer{Message: saved}

	// «@Нестор» в тексте — тоже просьба ответить (0.97.0). Порог один: имя бота в обращении,
	// с собакой. Обычное упоминание «Нестор» без собаки — просто имя, на него бот не отвечает.
	if !in.AskBot && !mentionsBot(body, s.botName) {
		return out, nil
	}
	if !s.BotAvailable() {
		out.Note = ErrBotDisabled.Error()
		return out, nil
	}
	reply, note := s.askBot(ctx, userID, projectID, in, frame, author)
	if reply != nil {
		out.Reply = reply
	}
	if note != "" {
		out.Note = note
	}
	return out, nil
}

// askBot спрашивает Нестора и сохраняет его ответ сообщением чата.
func (s *Service) askBot(
	ctx context.Context, userID, projectID uuid.UUID, in Input, frame *store.Event, author string,
) (*store.ChatMessage, string) {
	// Последние сообщения чата — контекст разговора (0.96.0). Без него бот отвечает на реплику вне
	// обсуждения: «а как же второе?» для него пустой вопрос. Берём немного и только текст: длинная
	// лента съела бы запрос.
	history := s.recentTranscript(ctx, projectID)
	question := botQuestion(in.Body, in.Quote, frame, author, history)
	answer, err := s.bot.Answer(ctx, userID, projectID, question)
	if err != nil {
		// Ошибку не выдаём 500-й: сообщение участника уже сохранено, и потерять его из-за
		// недоступной модели нельзя. Человек увидит причину рядом с сообщением.
		return nil, botErrorText(err)
	}
	answer = strings.TrimSpace(answer)
	if answer == "" {
		return nil, "Нестор не ответил — попробуйте переформулировать вопрос"
	}
	if utf8.RuneCountInString(answer) > maxBodyRunes {
		answer = string([]rune(answer)[:maxBodyRunes])
	}
	reply := store.ChatMessage{
		ProjectID: projectID, AuthorName: s.botName,
		Kind: store.ChatKindBot, Body: answer, EventID: in.EventID,
	}
	if err := s.store.AppendChatMessage(ctx, &reply); err != nil {
		return nil, "ответ Нестора не сохранился: " + err.Error()
	}
	s.notifyChanged(projectID)
	return &reply, ""
}

// botQuestion собирает вопрос для модели: контекст кадра, цитаты и последние реплики чата.
//
// Почему текстом, а не отдельными полями: у модели один вход — сообщения, и «вопрос из чата» с
// ссылкой надо объяснить словами, иначе она не поймёт, о каком кадре речь.
func botQuestion(body, quote string, frame *store.Event, author string, history []string) string {
	var b strings.Builder
	b.WriteString("Вопрос из общего чата проекта (отвечай коротко, по делу и по-русски).\n")
	if len(history) > 0 {
		b.WriteString("Последние сообщения чата, чтобы ты понимал, о чём речь:\n")
		for _, line := range history {
			b.WriteString(line + "\n")
		}
	}
	if frame != nil {
		fmt.Fprintf(&b, "Речь о кадре «%s».\n", frame.Title)
		if quote != "" {
			fmt.Fprintf(&b, "Обсуждаемая фраза: «%s»\n", quote)
		}
		// Текст кадра — в пределах разумного: длинная глава не должна съесть весь запрос.
		text := strings.TrimSpace(frame.Body)
		if runes := []rune(text); len(runes) > 1500 {
			text = string(runes[:1500]) + "…"
		}
		if text != "" {
			fmt.Fprintf(&b, "Текст кадра:\n%s\n", text)
		}
	}
	if author != "" {
		fmt.Fprintf(&b, "Автор вопроса: %s.\n", author)
	}
	fmt.Fprintf(&b, "\nВопрос: %s", body)
	return b.String()
}

// botErrorText переводит ошибку бота в человеческое объяснение.
func botErrorText(err error) string {
	text := err.Error()
	if strings.Contains(text, "выключен") || strings.Contains(text, "disabled") {
		return ErrBotDisabled.Error()
	}
	return "Нестор не смог ответить: " + text
}

// mentionsBot — позвали ли бота по имени в тексте («@Нестор», «@нестор,»).
//
// Только с собакой: имя бота в обычной фразе («Нестор молчал») — это текст истории, и отвечать на
// него ботом было бы навязчиво. Регистр не важен: «@нестор» — тот же человек.
func mentionsBot(body, botName string) bool {
	needle := "@" + strings.ToLower(strings.TrimSpace(botName))
	if needle == "@" {
		return false
	}
	return strings.Contains(strings.ToLower(body), needle)
}

// recentTranscript — последние реплики чата одной строкой на сообщение.
//
// Пустая история — нормально: первый вопрос в пустом чате. Ошибка чтения тоже не мешает ответу:
// контекст разговора улучшает ответ, но без него бот всё равно ответит по кадру и цитате.
func (s *Service) recentTranscript(ctx context.Context, projectID uuid.UUID) []string {
	const limit = 8
	messages, err := s.store.ListChatMessages(ctx, projectID, limit)
	if err != nil {
		return nil
	}
	out := make([]string, 0, len(messages))
	for _, message := range messages {
		text := strings.TrimSpace(message.Body)
		if text == "" {
			continue
		}
		if runes := []rune(text); len(runes) > 300 {
			text = string(runes[:300]) + "…"
		}
		out = append(out, fmt.Sprintf("%s: %s", message.AuthorName, text))
	}
	return out
}

// Edit меняет текст своего сообщения (0.96.0).
//
// Почему только автор: правка чужого сообщения — это подмена сказанного, и «это писал не я»
// стало бы невозможно проверить. Бот (kind=bot) не правится вовсе: его ответ — запись разговора.
func (s *Service) Edit(
	ctx context.Context, userID, projectID, messageID uuid.UUID, body string,
) (*Message, error) {
	if err := s.proj.RequireViewer(ctx, userID, projectID); err != nil {
		return nil, err
	}
	clean := strings.TrimSpace(body)
	if utf8.RuneCountInString(clean) < minBodyRunes {
		return nil, fmt.Errorf("%w: сообщение не может быть пустым", ErrInvalidMessage)
	}
	if utf8.RuneCountInString(clean) > maxBodyRunes {
		return nil, fmt.Errorf("%w: сообщение не длиннее %d знаков", ErrInvalidMessage, maxBodyRunes)
	}
	message, err := s.store.ChatMessageByID(ctx, projectID, messageID)
	if err != nil {
		return nil, err
	}
	if message == nil {
		return nil, ErrReplyTarget
	}
	if message.Kind != store.ChatKindUser {
		return nil, ErrNotAuthor
	}
	if message.AuthorID == nil || *message.AuthorID != userID {
		return nil, ErrNotAuthor
	}
	updated, err := s.store.UpdateChatMessageBody(ctx, projectID, messageID, clean)
	if err != nil {
		return nil, err
	}
	if updated == nil {
		return nil, ErrReplyTarget
	}
	s.notifyChanged(projectID)
	return updated, nil
}

// notifyChanged сообщает открытым вкладкам проекта, что появилось сообщение.
func (s *Service) notifyChanged(projectID uuid.UUID) {
	if s.notify != nil {
		s.notify.NotifyChat(projectID)
	}
}

// authorName — имя участника для подписи сообщения.
func (s *Service) authorName(ctx context.Context, userID uuid.UUID) string {
	user, err := s.store.GetUserByID(ctx, userID)
	if err != nil || user == nil {
		return "участник"
	}
	name := strings.TrimSpace(user.DisplayName)
	if name == "" {
		name = user.Email
	}
	if name == "" {
		name = "участник"
	}
	return name
}

// ---- служебное ----

// Now — время сервера для тестов (подмена не нужна, но интерфейс полезен вызывающему).
func Now() time.Time { return time.Now().UTC() }
