package ai

// endpoints.go — свои серверы моделей у пользователя.
//
// Зачем это вообще. Список провайдеров собирался только из окружения стенда: адрес
// сервера моделей задавал админ (`AI_OLLAMA_URL`, `AI_OPENAI_COMPAT_URL`). В настройках
// помощника можно было выбрать провайдера из этого списка и ввести ключ, но НЕ адрес —
// то есть человек со своим llama.cpp на домашней машине подключиться не мог, а причина
// была невидима: поля просто нет.
//
// Теперь у каждого есть свои серверы: адрес, необязательный ключ и признак «считает на
// моей машине или в моей сети» (от него зависит, нужно ли согласие на отправку текста).
// Провайдер такого сервера получает идентификатор `own:<uuid>`, поэтому он не может
// столкнуться с провайдерами стенда и не исчезает при перенастройке стенда.
//
// Чего здесь намеренно НЕТ: проверки, что адрес «безопасный». Сервер стенда сходит по
// нему сам, поэтому теоретически человек может постучаться во внутреннюю сеть. Для
// личного стенда с регистрацией по приглашению это осознанный компромисс: запретить
// локальные адреса значило бы запретить ровно тот случай, ради которого функция сделана
// (llama.cpp на своей машине). Если стенд когда-нибудь откроют для чужих — здесь и
// появится список запрещённых диапазонов.

import (
	"context"
	"errors"
	"fmt"
	"net/url"
	"strings"

	"github.com/google/uuid"

	"github.com/skyfraze/backend/internal/store"
)

// Пределы своих серверов.
const (
	// maxUserEndpoints — сколько серверов может быть у человека. Больше пяти — это уже
	// не «свой сервер», а каталог, и разбираться в нём будет он сам.
	maxUserEndpoints = 5
	// maxEndpointTitleChars — подпись сервера в списке.
	maxEndpointTitleChars = 60
	// maxEndpointURLChars — адрес вместе со схемой.
	maxEndpointURLChars = 300
)

// ownProviderPrefix — идентификатор своего сервера в API и в базе.
const ownProviderPrefix = "own:"

// Endpoint — свой сервер моделей, как его видит интерфейс (без ключа: ключ наружу не
// отдаётся никогда, даже свой — он хранится шифртекстом).
type Endpoint struct {
	ID    uuid.UUID `json:"id"`
	Title string    `json:"title"`
	// URL — адрес OpenAI-совместимого API, как его видит сервер стенда.
	URL string `json:"url"`
	// Local — считает на машине человека (или в своей сети): согласие не нужно.
	Local bool `json:"local"`
	// HasKey — ключ задан (сам ключ наружу не уходит).
	HasKey bool `json:"has_key"`
	// ProviderID — идентификатор провайдера, под которым этот сервер видно в списке
	// выбора модели: `own:<uuid>`.
	ProviderID string `json:"provider_id"`
}

// Endpoints — свои серверы этого человека.
func (s *Service) Endpoints(ctx context.Context, userID uuid.UUID) ([]Endpoint, error) {
	if !s.Enabled() {
		return nil, nil
	}
	list, err := s.store.ListAIEndpoints(ctx, userID)
	if err != nil {
		return nil, err
	}
	out := make([]Endpoint, 0, len(list))
	for _, e := range list {
		out = append(out, endpointDTO(e))
	}
	return out, nil
}

// AddEndpoint добавляет свой сервер моделей.
//
// Ключ необязателен: свой сервер (llama.cpp, vLLM) обычно ключа не требует. Если ключ
// всё же нужен, а шифровать его нечем (на стенде нет AI_SECRET_KEY) — отказываем: хранить
// ключ открытым текстом нельзя, а молча «забыть» его значило бы показать «подключено» на
// неработающем сервере.
func (s *Service) AddEndpoint(
	ctx context.Context, userID uuid.UUID, title, rawURL, key string, local bool,
) (*Endpoint, error) {
	if !s.Enabled() {
		return nil, errors.New("ИИ-помощник выключен на этом стенде")
	}
	title = strings.TrimSpace(title)
	if title == "" {
		return nil, errors.New("назовите сервер: так его будет видно в списке моделей")
	}
	if len([]rune(title)) > maxEndpointTitleChars {
		return nil, fmt.Errorf("название длиннее %d символов", maxEndpointTitleChars)
	}
	baseURL, err := normalizeEndpointURL(rawURL)
	if err != nil {
		return nil, err
	}
	key = strings.TrimSpace(key)
	if key != "" && !s.KeysReady() {
		return nil, ErrNoCipher
	}
	count, err := s.store.CountAIEndpoints(ctx, userID)
	if err != nil {
		return nil, err
	}
	if count >= maxUserEndpoints {
		return nil, fmt.Errorf("своих серверов уже %d — больше не нужно", maxUserEndpoints)
	}

	var ciphertext []byte
	if key != "" {
		ciphertext, err = s.cipher.Encrypt(key)
		if err != nil {
			return nil, err
		}
	}
	saved, err := s.store.UpsertAIEndpoint(ctx, store.AIEndpoint{
		ID: uuid.New(), UserID: userID, Title: title, BaseURL: baseURL,
		Local: local, KeyCiphertext: ciphertext,
	})
	if err != nil {
		return nil, err
	}
	s.logger.Info("ai: добавлен свой сервер моделей", "user", userID, "endpoint", saved.ID, "local", local)
	dto := endpointDTO(*saved)
	return &dto, nil
}

// DeleteEndpoint удаляет свой сервер.
func (s *Service) DeleteEndpoint(ctx context.Context, userID, id uuid.UUID) error {
	if err := s.store.DeleteAIEndpoint(ctx, id, userID); err != nil {
		return err
	}
	s.logger.Info("ai: свой сервер моделей удалён", "user", userID, "endpoint", id)
	return nil
}

// endpointDTO переводит запись в то, что видит интерфейс.
func endpointDTO(e store.AIEndpoint) Endpoint {
	return Endpoint{
		ID: e.ID, Title: e.Title, URL: e.BaseURL, Local: e.Local,
		HasKey: len(e.KeyCiphertext) > 0, ProviderID: ownProviderPrefix + e.ID.String(),
	}
}

// normalizeEndpointURL проверяет адрес и приводит его к виду без хвостового слэша.
//
// Проверяем ровно то, без чего запрос не соберётся: схему http/https и хост. Придираться
// к путям бессмысленно — у OpenAI-совместимых серверов он бывает любой (`/v1`, `/v1/openai`).
func normalizeEndpointURL(raw string) (string, error) {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return "", errors.New("укажите адрес сервера, например http://192.168.1.10:8080/v1")
	}
	if len(raw) > maxEndpointURLChars {
		return "", fmt.Errorf("адрес длиннее %d символов", maxEndpointURLChars)
	}
	if !strings.Contains(raw, "://") {
		// Частая ошибка: адрес пишут без схемы. Подсказываем, а не гадаем.
		return "", errors.New("адрес должен начинаться со схемы: http:// или https://")
	}
	parsed, err := url.Parse(raw)
	if err != nil {
		return "", errors.New("адрес не разбирается — проверьте его")
	}
	if parsed.Scheme != "http" && parsed.Scheme != "https" {
		return "", errors.New("поддерживаются только http:// и https://")
	}
	if strings.TrimSpace(parsed.Host) == "" {
		return "", errors.New("в адресе нет хоста")
	}
	return strings.TrimRight(raw, "/"), nil
}

// providersFor — провайдеры стенда ПЛЮС свои серверы человека.
//
// Каждый свой сервер становится обычным провайдером: тем же путём идут список моделей,
// чат, ключ и согласие. Поэтому «свой сервер» не отдельная ветка поведения, а ещё один
// провайдер — с той разницей, что его адрес задал человек, а не админ.
func (s *Service) providersFor(ctx context.Context, userID uuid.UUID) []Provider {
	out := make([]Provider, 0, len(s.providers)+2)
	out = append(out, s.providers...)
	list, err := s.store.ListAIEndpoints(ctx, userID)
	if err != nil {
		// Сбой чтения своих серверов не должен ломать список провайдеров стенда: без
		// них помощник работает, просто без личных серверов.
		s.logger.Warn("ai: свои серверы не прочитаны", "user", userID, "err", err)
		return out
	}
	for _, e := range list {
		out = append(out, Provider{
			ID:    ownProviderPrefix + e.ID.String(),
			Title: e.Title,
			Kind:  KindOpenAI,
			// Хвостовой слэш убран при сохранении: клиент дописывает путь сам.
			BaseURL: e.BaseURL,
			// Ключ у своего сервера свой: он лежит в записи, а не в ключах провайдеров.
			Keyless:       len(e.KeyCiphertext) == 0,
			KeyInline:     len(e.KeyCiphertext) > 0,
			Local:         e.Local,
			FreeByDefault: true,
			Note:          "свой сервер моделей",
		})
	}
	return out
}

// providerFor находит провайдера по идентификатору, включая свои серверы человека.
func (s *Service) providerFor(ctx context.Context, userID uuid.UUID, id string) (Provider, bool) {
	id = strings.TrimSpace(strings.ToLower(id))
	if strings.HasPrefix(id, ownProviderPrefix) {
		raw := strings.TrimPrefix(id, ownProviderPrefix)
		endpointID, err := uuid.Parse(raw)
		if err != nil {
			return Provider{}, false
		}
		for _, p := range s.providersFor(ctx, userID) {
			if p.ID == id || strings.HasSuffix(p.ID, endpointID.String()) {
				return p, true
			}
		}
		return Provider{}, false
	}
	for _, p := range s.providers {
		if p.ID == id {
			return p, true
		}
	}
	return Provider{}, false
}

// IsOwnProvider — свой сервер человека (а не провайдер стенда).
func IsOwnProvider(providerID string) bool {
	return strings.HasPrefix(strings.TrimSpace(strings.ToLower(providerID)), ownProviderPrefix)
}

// ownEndpoint читает запись своего сервера по идентификатору провайдера.
func (s *Service) ownEndpoint(ctx context.Context, userID uuid.UUID, providerID string) (*store.AIEndpoint, error) {
	raw := strings.TrimPrefix(strings.TrimSpace(strings.ToLower(providerID)), ownProviderPrefix)
	id, err := uuid.Parse(raw)
	if err != nil {
		return nil, store.ErrNotFound
	}
	return s.store.AIEndpointByID(ctx, id, userID)
}
