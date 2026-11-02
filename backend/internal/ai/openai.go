package ai

// openai.go — провайдеры, совместимые с OpenAI API.
//
// Один клиент на всех: OpenRouter, Groq, Google AI Studio (у него есть
// OpenAI-совместимый слой), OpenAI. Различия — только в базовом адресе и в том, как
// узнать список моделей, поэтому разбираем ответы терпимо: где-то `data[].id`, где-то
// ещё и цены (у OpenRouter — по ним и понимаем, что модель бесплатная).

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"sort"
	"strings"
	"time"
)

type openAIClient struct {
	provider Provider
	key      string
	client   *http.Client
}

func newOpenAI(p Provider, key string, timeout time.Duration) *openAIClient {
	return &openAIClient{provider: p, key: strings.TrimSpace(key), client: &http.Client{Timeout: timeout}}
}

// openAIModels — ответ GET /models. Поля цены есть только у OpenRouter; остальные
// игнорируются.
type openAIModels struct {
	Data []struct {
		ID      string `json:"id"`
		Name    string `json:"name"`
		Context int    `json:"context_length"`
		Pricing *struct {
			Prompt     string `json:"prompt"`
			Completion string `json:"completion"`
		} `json:"pricing"`
		// SupportedParameters — у OpenRouter тут перечислены возможности модели;
		// 'tools' означает поддержку инструментов.
		SupportedParameters []string `json:"supported_parameters"`
		Architecture        *struct {
			InputModalities []string `json:"input_modalities"`
		} `json:"architecture"`
	} `json:"data"`
	Error *openAIError `json:"error"`
}

// ListModels спрашивает у провайдера список моделей с этим ключом.
//
// Бесплатность считаем по цене, когда она есть (OpenRouter): нулевая цена промпта и
// ответа — бесплатная модель. Если цен нет (Groq, Google, OpenAI), верим
// FreeByDefault: у Groq и Google тариф бесплатный, у OpenAI — нет.
func (c *openAIClient) ListModels(ctx context.Context) ([]Model, error) {
	var out openAIModels
	if err := c.get(ctx, "/models", &out); err != nil {
		return nil, err
	}
	if out.Error != nil {
		return nil, fmt.Errorf("%w: %s", ErrUnavailable, out.Error.Message)
	}
	models := make([]Model, 0, len(out.Data))
	for _, m := range out.Data {
		free := c.provider.FreeByDefault
		if m.Pricing != nil {
			free = isZeroPrice(m.Pricing.Prompt) && isZeroPrice(m.Pricing.Completion)
		}
		title := m.ID
		if m.Name != "" {
			title = m.Name
		}
		models = append(models, Model{
			ID:       m.ID,
			Ref:      c.provider.ID + ":" + m.ID,
			Provider: c.provider.ID,
			Title:    title,
			Free:     free,
			// Локальность — свойство провайдера: свой сервер (llama.cpp, vLLM) считает
			// на своей машине, облачные — нет. Модели облачных сервисов локальными не
			// бывают никогда.
			Local:     c.provider.Local,
			Tools:     supportsParameter(m.SupportedParameters, "tools"),
			ContextKB: m.Context / 1024,
			// Зрение: сначала метаданные (OpenRouter перечисляет модальности входа),
			// если их нет — по имени модели (см. vision.go).
			Vision: (m.Architecture != nil && supportsVisionModality(m.Architecture.InputModalities)) ||
				looksLikeVisionModel(m.ID),
		})
	}
	return models, nil
}

// isZeroPrice — цена вида "0" или "0.000000" считается нулевой.
func isZeroPrice(v string) bool {
	v = strings.TrimSpace(v)
	if v == "" {
		return false
	}
	for _, r := range v {
		if r != '0' && r != '.' {
			return false
		}
	}
	return true
}

// supportsParameter — есть ли возможность в списке (пустой список = не знаем, не
// берёмся судить, инструменты передаём: пусть модель сама скажет, что не умеет).
func supportsParameter(list []string, want string) bool {
	if len(list) == 0 {
		return true
	}
	for _, item := range list {
		if item == want {
			return true
		}
	}
	return false
}

type openAIChatRequest struct {
	Model       string          `json:"model"`
	Messages    []openAIMessage `json:"messages"`
	Tools       []openAITool    `json:"tools,omitempty"`
	Temperature float64         `json:"temperature,omitempty"`
	// MaxTokens — предел ответа. Без него «думающая» модель тратит бюджет сервера на
	// reasoning_content и возвращает finish_reason=length без текста (0.141.0).
	MaxTokens int  `json:"max_tokens,omitempty"`
	Stream    bool `json:"stream"`
}

type openAIMessage struct {
	Role string `json:"role"`
	// Content — строка ИЛИ массив частей (текст + картинки). Тип `any`, потому что
	// этой же структурой разбирается ОТВЕТ сервера: у части серверов контент ответа
	// тоже приходит массивом частей, и жёсткая строка ломала бы разбор.
	Content    any              `json:"content"`
	ToolCalls  []openAIToolCall `json:"tool_calls,omitempty"`
	ToolCallID string           `json:"tool_call_id,omitempty"`
	Name       string           `json:"name,omitempty"`
}

// openAIContentPart — часть контента сообщения: текст или картинка.
type openAIContentPart struct {
	Type     string `json:"type"`
	Text     string `json:"text,omitempty"`
	ImageURL *struct {
		URL string `json:"url"`
	} `json:"image_url,omitempty"`
}

// contentFor собирает контент сообщения: строку, если картинок нет, и массив частей,
// если есть (стандартная форма OpenAI — сначала текст, потом картинки).
//
// Строкой, а не массивом, когда картинок нет намеренно: часть серверов (и старых
// версий llama.cpp) массив частей не принимает, и ломать им обычный чат незачем.
func contentFor(text string, images []string) any {
	if len(images) == 0 {
		return text
	}
	parts := make([]openAIContentPart, 0, len(images)+1)
	if strings.TrimSpace(text) != "" {
		parts = append(parts, openAIContentPart{Type: "text", Text: text})
	}
	for _, image := range images {
		part := openAIContentPart{Type: "image_url"}
		// data URL уходит как есть: OpenAI-совместимые серверы принимают картинку
		// именно в таком виде.
		part.ImageURL = &struct {
			URL string `json:"url"`
		}{URL: image}
		parts = append(parts, part)
	}
	return parts
}

// textOf достаёт текст из контента ответа: обычно это строка, но некоторые серверы
// отдают массив частей.
func textOf(content any) string {
	switch value := content.(type) {
	case string:
		return value
	case []any:
		var out strings.Builder
		for _, item := range value {
			part, ok := item.(map[string]any)
			if !ok {
				continue
			}
			if text, ok := part["text"].(string); ok {
				out.WriteString(text)
			}
		}
		return out.String()
	default:
		return ""
	}
}

type openAITool struct {
	Type     string          `json:"type"`
	Function openAIToolBrief `json:"function"`
}

type openAIToolBrief struct {
	Name        string         `json:"name"`
	Description string         `json:"description"`
	Parameters  map[string]any `json:"parameters"`
}

type openAIToolCall struct {
	ID       string `json:"id"`
	Type     string `json:"type"`
	Function struct {
		Name string `json:"name"`
		// Arguments у OpenAI — строка с JSON, а не объект: разбираем отдельно.
		Arguments string `json:"arguments"`
	} `json:"function"`
}

type openAIChatResponse struct {
	Model   string `json:"model"`
	Choices []struct {
		Message      openAIMessage `json:"message"`
		FinishReason string        `json:"finish_reason"`
	} `json:"choices"`
	Usage struct {
		PromptTokens     int `json:"prompt_tokens"`
		CompletionTokens int `json:"completion_tokens"`
	} `json:"usage"`
	Error *openAIError `json:"error"`
}

func (c *openAIClient) Chat(ctx context.Context, req Request) (Reply, error) {
	body := c.chatBody(req)
	body.Stream = false

	var out openAIChatResponse
	if err := c.post(ctx, "/chat/completions", body, &out); err != nil {
		return Reply{}, err
	}
	if out.Error != nil {
		return Reply{}, fmt.Errorf("%w: %s", ErrUnavailable, out.Error.Message)
	}
	if len(out.Choices) == 0 {
		return Reply{}, fmt.Errorf("%w: провайдер вернул пустой ответ", ErrUnavailable)
	}
	choice := out.Choices[0]
	reply := Reply{
		Content:      textOf(choice.Message.Content),
		Model:        firstNonEmpty(out.Model, req.Model),
		TokensIn:     out.Usage.PromptTokens,
		TokensOut:    out.Usage.CompletionTokens,
		FinishReason: choice.FinishReason,
	}
	for i, call := range choice.Message.ToolCalls {
		args := map[string]any{}
		if strings.TrimSpace(call.Function.Arguments) != "" {
			if err := json.Unmarshal([]byte(call.Function.Arguments), &args); err != nil {
				// Аргументы не разобрались — это ошибка модели, а не наша: сообщаем
				// вызывающему как вызов с пустыми аргументами, и валидация его отвергнет.
				args = map[string]any{"_raw": call.Function.Arguments}
			}
		}
		id := call.ID
		if id == "" {
			id = fmt.Sprintf("%s-%d-%s", c.provider.ID, i, call.Function.Name)
		}
		reply.ToolCalls = append(reply.ToolCalls, ToolCall{ID: id, Name: call.Function.Name, Arguments: args})
	}
	var warned bool
	reply.Content, warned = stripProviderWarning(reply.Content)
	if err := thinkingBudgetError(reply, req, warned); err != nil {
		return Reply{}, err
	}
	return reply, nil
}

// thinkingBudgetError — «модель ответила, но ответа нет» переводим в понятную ошибку (0.141.0).
//
// «Думающие» модели (gemma, qwen3 и подобные) тратят бюджет на рассуждения. При малом лимите
// видимого текста не остаётся: сервер отдаёт finish_reason=length и пустой content, а иные
// балансеры ещё и подставляют в content предупреждение «Модель сгенерировала только
// размышления…». Без этой проверки помощник сохранял предупреждение как ответ модели или
// молча получал пустоту — со стороны это «модель не смогла ответить» без причины.
//
// Ошибка возвращается только когда видимого ответа НЕТ и модель не попросила инструмент:
// если инструмент вызван, ответ будет в следующем раунде.
func thinkingBudgetError(reply Reply, req Request, warned bool) error {
	if len(reply.ToolCalls) > 0 {
		return nil
	}
	visible := strings.TrimSpace(reply.Content)
	if warned {
		return fmt.Errorf("%w: провайдер израсходовал бюджет ответа на рассуждения "+
			"(%d символов размышлений, лимит ответа %d) — увеличьте AI_MAX_OUTPUT_TOKENS",
			ErrUnavailable, reply.ReasoningLen, req.MaxTokens)
	}
	if reply.FinishReason == "length" {
		// Ответ оборван по лимиту: он неполный в любом случае (0.142.6). Показывать человеку
		// обрезанный JSON вызова или половину абзаца — хуже, чем сказать, что модель не
		// уложилась в лимит ответа.
		return fmt.Errorf("%w: ответ модели оборван по лимиту (%d токенов, текст %d знаков, "+
			"рассуждений %d) — увеличьте AI_MAX_OUTPUT_TOKENS или попросите правку одного фрагмента",
			ErrOutputLimit, req.MaxTokens, len([]rune(visible)), reply.ReasoningLen)
	}
	return nil
}

// warningText — это не ответ модели, а предупреждение сервера о пустом ответе.
func warningText(text string) bool {
	if text == "" {
		return false
	}
	return strings.Contains(text, "только размышления") ||
		strings.Contains(text, "only reasoning")
}

// stripProviderWarning убирает предупреждение сервера из текста ответа.
//
// Если модель всё-таки вызвала инструмент, ответ будет в следующем раунде, а предупреждение
// про рассуждения — не ответ: сохранять его в переписку нельзя.
func stripProviderWarning(content string) (string, bool) {
	if warningText(content) {
		return "", true
	}
	return content, false
}

// openAIStreamChunk — одно событие потока. Куски вызова инструмента приходят по
// частям: имя в одном событии, аргументы (строкой JSON) — в нескольких следующих,
// и склеивать их нужно по index.
// openAIStreamDelta — приращение одной реплики в потоке.
type openAIStreamDelta struct {
	// Content — строка или массив частей (см. textOf).
	Content any `json:"content"`
	// ReasoningContent/Reasoning — рассуждения «думающих» моделей (два имени поля у разных
	// серверов). Человеку они не нужны, но их длина говорит, куда ушёл бюджет ответа (0.141.0).
	ReasoningContent string `json:"reasoning_content"`
	Reasoning        string `json:"reasoning"`
	ToolCalls        []struct {
		Index    int    `json:"index"`
		ID       string `json:"id"`
		Type     string `json:"type"`
		Function struct {
			Name      string `json:"name"`
			Arguments string `json:"arguments"`
		} `json:"function"`
	} `json:"tool_calls"`
}

// reasoningOf — служебные рассуждения из приращения потока.
func reasoningOf(delta openAIStreamDelta) string {
	if delta.ReasoningContent != "" {
		return delta.ReasoningContent
	}
	return delta.Reasoning
}

type openAIStreamChunk struct {
	Model   string `json:"model"`
	Choices []struct {
		Delta        openAIStreamDelta `json:"delta"`
		FinishReason string            `json:"finish_reason"`
	} `json:"choices"`
	Usage *struct {
		PromptTokens     int `json:"prompt_tokens"`
		CompletionTokens int `json:"completion_tokens"`
	} `json:"usage"`
	Error *openAIError `json:"error"`
}

// ChatStream — потоковый вариант Chat: сервер отдаёт события SSE со кусками текста.
//
// Счётчики токенов в потоковом режиме приходят не всегда: их присылают, только если
// попросить (`stream_options.include_usage`), а часть серверов на незнакомое поле
// отвечает ошибкой. Поэтому просить не будем: точные счётчики не стоят того, чтобы
// ради них ломать совместимость с чужим сервером, а оценка расхода — дело вызывающего
// (см. фазу лимитов по токенам).
func (c *openAIClient) ChatStream(ctx context.Context, req Request, onText func(string) error) (Reply, error) {
	body := c.chatBody(req)
	body.Stream = true

	raw, err := json.Marshal(body)
	if err != nil {
		return Reply{}, err
	}
	httpReq, err := http.NewRequestWithContext(ctx, http.MethodPost, c.provider.BaseURL+"/chat/completions", bytes.NewReader(raw))
	if err != nil {
		return Reply{}, err
	}
	httpReq.Header.Set("Content-Type", "application/json")
	httpReq.Header.Set("Accept", "text/event-stream")
	c.authorize(httpReq)

	resp, err := c.client.Do(httpReq)
	if err != nil {
		return Reply{}, fmt.Errorf("%w: %s: %v", ErrUnavailable, c.provider.Title, err)
	}
	defer resp.Body.Close()
	if resp.StatusCode >= 400 {
		limited, _ := io.ReadAll(io.LimitReader(resp.Body, 8<<10))
		if resp.StatusCode == http.StatusUnauthorized || resp.StatusCode == http.StatusForbidden {
			return Reply{}, fmt.Errorf("%w: %s", ErrUnauthorized, strings.TrimSpace(string(limited)))
		}
		return Reply{}, httpError(resp.StatusCode, limited)
	}

	type toolAcc struct {
		id   string
		name string
		args strings.Builder
	}
	acc := map[int]*toolAcc{}
	// live придерживает начало потока: предупреждение балансера приходит обычным куском
	// content, и отдавать его человеку нельзя (0.142.1).
	live := liveFilter{}
	order := []int{}
	reply := Reply{Model: req.Model}
	var text strings.Builder

	err = readSSE(resp.Body, func(data string) error {
		if strings.TrimSpace(data) == "[DONE]" {
			return errStreamEnd
		}
		var chunk openAIStreamChunk
		if err := json.Unmarshal([]byte(data), &chunk); err != nil {
			return fmt.Errorf("%w: разбор потока: %v", ErrUnavailable, err)
		}
		if chunk.Error != nil {
			return fmt.Errorf("%w: %s", ErrUnavailable, chunk.Error.Message)
		}
		if chunk.Model != "" {
			reply.Model = chunk.Model
		}
		if chunk.Usage != nil {
			reply.TokensIn = chunk.Usage.PromptTokens
			reply.TokensOut = chunk.Usage.CompletionTokens
		}
		if len(chunk.Choices) == 0 {
			return nil
		}
		if chunk.Choices[0].FinishReason != "" {
			reply.FinishReason = chunk.Choices[0].FinishReason
		}
		delta := chunk.Choices[0].Delta
		// Рассуждения считаем, но человеку не отдаём: это служебный текст модели.
		if piece := reasoningOf(delta); piece != "" {
			reply.ReasoningLen += len([]rune(piece))
		}
		if piece := textOf(delta.Content); piece != "" {
			text.WriteString(piece)
			if onText != nil {
				if err := forwardLive(&live, piece, onText); err != nil {
					return err
				}
			}
		}
		for _, call := range delta.ToolCalls {
			item, ok := acc[call.Index]
			if !ok {
				item = &toolAcc{}
				acc[call.Index] = item
				order = append(order, call.Index)
			}
			if call.ID != "" {
				item.id = call.ID
			}
			if call.Function.Name != "" {
				item.name = call.Function.Name
			}
			item.args.WriteString(call.Function.Arguments)
		}
		return nil
	})
	if err := streamEndOrError(err); err != nil {
		return Reply{}, streamStopped(ctx, err)
	}
	// Поток кончился, а начало так и осталось придержанным (короткий ответ короче подписи
	// предупреждения, например «Да.»): показываем его, иначе человек не увидит ответа.
	if !live.decided && live.held.Len() > 0 {
		held := live.held.String()
		live.decided = true
		live.held.Reset()
		if !strings.HasPrefix(held, warningSignature) && onText != nil {
			if err := onText(held); err != nil {
				return Reply{}, streamStopped(ctx, err)
			}
		}
	}

	sort.Ints(order)
	for _, index := range order {
		item := acc[index]
		if item.name == "" {
			continue
		}
		args := map[string]any{}
		if raw := strings.TrimSpace(item.args.String()); raw != "" {
			if err := json.Unmarshal([]byte(raw), &args); err != nil {
				// Аргументы не разобрались — ошибка модели, а не наша: отдаём как есть,
				// и валидация вызова отвергнет его с понятным текстом.
				args = map[string]any{"_raw": raw}
			}
		}
		id := item.id
		if id == "" {
			id = fmt.Sprintf("%s-%d-%s", c.provider.ID, index, item.name)
		}
		reply.ToolCalls = append(reply.ToolCalls, ToolCall{ID: id, Name: item.name, Arguments: args})
	}
	reply.Content = text.String()
	var warned bool
	reply.Content, warned = stripProviderWarning(reply.Content)
	if err := thinkingBudgetError(reply, req, warned); err != nil {
		return Reply{}, err
	}
	return reply, nil
}

// chatBody собирает тело запроса к /chat/completions — общее для обычного и потокового
// вариантов, чтобы поля не разъезжались между ними.
func (c *openAIClient) chatBody(req Request) openAIChatRequest {
	body := openAIChatRequest{Model: req.Model, Temperature: req.Temperature, MaxTokens: req.MaxTokens}
	for _, m := range req.Messages {
		msg := openAIMessage{
			Role:       m.Role,
			Content:    contentFor(m.Content, m.Images),
			ToolCallID: m.ToolCallID,
			Name:       m.Name,
		}
		for _, call := range m.ToolCalls {
			var tc openAIToolCall
			tc.ID = call.ID
			tc.Type = "function"
			tc.Function.Name = call.Name
			raw, err := json.Marshal(call.Arguments)
			if err != nil {
				continue
			}
			tc.Function.Arguments = string(raw)
			msg.ToolCalls = append(msg.ToolCalls, tc)
		}
		body.Messages = append(body.Messages, msg)
	}
	for _, t := range req.Tools {
		body.Tools = append(body.Tools, openAITool{Type: "function", Function: openAIToolBrief{
			Name: t.Name, Description: t.Description, Parameters: t.Parameters,
		}})
	}
	return body
}

func (c *openAIClient) get(ctx context.Context, path string, out any) error {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, c.provider.BaseURL+path, nil)
	if err != nil {
		return err
	}
	c.authorize(req)
	return c.do(req, out)
}

func (c *openAIClient) post(ctx context.Context, path string, body any, out any) error {
	raw, err := json.Marshal(body)
	if err != nil {
		return err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, c.provider.BaseURL+path, bytes.NewReader(raw))
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/json")
	c.authorize(req)
	return c.do(req, out)
}

// authorize ставит заголовок авторизации, только если ключ есть.
//
// Свой сервер (llama.cpp, vLLM) ключа обычно не требует, и отправлять ему
// «Authorization: Bearer » с пустым значением нельзя: часть серверов на такое
// отвечает 401, хотя без заголовка работала бы.
func (c *openAIClient) authorize(req *http.Request) {
	if c.key != "" {
		req.Header.Set("Authorization", "Bearer "+c.key)
	}
}

func (c *openAIClient) do(req *http.Request, out any) error {
	resp, err := c.client.Do(req)
	if err != nil {
		return fmt.Errorf("%w: %s: %v", ErrUnavailable, c.provider.Title, err)
	}
	defer resp.Body.Close()
	raw, err := io.ReadAll(io.LimitReader(resp.Body, 8<<20))
	if err != nil {
		return fmt.Errorf("%w: чтение ответа: %v", ErrUnavailable, err)
	}
	if resp.StatusCode == http.StatusUnauthorized || resp.StatusCode == http.StatusForbidden {
		return fmt.Errorf("%w: %s", ErrUnauthorized, strings.TrimSpace(string(raw)))
	}
	if resp.StatusCode >= 400 {
		return httpError(resp.StatusCode, raw)
	}
	if err := json.Unmarshal(raw, out); err != nil {
		return fmt.Errorf("%w: разбор ответа: %v", ErrUnavailable, err)
	}
	return nil
}

// warningSignature — начало предупреждения балансера о том, что видимого ответа нет.
const warningSignature = "⚠️ Модель сгенерировала только размышления"

// liveFilter придерживает начало потока, чтобы не показать человеку предупреждение сервера.
//
// Почему нельзя просто отфильтровать в конце: поток отдаётся по кускам, и предупреждение
// приходит ОДНИМ куском content — до того, как станет известен finish_reason. Снаружи это
// «модель пишет ⚠️ Модель сгенерировала только размышления…» посреди ответа (0.142.1).
type liveFilter struct {
	decided bool
	held    strings.Builder
}

// forwardLive отдаёт кусок человеку, если это не предупреждение сервера.
func forwardLive(live *liveFilter, piece string, onText func(string) error) error {
	if live.decided {
		return onText(piece)
	}
	live.held.WriteString(piece)
	held := live.held.String()
	switch {
	case strings.HasPrefix(warningSignature, held):
		// Пока это может оказаться началом предупреждения — ждём.
		return nil
	case strings.HasPrefix(held, warningSignature):
		// Это предупреждение: человеку не показываем.
		live.decided = true
		live.held.Reset()
		return nil
	default:
		live.decided = true
		live.held.Reset()
		return onText(held)
	}
}

// httpError переводит ответ об ошибке в понятную ошибку провайдера.
//
// Отдельно — 413 «контекст не влез» (0.142.1): у балансеров и локальных серверов окно модели
// меньше, чем наш запрос (правила + дерево проекта + результат инструмента), и они отвечают
// 413 с числами. Без разбора это выглядело как «провайдер недоступен», хотя дело в размере
// запроса: человеку нужно либо короче глава, либо модель с большим контекстом.
func httpError(status int, body []byte) error {
	text := strings.TrimSpace(string(body))
	if status == http.StatusRequestEntityTooLarge || strings.Contains(text, "context") && status == http.StatusBadRequest {
		detail := text
		if len([]rune(detail)) > 400 {
			detail = string([]rune(detail)[:400]) + "…"
		}
		return fmt.Errorf("%w: контекст модели меньше запроса (код %d) — уменьшите главу или "+
			"возьмите модель с бо́льшим контекстом; ответ сервера: %s", ErrTooLarge, status, detail)
	}
	return fmt.Errorf("%w: код %d: %s", ErrUnavailable, status, text)
}

// openAIError — ошибка провайдера в ответе или в событии потока.
//
// Форма гуляет: `{"error":{"message":"…"}}`, `{"error":"строка"}` (так отвечает балансер на
// 18080, когда поток оборвался), иногда `detail`. Жёсткая структура на таком поле ломала
// разбор ВСЕГО потока: `cannot unmarshal string into Go struct field …` — и помощник «не мог
// ответить» уже после того, как инструменты выполнились (0.142.4).
type openAIError struct{ Message string }

func (e *openAIError) UnmarshalJSON(raw []byte) error {
	var text string
	if err := json.Unmarshal(raw, &text); err == nil {
		e.Message = text
		return nil
	}
	var obj struct {
		Message string `json:"message"`
		Error   string `json:"error"`
		Detail  string `json:"detail"`
	}
	if err := json.Unmarshal(raw, &obj); err != nil {
		e.Message = strings.TrimSpace(string(raw))
		return nil
	}
	e.Message = firstNonEmptyStr(obj.Message, obj.Error, obj.Detail)
	if e.Message == "" {
		e.Message = strings.TrimSpace(string(raw))
	}
	return nil
}

// firstNonEmptyStr — первая непустая строка.
func firstNonEmptyStr(values ...string) string {
	for _, v := range values {
		if strings.TrimSpace(v) != "" {
			return v
		}
	}
	return ""
}
