package ai

// tokens.go — сколько токенов стоит запрос и ответ.
//
// Зачем оценка, а не только счётчики провайдера. Провайдеры возвращают `usage` не
// всегда: в потоковом режиме OpenAI-совместимые серверы отдают счётчики только по
// запросу (`stream_options.include_usage`), а часть серверов на незнакомое поле
// отвечает ошибкой. Если бы мы считали расход только по `usage`, в этих случаях он
// молча оказывался бы нулевым — то есть бюджет выглядел бы неограниченным, и лимит
// не работал бы ровно там, где он нужен.
//
// Оценка нарочно грубая и СКЛОННА ЗАВЫШАТЬ:
//
//   - кириллица дороже латиницы: один токен — это примерно 2–3 символа против 4;
//     берём 3 символа на токен, чтобы не занизить расход;
//   - на каждое сообщение добавляем служебную надбавку (роль, разделители) — у
//     настоящих шаблонов чата она есть всегда;
//   - описания инструментов считаем целиком: они уходят в каждый запрос.
//
// Оценка никогда не заменяет настоящий счётчик: она нужна там, где счётчика нет.

import (
	"encoding/json"
	"unicode/utf8"
)

// charsPerToken — сколько символов приходится на один токен (см. выше).
const charsPerToken = 3

// messageOverheadTokens — служебная надбавка на одно сообщение (роль, разделители).
const messageOverheadTokens = 4

// toolOverheadTokens — служебная надбавка на один инструмент (обёртка JSON-схемы).
const toolOverheadTokens = 8

// EstimateTokens — примерная оценка числа токенов в тексте.
func EstimateTokens(text string) int {
	if text == "" {
		return 0
	}
	runes := utf8.RuneCountInString(text)
	// Округление вверх: дробный токен — всё равно токен.
	return (runes + charsPerToken - 1) / charsPerToken
}

// EstimateRequestTokens — примерная стоимость одного запроса к модели: все сообщения
// (правила, оглавление проекта, история, вопрос) плюс описания инструментов.
//
// Считается ДО запроса — по этой оценке видно, поместится ли он в контекст модели, и
// сколько он будет стоить.
func EstimateRequestTokens(req Request) int {
	total := 0
	for _, m := range req.Messages {
		total += EstimateTokens(m.Content) + messageOverheadTokens
		for _, call := range m.ToolCalls {
			total += EstimateTokens(call.Name) + estimateArguments(call.Arguments)
		}
	}
	for _, tool := range req.Tools {
		total += EstimateTokens(tool.Name) + EstimateTokens(tool.Description) +
			estimateArguments(tool.Parameters) + toolOverheadTokens
	}
	return total
}

// estimateArguments оценивает аргументы (или схему) вызова как JSON: точная форма нам
// не важна, важен порядок величины.
func estimateArguments(args map[string]any) int {
	if len(args) == 0 {
		return 0
	}
	raw, err := json.Marshal(args)
	if err != nil {
		return 0
	}
	return EstimateTokens(string(raw))
}
