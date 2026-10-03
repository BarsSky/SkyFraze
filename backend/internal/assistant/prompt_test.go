package assistant

// prompt_test.go — что правила говорят модели о её возможностях.
//
// Это внутренний тест (не _test пакета): проверяем текст, который уходит модели, а он
// собирается неэкспортируемой функцией. Проверяем именно ЧЕСТНОСТЬ текста: если картинок
// нет, правила не должны о них обещать, а если текста нет — модель должна знать, что
// кадры создавать нельзя.

import (
	"strings"
	"testing"

	"github.com/skyfraze/backend/internal/store"
)

func TestCapabilityBlockTellsTheTruth(t *testing.T) {
	cases := []struct {
		name     string
		caps     Capabilities
		mustHave []string
		mustNot  []string
	}{
		{
			name: "текст есть, картинок нет",
			caps: Capabilities{
				Text: true, Images: false, Generation: store.GenerationAuto,
				ImageNote: "генератор изображений не настроен (AI_IMAGE_URL)",
			},
			mustHave: []string{"текст: да", "картинки: НЕТ", "не настроен", "auto"},
			mustNot:  []string{"картинки: да"},
		},
		{
			name: "оба доступны, задан стиль",
			caps: Capabilities{
				Text: true, Images: true, Generation: store.GenerationBoth,
				ImageStyle: "акварель, тёплый свет",
			},
			mustHave: []string{"текст: да", "картинки: да", "акварель, тёплый свет", "оба"},
		},
		{
			name: "только картинки: текст запрещён",
			caps: Capabilities{
				Text: false, Images: true, Generation: store.GenerationImages,
			},
			mustHave: []string{"текст: НЕТ", "только картинки"},
			mustNot:  []string{"текст: да"},
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			block := tc.caps.promptBlock()
			for _, want := range tc.mustHave {
				if !strings.Contains(block, want) {
					t.Errorf("в правилах нет %q:\n%s", want, block)
				}
			}
			for _, unwanted := range tc.mustNot {
				if strings.Contains(block, unwanted) {
					t.Errorf("в правилах есть лишнее %q:\n%s", unwanted, block)
				}
			}
		})
	}
}

func TestSystemPromptCarriesCapabilitiesAndRole(t *testing.T) {
	project := &store.Project{Title: "Маяк"}
	persona := Persona{
		Name: "Нестор", RoleTitle: "Летописец", RoleHint: "следит за датами",
		RoleRules: "Держи хронологию.", Instructions: "Без спойлеров.",
	}
	caps := Capabilities{
		Text: true, Images: false, Generation: store.GenerationText,
		ImageNote: "владелец проекта выбрал режим «только текст»",
	}
	prompt := systemPrompt(project, persona, 7, caps)

	for _, want := range []string{
		"Нестор", "Маяк", "Летописец", "Держи хронологию.", "Без спойлеров.",
		"текст: да", "картинки: НЕТ", "только текст", "больше 7 кадров",
		"list_events", "create_chapter", "create_sub_event",
	} {
		if !strings.Contains(prompt, want) {
			t.Errorf("в правилах нет %q", want)
		}
	}
	// Инструмента генерации в этой версии нет — и правила не должны его обещать.
	if strings.Contains(prompt, "generate_image") {
		t.Error("правила обещают инструмент, которого нет")
	}
}
