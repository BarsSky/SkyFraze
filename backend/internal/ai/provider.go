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
	// KeyInline — ключ лежит В САМОМ провайдере, а не в ключах пользователя и не в
	// окружении стенда. Так устроен свой сервер человека: он задаёт адрес и ключ одной
	// формой, и запись помнит оба. Без этого признака сервер с уже заданным ключом
	// выглядел бы как «нужен ключ»: интерфейс предлагал бы ввести то, что уже введено,
	// и отправка считалась бы неготовой.
	KeyInline bool
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
	// MaxTokens — сколько токенов ответа разрешить (0 — решает провайдер).
	//
	// Нужен «думающим» моделям: рассуждения тратят тот же бюджет, что и ответ, и при малом
	// лимите видимого текста не остаётся (0.141.0, см. Config.MaxOutputTokens).
	MaxTokens int
}

// Reply — ответ модели.
type Reply struct {
	Content   string
	ToolCalls []ToolCall
	Model     string
	TokensIn  int
	TokensOut int
	// FinishReason — почему генерация закончилась (`stop`, `length`, `tool_calls`, …).
	// `length` при пустом Content — это «бюджет кончился», а не «модель промолчала».
	FinishReason string
	// ReasoningLen — сколько символов модели ушло в рассуждения (`reasoning_content`).
	// Для диагностики: если ответа нет, а здесь сотни символов, бюджет съели размышления.
	ReasoningLen int
	// FirstByteMS — через сколько миллисекунд после запроса пришли первые байты ответа.
	//
	// Нужно, чтобы отличать «модель думала» от «сервер поднимал выгруженную модель»:
	// холодный старт на стенде занимал 117 с, обычный ответ — 10–40. Пишется в журнал
	// (`ai: ответ модели`, поле waited_ms) и в лог только когда ожидание заметное.
	FirstByteMS int
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
	// ErrTooLarge — запрос больше контекстного окна модели (413 у балансеров и локальных
	// серверов). Это не «провайдер недоступен»: лечится размером запроса или моделью.
	ErrTooLarge = errors.New("контекст модели меньше запроса")
	// ErrOutputLimit — модель не уложилась в лимит ответа (finish_reason=length). Текст ответа
	// неполный: обрезанный JSON вызова инструмента или половина абзаца.
	ErrOutputLimit = errors.New("модель не уложилась в лимит ответа")
	// ErrModelLoading — сервер моделей ещё поднимает модель (0.145.0).
	//
	// У локальных балансеров выгруженную модель загружает первый же запрос: он висит
	// минутами или сразу отвечает «model is loading». Это НЕ ошибка и НЕ «провайдер
	// недоступен»: запрос надо повторить, а человеку — сказать, что модель загружается.
	ErrModelLoading = errors.New("модель загружается на сервере")
)

// Timeouts — пределы ожидания одного обращения к модели (0.145.0).
//
// Зачем три разных предела вместо одного. Холодный старт (модель выгружена из памяти) и
// обычная генерация — разные по длительности события: на стенде первый запрос после простоя
// занял 117 секунд, а следующие — 10–40. Один общий предел либо рвал холодный старт, либо
// позволял зависшему соединению висеть вечно.
type Timeouts struct {
	// Request — весь обычный (не потоковый) запрос.
	Request time.Duration
	// LoadWait — сколько ждать ПЕРВЫХ байт потокового ответа: сервер может поднимать
	// выгруженную модель, и всё это время он молчит законно.
	LoadWait time.Duration
	// Idle — сколько терпеть молчание сервера уже после начала ответа.
	Idle time.Duration
}

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
//
// Один предел на всё: так клиента собирают тесты и ручные проверки.
func NewClient(p Provider, key string, timeout time.Duration) (Client, error) {
	return NewClientWithTimeouts(p, key, Timeouts{Request: timeout, LoadWait: timeout, Idle: timeout})
}

// NewClientWithTimeouts — клиент с раздельными пределами ожидания (0.145.0).
func NewClientWithTimeouts(p Provider, key string, timeouts Timeouts) (Client, error) {
	if timeouts.LoadWait <= 0 {
		timeouts.LoadWait = timeouts.Request
	}
	if timeouts.Idle <= 0 {
		timeouts.Idle = timeouts.Request
	}
	switch p.Kind {
	case KindOllama:
		return newOllama(p, timeouts), nil
	case KindOpenAI:
		if strings.TrimSpace(key) == "" && !p.Keyless {
			return nil, fmt.Errorf("%w: %s", ErrNoKey, p.ID)
		}
		return newOpenAI(p, key, timeouts), nil
	default:
		return nil, fmt.Errorf("неизвестный провайдер: %s", p.Kind)
	}
}
