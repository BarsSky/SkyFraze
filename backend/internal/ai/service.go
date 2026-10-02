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
	"time"

	"github.com/google/uuid"

	"github.com/skyfraze/backend/internal/store"
)

// Config — настройки ИИ-помощника из окружения.
type Config struct {
	Enabled         bool
	OllamaURL       string
	OpenAICompatURL string
	SecretKey       string
	DefaultModel    string
	MaxToolCalls    int
	TimeoutSeconds  int
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
}

// New собирает сервис. Ошибки конфигурации не валят сервер: ИИ — необязательная
// функция, и вместо падения он должен честно сказать, чего не хватает.
func New(st *store.Store, cfg Config, envKeys map[string]string, logger *slog.Logger) *Service {
	svc := &Service{
		store:     st,
		logger:    logger,
		providers: ProviderList(cfg.OllamaURL, cfg.OpenAICompatURL),
		cfg:       cfg,
		envKeys:   envKeys,
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
	out := make([]ProviderInfo, 0, len(s.providers))
	for _, p := range s.providers {
		stand := s.standKey(p) != ""
		hasKey := p.Kind == KindOllama || mine[p.ID] || stand
		out = append(out, ProviderInfo{
			ID: p.ID, Title: p.Title, Note: p.Note,
			Local: p.Kind == KindOllama, Free: p.FreeByDefault,
			HasKey: hasKey, StandKey: stand,
			KeyRequired: p.Kind != KindOllama && !hasKey,
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
	provider, ok := s.providerByID(providerID)
	if !ok {
		return fmt.Errorf("неизвестный провайдер: %s", providerID)
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
	provider, ok := s.providerByID(providerID)
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
	provider, ok := s.providerByID(providerID)
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

// clientFor выбирает ключ: свой → ключ стенда → ошибка «нужен ключ».
func (s *Service) clientFor(ctx context.Context, userID uuid.UUID, provider Provider) (Client, error) {
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
	if key == "" && provider.Kind != KindOllama {
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
