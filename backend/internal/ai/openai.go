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
			ID:        m.ID,
			Ref:       c.provider.ID + ":" + m.ID,
			Provider:  c.provider.ID,
			Title:     title,
			Free:      free,
			Tools:     supportsParameter(m.SupportedParameters, "tools"),
			ContextKB: m.Context / 1024,
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
	Role       string           `json:"role"`
	Content    string           `json:"content"`
	ToolCalls  []openAIToolCall `json:"tool_calls,omitempty"`
	ToolCallID string           `json:"tool_call_id,omitempty"`
	Name       string           `json:"name,omitempty"`
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
	body := openAIChatRequest{Model: req.Model, Temperature: req.Temperature, Stream: false}
	for _, m := range req.Messages {
		msg := openAIMessage{Role: m.Role, Content: m.Content, ToolCallID: m.ToolCallID, Name: m.Name}
		for _, call := range m.ToolCalls {
			var tc openAIToolCall
			tc.ID = call.ID
			tc.Type = "function"
			tc.Function.Name = call.Name
			raw, err := json.Marshal(call.Arguments)
			if err != nil {
				return Reply{}, err
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
		Content:   choice.Message.Content,
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

func (c *openAIClient) get(ctx context.Context, path string, out any) error {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, c.provider.BaseURL+path, nil)
	if err != nil {
		return err
	}
	req.Header.Set("Authorization", "Bearer "+c.key)
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
	req.Header.Set("Authorization", "Bearer "+c.key)
	return c.do(req, out)
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
