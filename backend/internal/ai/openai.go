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
	Error *struct {
		Message string `json:"message"`
		Type    string `json:"type"`
	} `json:"error"`
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
	Stream      bool            `json:"stream"`
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
	Error *struct {
		Message string `json:"message"`
		Type    string `json:"type"`
	} `json:"error"`
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
		Content:   textOf(choice.Message.Content),
		Model:     firstNonEmpty(out.Model, req.Model),
		TokensIn:  out.Usage.PromptTokens,
		TokensOut: out.Usage.CompletionTokens,
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
	return reply, nil
}

// openAIStreamChunk — одно событие потока. Куски вызова инструмента приходят по
// частям: имя в одном событии, аргументы (строкой JSON) — в нескольких следующих,
// и склеивать их нужно по index.
type openAIStreamChunk struct {
	Model   string `json:"model"`
	Choices []struct {
		Delta struct {
			// Content — строка или массив частей (см. textOf).
			Content   any `json:"content"`
			ToolCalls []struct {
				Index    int    `json:"index"`
				ID       string `json:"id"`
				Type     string `json:"type"`
				Function struct {
					Name      string `json:"name"`
					Arguments string `json:"arguments"`
				} `json:"function"`
			} `json:"tool_calls"`
		} `json:"delta"`
		FinishReason string `json:"finish_reason"`
	} `json:"choices"`
	Usage *struct {
		PromptTokens     int `json:"prompt_tokens"`
		CompletionTokens int `json:"completion_tokens"`
	} `json:"usage"`
	Error *struct {
		Message string `json:"message"`
	} `json:"error"`
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
		return Reply{}, fmt.Errorf("%w: код %d: %s", ErrUnavailable, resp.StatusCode, strings.TrimSpace(string(limited)))
	}

	type toolAcc struct {
		id   string
		name string
		args strings.Builder
	}
	acc := map[int]*toolAcc{}
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
		delta := chunk.Choices[0].Delta
		if piece := textOf(delta.Content); piece != "" {
			text.WriteString(piece)
			if onText != nil {
				if err := onText(piece); err != nil {
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
	return reply, nil
}

// chatBody собирает тело запроса к /chat/completions — общее для обычного и потокового
// вариантов, чтобы поля не разъезжались между ними.
func (c *openAIClient) chatBody(req Request) openAIChatRequest {
	body := openAIChatRequest{Model: req.Model, Temperature: req.Temperature}
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
		return fmt.Errorf("%w: код %d: %s", ErrUnavailable, resp.StatusCode, strings.TrimSpace(string(raw)))
	}
	if err := json.Unmarshal(raw, out); err != nil {
		return fmt.Errorf("%w: разбор ответа: %v", ErrUnavailable, err)
	}
	return nil
}
