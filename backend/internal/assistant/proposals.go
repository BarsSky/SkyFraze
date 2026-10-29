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
	"encoding/json"
	"errors"
	"fmt"
	"strings"

	"github.com/google/uuid"

	"github.com/skyfraze/backend/internal/collab/yjs"
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
	// Фрагмент (kind=update_span, миграция 0027): замечание, к которому относится правка, и
	// текст «было/станет» для ЭТОГО куска. Отдельные поля, а не OldBody/NewBody: правка
	// фрагмента проверяется и показывается по куску, а не по кадру целиком.
	CommentID *uuid.UUID `json:"comment_id,omitempty"`
	OldSpan   string     `json:"old_span"`
	NewSpan   string     `json:"new_span"`
	// Дата (kind=update_date, 0.106.0): «было» и «станет» в формате YYYY-MM-DD; пусто — даты
	// нет. Отдельные поля, а не OldTitle: «Вернуть прежний текст» не должен трогать дату.
	OldDate string `json:"old_date"`
	NewDate string `json:"new_date"`
}

// Ошибки работы с предложениями.
var (
	// ErrProposalNotFound — предложения нет, оно чужое или уже решено.
	ErrProposalNotFound = errors.New("предложение не найдено")
	// ErrProposalStale — текст изменился после предложения: применять его нельзя.
	//
	// Формулировка не про «кадр»: тем же отказом отвечает правка ФРАГМЕНТА
	// (`update_span`), где сверяется не кадр, а сам кусок текста (см. `ApplyProposal`).
	// Раньше человек, правивший абзац, читал «кадр изменился» и искал правку не там.
	ErrProposalStale = errors.New("предложение устарело: текст изменился после предложения")
	// ErrProposalWrongUser — предложение сделано другому человеку.
	ErrProposalWrongUser = errors.New("предложение сделано другому человеку")
)

// ProposalDTO переводит запись в вид для интерфейса.
func ProposalDTO(c store.AIChange) Proposal {
	return Proposal{
		ID: c.ID, Kind: c.Kind, Status: c.Status,
		EventID: c.EventID, EventTitle: c.EventTitle,
		OldTitle: c.OldTitle, OldBody: c.OldBody, NewTitle: c.NewTitle, NewBody: c.NewBody,
		CommentID: c.CommentID, OldSpan: c.OldSpan, NewSpan: c.NewSpan,
		OldDate: c.OldDate, NewDate: c.NewDate,
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
	// Правка фрагмента сверяется ПО ФРАГМЕНТУ, а не по кадру, и делает это своя ветка ниже.
	// Поэтому общие проверки «кадр не изменился» её пропускают: у предложения фрагмента
	// OldTitle/OldBody пусты (оно про кусок), и общая сверка отвергала бы его всегда.
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
	} else if !revert && change.Kind == store.AIChangeDeleteEvent {
		// Удаление тоже требует «кадр не изменился»: если человек правил текст после
		// предложения, удалять уже не тот кадр, который обсуждали с помощником.
		if err := s.requireUnchanged(ctx, projectID, change.EventID, change.OldTitle, change.OldBody); err != nil {
			_ = s.store.SetAIChangeStatus(ctx, change.ID, from, store.AIChangeSuperseded)
			return nil, "", err
		}
	}

	// Правка фрагмента: сверяется ФРАГМЕНТ, а не кадр.
	//
	// Почему не общий requireUnchanged: предложение про два абзаца, и чужая правка в
	// соседнем абзаце не должна его отменять — иначе «предложение устарело» появлялось бы
	// там, где всё на месте. Зато если изменился сам фрагмент, применять нельзя: человек
	// подтверждал правку по тексту, которого уже нет.
	if change.Kind == store.AIChangeUpdateSpan {
		// Ожидаемый текст и замена зависят от действия: применяем old_span → new_span,
		// возвращаем new_span → old_span.
		expect, replacement := change.OldSpan, change.NewSpan
		if revert {
			expect, replacement = change.NewSpan, change.OldSpan
		}
		if len(change.AnchorStart) == 0 || len(change.AnchorEnd) == 0 {
			return nil, "", ErrProposalStale
		}
		warning, newStart, newEnd, err := s.editor.ReplaceSpanChecked(ctx, actorID, userID, projectID,
			change.EventID.String(), "body", change.AnchorStart, change.AnchorEnd, expect, replacement)
		if err != nil {
			if errors.Is(err, yjs.ErrSpanChanged) {
				_ = s.store.SetAIChangeStatus(ctx, change.ID, from, store.AIChangeSuperseded)
				return nil, "", ErrProposalStale
			}
			return nil, "", editErrorText(err)
		}
		// Якорь на новый текст: следующее действие (повторное «Применить» или «Вернуть»)
		// ищет фрагмент по нему. Сбой записи не отменяет правку — она уже в документе,
		// но следующее действие может не найти фрагмент, и об этом честно в журнале.
		if len(newStart) > 0 && len(newEnd) > 0 {
			if aerr := s.store.SetAIChangeSpanAnchor(ctx, change.ID, newStart, newEnd); aerr != nil {
				s.logger.Warn("ai: якорь предложения не обновлён — «Вернуть» может не найти фрагмент",
					"change", change.ID, "err", aerr)
			} else {
				change.AnchorStart, change.AnchorEnd = newStart, newEnd
			}
		}
		return change, warning, nil
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

	// Правка даты (kind=update_date, 0.106.0): сверяется ДАТА, а не текст и не кадр целиком.
	// Применяем old_date → new_date, возвращаем new_date → old_date; «дата уже другая» —
	// отказ, а не тихая перезапись чужой правки.
	if change.Kind == store.AIChangeUpdateDate {
		expect, date := change.OldDate, change.NewDate
		if revert {
			expect, date = change.NewDate, change.OldDate
		}
		if err := s.requireDateUnchanged(ctx, projectID, change.EventID, expect); err != nil {
			_ = s.store.SetAIChangeStatus(ctx, change.ID, from, store.AIChangeSuperseded)
			return nil, "", err
		}
		warning, err := s.editor.SetEventDate(ctx, actorID, userID, projectID,
			change.EventID.String(), date)
		if err != nil {
			return nil, "", editErrorText(err)
		}
		return change, warning, nil
	}

	if revert {
		return s.reviveDeleted(ctx, actorID, userID, projectID, change)
	}
	// Детей проверяет редактор (ErrEventHasChildren): удалить главу вместе с
	// под-событиями — одно нажатие, которое уносит больше, чем видно на экране.
	warning, gone, err := s.editor.DeleteEvent(ctx, actorID, userID, projectID, change.EventID.String())
	if err != nil {
		return nil, "", editErrorText(err)
	}
	// Снимок сохраняем сразу после удаления и обязательно ДО перевода предложения в
	// applied: если запись не удалась, «Вернуть» будет нечем — и об этом честно
	// сказано в журнале, вместо тихой потери отмены.
	if gone != nil {
		raw, marshalErr := json.Marshal(gone)
		if marshalErr == nil {
			if saveErr := s.store.SetAIChangeFrame(ctx, change.ID, raw); saveErr != nil {
				s.logger.Warn("ai: не удалось сохранить снимок удалённого кадра — вернуть его не получится",
					"change", change.ID, "event", change.EventID, "err", saveErr)
			} else {
				change.Frame = raw
			}
		}
	}
	return change, warning, nil
}

// reviveDeleted возвращает кадр, удалённый по подтверждённому предложению.
//
// Здесь «Вернуть» — не восстановление текста в существующем кадре (его нет), а вставка
// кадра обратно в документ по снимку (ai_changes.frame, миграция 0017): прежний
// идентификатор, родитель, место в дереве, дата, вложения, фон и created_at.
func (s *Service) reviveDeleted(
	ctx context.Context, actorID, userID, projectID uuid.UUID, change *store.AIChange,
) (*store.AIChange, string, error) {
	if len(change.Frame) == 0 {
		// Предложения, применённые до миграции 0017, снимка не имеют. Врать «нельзя» без
		// причины нельзя тоже: причина есть, и она — в тексте отказа.
		return nil, "", errNoFrameSnapshot
	}
	var removed yjs.RemovedEvent
	if err := json.Unmarshal(change.Frame, &removed); err != nil {
		return nil, "", fmt.Errorf("снимок кадра повреждён: %w", err)
	}
	if removed.ID == "" {
		removed.ID = change.EventID.String()
	}
	// Заголовок и текст берём из Old*: это то, что видел человек, когда соглашался на
	// удаление. В снимке они тоже есть, но Old* — источник правды предложения.
	removed.Title = change.OldTitle
	removed.Body = change.OldBody

	warning, result, err := s.editor.ReviveEvent(ctx, actorID, userID, projectID, removed)
	if err != nil {
		return nil, "", editErrorText(err)
	}
	s.logger.Info("ai: удалённый кадр возвращён",
		"project", projectID, "user", userID, "event", change.EventID,
		"change", change.ID, "orphan", result.Orphan)
	return change, warning, nil
}

// errNoFrameSnapshot — у предложения нет снимка удалённого кадра.
var errNoFrameSnapshot = errors.New("у этого удаления нет снимка кадра: вернуть его " +
	"можно только из истории версий проекта")

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

// requireDateUnchanged проверяет, что дата кадра та же, что была в предложении.
//
// Тем же путём, что и сверка текста: читаем проекцию (`ListEvents`), а не часы. Проекция
// отстаёт от документа не больше чем на период сохранения комнаты (5 с) — этого достаточно,
// чтобы «человек успел поправить дату в другой вкладке» не затиралось молча. Кадр мог
// исчезнуть — тогда тоже отказ: применять правку некуда.
func (s *Service) requireDateUnchanged(
	ctx context.Context, projectID, eventID uuid.UUID, want string,
) error {
	rows, err := s.store.ListEvents(ctx, projectID)
	if err != nil {
		return err
	}
	for _, row := range rows {
		if row.ID != eventID {
			continue
		}
		current := ""
		if row.EventDate != nil {
			current = row.EventDate.Format("2006-01-02")
		}
		if current != want {
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
	case errors.Is(err, transfer.ErrEventExists):
		return errors.New("кадр с таким идентификатором уже есть в проекте: возвращать нечего")
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
	if kind == store.AIChangeUpdateDate {
		return "предложение даты сохранено и ждёт подтверждения человеком; дата пока НЕ изменена " +
			"и повторять вызов не нужно — скажи человеку, что он может применить правку в окне помощника"
	}
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
	switch kind {
	case store.AIChangeDeleteEvent:
		what = "удалить"
	case store.AIChangeUpdateDate:
		what = "перенести"
	case store.AIChangeUpdateSpan:
		what = "поправить фрагмент в"
	}
	return fmt.Sprintf("%s кадр «%s»", what, strings.TrimSpace(eventTitle))
}
