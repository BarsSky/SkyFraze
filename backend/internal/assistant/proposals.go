package assistant

// proposals.go — правки существующих кадров: предложить, применить, отклонить, вернуть.
//
// Почему через подтверждение, а не сразу. До этой возможности помощник умел только
// создавать кадры, и это было записано как решение, а не как недоделка
// (docs/ai-assistant.md, «Что не берём»): перезапись и удаление — необратимые правки
// чужого текста, и модель, которая делает их сама, рано или поздно сделает не то.
//
// Теперь так: агент описывает правку, сервер сохраняет снимок «до» и «после» (миграция
// 0015), а применяет её человек одной кнопкой в том же окне. Из снимка следуют три
// свойства, которых не было бы при «применить сразу»:
//
//   - «Вернуть» — не догадка: старый текст лежит рядом с предложением;
//   - «кадр изменился» проверяется по снимку, а не по времени: если человек правил
//     кадр после предложения, применять старое нельзя — оно затрёт его правку;
//   - отклонённое предложение не оставляет следов в проекте вовсе.

import (
	"context"
	"errors"
	"fmt"
	"strings"

	"github.com/google/uuid"

	"github.com/skyfraze/backend/internal/store"
	"github.com/skyfraze/backend/internal/transfer"
)

// Proposal — предложенная правка в том виде, в каком её видит интерфейс.
type Proposal struct {
	ID     uuid.UUID `json:"id"`
	Kind   string    `json:"kind"` // update_text | delete_event
	Status string    `json:"status"`
	// EventID/EventTitle — к какому кадру.
	EventID    uuid.UUID `json:"event_id"`
	EventTitle string    `json:"event_title"`
	// Old*/New* — «было» и «станет»: по ним интерфейс показывает разницу, а «Вернуть»
	// возвращает Old* в кадр.
	OldTitle string `json:"old_title"`
	OldBody  string `json:"old_body"`
	NewTitle string `json:"new_title"`
	NewBody  string `json:"new_body"`
}

// Ошибки работы с предложениями.
var (
	// ErrProposalNotFound — предложения нет, оно чужое или уже решено.
	ErrProposalNotFound = errors.New("предложение не найдено")
	// ErrProposalStale — кадр изменился после предложения: применять его нельзя.
	ErrProposalStale = errors.New("кадр изменился после предложения")
	// ErrProposalWrongUser — предложение сделано другому человеку.
	ErrProposalWrongUser = errors.New("предложение сделано другому человеку")
)

// ProposalDTO переводит запись в вид для интерфейса.
func ProposalDTO(c store.AIChange) Proposal {
	return Proposal{
		ID: c.ID, Kind: c.Kind, Status: c.Status,
		EventID: c.EventID, EventTitle: c.EventTitle,
		OldTitle: c.OldTitle, OldBody: c.OldBody, NewTitle: c.NewTitle, NewBody: c.NewBody,
	}
}

// Proposals — правки, о которых человеку стоит знать.
//
// Ожидающие (ждут решения) и применённые за последнюю неделю (их ещё можно вернуть).
// Второе — не «история ради истории»: снимок старого текста лежит в базе, и прятать его
// после перезагрузки страницы значило бы давать отмену только тем, кто не закрыл вкладку.
func (s *Service) Proposals(ctx context.Context, userID, projectID uuid.UUID) ([]Proposal, error) {
	pending, err := s.store.PendingAIChanges(ctx, projectID, userID)
	if err != nil {
		return nil, err
	}
	applied, err := s.store.AppliedAIChanges(ctx, projectID, userID)
	if err != nil {
		return nil, err
	}
	out := make([]Proposal, 0, len(pending)+len(applied))
	for _, row := range pending {
		out = append(out, ProposalDTO(row))
	}
	for _, row := range applied {
		out = append(out, ProposalDTO(row))
	}
	return out, nil
}

// PendingProposals — только ожидающие решения (тесты и внутренние проверки).
func (s *Service) PendingProposals(ctx context.Context, userID, projectID uuid.UUID) ([]Proposal, error) {
	rows, err := s.store.PendingAIChanges(ctx, projectID, userID)
	if err != nil {
		return nil, err
	}
	out := make([]Proposal, 0, len(rows))
	for _, row := range rows {
		out = append(out, ProposalDTO(row))
	}
	return out, nil
}

// applyProposal — общий путь применения: проверить, что кадр тот же, и применить.
//
// `rebuild` строит, что именно писать в кадр (для «вернуть» — старое, для применения —
// новое). Так «применить» и «вернуть» идут одним кодом и не могут разойтись в проверках.
func (s *Service) applyProposal(
	ctx context.Context, actorID, userID, projectID, proposalID uuid.UUID, revert bool,
) (*store.AIChange, string, error) {
	change, err := s.store.AIChangeByID(ctx, projectID, proposalID)
	if err != nil {
		if errors.Is(err, store.ErrNotFound) {
			return nil, "", ErrProposalNotFound
		}
		return nil, "", err
	}
	if change.UserID != userID {
		// Не «нет прав», а «это не ваше предложение»: так же, как с чужими беседами.
		return nil, "", ErrProposalWrongUser
	}

	// Применять можно ожидающее; возвращать — примененное.
	from := store.AIChangePending
	if revert {
		from = store.AIChangeApplied
	}
	if change.Status != from {
		return nil, "", ErrProposalNotFound
	}
	if change.Kind == store.AIChangeUpdateText {
		// Ожидаемое состояние зависит от действия: перед применением кадр должен быть
		// ровно таким, каким его запомнили ДО, а перед возвратом — таким, каким его
		// сделала применённая правка. Иначе мы затрём то, что человек успел исправить.
		expectedTitle, expectedBody := change.OldTitle, change.OldBody
		if revert {
			expectedTitle, expectedBody = change.NewTitle, change.NewBody
		}
		if err := s.requireUnchanged(ctx, projectID, change.EventID, expectedTitle, expectedBody); err != nil {
			// Кадр правили после предложения: помечаем предложение устаревшим, чтобы
			// оно не всплыло повторно, и говорим человеку словами, что случилось.
			_ = s.store.SetAIChangeStatus(ctx, change.ID, from, store.AIChangeSuperseded)
			return nil, "", err
		}
	}

	if change.Kind == store.AIChangeUpdateText {
		title, body := change.NewTitle, change.NewBody
		if revert {
			title, body = change.OldTitle, change.OldBody
		}
		warning, err := s.editor.UpdateEventText(ctx, actorID, userID, projectID,
			change.EventID.String(), &title, &body)
		if err != nil {
			return nil, "", editErrorText(err)
		}
		return change, warning, nil
	}

	if revert {
		// Удаление вернуть нельзя: кадр уже убран из документа, и восстанавливать его
		// пришлось бы вставкой с прежним идентификатором и местом — это другая
		// возможность, и обещать её кнопкой «Вернуть» было бы обманом.
		return nil, "", errors.New("удаление отменить нельзя: кадр нужно создать заново")
	}
	// Детей проверяем до применения: удалить главу вместе с под-событиями — одно
	// нажатие, которое уносит больше, чем видно на экране.
	warning, err := s.editor.DeleteEvent(ctx, actorID, userID, projectID, change.EventID.String())
	if err != nil {
		return nil, "", editErrorText(err)
	}
	return change, warning, nil
}

// ApplyProposal применяет предложение: правка уходит в документ, предложение — в applied.
func (s *Service) ApplyProposal(
	ctx context.Context, actorID, userID, projectID, proposalID uuid.UUID,
) (Proposal, string, error) {
	change, warning, err := s.applyProposal(ctx, actorID, userID, projectID, proposalID, false)
	if err != nil {
		return Proposal{}, "", err
	}
	if err := s.store.SetAIChangeStatus(ctx, change.ID, store.AIChangePending, store.AIChangeApplied); err != nil {
		// Правка уже в документе: состояние предложения — не повод считать её неудачной.
		// Худшее, что будет, — кнопка «Применить» покажется ещё раз.
		s.logger.Warn("ai: не удалось обновить состояние предложения",
			"change", change.ID, "err", err)
	}
	change.Status = store.AIChangeApplied
	return ProposalDTO(*change), warning, nil
}

// RevertProposal возвращает прежний текст перезаписанного кадра.
func (s *Service) RevertProposal(
	ctx context.Context, actorID, userID, projectID, proposalID uuid.UUID,
) (Proposal, string, error) {
	change, warning, err := s.applyProposal(ctx, actorID, userID, projectID, proposalID, true)
	if err != nil {
		return Proposal{}, "", err
	}
	if err := s.store.SetAIChangeStatus(ctx, change.ID, store.AIChangeApplied, store.AIChangePending); err != nil {
		s.logger.Warn("ai: не удалось обновить состояние предложения",
			"change", change.ID, "err", err)
	}
	// Возвращённый текст снова ждёт решения: применять его повторно — обычное действие.
	change.Status = store.AIChangePending
	return ProposalDTO(*change), warning, nil
}

// DiscardProposal отказывается от предложения.
func (s *Service) DiscardProposal(ctx context.Context, userID, projectID, proposalID uuid.UUID) error {
	change, err := s.store.AIChangeByID(ctx, projectID, proposalID)
	if err != nil {
		if errors.Is(err, store.ErrNotFound) {
			return ErrProposalNotFound
		}
		return err
	}
	if change.UserID != userID {
		return ErrProposalWrongUser
	}
	if err := s.store.SetAIChangeStatus(ctx, change.ID, store.AIChangePending, store.AIChangeDiscarded); err != nil {
		if errors.Is(err, store.ErrNotFound) {
			return ErrProposalNotFound
		}
		return err
	}
	return nil
}

// requireUnchanged сверяет кадр с ожидаемым содержимым.
//
// Именно сверка содержимого, а не времени: часы у сервера и клиента разные, а «кадр
// изменился» — это факт о тексте, а не о времени. Заодно это ловит случай «кадр удалили».
func (s *Service) requireUnchanged(
	ctx context.Context, projectID, eventID uuid.UUID, wantTitle, wantBody string,
) error {
	rows, err := s.store.ListEvents(ctx, projectID)
	if err != nil {
		return err
	}
	for _, row := range rows {
		if row.ID != eventID {
			continue
		}
		if row.Title != wantTitle || row.Body != wantBody {
			return ErrProposalStale
		}
		return nil
	}
	return ErrProposalStale
}

// editErrorText переводит отказы пути правки в текст для человека.
func editErrorText(err error) error {
	switch {
	case errors.Is(err, transfer.ErrEventNotFound):
		return errors.New("кадр не найден: возможно, его уже удалили")
	case errors.Is(err, transfer.ErrEventHasChildren):
		return errors.New("у кадра есть под-события: сначала решите, что с ними (удалять главу вместе с детьми нельзя)")
	case errors.Is(err, transfer.ErrMarkdownBusy):
		return errors.New("проект сейчас загружается сервером — повторите через пару секунд")
	case errors.Is(err, transfer.ErrForbidden):
		return errors.New("нет прав на изменение этого проекта")
	default:
		return err
	}
}

// proposalNote — что сказать модели после создания предложения.
//
// Модели важно понимать разницу: она НЕ изменила проект, и повторять вызов нельзя.
// Иначе она честно решит, что «не получилось», и предложит то же самое ещё три раза.
func proposalNote(kind string) string {
	if kind == store.AIChangeDeleteEvent {
		return "предложение удаления сохранено и ждёт подтверждения человеком; кадр пока НЕ удалён " +
			"и повторять вызов не нужно — скажи человеку, что он может подтвердить удаление в окне помощника"
	}
	return "предложение правки сохранено и ждёт подтверждения человеком; текст пока НЕ изменён " +
		"и повторять вызов не нужно — скажи человеку, что он может применить правку в окне помощника"
}

// proposalTitle — короткая подпись для журнала и интерфейса.
func proposalTitle(kind, eventTitle string) string {
	what := "переписать"
	if kind == store.AIChangeDeleteEvent {
		what = "удалить"
	}
	return fmt.Sprintf("%s кадр «%s»", what, strings.TrimSpace(eventTitle))
}
