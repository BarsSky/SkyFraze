// Package coauthors — соавторы: творческий круг человека.
//
// Соавторство — это связь двух людей в общем деле. Оно появляется по заявке и
// согласию, несёт специализации (кто за что берётся: правописание, проработка
// героя или злодея, технические концепты, магические системы, ландшафты, арт) и
// два независимых разрешения «видит мои закрытые проекты».
//
// Важно: соавторство само по себе НЕ даёт правок. Оно даёт чтение закрытых
// проектов, если владелец открыл доступ, и попадает в список при добавлении
// человека в проект — там уже выбирается роль (editor/viewer) как обычно.
package coauthors

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"unicode/utf8"

	"github.com/google/uuid"

	"github.com/skyfraze/backend/internal/store"
)

var (
	// ErrSelf — попытка позвать себя.
	ErrSelf = errors.New("cannot add yourself")
	// ErrAlreadyCoauthors — связь уже принята.
	ErrAlreadyCoauthors = errors.New("already coauthors")
	// ErrRequestPending — заявка уже отправлена и ждёт решения.
	ErrRequestPending = errors.New("request pending")
	// ErrNotFound — связи нет или она не ваша.
	ErrNotFound = errors.New("link not found")
	// ErrInvalidCrafts — специализации не помещаются в разумные пределы.
	// Тот же предел, что у специализаций в профиле человека: чистку делает
	// store.CleanCrafts, а сентинел нужен свой, чтобы вызывающий код не тащил
	// store ради сравнения ошибки.
	ErrInvalidCrafts = store.ErrInvalidCrafts
)

// Ограничение на сопроводительное сообщение. Пределы специализаций (12 значений
// по 60 рун) — общие с профилем человека и живут в store.CleanCrafts.
const maxMessage = 500

type Service struct {
	store *store.Store
}

func New(s *store.Store) *Service {
	return &Service{store: s}
}

// Invite создаёт заявку в соавторы.
//
// Если встречная заявка уже висит (человек позвал меня, а я зову его), это
// взаимное согласие — сразу принимаем её. Иначе заявка ждёт решения адресата.
func (s *Service) Invite(ctx context.Context, requesterID, addresseeID uuid.UUID, message string, crafts []string) (*store.CoauthorLink, error) {
	if requesterID == addresseeID {
		return nil, ErrSelf
	}
	crafts, err := store.CleanCrafts(crafts)
	if err != nil {
		return nil, err
	}
	message = strings.TrimSpace(message)
	if utf8.RuneCountInString(message) > maxMessage {
		return nil, fmt.Errorf("message too long")
	}

	existing, err := s.store.GetCoauthorLink(ctx, requesterID, addresseeID)
	switch {
	case err == nil && existing.Status == store.CoauthorAccepted:
		return nil, ErrAlreadyCoauthors
	case err == nil && existing.Status == store.CoauthorPending && existing.AddresseeID == requesterID:
		// Встречная заявка: оба хотят — принимаем прежнюю.
		return s.store.DecideCoauthor(ctx, existing.ID, requesterID, true)
	case err != nil && !errors.Is(err, store.ErrNotFound):
		return nil, err
	}

	return s.store.UpsertCoauthorRequest(ctx, requesterID, addresseeID, message, crafts)
}

// Decide — согласие или отказ по входящей заявке.
func (s *Service) Decide(ctx context.Context, userID, linkID uuid.UUID, accept bool) (*store.CoauthorLink, error) {
	link, err := s.store.DecideCoauthor(ctx, linkID, userID, accept)
	if errors.Is(err, store.ErrNotFound) {
		return nil, ErrNotFound
	}
	return link, err
}

// Update меняет специализации и разрешение смотреть мои закрытые проекты.
// Разрешение своё: владелец закрытых проектов ставит его только за себя.
func (s *Service) Update(ctx context.Context, userID, linkID uuid.UUID, crafts *[]string, sharesClosed *bool) (*store.CoauthorLink, error) {
	var cleaned []string
	if crafts != nil {
		var err error
		cleaned, err = store.CleanCrafts(*crafts)
		if err != nil {
			return nil, err
		}
	}
	link, err := s.store.UpdateCoauthor(ctx, linkID, userID, cleaned, sharesClosed)
	if errors.Is(err, store.ErrNotFound) {
		return nil, ErrNotFound
	}
	return link, err
}

// Remove разрывает соавторство. Доступ к закрытым проектам исчезает вместе с ним.
func (s *Service) Remove(ctx context.Context, userID, linkID uuid.UUID) error {
	err := s.store.RemoveCoauthor(ctx, linkID, userID)
	if errors.Is(err, store.ErrNotFound) {
		return ErrNotFound
	}
	return err
}

// List — принятые соавторы, ожидающие заявки и отправленные мной заявки.
type List struct {
	Coauthors []store.CoauthorLink `json:"coauthors"`
	Incoming  []store.CoauthorLink `json:"incoming"`
	Outgoing  []store.CoauthorLink `json:"outgoing"`
}

func (s *Service) List(ctx context.Context, userID uuid.UUID) (*List, error) {
	coauthors, err := s.store.ListCoauthors(ctx, userID)
	if err != nil {
		return nil, err
	}
	incoming, err := s.store.ListCoauthorRequests(ctx, userID, "incoming")
	if err != nil {
		return nil, err
	}
	outgoing, err := s.store.ListCoauthorRequests(ctx, userID, "outgoing")
	if err != nil {
		return nil, err
	}
	return &List{Coauthors: coauthors, Incoming: incoming, Outgoing: outgoing}, nil
}

// Search — поиск людей по нику и имени. Отдаём и отношения: интерфейсу нужно
// понимать, предложить приглашение или показать, что человек уже в круге.
func (s *Service) Search(ctx context.Context, viewerID uuid.UUID, query string) ([]store.UserSearchResult, error) {
	return s.store.SearchUsers(ctx, viewerID, query, 20)
}
