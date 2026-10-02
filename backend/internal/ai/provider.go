// Package ai — ИИ-помощник: провайдеры моделей, ключи и инструменты проекта.
//
// Зачем отдельный пакет. Модель — это внешний сервис: у него свои таймауты, свои
// ошибки, свои форматы. Прятать это в обработчиках нельзя (обработчик станет
// непроверяемым), а смешивать с проектами — тем более: проекты не должны знать, кто
// им пишет главы.
//
// Что здесь есть и почему так:
//
//   - **Два вида подключения.** Локальный сервер моделей (Ollama) — бесплатно, без
//     ключа и без отправки текста наружу; и провайдеры, совместимые с OpenAI API
//     (OpenRouter, Groq, Google, OpenAI), — по ключу пользователя. Одного «универсального»
//     способа нет: без ключа работает только локальная модель.
//   - **Ключи только шифрованными.** Ключ пользователя — это деньги и доступ; он
//     лежит в базе в виде AES-256-GCM и наружу не отдаётся никогда (в API только
//     «подключено/нет»). Без ключа шифрования функция своих ключей выключена целиком.
//   - **Инструменты, а не свободный текст.** Модель просит создать главу вызовом
//     инструмента (native tool-calls или блок ```skyfraze-tools), а выполняет его
//     сервер. Так видно, что именно изменилось, и можно поставить лимит.
package ai

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"time"
)

// ProviderKind — как с провайдером разговаривать.
type ProviderKind string

const (
	// KindOllama — локальный сервер моделей: ключ не нужен, список моделей и чат
	// через его собственный API.
	KindOllama ProviderKind = "ollama"
	// KindOpenAI — всё, что понимает OpenAI-совместимый `/v1/chat/completions`
	// (OpenRouter, Groq, Google AI Studio, OpenAI).
	KindOpenAI ProviderKind = "openai"
)

// Provider — один источник моделей.
type Provider struct {
	// ID — короткое имя для API и базы ('ollama', 'groq', 'openrouter').
	ID string
	// Title — как показать человеку.
	Title string
	Kind  ProviderKind
	// BaseURL — корень API без слэша на конце.
	BaseURL string
	// KeyEnv — переменная окружения с ключом стенда (пусто — ключа стенда нет).
	// Ключ пользователя имеет приоритет над ключом стенда.
	KeyEnv string
	// FreeByDefault — модели этого провайдера бесплатны для человека либо потому,
	// что провайдер локальный (Ollama), либо потому, что тариф бесплатный (Groq,
	// Google). У OpenRouter решает цена конкретной модели (см. models.go).
	FreeByDefault bool
	// Note — короткое пояснение для интерфейса («работает без ключа», «нужен ваш ключ»).
	Note string
}

// ProviderList — провайдеры, которые видит стенд. Собирается из конфигурации:
// локальный сервер — если задан его адрес, остальные — всегда (они просто требуют
// ключ, а его может дать пользователь).
//
// Почему список фиксирован, а не «все провайдеры интернета»: у каждого свой формат, и
// обещать «автоматически подключим всё бесплатное» было бы обманом — бесплатно без
// ключа работает только локальная модель.
func ProviderList(ollamaURL, compatURL string) []Provider {
	out := make([]Provider, 0, 4)
	if strings.TrimSpace(ollamaURL) != "" {
		out = append(out, Provider{
			ID:            "ollama",
			Title:         "Локальная модель (Ollama)",
			Kind:          KindOllama,
			BaseURL:       strings.TrimRight(strings.TrimSpace(ollamaURL), "/"),
			FreeByDefault: true,
			Note:          "работает без ключа и без интернета: текст проекта никуда не уходит",
		})
	}
	if strings.TrimSpace(compatURL) != "" {
		out = append(out, Provider{
			ID: "custom", Title: "Свой сервер моделей", Kind: KindOpenAI,
			BaseURL: strings.TrimRight(strings.TrimSpace(compatURL), "/"), KeyEnv: "CUSTOM_AI_API_KEY",
			Note: "OpenAI-совместимый сервер (llama.cpp, vLLM, шлюз): нужен ваш ключ",
		})
	}
	out = append(out,
		Provider{
			ID: "groq", Title: "Groq", Kind: KindOpenAI,
			BaseURL: "https://api.groq.com/openai/v1", KeyEnv: "GROQ_API_KEY",
			FreeByDefault: true, Note: "бесплатный тариф: нужен ваш ключ",
		},
		Provider{
			ID: "openrouter", Title: "OpenRouter", Kind: KindOpenAI,
			BaseURL: "https://openrouter.ai/api/v1", KeyEnv: "OPENROUTER_API_KEY",
			Note: "есть бесплатные модели (берём те, где цена нулевая): нужен ваш ключ",
		},
		Provider{
			ID: "google", Title: "Google AI Studio", Kind: KindOpenAI,
			BaseURL: "https://generativelanguage.googleapis.com/v1beta/openai", KeyEnv: "GOOGLE_API_KEY",
			FreeByDefault: true, Note: "бесплатный тариф Gemini: нужен ваш ключ",
		},
		Provider{
			ID: "openai", Title: "OpenAI", Kind: KindOpenAI,
			BaseURL: "https://api.openai.com/v1", KeyEnv: "OPENAI_API_KEY",
			Note: "платные модели: нужен ваш ключ",
		},
	)
	return out
}

// Model — модель, доступная человеку.
type Model struct {
	// ID — идентификатор у провайдера.
	ID string `json:"id"`
	// Ref — 'provider:model' — то, что передаёт интерфейс.
	Ref       string `json:"ref"`
	Provider  string `json:"provider"`
	Title     string `json:"title"`
	Free      bool   `json:"free"`
	Local     bool   `json:"local"`
	Tools     bool   `json:"tools"`
	ContextKB int    `json:"context_kb,omitempty"`
}

// ToolCall — вызов инструмента, который вернула модель.
type ToolCall struct {
	ID        string         `json:"id"`
	Name      string         `json:"name"`
	Arguments map[string]any `json:"arguments"`
}

// Message — одно сообщение переписки.
type Message struct {
	// Role: system | user | assistant | tool.
	Role string `json:"role"`
	// Content — текст (у tool-сообщения — результат работы инструмента в JSON).
	Content string `json:"content"`
	// ToolCalls — что модель попросила выполнить (у assistant).
	ToolCalls []ToolCall `json:"tool_calls,omitempty"`
	// ToolCallID — на какой вызов отвечает tool-сообщение.
	ToolCallID string `json:"tool_call_id,omitempty"`
	// Name — имя инструмента у tool-сообщения.
	Name string `json:"name,omitempty"`
}

// ToolDef — описание инструмента в OpenAI-совместимом виде: его получает модель.
type ToolDef struct {
	Name        string         `json:"name"`
	Description string         `json:"description"`
	Parameters  map[string]any `json:"parameters"`
}

// Request — запрос к модели.
type Request struct {
	Model    string
	Messages []Message
	Tools    []ToolDef
	// Temperature — по умолчанию 0.4 (нужна аккуратность, но и живость текста).
	Temperature float64
}

// Reply — ответ модели.
type Reply struct {
	Content   string
	ToolCalls []ToolCall
	Model     string
	TokensIn  int
	TokensOut int
}

// Client — то, что умеет любой провайдер.
type Client interface {
	// ListModels — какие модели доступны с этим ключом.
	ListModels(ctx context.Context) ([]Model, error)
	// Chat — один обмен сообщениями (с инструментами, если модель их умеет).
	Chat(ctx context.Context, req Request) (Reply, error)
}

// Ошибки, которые вызывающий различает: провайдер недоступен, ключ не принят,
// модель не умеет инструменты. Всё остальное — обычная ошибка с текстом.
var (
	// ErrNoKey — для провайдера не задан ни ключ пользователя, ни ключ стенда.
	ErrNoKey = errors.New("нет ключа для провайдера")
	// ErrUnauthorized — провайдер отверг ключ.
	ErrUnauthorized = errors.New("провайдер отверг ключ")
	// ErrUnavailable — провайдер не ответил или ответил ошибкой.
	ErrUnavailable = errors.New("провайдер недоступен")
)

// httpTimeout — предел на один запрос. Локальные модели на слабой машине думают
// долго, поэтому значение настраивается (AI_TIMEOUT_SECONDS).
func httpTimeout(seconds int) time.Duration {
	if seconds <= 0 {
		seconds = 120
	}
	return time.Duration(seconds) * time.Second
}

// NewClient собирает клиента для провайдера. key — ключ (пользователя или стенда);
// для Ollama он не нужен.
func NewClient(p Provider, key string, timeout time.Duration) (Client, error) {
	switch p.Kind {
	case KindOllama:
		return newOllama(p, timeout), nil
	case KindOpenAI:
		if strings.TrimSpace(key) == "" {
			return nil, fmt.Errorf("%w: %s", ErrNoKey, p.ID)
		}
		return newOpenAI(p, key, timeout), nil
	default:
		return nil, fmt.Errorf("неизвестный провайдер: %s", p.Kind)
	}
}
