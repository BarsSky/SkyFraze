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
	// Keyless — ключ не нужен вовсе: свой сервер в локальной сети (llama.cpp, vLLM)
	// обычно не проверяет Authorization, и требовать «введите ключ, чтобы поговорить
	// со своим же сервером» бессмысленно. Если ключ всё же задан — он отправляется.
	Keyless bool
	// NumCtx — явный размер контекста для запросов к Ollama-подобному серверу
	// (`options.num_ctx`); 0 — не задавать.
	//
	// Зачем это нужно. У llama.cpp-подобных серверов есть автоперезагрузка модели под
	// «правильный» контекст: без явного `num_ctx` сервер решает, что запросу нужен
	// большой контекст, уходит в перезагрузку и отвечает «retry in 30s» на КАЖДЫЙ
	// запрос — со стороны это выглядит как «модель не работает». С явным небольшим
	// значением (например, 8192) запрос обрабатывается сразу.
	NumCtx int
	// Local — модели считаются на СВОЕЙ машине (или в своей сети), а не у чужого
	// сервиса. Для согласия это принципиально: текст проекта никуда не уходит, и
	// спрашивать разрешение было бы формальностью, приучающей нажимать «согласен»
	// не читая. Ставится админом для своего OpenAI-совместимого сервера: локальный
	// он или корпоративный шлюз — знает только он.
	Local bool
	// FreeByDefault — модели этого провайдера бесплатны для человека либо потому,
	// что провайдер локальный (Ollama), либо потому, что тариф бесплатный (Groq,
	// Google). У OpenRouter решает цена конкретной модели (см. models.go).
	FreeByDefault bool
	// Note — короткое пояснение для интерфейса («работает без ключа», «нужен ваш ключ»).
	Note string
}

// ProviderOptions — что стенд знает о своих серверах моделей (из окружения).
type ProviderOptions struct {
	// OllamaURL — адрес Ollama-совместимого сервера (пусто — такого провайдера нет).
	OllamaURL string
	// OllamaNumCtx — явный размер контекста для него (0 — не задавать).
	OllamaNumCtx int
	// OpenAICompatURL — адрес своего OpenAI-совместимого сервера.
	OpenAICompatURL string
	// OpenAICompatLocal — считать ли этот сервер своим (считает на своей машине или в
	// своей сети). Знает только админ: llama.cpp в соседней комнате и корпоративный
	// шлюз в интернете выглядят для кода одинаково.
	OpenAICompatLocal bool
}

// ProviderList — провайдеры, которые видит стенд. Собирается из конфигурации:
// локальный сервер — если задан его адрес, остальные — всегда (они просто требуют
// ключ, а его может дать пользователь).
//
// Почему список фиксирован, а не «все провайдеры интернета»: у каждого свой формат, и
// обещать «автоматически подключим всё бесплатное» было бы обманом — бесплатно без
// ключа работает только модель на своей машине.
func ProviderList(opts ProviderOptions) []Provider {
	out := make([]Provider, 0, 4)
	if strings.TrimSpace(opts.OllamaURL) != "" {
		out = append(out, Provider{
			ID:            "ollama",
			Title:         "Ollama",
			Kind:          KindOllama,
			BaseURL:       strings.TrimRight(strings.TrimSpace(opts.OllamaURL), "/"),
			NumCtx:        opts.OllamaNumCtx,
			FreeByDefault: true,
			// Локальность — свойство МОДЕЛИ, а не провайдера: у Ollama рядом с
			// локальными бывают облачные (`…:cloud`, считаются на ollama.com).
			// Поэтому в подписи обе возможности, а решает признак модели.
			Note: "модели на своей машине работают без ключа; облачные («:cloud») считаются на ollama.com и требуют согласия",
		})
	}
	if strings.TrimSpace(opts.OpenAICompatURL) != "" {
		note := "OpenAI-совместимый сервер (llama.cpp, vLLM, шлюз): ключ не нужен, если его не требует сам сервер"
		if opts.OpenAICompatLocal {
			note = "свой OpenAI-совместимый сервер (llama.cpp, vLLM): считает на вашей машине, ключ не нужен"
		}
		out = append(out, Provider{
			ID: "custom", Title: "Свой сервер моделей", Kind: KindOpenAI,
			BaseURL: strings.TrimRight(strings.TrimSpace(opts.OpenAICompatURL), "/"), KeyEnv: "CUSTOM_AI_API_KEY",
			Keyless:       true,
			Local:         opts.OpenAICompatLocal,
			FreeByDefault: true,
			Note:          note,
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
	// Vision — модель умеет смотреть картинки: к сообщению можно приложить
	// изображение, и модель его увидит. Признак нужен интерфейсу ДО отправки: обещать
	// зрение и молча отправить картинку туда, где её не увидят, — обман.
	Vision bool `json:"vision,omitempty"`
	// Cloud — модель считается на удалённом сервере, хотя провайдер «локальный»
	// (облачные модели Ollama: `…:cloud`, `remote_host`). Признак живёт у модели,
	// а не у провайдера: у одного и того же Ollama локальные и облачные модели
	// соседствуют, а для приватности это разные вещи — облачная отправляет текст
	// проекта наружу и требует согласия человека.
	Cloud bool `json:"cloud,omitempty"`
}

// IsCloudModelRef — облачная ли модель по её идентификатору.
//
// Нужна там, где списка моделей под рукой нет: согласие на отправку текста
// спрашивается ДО запроса к провайдеру, по той модели, которую выбрал человек.
func IsCloudModelRef(modelID string) bool {
	return isCloudModel(modelID)
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
	// Images — картинки, приложенные к сообщению, в виде data URL
	// (`data:image/png;base64,…`). Единый вид для всех провайдеров: Ollama ждёт
	// чистый base64, OpenAI-совместимые — data URL внутри части контента, и перевод
	// делает клиент провайдера, а не вызывающий.
	Images []string `json:"images,omitempty"`
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
// для Ollama и для провайдеров с Keyless он не нужен.
func NewClient(p Provider, key string, timeout time.Duration) (Client, error) {
	switch p.Kind {
	case KindOllama:
		return newOllama(p, timeout), nil
	case KindOpenAI:
		if strings.TrimSpace(key) == "" && !p.Keyless {
			return nil, fmt.Errorf("%w: %s", ErrNoKey, p.ID)
		}
		return newOpenAI(p, key, timeout), nil
	default:
		return nil, fmt.Errorf("неизвестный провайдер: %s", p.Kind)
	}
}
