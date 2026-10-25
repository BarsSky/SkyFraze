// Package notify — письма о новых замечаниях.
//
// Что это и чего здесь нет. Уведомление — короткое письмо «в проекте X появились
// замечания», собранное из очереди (comment_notifications, миграция 0020). Никакого
// «движка шаблонов» и подписок на всё подряд: одна причина письма, один вид письма.
//
// Почему SMTP из стандартной библиотеки, а не внешний сервис. Письмо — это «соединиться,
// поздороваться, отдать текст». net/smtp делает ровно это; тянуть ради него SDK почтового
// провайдера (и привязывать стенд к одному провайдеру) не нужно.
//
// Отправка идёт фоновым обходом: очередь читается пачкой, письма группируются ПО ЧЕЛОВЕКУ —
// пять замечаний подряд не должны превращаться в пять писем. Неудача не теряет письмо: у
// строки растёт attempts и пишется last_error, следующая попытка снова её возьмёт (пока не
// упрётся в предел).
package notify

import (
	"context"
	"encoding/base64"
	"errors"
	"fmt"
	"log/slog"
	"net"
	"net/smtp"
	"strings"
	"time"

	"github.com/google/uuid"

	"github.com/skyfraze/backend/internal/store"
)

// Config — настройки почты. Пустой Host или From означает «письма не отправляются»:
// стенд без почтового сервера работает как работал, уведомления остаются в интерфейсе.
type Config struct {
	Host     string
	Port     int
	Username string
	Password string
	From     string
	// ImplicitTLS — соединение сразу по TLS (порт 465). Иначе — обычное соединение и
	// STARTTLS, если сервер его предлагает (587 и большинство локальных MTA).
	ImplicitTLS bool
	// BaseURL — адрес стенда для ссылок в письме (`https://skyfraze.example`). Пусто —
	// письмо без ссылок: битая ссылка хуже её отсутствия.
	BaseURL string
	// Interval — как часто обходить очередь.
	Interval time.Duration
	// MaxAttempts — после скольких неудач перестать пытаться.
	MaxAttempts int
}

// Enabled — настроена ли почта.
func (c Config) Enabled() bool {
	return strings.TrimSpace(c.Host) != "" && strings.TrimSpace(c.From) != ""
}

// Sender отправляет одно письмо. Интерфейс — ради тестов: поддельный SMTP-сервер в тестах
// проверяет текст письма, а не сеть.
type Sender interface {
	Send(ctx context.Context, to, subject, body string) error
}

// Service — фоновый обход очереди.
type Service struct {
	store  *store.Store
	sender Sender
	logger *slog.Logger
	cfg    Config
}

func New(st *store.Store, sender Sender, cfg Config, logger *slog.Logger) *Service {
	if cfg.Interval <= 0 {
		cfg.Interval = time.Minute
	}
	if cfg.MaxAttempts <= 0 {
		cfg.MaxAttempts = 5
	}
	return &Service{store: st, sender: sender, logger: logger, cfg: cfg}
}

// Run обходит очередь до отмены контекста.
func (s *Service) Run(ctx context.Context) {
	// Первый обход — не сразу: сервер только поднялся, и письма подождут нескольких секунд.
	select {
	case <-ctx.Done():
		return
	case <-time.After(5 * time.Second):
	}
	ticker := time.NewTicker(s.cfg.Interval)
	defer ticker.Stop()
	for {
		if _, _, err := s.Flush(ctx); err != nil && ctx.Err() == nil {
			s.logger.Warn("notify: обход очереди не удался", "err", err)
		}
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
		}
	}
}

// Flush отправляет то, что накопилось: одно письмо на человека.
func (s *Service) Flush(ctx context.Context) (sent, failed int, err error) {
	pending, err := s.store.PendingCommentNotifications(ctx, 200, s.cfg.MaxAttempts)
	if err != nil {
		return 0, 0, err
	}
	if len(pending) == 0 {
		return 0, 0, nil
	}

	// Группируем по человеку: пять замечаний подряд — одно письмо, а не пять.
	byUser := make(map[uuid.UUID][]store.CommentNotification, len(pending))
	order := make([]uuid.UUID, 0, len(pending))
	for _, row := range pending {
		if _, seen := byUser[row.UserID]; !seen {
			order = append(order, row.UserID)
		}
		byUser[row.UserID] = append(byUser[row.UserID], row)
	}

	for _, userID := range order {
		rows := byUser[userID]
		ids := make([]uuid.UUID, 0, len(rows))
		for _, row := range rows {
			ids = append(ids, row.ID)
		}
		subject, body := compose(rows, s.cfg.BaseURL)
		if sendErr := s.sender.Send(ctx, rows[0].Email, subject, body); sendErr != nil {
			// Сеть подвела — письмо не теряем: попытка зачтётся, следующая возьмёт снова.
			if markErr := s.store.MarkCommentNotificationsFailed(ctx, ids, sendErr.Error()); markErr != nil {
				s.logger.Warn("notify: не удалось отметить неудачу", "err", markErr)
			}
			failed++
			s.logger.Warn("notify: письмо не отправлено", "to", rows[0].Email, "err", sendErr)
			continue
		}
		if markErr := s.store.MarkCommentNotificationsSent(ctx, ids); markErr != nil {
			s.logger.Warn("notify: письмо отправлено, но отметка не записалась", "err", markErr)
		}
		sent++
		s.logger.Info("notify: письмо о новых замечаниях отправлено",
			"to", rows[0].Email, "comments", len(rows))
	}
	return sent, failed, nil
}

// compose собирает тему и текст письма.
//
// Письмо короткое и без разметки: получатель должен понять «где и что», а не читать
// дайджест. Полный текст замечания — в проекте, и ссылка ведёт туда.
func compose(rows []store.CommentNotification, baseURL string) (subject, body string) {
	project := rows[0].ProjectTitle
	if project == "" {
		project = "проект"
	}
	count := len(rows)
	subject = fmt.Sprintf("SkyFraze: %s в «%s»", plural(count), project)

	var b strings.Builder
	b.WriteString("Новые замечания в проекте «" + project + "»:\n\n")
	for _, row := range rows {
		frame := row.EventTitle
		if frame == "" {
			frame = "кадр"
		}
		b.WriteString(fmt.Sprintf("• %s — %s: %s\n", frame, row.AuthorName, oneLine(row.Body, 300)))
	}
	if baseURL != "" {
		link := strings.TrimSuffix(baseURL, "/") + "/projects/" + rows[0].ProjectID.String()
		b.WriteString("\nОткрыть проект: " + link + "\n")
	}
	b.WriteString("\nВы получаете это письмо, потому что включили уведомления в профиле SkyFraze.")
	b.WriteString("\nОтключить: профиль → «Присылать замечания на почту».\n")
	return subject, b.String()
}

// plural — «1 новое замечание», «2 новых замечания».
func plural(n int) string {
	switch {
	case n == 1:
		return "новое замечание"
	case n >= 2 && n <= 4:
		return fmt.Sprintf("%d новых замечания", n)
	default:
		return fmt.Sprintf("%d новых замечаний", n)
	}
}

// oneLine — текст в одну строку с пределом: письмо не должно превращаться в главу.
func oneLine(text string, limit int) string {
	flat := strings.Join(strings.Fields(text), " ")
	if len([]rune(flat)) <= limit {
		return flat
	}
	runes := []rune(flat)
	return string(runes[:limit]) + "…"
}

// SMTPSender — отправка через SMTP.
type SMTPSender struct {
	cfg Config
}

func NewSMTPSender(cfg Config) *SMTPSender { return &SMTPSender{cfg: cfg} }

// Send соединяется с сервером и отдаёт одно письмо.
//
// Адрес сервера — тот, что в настройках; адрес получателя — из очереди (он пришёл из базы,
// а не от клиента, но всё равно проверяется: перевод строки в адресе — это инъекция
// заголовков, и допускать её нельзя).
func (s *SMTPSender) Send(ctx context.Context, to, subject, body string) error {
	if !s.cfg.Enabled() {
		return errors.New("notify: почта не настроена")
	}
	if err := validAddress(to); err != nil {
		return err
	}
	if strings.ContainsAny(subject, "\r\n") {
		return errors.New("notify: перевод строки в теме письма")
	}
	addr := net.JoinHostPort(s.cfg.Host, fmt.Sprint(s.cfg.Port))
	message := buildMessage(s.cfg.From, to, subject, body)

	var client *smtp.Client
	var err error
	if s.cfg.ImplicitTLS {
		client, err = dialTLS(ctx, addr, s.cfg.Host)
	} else {
		client, err = dialPlain(ctx, addr, s.cfg.Host, s.cfg.Username, s.cfg.Password)
	}
	if err != nil {
		return err
	}
	defer client.Close()

	if !s.cfg.ImplicitTLS && s.cfg.Username != "" {
		if authErr := client.Auth(smtp.PlainAuth("", s.cfg.Username, s.cfg.Password, s.cfg.Host)); authErr != nil {
			return fmt.Errorf("notify: smtp auth: %w", authErr)
		}
	}
	if err := client.Mail(s.cfg.From); err != nil {
		return fmt.Errorf("notify: mail from: %w", err)
	}
	if err := client.Rcpt(to); err != nil {
		return fmt.Errorf("notify: rcpt to: %w", err)
	}
	writer, err := client.Data()
	if err != nil {
		return fmt.Errorf("notify: data: %w", err)
	}
	if _, err := writer.Write([]byte(message)); err != nil {
		return fmt.Errorf("notify: write: %w", err)
	}
	if err := writer.Close(); err != nil {
		return fmt.Errorf("notify: close data: %w", err)
	}
	return client.Quit()
}

// buildMessage — письмо в формате RFC 5322: заголовки, пустая строка, тело.
//
// Тема кодируется по RFC 2047, если в ней есть не-ASCII: в заголовке допустим только ASCII,
// и живая отправка это показала — тело с кириллицей читалось, а тема доезжала как `??????`.
// Base64-слово `=?UTF-8?B?…?=` понимают все почтовые клиенты.
func buildMessage(from, to, subject, body string) string {
	var b strings.Builder
	b.WriteString("From: " + from + "\r\n")
	b.WriteString("To: " + to + "\r\n")
	b.WriteString("Subject: " + encodeHeader(subject) + "\r\n")
	b.WriteString("Date: " + time.Now().UTC().Format(time.RFC1123Z) + "\r\n")
	b.WriteString("MIME-Version: 1.0\r\n")
	b.WriteString("Content-Type: text/plain; charset=utf-8\r\n")
	b.WriteString("\r\n")
	b.WriteString(strings.ReplaceAll(body, "\n", "\r\n"))
	return b.String()
}

// encodeHeader — RFC 2047 для не-ASCII значения заголовка.
func encodeHeader(value string) string {
	for _, r := range value {
		if r > 127 {
			return "=?UTF-8?B?" + base64.StdEncoding.EncodeToString([]byte(value)) + "?="
		}
	}
	return value
}

// validAddress — простая проверка адреса: собака, точка, никаких переводов строк и скобок.
func validAddress(address string) error {
	if strings.ContainsAny(address, "\r\n<>") {
		return errors.New("notify: недопустимый адрес получателя")
	}
	at := strings.LastIndex(address, "@")
	if at <= 0 || at == len(address)-1 || !strings.Contains(address[at:], ".") {
		return fmt.Errorf("notify: адрес получателя не похож на почту: %q", address)
	}
	return nil
}

