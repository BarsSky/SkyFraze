package ai

// ollama.go — локальный сервер моделей (Ollama).
//
// Это единственный вариант «бесплатно и без ключа»: модель считает на машине стенда,
// и текст проекта никуда не уходит. Поэтому локальные модели показываются человеку
// отдельно и с пометкой «локальная».
//
// Разговариваем с ним его собственным API (`/api/tags`, `/api/chat`), а не
// OpenAI-совместимым `/v1`: свой API есть во всех версиях Ollama, а совместимый слой
// появился позже. Инструменты (`tools`) поддерживаются в `/api/chat` с версии 0.3.

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

type ollamaClient struct {
	provider Provider
	client   *http.Client
}

func newOllama(p Provider, timeout time.Duration) *ollamaClient {
	return &ollamaClient{provider: p, client: &http.Client{Timeout: timeout}}
}

// ollamaTags — ответ GET /api/tags.
type ollamaTags struct {
	Models []struct {
		Name    string `json:"name"`
		Model   string `json:"model"`
		Size    int64  `json:"size"`
		Details struct {
			Family        string `json:"family"`
			ParameterSize string `json:"parameter_size"`
		} `json:"details"`
		Capabilities []string `json:"capabilities"`
		// RemoteHost заполнен у ОБЛАЧНЫХ моделей: запрос уходит на ollama.com, а не
		// считается на машине стенда. Для приватности это принципиально другая
		// модель, и называть её локальной нельзя.
		RemoteHost string `json:"remote_host"`
	} `json:"models"`
}

// ListModels спрашивает у Ollama, какие модели скачаны.
//
// Про инструменты (`tools`) Ollama сообщает списком возможностей; если список пуст
// (старая версия), считаем, что инструменты есть — иначе половина моделей оказалась бы
// «не умеет» без причины. Ошибку модели видно в чате, и это честнее.
//
// Локальность проверяем по каждой модели отдельно. У Ollama есть облачные модели
// (`…:cloud`, в ответе `remote_host`): они выглядят как обычные, но считаются на
// ollama.com, и текст проекта уходит наружу. Провайдер тут ни при чём — он один и тот
// же, а модели разные, поэтому признак «локальная» живёт у модели.
func (c *ollamaClient) ListModels(ctx context.Context) ([]Model, error) {
	var out ollamaTags
	if err := c.get(ctx, "/api/tags", &out); err != nil {
		return nil, err
	}
	models := make([]Model, 0, len(out.Models))
	for _, m := range out.Models {
		name := m.Model
		if name == "" {
			name = m.Name
		}
		title := name
		if m.Details.ParameterSize != "" {
			title = fmt.Sprintf("%s (%s)", name, m.Details.ParameterSize)
		}
		remote := isCloudModel(name) || strings.TrimSpace(m.RemoteHost) != ""
		if remote && m.RemoteHost != "" {
			title = fmt.Sprintf("%s — облачная (%s)", title, hostOnly(m.RemoteHost))
		}
		models = append(models, Model{
			ID:       name,
			Ref:      c.provider.ID + ":" + name,
			Provider: c.provider.ID,
			Title:    title,
			// Облачная модель бесплатной не бывает: за неё платит аккаунт Ollama,
			// и человек должен видеть это до отправки текста.
			Free:  !remote,
			Local: !remote,
			Cloud: remote,
			Tools: supportsTools(m.Capabilities),
		})
	}
	return models, nil
}

// isCloudModel — облачная модель по имени: Ollama помечает их суффиксом `:cloud`.
//
// Проверка по имени нужна не только для списка: согласие на отправку текста
// спрашивается ДО запроса к провайдеру, когда списка моделей под рукой нет.
func isCloudModel(name string) bool {
	return strings.HasSuffix(strings.ToLower(strings.TrimSpace(name)), ":cloud")
}

// hostOnly — имя хоста без схемы и пути (для подписи «облачная (ollama.com)»).
func hostOnly(raw string) string {
	host := strings.TrimSpace(raw)
	host = strings.TrimPrefix(strings.TrimPrefix(host, "https://"), "http://")
	if idx := strings.IndexAny(host, "/:"); idx >= 0 {
		host = host[:idx]
	}
	if host == "" {
		return "удалённый сервер"
	}
	return host
}

// supportsTools — есть ли у модели инструменты по списку возможностей Ollama.
func supportsTools(capabilities []string) bool {
	if len(capabilities) == 0 {
		return true // старый Ollama не перечисляет — не берёмся судить
	}
	for _, c := range capabilities {
		if c == "tools" {
			return true
		}
	}
	return false
}

type ollamaChatRequest struct {
	Model    string          `json:"model"`
	Messages []ollamaMessage `json:"messages"`
	Tools    []ollamaTool    `json:"tools,omitempty"`
	Stream   bool            `json:"stream"`
	Options  map[string]any  `json:"options,omitempty"`
}

type ollamaMessage struct {
	Role      string           `json:"role"`
	Content   string           `json:"content"`
	ToolCalls []ollamaToolCall `json:"tool_calls,omitempty"`
	ToolName  string           `json:"tool_name,omitempty"`
}

type ollamaTool struct {
	Type     string             `json:"type"`
	Function ollamaToolFunction `json:"function"`
}

type ollamaToolFunction struct {
	Name        string         `json:"name"`
	Description string         `json:"description"`
	Parameters  map[string]any `json:"parameters"`
}

type ollamaToolCall struct {
	Function struct {
		Name      string         `json:"name"`
		Arguments map[string]any `json:"arguments"`
	} `json:"function"`
}

type ollamaChatResponse struct {
	Model   string        `json:"model"`
	Message ollamaMessage `json:"message"`
	Error   string        `json:"error"`
	// Счётчики: prompt_eval_count — вход, eval_count — выход.
	PromptEvalCount int `json:"prompt_eval_count"`
	EvalCount       int `json:"eval_count"`
}

func (c *ollamaClient) Chat(ctx context.Context, req Request) (Reply, error) {
	body := c.chatBody(req)
	body.Stream = false

	var out ollamaChatResponse
	if err := c.post(ctx, "/api/chat", body, &out); err != nil {
		return Reply{}, err
	}
	if out.Error != "" {
		return Reply{}, fmt.Errorf("%w: %s", ErrUnavailable, out.Error)
	}
	reply := Reply{
		Content:   out.Message.Content,
		Model:     firstNonEmpty(out.Model, req.Model),
		TokensIn:  out.PromptEvalCount,
		TokensOut: out.EvalCount,
	}
	for i, call := range out.Message.ToolCalls {
		args := call.Function.Arguments
		if args == nil {
			args = map[string]any{}
		}
		reply.ToolCalls = append(reply.ToolCalls, ToolCall{
			ID:        fmt.Sprintf("ollama-%d-%s", i, call.Function.Name),
			Name:      call.Function.Name,
			Arguments: args,
		})
	}
	return reply, nil
}

// ChatStream — потоковый вариант Chat: Ollama отдаёт по строке JSON на кусок.
//
// Последняя строка помечена `done: true` и несёт счётчики токенов. Вызовы инструментов
// приходят там же, в message.tool_calls, и собираются целиком: по частям их выполнить
// нельзя, а показать «половину вызова» человеку — бессмысленно.
func (c *ollamaClient) ChatStream(ctx context.Context, req Request, onText func(string) error) (Reply, error) {
	body := c.chatBody(req)
	body.Stream = true

	raw, err := json.Marshal(body)
	if err != nil {
		return Reply{}, err
	}
	httpReq, err := http.NewRequestWithContext(ctx, http.MethodPost, c.provider.BaseURL+"/api/chat", bytes.NewReader(raw))
	if err != nil {
		return Reply{}, err
	}
	httpReq.Header.Set("Content-Type", "application/json")
	httpReq.Header.Set("Accept", "application/x-ndjson")

	resp, err := c.client.Do(httpReq)
	if err != nil {
		return Reply{}, fmt.Errorf("%w: %s: %v", ErrUnavailable, c.provider.BaseURL, err)
	}
	defer resp.Body.Close()
	if resp.StatusCode >= 400 {
		limited, _ := io.ReadAll(io.LimitReader(resp.Body, 8<<10))
		if resp.StatusCode == http.StatusUnauthorized || resp.StatusCode == http.StatusForbidden {
			return Reply{}, fmt.Errorf("%w: %s", ErrUnauthorized, strings.TrimSpace(string(limited)))
		}
		return Reply{}, fmt.Errorf("%w: код %d: %s", ErrUnavailable, resp.StatusCode, strings.TrimSpace(string(limited)))
	}

	reply := Reply{Model: req.Model}
	var text strings.Builder
	err = readJSONLines(resp.Body, func(line []byte) error {
		var chunk ollamaChatResponse
		if err := json.Unmarshal(line, &chunk); err != nil {
			return fmt.Errorf("%w: разбор потока: %v", ErrUnavailable, err)
		}
		if chunk.Error != "" {
			return fmt.Errorf("%w: %s", ErrUnavailable, chunk.Error)
		}
		if chunk.Model != "" {
			reply.Model = chunk.Model
		}
		// Счётчики приходят в последней строке; в промежуточных они нули.
		if chunk.PromptEvalCount > 0 {
			reply.TokensIn = chunk.PromptEvalCount
		}
		if chunk.EvalCount > 0 {
			reply.TokensOut = chunk.EvalCount
		}
		if piece := chunk.Message.Content; piece != "" {
			text.WriteString(piece)
			if onText != nil {
				if err := onText(piece); err != nil {
					return err
				}
			}
		}
		for _, call := range chunk.Message.ToolCalls {
			args := call.Function.Arguments
			if args == nil {
				args = map[string]any{}
			}
			reply.ToolCalls = append(reply.ToolCalls, ToolCall{
				ID:        fmt.Sprintf("ollama-%d-%s", len(reply.ToolCalls), call.Function.Name),
				Name:      call.Function.Name,
				Arguments: args,
			})
		}
		return nil
	})
	if err != nil {
		return Reply{}, streamStopped(ctx, err)
	}
	reply.Content = text.String()
	return reply, nil
}

// chatBody собирает тело запроса к /api/chat — общее для обычного и потокового
// вариантов. Одно место на двоих: иначе температура и num_ctx рано или поздно
// разошлись бы между ними.
func (c *ollamaClient) chatBody(req Request) ollamaChatRequest {
	body := ollamaChatRequest{
		Model:    req.Model,
		Messages: make([]ollamaMessage, 0, len(req.Messages)),
	}
	for _, m := range req.Messages {
		msg := ollamaMessage{Role: m.Role, Content: m.Content, ToolName: m.Name}
		for _, call := range m.ToolCalls {
			var tc ollamaToolCall
			tc.Function.Name = call.Name
			tc.Function.Arguments = call.Arguments
			msg.ToolCalls = append(msg.ToolCalls, tc)
		}
		body.Messages = append(body.Messages, msg)
	}
	for _, t := range req.Tools {
		body.Tools = append(body.Tools, ollamaTool{Type: "function", Function: ollamaToolFunction{
			Name: t.Name, Description: t.Description, Parameters: t.Parameters,
		}})
	}
	if req.Temperature > 0 {
		body.Options = map[string]any{"temperature": req.Temperature}
	}
	// Явный размер контекста (AI_OLLAMA_NUM_CTX). Нужен llama.cpp-подобным серверам:
	// без него они решают, что запросу нужен большой контекст, уходят в автоперезагрузку
	// модели и отвечают «retry in 30s» на каждый запрос.
	if c.provider.NumCtx > 0 {
		if body.Options == nil {
			body.Options = map[string]any{}
		}
		body.Options["num_ctx"] = c.provider.NumCtx
	}
	return body
}

// streamStopped превращает обрыв потока в понятную ошибку: отмену контекста отдаём
// как есть (это «стоп» от человека, а не сбой), остальное — как ошибку провайдера.
func streamStopped(ctx context.Context, err error) error {
	if ctxErr := ctx.Err(); ctxErr != nil {
		return ctxErr
	}
	return err
}

func (c *ollamaClient) get(ctx context.Context, path string, out any) error {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, c.provider.BaseURL+path, nil)
	if err != nil {
		return err
	}
	return c.do(req, out)
}

func (c *ollamaClient) post(ctx context.Context, path string, body any, out any) error {
	raw, err := json.Marshal(body)
	if err != nil {
		return err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, c.provider.BaseURL+path, bytes.NewReader(raw))
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/json")
	return c.do(req, out)
}

func (c *ollamaClient) do(req *http.Request, out any) error {
	resp, err := c.client.Do(req)
	if err != nil {
		// Локальный сервер просто не запущен — самая частая причина, и текст должен
		// говорить об этом, а не «network error».
		return fmt.Errorf("%w: %s: %v", ErrUnavailable, c.provider.BaseURL, err)
	}
	defer resp.Body.Close()
	raw, err := io.ReadAll(io.LimitReader(resp.Body, 8<<20))
	if err != nil {
		return fmt.Errorf("%w: чтение ответа: %v", ErrUnavailable, err)
	}
	if resp.StatusCode >= 400 {
		if resp.StatusCode == http.StatusUnauthorized || resp.StatusCode == http.StatusForbidden {
			return fmt.Errorf("%w: %s", ErrUnauthorized, strings.TrimSpace(string(raw)))
		}
		return fmt.Errorf("%w: код %d: %s", ErrUnavailable, resp.StatusCode, strings.TrimSpace(string(raw)))
	}
	if err := json.Unmarshal(raw, out); err != nil {
		return fmt.Errorf("%w: разбор ответа: %v", ErrUnavailable, err)
	}
	return nil
}

func firstNonEmpty(values ...string) string {
	for _, v := range values {
		if v != "" {
			return v
		}
	}
	return ""
}
