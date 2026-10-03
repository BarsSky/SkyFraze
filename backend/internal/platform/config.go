package platform

import (
	"fmt"
	"strings"

	"github.com/kelseyhightower/envconfig"
)

// Config — runtime configuration loaded from environment variables.
// 12-factor: every field has an env binding.
type Config struct {
	Listen     string `envconfig:"LISTEN" default:":8080"`
	DBURL      string `envconfig:"DATABASE_URL" required:"true"`
	JWTSecret  string `envconfig:"JWT_SECRET" required:"true"`
	StorageDir string `envconfig:"STORAGE_DIR" default:"./storage"`

	// Object store (filesystem in MVP; MinIO/S3 в Phase 2)
	S3Endpoint string `envconfig:"S3_ENDPOINT" default:""`
	S3Bucket   string `envconfig:"S3_BUCKET" default:"skyfraze-assets"`
	S3Key      string `envconfig:"S3_KEY" default:""`
	S3Secret   string `envconfig:"S3_SECRET" default:""`
	S3UseSSL   bool   `envconfig:"S3_USE_SSL" default:"false"`

	// Frontend CORS
	CORSOrigins string `envconfig:"CORS_ORIGINS" default:"http://localhost:5173"`

	// Администрирование развёртывания.
	//
	// AdminEmails — список администраторов через запятую. Права выдаются и уже
	// зарегистрированным, и тем, кто зарегистрируется позже. Если список пуст,
	// администратором становится первый зарегистрированный пользователь: иначе
	// инсталляция осталась бы без способа управлять регистрацией.
	AdminEmails string `envconfig:"ADMIN_EMAILS" default:""`

	// RegistrationMode — начальный режим регистрации, если в БД его ещё нет:
	// 'request' (по заявке, по умолчанию) | 'open' (любой может регистрироваться).
	// Значение из БД приоритетнее: после первого старта режим меняется в админке.
	RegistrationMode string `envconfig:"REGISTRATION_MODE" default:"request"`

	// AssetQuotaBytes — предел суммы вложений проекта. Считается по строкам
	// `assets`, то есть по весу ПОСЛЕ пережатия картинок: фото на 8 МБ приезжает
	// как 300 КБ и столько и занимает. 0 — без предела.
	//
	// 10 МиБ по умолчанию — это примерно сто фотографий с телефона или
	// тридцать-сорок скриншотов: страница показывает картинки, а не хранит
	// архив, и без предела один проект может съесть диск стенда.
	AssetQuotaBytes int64 `envconfig:"ASSET_QUOTA_BYTES" default:"10485760"`

	// Механизм обновления (см. internal/update и deploy/skyfraze-update.sh).
	//
	// UpdateRepo — 'owner/name' репозитория на GitHub, откуда берутся релизы.
	// Пусто → страница обновления честно скажет, что источник не настроен.
	UpdateRepo string `envconfig:"UPDATE_REPO" default:""`
	// UpdateToken — токен для приватного репозитория или поднятия лимита API.
	UpdateToken string `envconfig:"UPDATE_TOKEN" default:""`
	// UpdateChannel — 'stable' (по умолчанию, предрелизы игнорируются) | 'any'.
	UpdateChannel string `envconfig:"UPDATE_CHANNEL" default:"stable"`
	// UpdateStateDir — каталог, общий с хостом: сюда админка пишет заявку
	// (request.json), а хост-скрипт — состояние (status.json) и лог (update.log).
	UpdateStateDir string `envconfig:"UPDATE_STATE_DIR" default:""`

	// --- ИИ-помощник (docs/ai-assistant.md) ---
	//
	// AIEnabled — главный выключатель. По умолчанию выключено: разговор с моделью
	// означает, что текст проекта уходит третьей стороне, и включать это молча
	// нельзя.
	AIEnabled bool `envconfig:"AI_ENABLED" default:"false"`
	// AIOllamaURL — локальный сервер моделей (Ollama). Это единственный вариант
	// «бесплатно и без ключа»: ничего никуда не отправляется, модель считает на
	// своей машине. Пусто — локальных моделей нет.
	AIOllamaURL string `envconfig:"AI_OLLAMA_URL" default:""`
	// AIOllamaNumCtx — явный размер контекста для этого сервера (0 — не задавать).
	//
	// Нужен llama.cpp-подобным серверам: без явного `num_ctx` они решают, что запросу
	// нужен большой контекст, уходят в автоперезагрузку модели и отвечают «retry in
	// 30s» на КАЖДЫЙ запрос — со стороны это выглядит как «модель не работает».
	AIOllamaNumCtx int `envconfig:"AI_OLLAMA_NUM_CTX" default:"0"`
	// AIOpenAICompatURL — свой сервер, совместимый с OpenAI API (llama.cpp, vLLM,
	// корпоративный шлюз): адрес задаёт админ, ключ — по желанию (свой сервер ключа
	// обычно не требует). Пусто — нет такого провайдера.
	AIOpenAICompatURL string `envconfig:"AI_OPENAI_COMPAT_URL" default:""`
	// AIOpenAICompatLocal — считать ли этот сервер своим: модели считаются на своей
	// машине или в своей сети, поэтому согласие на отправку текста проекта не нужно.
	// По умолчанию false — «не знаем, значит чужой»: llama.cpp в соседней комнате и
	// корпоративный шлюз в интернете выглядят для кода одинаково, и решает админ.
	AIOpenAICompatLocal bool `envconfig:"AI_OPENAI_COMPAT_LOCAL" default:"false"`
	// AISecretKey — ключ шифрования пользовательских ключей провайдеров
	// (AES-256-GCM). Пусто — функция «свой ключ» выключена целиком: хранить ключи
	// без шифрования нельзя.
	AISecretKey string `envconfig:"AI_SECRET_KEY" default:""`
	// AIDefaultModel — модель по умолчанию в интерфейсе ('provider:model').
	AIDefaultModel string `envconfig:"AI_DEFAULT_MODEL" default:""`
	// AIMaxToolCalls — сколько инструментов модель может вызвать за одно сообщение:
	// защита от модели, которая «зациклилась» и создаёт главы бесконечно.
	AIMaxToolCalls int `envconfig:"AI_MAX_TOOL_CALLS" default:"10"`
	// AITimeout — предел на один запрос к модели: локальные модели на слабой машине
	// думают долго, но не бесконечно.
	AITimeoutSeconds int `envconfig:"AI_TIMEOUT_SECONDS" default:"120"`
	// AITokensPerDay — предел расхода токенов на человека за сутки (0 — без предела).
	//
	// Нужен там, где за модель платит стенд (ключ админа): один человек, спросивший
	// триста раз подряд, — это его счёт. Для локальной модели предел смысла не имеет,
	// поэтому по умолчанию 0, а в интерфейсе расход видно всегда.
	AITokensPerDay int `envconfig:"AI_TOKENS_PER_DAY" default:"0"`

	// --- генерация изображений (A1111-совместимый сервер) ---
	//
	// AIImageURL — адрес сервера генерации (Automatic1111, Forge, SD.Next): у них общий
	// простой HTTP-API. Пусто — генерации нет, и помощник честно скажет об этом, а не
	// пообещает картинку. Генерация — отдельный сервис со своим железом, поэтому адрес
	// задаётся отдельно от адресов текстовых моделей.
	AIImageURL string `envconfig:"AI_IMAGE_URL" default:""`
	// AIImageTimeoutSeconds — предел на одну генерацию. По умолчанию 180: на слабой
	// видеокарте иллюстрация 1024×576 рисуется десятки секунд, а не секунды.
	AIImageTimeoutSeconds int `envconfig:"AI_IMAGE_TIMEOUT_SECONDS" default:"180"`
	// AIImageSteps — сколько шагов диффузии заказывать (0 — значение по умолчанию 28).
	AIImageSteps int `envconfig:"AI_IMAGE_STEPS" default:"0"`
	// AIImageModel — чекпойнт по умолчанию (пусто — тот, что выбран на сервере).
	AIImageModel string `envconfig:"AI_IMAGE_MODEL" default:""`
	// AIImageAutoLoad — поднимать выгруженную модель самим (POST /api/image/models/load).
	// По умолчанию да: балансеры, которые держат модели на диске, иначе отвечают
	// «модель не загружена» на первый запрос, и это выглядит как неработающая генерация.
	AIImageAutoLoad bool `envconfig:"AI_IMAGE_AUTOLOAD" default:"true"`
	// AIImageNegative — негативный промпт стенда: то, чего на иллюстрациях быть не должно.
	AIImageNegative string `envconfig:"AI_IMAGE_NEGATIVE" default:""`
}

// AdminEmailList — ADMIN_EMAILS как список (нормализованный, без пустых).
func (c *Config) AdminEmailList() []string {
	out := []string{}
	for _, part := range strings.Split(c.AdminEmails, ",") {
		part = strings.ToLower(strings.TrimSpace(part))
		if part != "" {
			out = append(out, part)
		}
	}
	return out
}

// LoadConfig — читает env через envconfig.
func LoadConfig() (*Config, error) {
	var c Config
	if err := envconfig.Process("", &c); err != nil {
		return nil, fmt.Errorf("load config: %w", err)
	}
	return &c, nil
}
