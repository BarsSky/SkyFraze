package assistant_test

// entity_proposals_test.go — разбор аргументов propose_entities (0.77.0).
//
// Разбор структурный: имена, виды и подписи проверяет ProposeEntities теми же правилами, что и
// создание карточки. Здесь — то, что можно проверить без базы: «пустой список», «карточка без
// имени», «алиасы строкой вместо списка».

import (
	"strings"
	"testing"

	"github.com/skyfraze/backend/internal/assistant"
)

func TestParseEntityProposalReadsCardsAndLinks(t *testing.T) {
	args, err := assistant.ParseEntityProposal(map[string]any{
		"note": "  герои первой главы  ",
		"cards": []any{
			map[string]any{
				"kind": "character", "name": "  Анна  ",
				"aliases": []any{"Аня", "Анну"}, "description": "главная героиня",
			},
			map[string]any{"kind": "place", "name": "Земля"},
		},
		"links": []any{
			map[string]any{"from": "Анна", "to": "Земля", "label": "живёт на"},
		},
	})
	if err != nil {
		t.Fatalf("разбор: %v", err)
	}
	if len(args.Cards) != 2 || args.Cards[0].Name != "Анна" {
		t.Fatalf("карточки: %+v", args.Cards)
	}
	if strings.Join(args.Cards[0].Aliases, ",") != "Аня,Анну" {
		t.Errorf("алиасы: %+v", args.Cards[0].Aliases)
	}
	if args.Cards[1].Aliases == nil {
		t.Error("алиасы без списка должны быть пустым срезом, а не nil")
	}
	if len(args.Links) != 1 || args.Links[0].Label != "живёт на" {
		t.Fatalf("связи: %+v", args.Links)
	}
	if args.Note != "герои первой главы" {
		t.Errorf("пояснение: %q", args.Note)
	}
}

func TestParseEntityProposalRefusesBrokenArgs(t *testing.T) {
	cases := []struct {
		name string
		args map[string]any
		want string
	}{
		{"без карточек", map[string]any{}, "cards"},
		{"пустой список", map[string]any{"cards": []any{}}, "cards"},
		{"карточка не объект", map[string]any{"cards": []any{"Анна"}}, "объект"},
		{"карточка без имени", map[string]any{"cards": []any{
			map[string]any{"kind": "character"},
		}}, "имя"},
		{"связи не список", map[string]any{
			"cards": []any{map[string]any{"kind": "character", "name": "Анна"}},
			"links": "Анна → Земля",
		}, "links"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			_, err := assistant.ParseEntityProposal(tc.args)
			if err == nil {
				t.Fatalf("ожидалась ошибка с упоминанием %q", tc.want)
			}
			if !strings.Contains(err.Error(), tc.want) {
				t.Fatalf("текст ошибки: %q, ожидалось упоминание %q", err.Error(), tc.want)
			}
		})
	}
}

// Не-строки в алиасах пропускаются: модель иногда присылает числа или null в списке, и падать
// из-за этого незачем — мусор отсеет проверка алиасов.
func TestParseEntityProposalSkipsNonStringAliases(t *testing.T) {
	args, err := assistant.ParseEntityProposal(map[string]any{
		"cards": []any{map[string]any{
			"kind": "character", "name": "Анна",
			"aliases": []any{"Аня", 42, nil, "Анну"},
		}},
	})
	if err != nil {
		t.Fatalf("разбор: %v", err)
	}
	if strings.Join(args.Cards[0].Aliases, ",") != "Аня,Анну" {
		t.Fatalf("алиасы: %+v", args.Cards[0].Aliases)
	}
}
