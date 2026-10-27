package assistant

// entity_proposals.go — предложения помощника «заведите карточки мира и связи между ними»
// (0.77.0, миграция 0033): предложить, показать, применить, отклонить.
//
// Почему карточки не создаются сразу. Карточка — не правка одной сцены: она меняет весь проект
// (упоминания в тексте, хронологию, матрицу, граф связей), а неверное имя портит связи везде,
// где встречается. Поэтому помощник предлагает пачку, а создаёт её человек одной кнопкой — то
// же правило, что у правки кадра, и по той же причине (docs/entity-links.md, §3.3).
//
// Чего здесь НЕТ и почему:
//
//   - «Вернуть» (как у правки текста). Созданная карточка удаляется одной кнопкой в панели
//     связей, снимок для этого не нужен. Обещать отмену тем же механизмом значило бы завести
//     второй способ удаления, который однажды разойдётся с первым.
//   - Связей по идентификаторам. На момент предложения карточек нет, поэтому связи описаны
//     именами и разрешаются в id при применении. Это же позволяет предложить связь с карточкой,
//     которая в проекте уже есть, но в пачку не попала.
//
// Что видит человек, если что-то не сложилось. Применение не «всё или ничего»: занятое имя
// пропускается (карточка уже есть — это не ошибка), а неверное поле или неизвестный конец
// связи попадают в отчёт построчно. Человек должен видеть, что получилось, а не «не вышло».

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/google/uuid"

	"github.com/skyfraze/backend/internal/entities"
	"github.com/skyfraze/backend/internal/store"
)

// Пределы одного предложения. Почему такие: двенадцать карточек — это уже весь основной состав
// книги, и пачка больше похожа на «перепиши проект», чем на предложение. Связи ограничены
// отдельно, потому что двадцать карточек по двадцать связей — это четыреста пар, которые
// человек не проверит глазами, а подтверждение без проверки — не подтверждение.
const (
	maxProposedCards = 12
	maxProposedLinks = 24
)

// Ошибки применения предложения карточек.
var (
	// ErrEntityProposalEmpty — предложение без карточек: предлагать нечего.
	ErrEntityProposalEmpty = errors.New("в предложении нет карточек")
	// ErrEntityProposalTooMany — предложение больше предела.
	ErrEntityProposalTooMany = errors.New("в предложении слишком много карточек или связей")
)

// EntityProposalView — предложение в том виде, в каком его видит интерфейс.
type EntityProposalView struct {
	ID     uuid.UUID `json:"id"`
	Status string    `json:"status"`
	// Note — почему помощник это предлагает, его словами.
	Note  string               `json:"note"`
	Cards []store.ProposedCard `json:"cards"`
	Links []store.ProposedLink `json:"links"`
	// CreatedAt — чтобы интерфейс мог поставить «свежее» первым, не полагаясь на порядок.
	CreatedAt time.Time `json:"created_at"`
}

// ProposalItemError — что не получилось и почему, построчно.
type ProposalItemError struct {
	Name   string `json:"name"`
	Reason string `json:"reason"`
}

// EntityProposalResult — итог применения: что создано, что уже было, что не вышло.
//
// Разделение на три списка, а не «ok: true» — суть подтверждения: человек нажал «добавить» и
// должен увидеть, что именно появилось. «Занятое имя» попало в Existing, а не в ошибки: это
// нормальный исход («Анна уже есть — второй не надо»), а не сбой.
type EntityProposalResult struct {
	Created  []string            `json:"created"`
	Existing []string            `json:"existing"`
	Failed   []ProposalItemError `json:"failed"`
	// LinksCreated — «Аня → живёт на → Земля», словами: подпись принадлежит связи, и без
	// обоих концов строка читалась бы как половина.
	LinksCreated []string            `json:"links_created"`
	LinksSkipped []ProposalItemError `json:"links_skipped"`
}

// entityKindOptions — ключи и названия типов карточек проекта (0.81.0).
//
// Нужны инструменту: его `enum` должен совпадать с тем, что человек видит в панели «Связи».
// Ошибку чтения не считаем фатальной — помощник получит стартовые три типа: отказывать в работе
// из-за одного запроса было бы хуже.
func (s *Service) entityKindOptions(ctx context.Context, projectID uuid.UUID) ([]string, map[string]string) {
	if s.store == nil {
		return nil, nil
	}
	if err := s.store.EnsureEntityTypes(ctx, projectID); err != nil {
		s.logger.Warn("ai: типы карточек не прочитаны", "project", projectID, "err", err)
		return nil, nil
	}
	list, err := s.store.ListEntityTypes(ctx, projectID)
	if err != nil {
		s.logger.Warn("ai: типы карточек не прочитаны", "project", projectID, "err", err)
		return nil, nil
	}
	kinds := make([]string, 0, len(list))
	titles := make(map[string]string, len(list))
	for _, item := range list {
		kinds = append(kinds, item.Key)
		titles[item.Key] = item.Title
	}
	return kinds, titles
}

// EntityProposalDTO переводит запись в вид для интерфейса.
func EntityProposalDTO(p store.EntityProposal) EntityProposalView {
	cards := p.Cards
	if cards == nil {
		cards = []store.ProposedCard{}
	}
	links := p.Links
	if links == nil {
		links = []store.ProposedLink{}
	}
	return EntityProposalView{
		ID: p.ID, Status: p.Status, Note: p.Note,
		Cards: cards, Links: links, CreatedAt: p.CreatedAt,
	}
}

// ProposeEntities сохраняет предложение карточек.
//
// Проверка полей — здесь, а не только при применении: предложение, которое сервер заведомо не
// сможет применить, показывает человеку кнопку, которая не работает. Тексты ошибок уходят
// модели, поэтому они говорят, что именно поправить.
func (s *Service) ProposeEntities(
	ctx context.Context, userID, projectID uuid.UUID,
	cards []store.ProposedCard, links []store.ProposedLink, note string,
) (*store.EntityProposal, error) {
	if len(cards) == 0 {
		return nil, ErrEntityProposalEmpty
	}
	if len(cards) > maxProposedCards || len(links) > maxProposedLinks {
		return nil, ErrEntityProposalTooMany
	}
	// Вид обязан быть типом ЭТОГО проекта (0.81.0): модель видела enum, но полагаться на это
	// нельзя — предложение с чужим видом всё равно не применится, а узнать об этом человек
	// должен сразу, до подтверждения.
	kinds, _ := s.entityKindOptions(ctx, projectID)
	allowed := make(map[string]bool, len(kinds))
	for _, key := range kinds {
		allowed[key] = true
	}
	// Имена в пачке не должны повторяться: две «Анны» в одном предложении — это не две
	// карточки (уникальность имени в проекте), а путаница при применении связей.
	seen := make(map[string]bool, len(cards))
	cleaned := make([]store.ProposedCard, 0, len(cards))
	for _, card := range cards {
		card.Aliases = nonNilStrings(card.Aliases)
		description := card.Description
		entity, err := entities.PrepareCard(entities.Input{
			Kind: card.Kind, Name: card.Name,
			Aliases: &card.Aliases, Description: &description,
		})
		if err != nil {
			return nil, err
		}
		if len(allowed) > 0 && !allowed[entity.Kind] {
			return nil, fmt.Errorf("%w: вид «%s» не заведён в проекте — возьмите из list_entities или стартовые character/place/theme",
				entities.ErrInvalidEntity, entity.Kind)
		}
		key := strings.ToLower(entity.Name)
		if seen[key] {
			return nil, fmt.Errorf("%w: карточка «%s» в предложении повторяется", entities.ErrInvalidEntity, entity.Name)
		}
		seen[key] = true
		cleaned = append(cleaned, store.ProposedCard{
			Kind: entity.Kind, Name: entity.Name,
			Aliases: entity.Aliases, Description: entity.Description,
		})
	}
	for _, link := range links {
		if strings.TrimSpace(link.From) == "" || strings.TrimSpace(link.To) == "" {
			return nil, fmt.Errorf("%w: у связи должны быть обе карточки", entities.ErrInvalidEntity)
		}
		if strings.EqualFold(strings.TrimSpace(link.From), strings.TrimSpace(link.To)) {
			return nil, fmt.Errorf("%w: карточка не может быть связана сама с собой", entities.ErrInvalidEntity)
		}
		if err := entities.ValidateLinkLabel(link.Label); err != nil {
			return nil, err
		}
	}

	created, err := s.store.CreateEntityProposal(ctx, store.EntityProposal{
		ProjectID: projectID, UserID: userID,
		Note: strings.TrimSpace(note), Cards: cleaned, Links: links,
	})
	if err != nil {
		return nil, err
	}
	s.logger.Info("ai: предложены карточки мира",
		"project", projectID, "user", userID, "cards", len(created.Cards),
		"links", len(created.Links), "proposal", created.ID)
	return created, nil
}

// EntityProposals — предложения карточек, которые ждут решения этого человека.
func (s *Service) EntityProposals(
	ctx context.Context, userID, projectID uuid.UUID,
) ([]EntityProposalView, error) {
	rows, err := s.store.PendingEntityProposals(ctx, projectID, userID)
	if err != nil {
		return nil, err
	}
	out := make([]EntityProposalView, 0, len(rows))
	for _, row := range rows {
		out = append(out, EntityProposalDTO(row))
	}
	return out, nil
}

// ApplyEntityProposal создаёт карточки и связи из подтверждённого предложения.
//
// Порядок важен: сначала карточки, потом связи — иначе связывать будет нечего. Внутри шага
// ошибка одной карточки не отменяет остальные: человек подтвердил пачку, и получить «ничего не
// вышло» из-за одного длинного имени хуже, чем получить десять карточек и одну строку отчёта.
func (s *Service) ApplyEntityProposal(
	ctx context.Context, userID, projectID, proposalID uuid.UUID,
) (EntityProposalView, EntityProposalResult, error) {
	proposal, err := s.entityProposal(ctx, userID, projectID, proposalID)
	if err != nil {
		return EntityProposalView{}, EntityProposalResult{}, err
	}
	if s.worldWrite == nil {
		return EntityProposalView{}, EntityProposalResult{},
			errors.New("карточки мира недоступны на этом стенде")
	}
	result := EntityProposalResult{
		Created: []string{}, Existing: []string{}, Failed: []ProposalItemError{},
		LinksCreated: []string{}, LinksSkipped: []ProposalItemError{},
	}

	// Имена уже существующих карточек — регистр не различаем: уникальность в базе тоже по
	// lower(name), и «анна» находит «Анну».
	existing, err := s.world.ListEntities(ctx, userID, projectID)
	if err != nil {
		return EntityProposalView{}, result, err
	}
	byName := make(map[string]store.ProjectEntity, len(existing))
	for _, entity := range existing {
		byName[strings.ToLower(entity.Name)] = entity
	}

	for _, card := range proposal.Cards {
		key := strings.ToLower(card.Name)
		if _, ok := byName[key]; ok {
			result.Existing = append(result.Existing, card.Name)
			continue
		}
		aliases := nonNilStrings(card.Aliases)
		description := card.Description
		created, cErr := s.worldWrite.Create(ctx, userID, projectID, entities.Input{
			Kind: card.Kind, Name: card.Name,
			Aliases: &aliases, Description: &description,
		})
		if cErr != nil {
			// Имя заняли между чтением списка и вставкой (или оно занято вариантом регистра):
			// это не сбой, а тот же нормальный исход «уже есть».
			if errors.Is(cErr, store.ErrEntityExists) {
				result.Existing = append(result.Existing, card.Name)
				continue
			}
			result.Failed = append(result.Failed, ProposalItemError{
				Name: card.Name, Reason: entityErrorText(cErr),
			})
			continue
		}
		result.Created = append(result.Created, created.Name)
		byName[strings.ToLower(created.Name)] = *created
	}

	for _, link := range proposal.Links {
		from, okFrom := byName[strings.ToLower(strings.TrimSpace(link.From))]
		to, okTo := byName[strings.ToLower(strings.TrimSpace(link.To))]
		if !okFrom || !okTo {
			missing := link.From
			if okFrom {
				missing = link.To
			}
			result.LinksSkipped = append(result.LinksSkipped, ProposalItemError{
				Name: linkTitle(link), Reason: fmt.Sprintf("карточки «%s» нет в проекте", missing),
			})
			continue
		}
		if _, lErr := s.worldWrite.AddLink(ctx, userID, projectID, from.ID, to.ID, link.Label); lErr != nil {
			result.LinksSkipped = append(result.LinksSkipped, ProposalItemError{
				Name: linkTitle(link), Reason: entityErrorText(lErr),
			})
			continue
		}
		result.LinksCreated = append(result.LinksCreated, linkTitle(link))
	}

	// Состояние переводим ПОСЛЕ применения: если запись упадёт, предложение останется
	// ожидающим, и повторное «Добавить» не создаст карточки дважды — существующие уйдут в
	// «уже есть».
	if sErr := s.store.SetEntityProposalStatus(ctx, proposal.ID,
		store.EntityProposalPending, store.EntityProposalApplied); sErr != nil {
		s.logger.Warn("ai: не удалось обновить состояние предложения карточек",
			"proposal", proposal.ID, "err", sErr)
	}
	proposal.Status = store.EntityProposalApplied
	s.logger.Info("ai: предложение карточек применено",
		"project", projectID, "user", userID, "proposal", proposal.ID,
		"created", len(result.Created), "existing", len(result.Existing),
		"failed", len(result.Failed), "links", len(result.LinksCreated))
	return EntityProposalDTO(*proposal), result, nil
}

// DiscardEntityProposal отказывается от предложения: проект не меняется.
func (s *Service) DiscardEntityProposal(
	ctx context.Context, userID, projectID, proposalID uuid.UUID,
) error {
	proposal, err := s.entityProposal(ctx, userID, projectID, proposalID)
	if err != nil {
		return err
	}
	if err := s.store.SetEntityProposalStatus(ctx, proposal.ID,
		store.EntityProposalPending, store.EntityProposalDiscarded); err != nil {
		if errors.Is(err, store.ErrNotFound) {
			return ErrProposalNotFound
		}
		return err
	}
	return nil
}

// entityProposal читает ожидающее предложение, проверяя владельца.
//
// Чужое предложение — не «нет прав», а «это не ваше»: беседа личная, и её содержание не должно
// всплывать у соавтора.
func (s *Service) entityProposal(
	ctx context.Context, userID, projectID, proposalID uuid.UUID,
) (*store.EntityProposal, error) {
	proposal, err := s.store.EntityProposalByID(ctx, projectID, proposalID)
	if err != nil {
		if errors.Is(err, store.ErrNotFound) {
			return nil, ErrProposalNotFound
		}
		return nil, err
	}
	if proposal.UserID != userID {
		return nil, ErrProposalWrongUser
	}
	if proposal.Status != store.EntityProposalPending {
		return nil, ErrProposalNotFound
	}
	return proposal, nil
}

// entityErrorText переводит отказы карточек и связей в текст для человека.
//
// Отдельно от editErrorText: тот говорит про кадры и версии, и «кадр не найден» на карточку
// было бы неправдой.
func entityErrorText(err error) string {
	switch {
	case errors.Is(err, entities.ErrEntityExists):
		return "карточка с таким именем уже есть в проекте"
	case errors.Is(err, entities.ErrInvalidEntity):
		return strings.TrimPrefix(err.Error(), entities.ErrInvalidEntity.Error()+": ")
	default:
		return err.Error()
	}
}

// linkTitle — подпись связи для отчёта: «Аня → живёт на → Земля».
func linkTitle(link store.ProposedLink) string {
	return fmt.Sprintf("%s → %s → %s",
		strings.TrimSpace(link.From), strings.TrimSpace(link.Label), strings.TrimSpace(link.To))
}

// nonNilStrings — не nil, а пустой срез: `null` в JSON интерфейс читает как «поля нет», и
// карточка с nil-алиасами показалась бы сломанной.
func nonNilStrings(values []string) []string {
	if values == nil {
		return []string{}
	}
	return values
}
