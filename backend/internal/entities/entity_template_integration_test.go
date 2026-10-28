package entities_test

// entity_template_integration_test.go — заготовка карточки применяется при СОЗДАНИИ (0.92.2).
//
// До 0.92.2 заготовку типа (описание с `{{name}}` и алиасы) подставляла только форма в
// интерфейсе. Карточка, созданная помощником (`propose_entities`) или через API, оставалась
// пустой — тип «Порт» с описанием «{{name}} — порт…» давал человеку одно, а помощнику другое.
// Теперь правило одно и живёт на сервере: заготовка заполняет ТОЛЬКО пустые поля, присланное
// значение всегда сильнее.

import (
	"context"
	"testing"

	"github.com/skyfraze/backend/internal/entities"
	"github.com/skyfraze/backend/internal/store"
)

func TestCreateEntityAppliesCardTemplate(t *testing.T) {
	e := setupEntities(t)
	ctx := context.Background()

	port, err := e.svc.CreateType(ctx, e.owner, e.project, "Порт", "⚓", "", store.EntityCardTemplate{
		Description: "{{name}} — порт на северном берегу.",
		// «П» короче двух знаков, «ГАВАНЬ» — дубль «гавань»: оба отбрасываются, а не валят создание.
		Aliases: []string{"гавань", "П", "ГАВАНЬ"},
	})
	if err != nil {
		t.Fatalf("тип с заготовкой: %v", err)
	}

	// 1. Чего не прислали — берётся из заготовки, `{{name}}` подставлен.
	card, err := e.svc.Create(ctx, e.owner, e.project, entities.Input{Kind: port.Key, Name: "Туман"})
	if err != nil {
		t.Fatalf("карточка: %v", err)
	}
	if card.Description != "Туман — порт на северном берегу." {
		t.Fatalf("описание из заготовки: %q", card.Description)
	}
	if len(card.Aliases) != 1 || card.Aliases[0] != "гавань" {
		t.Fatalf("алиасы из заготовки: %+v", card.Aliases)
	}

	// 2. Присланное сильнее заготовки.
	own := "Свой текст."
	ownAliases := []string{"ветерок"}
	explicit, err := e.svc.Create(ctx, e.owner, e.project, entities.Input{
		Kind: port.Key, Name: "Ветер", Description: &own, Aliases: &ownAliases,
	})
	if err != nil {
		t.Fatalf("карточка с явными полями: %v", err)
	}
	if explicit.Description != own || len(explicit.Aliases) != 1 || explicit.Aliases[0] != "ветерок" {
		t.Fatalf("явные поля перезаписаны заготовкой: %+v", explicit)
	}

	// 3. Пустые строки (так присылает помощник: указатели есть, значения пустые) — заготовка
	// применяется: «пусто» и «не прислали» для заготовки одно и то же.
	empty := ""
	noAliases := []string{}
	quiet, err := e.svc.Create(ctx, e.owner, e.project, entities.Input{
		Kind: port.Key, Name: "Штиль", Description: &empty, Aliases: &noAliases,
	})
	if err != nil {
		t.Fatalf("карточка с пустыми полями: %v", err)
	}
	if quiet.Description != "Штиль — порт на северном берегу." || len(quiet.Aliases) != 1 {
		t.Fatalf("пустые поля не заполнены заготовкой: %+v", quiet)
	}
}

// Длинная заготовка не должна ломать создание карточки: имя подставляется в текст, а пределы
// описания проверяются как у обычного поля.
func TestCreateEntityTemplateStaysWithinLimits(t *testing.T) {
	e := setupEntities(t)
	ctx := context.Background()
	// Заготовка на пределе плюс имя — вместе больше предела описания карточки.
	long := ""
	for len([]rune(long)) < 590 {
		long += "Слово "
	}
	kind, err := e.svc.CreateType(ctx, e.owner, e.project, "Гора", "", "", store.EntityCardTemplate{
		Description: long + "{{name}}.",
	})
	if err != nil {
		t.Fatalf("тип: %v", err)
	}
	card, err := e.svc.Create(ctx, e.owner, e.project, entities.Input{Kind: kind.Key, Name: "Пик"})
	if err != nil {
		t.Fatalf("карточка с длинной заготовкой: %v", err)
	}
	if runes := []rune(card.Description); len(runes) > 600 {
		t.Fatalf("описание длиннее предела: %d знаков", len(runes))
	}
}
