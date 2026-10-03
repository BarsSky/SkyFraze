package ai

// service.go — сборка того, что видит человек: какие провайдеры доступны, с каким
// ключом и какие модели у них есть.
//
// Логика приоритетов проста и должна быть видна в интерфейсе:
//
//	ключ пользователя → ключ стенда → ключа нет (провайдер показан, но «нужен ключ»)
//
// Локальная модель ключа не требует вовсе. Именно поэтому порядок такой: сначала
// своё (человек платит и отвечает сам), потом общее (ключ стенда, если админ его задал).

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"strings"
	"sync"
	"time"

	"github.com/google/uuid"

	"github.com/skyfraze/backend/internal/store"
)

// Config — настройки ИИ-помощника из окружения.
type Config struct {
	Enabled         bool
	OllamaURL       string
	OllamaNumCtx    int
	OpenAICompatURL string
	// OpenAICompatLocal — свой ли это сервер (считает на своей машине или в своей
	// сети). От этого зависит, нужно ли согласие на отправку текста проекта.
	OpenAICompatLocal bool
	SecretKey         string
	DefaultModel      string
	MaxToolCalls      int
	TimeoutSeconds    int
	// TokensPerDay — предел расхода на человека за сутки (0 — без предела).
	//
	// Зачем предел вообще. Ключ стенда платит админ, и «один человек спросил 300 раз
	// подряд» — это его счёт. Для своих ключей предел тоже полезен: интерфейс
	// показывает расход, а не удивляет счётом в конце месяца. По умолчанию 0:
	// локальная модель бесплатна, и запрет «на всякий случай» только мешал бы.
	TokensPerDay int

	// --- генерация изображений (docs/ai-assistant.md, фаза 5) ---
	//
	// ImageURL — адрес A1111-совместимого сервера генерации (пусто — генерации нет).
	// Генерация картинок — отдельный сервис со своим железом; адрес задаёт админ.
	ImageURL string
	// ImageTimeoutSeconds — предел на одну генерацию: на слабой видеокарте это минуты.
	ImageTimeoutSeconds int
	// ImageSteps — сколько шагов диффузии по умолчанию (0 — значение по умолчанию).
	ImageSteps int
	// ImageModel — чекпойнт по умолчанию (пусто — выбранный на сервере генерации).
	ImageModel string
	// ImageAutoLoad — поднимать выгруженную модель самим. Нужно балансерам, которые
	// держат модели на диске и грузят по требованию: без этого первый запрос всегда
	// получал бы «модель не загружена».
	ImageAutoLoad bool
	// ImageNegative — негативный промпт стенда: то, чего на иллюстрациях быть не должно.
	ImageNegative string
}

// Service — доступные модели и ключи пользователей.
type Service struct {
	store     *store.Store
	logger    *slog.Logger
	cipher    *Cipher
	providers []Provider
	cfg       Config
	// envKeys — ключи стенда (провайдер → ключ). Пусто у большинства стендов: ключи
	// стенда нужны только если админ решил платить за всех.
	envKeys map[string]string
	// imageMu защищает кэш доступности генератора изображений (см. image.go).
	imageMu        sync.Mutex
	imageCheckedAt time.Time
	imageOK        bool
	imageNote      string
	imageModels    []string
}

// New собирает сервис. Ошибки конфигурации не валят сервер: ИИ — необязательная
// функция, и вместо падения он должен честно сказать, чего не хватает.
func New(st *store.Store, cfg Config, envKeys map[string]string, logger *slog.Logger) *Service {
	svc := &Service{
		store:  st,
		logger: logger,
		providers: ProviderList(ProviderOptions{
			OllamaURL:         cfg.OllamaURL,
			OllamaNumCtx:      cfg.OllamaNumCtx,
			OpenAICompatURL:   cfg.OpenAICompatURL,
			OpenAICompatLocal: cfg.OpenAICompatLocal,
		}),
		cfg:     cfg,
		envKeys: envKeys,
	}
	if cfg.SecretKey != "" {
		cipher, err := NewCipher(cfg.SecretKey)
		if err != nil {
			logger.Error("ai: ключ шифрования не принят, свои ключи выключены", "err", err)
		} else {
			svc.cipher = cipher
		}
	}
	if cfg.MaxToolCalls <= 0 {
		svc.cfg.MaxToolCalls = 10
	}
	return svc
}

// Enabled — включён ли помощник вообще.
func (s *Service) Enabled() bool { return s != nil && s.cfg.Enabled }

// UseProviders заменяет список провайдеров.
//
// Нужно тестам (в них провайдер — заглушка на localhost) и стендам со своим
// OpenAI-совместимым сервером: llama.cpp, vLLM, корпоративный шлюз. Такой сервер
// описывается тем же Provider, что и облачные, — разница только в адресе.
func (s *Service) UseProviders(list []Provider) { s.providers = list }

// KeysReady — можно ли хранить пользовательские ключи (задан AI_SECRET_KEY).
func (s *Service) KeysReady() bool { return s != nil && s.cipher != nil }

// TokensPerDay — предел расхода на человека за сутки (0 — без предела).
func (s *Service) TokensPerDay() int {
	if s == nil {
		return 0
	}
	return s.cfg.TokensPerDay
}

// SetTokensPerDay задаёт предел расхода (тесты и стенды, где предел меняют на ходу).
func (s *Service) SetTokensPerDay(limit int) {
	if s == nil {
		return
	}
	if limit < 0 {
		limit = 0
	}
	s.cfg.TokensPerDay = limit
}

// SpentTokens — сколько токенов человек израсходовал за последние сутки.
//
// Окно скользящее (24 часа), а не «с полуночи»: у стенда и у человека часовые пояса
// могут не совпадать, и сброс «в полночь по серверу» выглядел бы случайным.
func (s *Service) SpentTokens(ctx context.Context, userID uuid.UUID) (int, error) {
	if s == nil || s.store == nil {
		return 0, nil
	}
	return s.store.AITokensSince(ctx, userID, time.Now().Add(-24*time.Hour))
}

// DefaultModel — модель, которую интерфейс выбирает первой.
func (s *Service) DefaultModel() string { return s.cfg.DefaultModel }

// MaxToolCalls — сколько вызовов инструментов разрешено за одно сообщение.
func (s *Service) MaxToolCalls() int { return s.cfg.MaxToolCalls }

// ProviderInfo — что интерфейс знает о провайдере.
type ProviderInfo struct {
	ID       string `json:"id"`
	Title    string `json:"title"`
	Note     string `json:"note"`
	Local    bool   `json:"local"`
	Free     bool   `json:"free_by_default"`
	HasKey   bool   `json:"has_key"`
	StandKey bool   `json:"stand_key"`
	// Keyless — ключ не нужен вовсе (свой сервер моделей).
	Keyless bool `json:"keyless"`
	// Own — это свой сервер ЭТОГО человека (`own:<uuid>`), а не провайдер стенда. Ключ
	// такого сервера живёт вместе с адресом, поэтому интерфейс не предлагает вводить его
	// отдельно: отдельного места для него нет.
	Own bool `json:"own"`
	// KeyRequired — без ключа провайдер работать не будет.
	KeyRequired bool `json:"key_required"`
}

// Providers отдаёт список провайдеров и то, чем они доступны этому пользователю.
func (s *Service) Providers(ctx context.Context, userID uuid.UUID) ([]ProviderInfo, error) {
	if !s.Enabled() {
		return nil, nil
	}
	mine, err := s.userKeys(ctx, userID)
	if err != nil {
		return nil, err
	}
	out := make([]ProviderInfo, 0, len(s.providers)+1)
	for _, p := range s.providersFor(ctx, userID) {
		stand := s.standKey(p) != ""
		// Готовым провайдер делает одно из трёх: ключ не нужен (свой сервер в своей сети
		// или Ollama), ключ уже лежит в самом провайдере (`KeyInline` — свой сервер
		// человека с ключом в записи) либо его даёт стенд.
		ready := p.Kind == KindOllama || p.Keyless || p.KeyInline || stand
		hasKey := ready || mine[p.ID]
		out = append(out, ProviderInfo{
			ID: p.ID, Title: p.Title, Note: p.Note,
			Local: p.Local || p.Kind == KindOllama, Free: p.FreeByDefault,
			HasKey: hasKey, StandKey: stand,
			Keyless:     p.Keyless,
			Own:         IsOwnProvider(p.ID),
			KeyRequired: !ready && !mine[p.ID],
		})
	}
	return out, nil
}

// userKeys — провайдеры, для которых у пользователя есть свой ключ.
func (s *Service) userKeys(ctx context.Context, userID uuid.UUID) (map[string]bool, error) {
	out := map[string]bool{}
	if !s.KeysReady() {
		return out, nil
	}
	providers, err := s.store.AIKeyProviders(ctx, userID)
	if err != nil {
		return nil, err
	}
	for _, p := range providers {
		out[p] = true
	}
	return out, nil
}

// SetKey сохраняет ключ пользователя. Ключ сначала проверяем запросом к провайдеру:
// сохранить неверный — значит показать «подключено» там, где ничего не работает.
func (s *Service) SetKey(ctx context.Context, userID uuid.UUID, providerID, key string) error {
	if !s.Enabled() {
		return errors.New("ИИ-помощник выключен на этом стенде")
	}
	if !s.KeysReady() {
		return ErrNoCipher
	}
	key = strings.TrimSpace(key)
	if key == "" {
		return errors.New("пустой ключ")
	}
	provider, ok := s.providerFor(ctx, userID, providerID)
	if !ok {
		return fmt.Errorf("неизвестный провайдер: %s", providerID)
	}
	if IsOwnProvider(provider.ID) {
		return errors.New("ключ своего сервера задаётся вместе с адресом: удалите сервер и добавьте заново")
	}
	if provider.Kind == KindOllama {
		return errors.New("локальной модели ключ не нужен")
	}
	if err := s.checkKey(ctx, provider, key); err != nil {
		return err
	}
	ciphertext, err := s.cipher.Encrypt(key)
	if err != nil {
		return err
	}
	if err := s.store.UpsertAIKey(ctx, userID, provider.ID, ciphertext); err != nil {
		return err
	}
	s.logger.Info("ai: ключ пользователя сохранён", "user", userID, "provider", provider.ID, "key", MaskKey(key))
	return nil
}

// DeleteKey убирает ключ пользователя.
func (s *Service) DeleteKey(ctx context.Context, userID uuid.UUID, providerID string) error {
	if !s.Enabled() {
		return errors.New("ИИ-помощник выключен на этом стенде")
	}
	return s.store.DeleteAIKey(ctx, userID, providerID)
}

// IsLocal — считает ли провайдер модели на своей машине (или в своей сети).
//
// Нужно согласию: отправка текста проекта ЛОКАЛЬНОЙ модели ничего никуда не отправляет,
// и спрашивать разрешение на «поговорить с собственной машиной» было бы формальностью,
// которая приучает нажимать «согласен» не читая. Для своего OpenAI-совместимого сервера
// это решает админ (`AI_OPENAI_COMPAT_LOCAL`): код не отличает llama.cpp в соседней
// комнате от корпоративного шлюза в интернете.
//
// Осторожно: у Ollama, кроме локальных, бывают ОБЛАЧНЫЕ модели (`…:cloud`) — они
// считаются на ollama.com, хотя провайдер тот же. Поэтому для решения о согласии этого
// признака мало, см. HasConsentFor.
func (s *Service) IsLocal(providerID string) bool {
	provider, ok := s.providerByID(providerID)
	return ok && (provider.Local || provider.Kind == KindOllama)
}

// isLocalFor — то же, но с учётом своих серверов человека: у них признак локальности
// задал сам человек, и от него зависит, спрашивать ли согласие на отправку текста.
func (s *Service) isLocalFor(ctx context.Context, userID uuid.UUID, providerID string) bool {
	provider, ok := s.providerFor(ctx, userID, providerID)
	return ok && (provider.Local || provider.Kind == KindOllama)
}

// Consents — провайдеры, на отправку которым пользователь согласился (и которые ещё
// существуют на стенде: список провайдеров может измениться после перенастройки).
func (s *Service) Consents(ctx context.Context, userID uuid.UUID) ([]string, error) {
	if !s.Enabled() {
		return nil, nil
	}
	stored, err := s.store.AIConsents(ctx, userID)
	if err != nil {
		return nil, err
	}
	// Список провайдеров читаем ОДИН раз: свои серверы человека лежат в базе, и
	// спрашивать их на каждое согласие значило бы сделать запрос на каждую запись.
	known := s.providersFor(ctx, userID)
	out := make([]string, 0, len(stored))
	for _, id := range stored {
		// Ищем провайдера ВМЕСТЕ со своими серверами человека: согласие на чужой сервер
		// (`own:<uuid>`) — такое же согласие, и выбросить его из списка значило бы
		// показывать галочку снятой, а отправку — всегда отклонять.
		if providerIn(known, id) {
			out = append(out, id)
		}
	}
	return out, nil
}

// providerIn — есть ли провайдер с таким идентификатором в готовом списке.
func providerIn(list []Provider, id string) bool {
	wanted := strings.ToLower(strings.TrimSpace(id))
	for _, p := range list {
		if strings.ToLower(p.ID) == wanted {
			return true
		}
	}
	return false
}

// HasConsent — можно ли отправлять текст этому провайдеру. Локальный — всегда можно.
func (s *Service) HasConsent(ctx context.Context, userID uuid.UUID, providerID string) (bool, error) {
	if s.isLocalFor(ctx, userID, providerID) {
		return true, nil
	}
	return s.consentStored(ctx, userID, providerID)
}

// HasConsentFor — можно ли отправлять текст этой МОДЕЛИ.
//
// Отличие от HasConsent принципиальное, и вот почему. «Локальный» — свойство модели, а
// не провайдера: у Ollama рядом с локальными живут облачные (`…:cloud`), которые
// считаются на ollama.com. Если считать согласие по провайдеру, облачная модель
// получила бы текст проекта без всякого вопроса — ровно то, от чего согласие и
// защищает. Поэтому решение принимается по конкретной модели, а «локальность»
// провайдера здесь только снимает вопрос для его собственных локальных моделей.
func (s *Service) HasConsentFor(ctx context.Context, userID uuid.UUID, providerID, modelID string) (bool, error) {
	if s.isLocalFor(ctx, userID, providerID) && !IsCloudModelRef(modelID) {
		return true, nil
	}
	return s.consentStored(ctx, userID, providerID)
}

// consentStored — есть ли запись согласия (без «локальный — значит можно»).
func (s *Service) consentStored(ctx context.Context, userID uuid.UUID, providerID string) (bool, error) {
	consents, err := s.Consents(ctx, userID)
	if err != nil {
		return false, err
	}
	wanted := strings.ToLower(strings.TrimSpace(providerID))
	for _, id := range consents {
		if id == wanted {
			return true, nil
		}
	}
	return false, nil
}

// SetConsent — человек согласился отправлять текст проекта этому провайдеру.
func (s *Service) SetConsent(ctx context.Context, userID uuid.UUID, providerID string) error {
	provider, ok := s.providerFor(ctx, userID, providerID)
	if !ok {
		return fmt.Errorf("неизвестный провайдер: %s", providerID)
	}
	return s.store.SetAIConsent(ctx, userID, provider.ID)
}

// DeleteConsent — согласие отозвано.
func (s *Service) DeleteConsent(ctx context.Context, userID uuid.UUID, providerID string) error {
	providerID = strings.ToLower(strings.TrimSpace(providerID))
	if providerID == "" {
		return errors.New("не указан провайдер")
	}
	return s.store.DeleteAIConsent(ctx, userID, providerID)
}

// ProviderTitleFor — человеческое имя провайдера (для сообщений об ошибке), включая свои
// серверы человека: в тексте должно стоять название, которое он сам задал («llama.cpp
// дома»), а не `own:<uuid>`.
//
// Варианта «без пользователя» здесь намеренно нет: он показывал бы человеку внутренний
// идентификатор его же сервера, и вернуть его обратно в код — значит снова получить
// сообщение, по которому непонятно, о чём речь.
func (s *Service) ProviderTitleFor(ctx context.Context, userID uuid.UUID, providerID string) string {
	if provider, ok := s.providerFor(ctx, userID, providerID); ok {
		return provider.Title
	}
	return providerID
}

// ParseModelRef разбирает 'provider:model' на части. Модель может содержать
// двоеточия (например, «qwen2.5:7b»), поэтому делим по ПЕРВОМУ двоеточию.
func ParseModelRef(ref string) (provider, model string, err error) {
	ref = strings.TrimSpace(ref)
	idx := strings.Index(ref, ":")
	if idx <= 0 || idx == len(ref)-1 {
		return "", "", fmt.Errorf("модель задаётся как 'провайдер:модель', а не %q", ref)
	}
	return strings.ToLower(strings.TrimSpace(ref[:idx])), strings.TrimSpace(ref[idx+1:]), nil
}

// checkKey проверяет ключ запросом списка моделей: 401/403 означает «ключ не принят»,
// недоступность провайдера — не повод не сохранить ключ (может, у него перерыв).
func (s *Service) checkKey(ctx context.Context, provider Provider, key string) error {
	client, err := NewClient(provider, key, httpTimeout(s.cfg.TimeoutSeconds))
	if err != nil {
		return err
	}
	checkCtx, cancel := context.WithTimeout(ctx, 20*time.Second)
	defer cancel()
	if _, err := client.ListModels(checkCtx); err != nil {
		if errors.Is(err, ErrUnauthorized) {
			return errors.New("провайдер отверг ключ — проверьте, что он скопирован целиком")
		}
		if errors.Is(err, ErrUnavailable) {
			// Провайдер недоступен: ключ сохраняем, но говорим об этом честно —
			// человек увидит «не удалось проверить» и сможет попробовать позже.
			s.logger.Warn("ai: провайдер недоступен при проверке ключа", "provider", provider.ID, "err", err)
			return nil
		}
		return err
	}
	return nil
}

// Models — модели одного провайдера, доступные этому пользователю.
func (s *Service) Models(ctx context.Context, userID uuid.UUID, providerID string) ([]Model, error) {
	if !s.Enabled() {
		return nil, errors.New("ИИ-помощник выключен на этом стенде")
	}
	provider, ok := s.providerFor(ctx, userID, providerID)
	if !ok {
		return nil, fmt.Errorf("неизвестный провайдер: %s", providerID)
	}
	client, err := s.clientFor(ctx, userID, provider)
	if err != nil {
		return nil, err
	}
	return client.ListModels(ctx)
}

// Chat — запрос к модели (используется инструментами проекта в следующей фазе).
func (s *Service) Chat(ctx context.Context, userID uuid.UUID, providerID string, req Request) (Reply, error) {
	if !s.Enabled() {
		return Reply{}, errors.New("ИИ-помощник выключен на этом стенде")
	}
	provider, ok := s.providerFor(ctx, userID, providerID)
	if !ok {
		return Reply{}, fmt.Errorf("неизвестный провайдер: %s", providerID)
	}
	client, err := s.clientFor(ctx, userID, provider)
	if err != nil {
		return Reply{}, err
	}
	if req.Temperature == 0 {
		req.Temperature = 0.4
	}
	return client.Chat(ctx, req)
}

// StreamChat — то же, что Chat, но текст ответа отдаётся по мере генерации.
//
// onText получает приращения текста; ошибка из onText прекращает генерацию (так
// останавливают ответ, когда писать больше некуда). Клиент, который потока не умеет
// (заглушки в тестах, будущие провайдеры), отвечает как обычно — его текст уходит
// одним куском, и вызывающий этого не замечает.
func (s *Service) StreamChat(
	ctx context.Context, userID uuid.UUID, providerID string, req Request, onText func(string) error,
) (Reply, error) {
	if !s.Enabled() {
		return Reply{}, errors.New("ИИ-помощник выключен на этом стенде")
	}
	provider, ok := s.providerFor(ctx, userID, providerID)
	if !ok {
		return Reply{}, fmt.Errorf("неизвестный провайдер: %s", providerID)
	}
	client, err := s.clientFor(ctx, userID, provider)
	if err != nil {
		return Reply{}, err
	}
	if req.Temperature == 0 {
		req.Temperature = 0.4
	}
	if streamer, ok := client.(Streamer); ok {
		return streamer.ChatStream(ctx, req, onText)
	}
	reply, err := client.Chat(ctx, req)
	if err != nil {
		return Reply{}, err
	}
	if reply.Content != "" && onText != nil {
		if err := onText(reply.Content); err != nil {
			return Reply{}, err
		}
	}
	return reply, nil
}

// clientFor выбирает ключ: свой → ключ стенда → ошибка «нужен ключ».
func (s *Service) clientFor(ctx context.Context, userID uuid.UUID, provider Provider) (Client, error) {
	// Свой сервер человека: ключ лежит в его записи (а не в ключах провайдеров), и
	// ключа стенда у него быть не может — это его сервер, а не сервер развёртывания.
	if IsOwnProvider(provider.ID) {
		endpoint, err := s.ownEndpoint(ctx, userID, provider.ID)
		if err != nil {
			return nil, err
		}
		if len(endpoint.KeyCiphertext) == 0 {
			return NewClient(provider, "", httpTimeout(s.cfg.TimeoutSeconds))
		}
		if s.cipher == nil {
			return nil, ErrNoCipher
		}
		plain, err := s.cipher.Decrypt(endpoint.KeyCiphertext)
		if err != nil {
			return nil, errors.New("ключ своего сервера не читается — добавьте сервер заново")
		}
		return NewClient(provider, plain, httpTimeout(s.cfg.TimeoutSeconds))
	}

	key := ""
	if s.KeysReady() {
		ciphertext, err := s.store.AIKeyCiphertext(ctx, userID, provider.ID)
		switch {
		case err == nil:
			plain, err := s.cipher.Decrypt(ciphertext)
			if err != nil {
				// Ключ шифрования сменили: просим ввести ключ заново, а не падаем.
				s.logger.Warn("ai: ключ пользователя не расшифрован", "provider", provider.ID, "err", err)
				return nil, errors.New("ключ провайдера не читается — введите его заново")
			}
			key = plain
		case errors.Is(err, store.ErrNotFound):
			// Своего ключа нет — ниже попробуем ключ стенда.
		default:
			return nil, err
		}
	}
	if key == "" {
		key = s.standKey(provider)
	}
	if key == "" && provider.Kind != KindOllama && !provider.Keyless {
		return nil, fmt.Errorf("%w: %s", ErrNoKey, provider.Title)
	}
	return NewClient(provider, key, httpTimeout(s.cfg.TimeoutSeconds))
}

// standKey — ключ стенда из окружения (может быть пустым).
func (s *Service) standKey(p Provider) string {
	if p.KeyEnv == "" {
		return ""
	}
	return strings.TrimSpace(s.envKeys[p.KeyEnv])
}

func (s *Service) providerByID(id string) (Provider, bool) {
	id = strings.TrimSpace(strings.ToLower(id))
	for _, p := range s.providers {
		if p.ID == id {
			return p, true
		}
	}
	return Provider{}, false
}
