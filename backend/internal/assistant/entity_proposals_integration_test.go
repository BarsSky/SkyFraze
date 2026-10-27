package assistant_test

// entity_proposals_integration_test.go — предложения карточек мира (0.77.0, миграция 0033).
//
// Что здесь важно проверить и почему именно так:
//
//   - модель НЕ создаёт карточки: после propose_entities в проекте нет ни одной — это главное
//     обещание возможности (карточка меняет весь проект, а не одну сцену);
//   - применяет человек, и связи разрешаются по ИМЕНАМ: на момент предложения идентификаторов
//     карточек ещё нет;
//   - занятое имя — не ошибка, а «уже есть»: иначе модель пришлось бы заставлять переписывать
//     пачку из-за карточки, которую человек завёл сам;
//   - негодная связь не отменяет карточки: человек подтвердил пачку, и получить «ничего не
//     вышло» из-за одного конца связи хуже, чем карточки и строку отчёта;
//   - чужое предложение применить нельзя: беседа личная.

import (
	"context"
	"errors"
	"strings"
	"testing"

	"github.com/google/uuid"

	"github.com/skyfraze/backend/internal/ai"
	"github.com/skyfraze/backend/internal/assistant"
	"github.com/skyfraze/backend/internal/entities"
	"github.com/skyfraze/backend/internal/store"
)

// worldEnv — окружение с подключёнными карточками мира: чтение и запись, как в бою (main.go).
//
// Отдельной функцией, а не правкой setup: у остальных тестов пакета карточек мира нет, и
// количество инструментов, предложенных модели, у них другое — если подключить карточки всем,
// тест про набор инструментов перестал бы проверять то, что проверяет.
func worldEnv(t *testing.T, replies ...ai.Reply) (*env, *entities.Service) {
	t.Helper()
	e := setup(t, replies...)
	entSvc := entities.New(e.st, e.proj)
	e.asst.UseEntities(entSvc)
	e.asst.UseEntityWriter(entSvc)
	return e, entSvc
}

// proposeCall — вызов propose_entities с двумя карточками и связью: один и тот же набор нужен
// почти всем тестам ниже.
func proposeCall(cards []any, links []any) ai.ToolCall {
	args := map[string]any{"note": "в главе появились новые герои", "cards": cards}
	if links != nil {
		args["links"] = links
	}
	return createCall(assistant.ToolProposeEntities, args)
}

func card(kind, name string, aliases ...string) map[string]any {
	out := map[string]any{"kind": kind, "name": name}
	if len(aliases) > 0 {
		list := make([]any, 0, len(aliases))
		for _, alias := range aliases {
			list = append(list, alias)
		}
		out["aliases"] = list
	}
	return out
}

func link(from, to, label string) map[string]any {
	return map[string]any{"from": from, "to": to, "label": label}
}

// Модель предлагает карточки — и проект остаётся прежним.
func TestEntityProposalDoesNotCreateCardsUntilApplied(t *testing.T) {
	e, entSvc := worldEnv(t,
		ai.Reply{ToolCalls: []ai.ToolCall{proposeCall(
			[]any{card("character", "Анна", "Аня", "Анну"), card("place", "Земля")},
			[]any{link("Анна", "Земля", "живёт на")},
		)}},
		ai.Reply{Content: "Предлагаю завести Анну и Землю."},
	)
	ctx := context.Background()
	owner := e.user(t, "owner@example.com")
	projectID, _, _ := e.seedProject(t, owner)

	turn, err := e.asst.Send(ctx, owner, projectID, uuid.Nil, "stub:stub-1", "Кто в главе?")
	if err != nil {
		t.Fatalf("send: %v", err)
	}
	if len(turn.EntityProposals) != 1 {
		t.Fatalf("предложений карточек в ответе: %d, ожидалось 1 (%+v)", len(turn.EntityProposals), turn)
	}
	if len(turn.Changes) != 0 {
		t.Fatalf("предложение попало в «изменения»: %+v", turn.Changes)
	}
	proposal := turn.EntityProposals[0]
	if len(proposal.Cards) != 2 || len(proposal.Links) != 1 {
		t.Fatalf("состав предложения: %+v", proposal)
	}
	if proposal.Cards[0].Name != "Анна" || len(proposal.Cards[0].Aliases) != 2 {
		t.Errorf("алиасы не сохранены: %+v", proposal.Cards[0])
	}
	if proposal.Note == "" {
		t.Error("пояснение «почему предлагаю» не сохранено")
	}

	// Проект НЕ изменился: ни карточек, ни связей.
	list, err := entSvc.ListEntities(ctx, owner, projectID)
	if err != nil {
		t.Fatalf("карточки: %v", err)
	}
	if len(list) != 0 {
		t.Fatalf("карточки созданы без подтверждения: %+v", list)
	}
	pending, err := e.asst.EntityProposals(ctx, owner, projectID)
	if err != nil {
		t.Fatalf("ожидающие предложения: %v", err)
	}
	if len(pending) != 1 || pending[0].ID != proposal.ID {
		t.Fatalf("предложение не ждёт решения: %+v", pending)
	}
}

// Применение создаёт карточки и связь, а повторное нажатие ничего не делает дважды.
func TestEntityProposalApplyCreatesCardsAndLinks(t *testing.T) {
	e, entSvc := worldEnv(t,
		ai.Reply{ToolCalls: []ai.ToolCall{proposeCall(
			[]any{card("character", "Анна", "Аня"), card("place", "Земля")},
			[]any{link("Анна", "Земля", "живёт на")},
		)}},
		ai.Reply{Content: "Готово."},
	)
	ctx := context.Background()
	owner := e.user(t, "owner@example.com")
	projectID, _, _ := e.seedProject(t, owner)
	turn, err := e.asst.Send(ctx, owner, projectID, uuid.Nil, "stub:stub-1", "Кто в главе?")
	if err != nil {
		t.Fatalf("send: %v", err)
	}
	proposal := turn.EntityProposals[0]

	applied, result, err := e.asst.ApplyEntityProposal(ctx, owner, projectID, proposal.ID)
	if err != nil {
		t.Fatalf("применение: %v", err)
	}
	if applied.Status != "applied" {
		t.Errorf("состояние предложения: %q", applied.Status)
	}
	if strings.Join(result.Created, ",") != "Анна,Земля" {
		t.Fatalf("создано: %+v", result.Created)
	}
	if len(result.Existing) != 0 || len(result.Failed) != 0 {
		t.Errorf("лишние строки отчёта: %+v", result)
	}
	if strings.Join(result.LinksCreated, ",") != "Анна → живёт на → Земля" {
		t.Fatalf("связи: %+v", result.LinksCreated)
	}

	list, err := entSvc.ListEntities(ctx, owner, projectID)
	if err != nil {
		t.Fatalf("карточки: %v", err)
	}
	if len(list) != 2 {
		t.Fatalf("карточек в проекте: %d, ожидалось 2", len(list))
	}
	var anna uuid.UUID
	for _, item := range list {
		if item.Name == "Анна" {
			anna = item.ID
			if strings.Join(item.Aliases, ",") != "Аня" {
				t.Errorf("алиасы созданной карточки: %+v", item.Aliases)
			}
		}
	}
	links, err := entSvc.Links(ctx, owner, projectID)
	if err != nil {
		t.Fatalf("связи: %v", err)
	}
	if len(links) != 1 || links[0].FromEntity != anna || links[0].Label != "живёт на" {
		t.Fatalf("связь после применения: %+v", links)
	}

	// Решённое предложение больше не ждёт и повторно не применяется.
	pending, err := e.asst.EntityProposals(ctx, owner, projectID)
	if err != nil {
		t.Fatalf("ожидающие: %v", err)
	}
	if len(pending) != 0 {
		t.Fatalf("применённое предложение осталось в ожидающих: %+v", pending)
	}
	if _, _, err := e.asst.ApplyEntityProposal(ctx, owner, projectID, proposal.ID); !errors.Is(err, assistant.ErrProposalNotFound) {
		t.Fatalf("повторное применение должно быть отвергнуто, получено %v", err)
	}
	if again, _ := entSvc.ListEntities(ctx, owner, projectID); len(again) != 2 {
		t.Fatalf("повторное применение создало карточки ещё раз: %d", len(again))
	}
}

// Занятое имя — не ошибка: карточка уже есть, второй такой не нужно.
func TestEntityProposalExistingNameIsReportedNotFailed(t *testing.T) {
	e, entSvc := worldEnv(t,
		ai.Reply{ToolCalls: []ai.ToolCall{proposeCall(
			[]any{card("character", "Анна"), card("place", "Земля")}, nil,
		)}},
		ai.Reply{Content: "Готово."},
	)
	ctx := context.Background()
	owner := e.user(t, "owner@example.com")
	projectID, _, _ := e.seedProject(t, owner)
	// Человек завёл «Анну» сам, пока помощник думал.
	if _, err := entSvc.Create(ctx, owner, projectID, entities.Input{Kind: "character", Name: "Анна"}); err != nil {
		t.Fatalf("карточка: %v", err)
	}
	turn, err := e.asst.Send(ctx, owner, projectID, uuid.Nil, "stub:stub-1", "Кто в главе?")
	if err != nil {
		t.Fatalf("send: %v", err)
	}

	_, result, err := e.asst.ApplyEntityProposal(ctx, owner, projectID, turn.EntityProposals[0].ID)
	if err != nil {
		t.Fatalf("применение: %v", err)
	}
	if strings.Join(result.Existing, ",") != "Анна" {
		t.Fatalf("«уже есть»: %+v", result.Existing)
	}
	if strings.Join(result.Created, ",") != "Земля" {
		t.Fatalf("создано: %+v", result.Created)
	}
	if len(result.Failed) != 0 {
		t.Errorf("занятое имя попало в ошибки: %+v", result.Failed)
	}
}

// Связь с карточкой, которой нет ни в пачке, ни в проекте, пропускается с причиной —
// остальные карточки при этом создаются.
func TestEntityProposalUnknownLinkTargetIsSkipped(t *testing.T) {
	e, entSvc := worldEnv(t,
		ai.Reply{ToolCalls: []ai.ToolCall{proposeCall(
			[]any{card("character", "Анна")},
			[]any{link("Анна", "Марс", "летит на")},
		)}},
		ai.Reply{Content: "Готово."},
	)
	ctx := context.Background()
	owner := e.user(t, "owner@example.com")
	projectID, _, _ := e.seedProject(t, owner)
	turn, err := e.asst.Send(ctx, owner, projectID, uuid.Nil, "stub:stub-1", "Кто в главе?")
	if err != nil {
		t.Fatalf("send: %v", err)
	}

	_, result, err := e.asst.ApplyEntityProposal(ctx, owner, projectID, turn.EntityProposals[0].ID)
	if err != nil {
		t.Fatalf("применение: %v", err)
	}
	if strings.Join(result.Created, ",") != "Анна" {
		t.Fatalf("карточка не создана из-за связи: %+v", result.Created)
	}
	if len(result.LinksCreated) != 0 {
		t.Fatalf("связь с несуществующей карточкой создана: %+v", result.LinksCreated)
	}
	if len(result.LinksSkipped) != 1 || !strings.Contains(result.LinksSkipped[0].Reason, "Марс") {
		t.Fatalf("причина пропуска связи: %+v", result.LinksSkipped)
	}
	list, _ := entSvc.ListEntities(ctx, owner, projectID)
	if len(list) != 1 {
		t.Fatalf("карточек: %d, ожидалась 1", len(list))
	}
}

// Отказ от предложения ничего не создаёт.
func TestEntityProposalDiscard(t *testing.T) {
	e, entSvc := worldEnv(t,
		ai.Reply{ToolCalls: []ai.ToolCall{proposeCall([]any{card("character", "Анна")}, nil)}},
		ai.Reply{Content: "Готово."},
	)
	ctx := context.Background()
	owner := e.user(t, "owner@example.com")
	projectID, _, _ := e.seedProject(t, owner)
	turn, err := e.asst.Send(ctx, owner, projectID, uuid.Nil, "stub:stub-1", "Кто в главе?")
	if err != nil {
		t.Fatalf("send: %v", err)
	}

	if err := e.asst.DiscardEntityProposal(ctx, owner, projectID, turn.EntityProposals[0].ID); err != nil {
		t.Fatalf("отказ: %v", err)
	}
	pending, err := e.asst.EntityProposals(ctx, owner, projectID)
	if err != nil {
		t.Fatalf("ожидающие: %v", err)
	}
	if len(pending) != 0 {
		t.Fatalf("отклонённое предложение осталось: %+v", pending)
	}
	list, _ := entSvc.ListEntities(ctx, owner, projectID)
	if len(list) != 0 {
		t.Fatalf("отказ создал карточки: %+v", list)
	}
}

// Чужое предложение применить нельзя: беседа, из которой оно пришло, — личная.
func TestEntityProposalIsPersonal(t *testing.T) {
	e, _ := worldEnv(t,
		ai.Reply{ToolCalls: []ai.ToolCall{proposeCall([]any{card("character", "Анна")}, nil)}},
		ai.Reply{Content: "Готово."},
	)
	ctx := context.Background()
	owner := e.user(t, "owner@example.com")
	other := e.user(t, "other@example.com")
	projectID, _, _ := e.seedProject(t, owner)
	if err := e.st.AddMembership(ctx, projectID, other, store.RoleEditor); err != nil {
		t.Fatalf("участие: %v", err)
	}
	turn, err := e.asst.Send(ctx, owner, projectID, uuid.Nil, "stub:stub-1", "Кто в главе?")
	if err != nil {
		t.Fatalf("send: %v", err)
	}

	if _, _, err := e.asst.ApplyEntityProposal(ctx, other, projectID, turn.EntityProposals[0].ID); !errors.Is(err, assistant.ErrProposalWrongUser) {
		t.Fatalf("чужое предложение должно быть отвергнуто, получено %v", err)
	}
	if _, _, err := e.asst.ApplyEntityProposal(ctx, owner, projectID, uuid.New()); !errors.Is(err, assistant.ErrProposalNotFound) {
		t.Fatalf("несуществующее предложение: %v", err)
	}
}

// Негодное имя отвергается СРАЗУ, а не при подтверждении: предложение, которое сервер заведомо
// не применит, показывает человеку кнопку, которая не работает.
func TestEntityProposalRejectsInvalidCardAtProposeTime(t *testing.T) {
	e, _ := worldEnv(t,
		ai.Reply{ToolCalls: []ai.ToolCall{proposeCall([]any{card("character", "Я")}, nil)}},
		ai.Reply{Content: "Поправлю."},
	)
	ctx := context.Background()
	owner := e.user(t, "owner@example.com")
	projectID, _, _ := e.seedProject(t, owner)

	turn, err := e.asst.Send(ctx, owner, projectID, uuid.Nil, "stub:stub-1", "Кто в главе?")
	if err != nil {
		t.Fatalf("send: %v", err)
	}
	if len(turn.EntityProposals) != 0 {
		t.Fatalf("предложение с именем в один знак сохранено: %+v", turn.EntityProposals)
	}
	refused := false
	for _, call := range turn.Calls {
		if call.Name == assistant.ToolProposeEntities && !call.OK && strings.Contains(call.Error, "имя от 2") {
			refused = true
		}
	}
	if !refused {
		t.Fatalf("отказа с объяснением про длину имени нет: %+v", turn.Calls)
	}
}

// Вид карточки обязан быть типом ЭТОГО проекта (0.81.0): модель видела enum, но полагаться на
// это нельзя — «дракон» без заведённого типа не должен доехать до кнопки «Добавить».
func TestEntityProposalRejectsForeignKind(t *testing.T) {
	e, _ := worldEnv(t,
		ai.Reply{ToolCalls: []ai.ToolCall{proposeCall([]any{card("dragon", "Смауг")}, nil)}},
		ai.Reply{Content: "Понял, возьму тип из проекта."},
	)
	ctx := context.Background()
	owner := e.user(t, "owner@example.com")
	projectID, _, _ := e.seedProject(t, owner)

	turn, err := e.asst.Send(ctx, owner, projectID, uuid.Nil, "stub:stub-1", "Кто в главе?")
	if err != nil {
		t.Fatalf("send: %v", err)
	}
	if len(turn.EntityProposals) != 0 {
		t.Fatalf("предложение с чужим видом сохранено: %+v", turn.EntityProposals)
	}
	refused := false
	for _, call := range turn.Calls {
		if call.Name == assistant.ToolProposeEntities && !call.OK && strings.Contains(call.Error, "не заведён") {
			refused = true
		}
	}
	if !refused {
		t.Fatalf("отказа с объяснением про вид нет: %+v", turn.Calls)
	}
}
