package ai_test

// tokens_test.go — оценка расхода токенов.
//
// Оценка нужна там, где провайдер счётчиков не прислал (в потоке это обычное дело).
// Проверяем главное её свойство: она ЗАВЫШАЕТ, а не занижает — иначе предел расхода
// пропускал бы больше, чем человек потратил на самом деле.

import (
	"strings"
	"testing"

	"github.com/skyfraze/backend/internal/ai"
)

func TestEstimateTokensGrowsWithText(t *testing.T) {
	if got := ai.EstimateTokens(""); got != 0 {
		t.Fatalf("пустой текст: %d", got)
	}
	short := ai.EstimateTokens("Маяк")
	long := ai.EstimateTokens(strings.Repeat("Маяк ", 100))
	if short <= 0 || long <= short {
		t.Fatalf("оценка не растёт: %d и %d", short, long)
	}
	// Округление вверх: «одна руна — один токен», а не ноль.
	if got := ai.EstimateTokens("я"); got != 1 {
		t.Fatalf("одна руна: %d", got)
	}
}

func TestEstimateTokensCountsRunesNotBytes(t *testing.T) {
	// Кириллица в UTF-8 занимает два байта на символ: если считать байты, оценка
	// завысилась бы вдвое (это терпимо), но если считать «байты/4» — занизилась бы
	// (а это уже пропущенный расход).
	cyrillic := ai.EstimateTokens(strings.Repeat("а", 30)) // 30 рун, 60 байт
	if cyrillic != 10 {
		t.Fatalf("30 рун кириллицы: %d, ожидалось 10", cyrillic)
	}
	// Тот же текст в латинице оценивается так же: мы нарочно не различаем алфавиты,
	// а берём худший случай.
	if latin := ai.EstimateTokens(strings.Repeat("a", 30)); latin != cyrillic {
		t.Fatalf("латиница %d, кириллица %d — оценка должна быть одинаковой", latin, cyrillic)
	}
}

func TestEstimateRequestTokensCountsMessagesAndTools(t *testing.T) {
	base := ai.EstimateRequestTokens(ai.Request{
		Messages: []ai.Message{{Role: "user", Content: strings.Repeat("а", 300)}},
	})
	// 300 рун ≈ 100 токенов плюс надбавка на сообщение.
	if base < 100 {
		t.Fatalf("оценка запроса занижена: %d", base)
	}

	withTools := ai.EstimateRequestTokens(ai.Request{
		Messages: []ai.Message{{Role: "user", Content: strings.Repeat("а", 300)}},
		Tools: []ai.ToolDef{{
			Name:        "create_chapter",
			Description: strings.Repeat("описание ", 20),
			Parameters:  map[string]any{"type": "object", "properties": map[string]any{"title": "строка"}},
		}},
	})
	// Описания инструментов уходят в КАЖДЫЙ запрос — их нельзя не считать.
	if withTools <= base {
		t.Fatalf("инструменты не учтены: %d против %d", withTools, base)
	}
}
