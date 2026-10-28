package assistant

// chat_bot.go — Нестор для общего чата проекта (0.95.0).
//
// Адаптер, а не метод сервиса: чат определяет свой узкий интерфейс (`chat.Bot`), и связывать
// пакеты напрямую незачем — в тестах чата бот подменяется одной строкой, а assistant не начинает
// зависеть от чата.

import (
	"context"

	"github.com/google/uuid"
)

// ChatBot — «Нестор» глазами общего чата.
type ChatBot struct {
	svc *Service
}

// NewChatBot оборачивает сервис помощника в интерфейс чата.
func NewChatBot(svc *Service) *ChatBot { return &ChatBot{svc: svc} }

// Enabled — работает ли помощник на стенде.
func (b *ChatBot) Enabled() bool {
	return b != nil && b.svc != nil && b.svc.Enabled()
}

// Answer отвечает на вопрос из чата, ничего не меняя в проекте (см. Service.Answer).
func (b *ChatBot) Answer(
	ctx context.Context, userID, projectID uuid.UUID, question string,
) (string, error) {
	if !b.Enabled() {
		return "", ErrDisabled
	}
	return b.svc.Answer(ctx, userID, projectID, question)
}
