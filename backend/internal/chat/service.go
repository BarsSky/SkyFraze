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
	"strings"
	"time"
	"unicode/utf8"

	"github.com/google/uuid"

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
	// ErrBotDisabled — Нестор выключен на стенде или в проекте.
	ErrBotDisabled = errors.New("Нестор выключен — сообщение сохранено, ответа не будет")
)

// ProjectAccess — права на проект (реализует projects.Service).
type ProjectAccess interface {
	RequireViewer(ctx context.Context, userID, projectID uuid.UUID) error
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

// Service — общий чат проекта.
type Service struct {
	store *store.Store
	proj  ProjectAccess
	bot   Bot
	// botName — имя, которым подписан ответ бота. Пусто — «Нестор».
	botName string
}

// New собирает сервис чата.
func New(st *store.Store, proj ProjectAccess) *Service {
	return &Service{store: st, proj: proj, botName: "Нестор"}
}

// UseBot подключает Нестора и его имя. Без этого чат работает, но бота не предлагает.
func (s *Service) UseBot(bot Bot, name string) {
	s.bot = bot
	if strings.TrimSpace(name) != "" {
		s.botName = strings.TrimSpace(name)
	}
}

// BotName — имя бота для интерфейса (подпись кнопки «спросить …»).
func (s *Service) BotName() string { return s.botName }

// BotAvailable — можно ли позвать бота сейчас: включён на стенде. Настройку проекта проверяет
// сам бот при ответе, а интерфейсу достаточно «кнопка есть или нет».
func (s *Service) BotAvailable() bool { return s.bot != nil && s.bot.Enabled() }

// Messages — последние сообщения проекта (viewer+). after != nil — только новые после него.
func (s *Service) Messages(
	ctx context.Context, userID, projectID uuid.UUID, after *uuid.UUID, limit int,
) ([]Message, error) {
	if err := s.proj.RequireViewer(ctx, userID, projectID); err != nil {
		return nil, err
	}
	if limit <= 0 || limit > maxLimit {
		limit = defaultLimit
	}
	if after == nil {
		return s.store.ListChatMessages(ctx, projectID, limit)
	}
	return s.store.ChatMessagesAfter(ctx, projectID, *after, limit)
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
		event, err := s.store.GetEvent(ctx, projectID, *in.EventID)
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
	saved := store.ChatMessage{
		ProjectID: projectID, AuthorID: &userID, AuthorName: author,
		Kind: store.ChatKindUser, Body: body, EventID: in.EventID, Quote: quote,
	}
	if err := s.store.AppendChatMessage(ctx, &saved); err != nil {
		return nil, err
	}
	out := &Answer{Message: saved}

	if !in.AskBot {
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
	question := botQuestion(in.Body, in.Quote, frame, author)
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
	return &reply, ""
}

// botQuestion собирает вопрос для модели: контекст кадра и цитаты, если они есть.
//
// Почему текстом, а не отдельными полями: у модели один вход — сообщения, и «вопрос из чата» с
// ссылкой надо объяснить словами, иначе она не поймёт, о каком кадре речь.
func botQuestion(body, quote string, frame *store.Event, author string) string {
	var b strings.Builder
	b.WriteString("Вопрос из общего чата проекта (отвечай коротко, по делу и по-русски).\n")
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
