package ai

// image.go — генерация изображений: клиент A1111-совместимого сервера.
//
// Зачем именно A1111-совместимый. Генерация картинок — это отдельный сервис со своим
// железом (видеокарта), и держать его внутри backend'а нельзя. A1111 (Stable Diffusion
// WebUI), Forge и SD.Next говорят на одном и том же простом HTTP-API
// (`/sdapi/v1/txt2img`), поэтому «генератор» здесь — это адрес такого сервера.
// Не задан адрес — генерации нет, и это ЧЕСТНОЕ состояние: интерфейс говорит
// «генератор не настроен», а не обещает картинку и падает.
//
// Что здесь важно и почему:
//
//   - **Доступность проверяется отдельно от вызова.** Наличие адреса ничего не значит:
//     сервер может быть выключен. Проверка — запрос списка моделей; её результат
//     кэшируется на минуту, иначе каждое открытие страницы ждало бы ответа выключенного
//     генератора (а таймаут у него — секунды).
//   - **Промпт собирается сервером, а не моделью.** Модель просит «нарисуй маяк», а
//     стиль проекта, негативный промпт и размеры добавляет наш код: иначе каждая
//     иллюстрация выглядела бы по-своему, а модель могла бы попросить что угодно.
//   - **Размер и шаги ограничены.** Генерация 4К на слабой видеокарте — это минуты
//     ожидания и риск, что запрос отвалится по таймауту.

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strings"
	"sync"
	"time"
)

// ErrImageUnavailable — генератор не настроен или не отвечает.
var ErrImageUnavailable = errors.New("генерация изображений недоступна")

// Пределы генерации. Значения подобраны под иллюстрацию кадра: 16:9, как у стадии.
const (
	defaultImageSteps  = 28
	defaultImageWidth  = 1024
	defaultImageHeight = 576
	maxImageWidth      = 2048
	maxImageHeight     = 2048
	// availabilityTTL — как долго помним ответ «генератор доступен/нет».
	availabilityTTL = time.Minute
	// probeTimeout — отдельный, короткий предел на проверку доступности: ждать десять
	// секунд на открытии страницы нельзя, а на генерацию — можно.
	probeTimeout = 3 * time.Second
)

// ImageRequest — что нарисовать. Промпт здесь уже полный: стиль и негативный промпт
// дописаны вызывающим.
type ImageRequest struct {
	Prompt   string
	Negative string
	Width    int
	Height   int
	Steps    int
	// Seed — 0 означает «любой»; конкретное число нужно, чтобы повторить результат.
	Seed int64
}

// ImageResult — нарисованная картинка.
type ImageResult struct {
	Data      []byte
	MediaType string
	// Model — какой чекпойнт нарисовал: у человека должен быть способ понять, чем
	// именно сделана иллюстрация.
	Model string
	// Seed — какое зерно вышло (для повторяемости).
	Seed int64
}

// ImageGenerator — сервер генерации изображений.
type ImageGenerator interface {
	// Available — отвечает ли сервер. Ошибка означает «недоступен», и её текст
	// показывается человеку как причина.
	Available(ctx context.Context) error
	// Models — какие чекпойнты есть на сервере (заодно это и проверка доступности).
	Models(ctx context.Context) ([]string, error)
	// Generate — нарисовать картинку.
	Generate(ctx context.Context, req ImageRequest) (ImageResult, error)
}

// imageLoadPath — эндпоинт «подними модель» у балансеров, которые держат модели
// выгруженными (llama-swap и подобные). У обычного Automatic1111 его нет, и это нормально:
// тогда мы просто вернём исходную ошибку генерации.
const imageLoadPath = "/api/image/models/load"

// imageConfig — настройки генератора из окружения.
type imageConfig struct {
	URL            string
	TimeoutSeconds int
	Steps          int
	Model          string
	Negative       string
	// AutoLoad — поднимать выгруженную модель самим (см. loadModel).
	AutoLoad bool
}

// imageCache — помним доступность и список моделей: без этого каждое открытие окна
// помощника ждало бы ответа выключенного генератора.
type imageCache struct {
	mu        sync.Mutex
	checkedAt time.Time
	ok        bool
	note      string
	models    []string
}

// ImageGenerator собирает клиент генератора. Второе значение — false, если генерация не
// настроена вовсе (пустой адрес): тогда и проверять нечего.
func (s *Service) ImageGenerator() (ImageGenerator, bool) {
	if s == nil || strings.TrimSpace(s.cfg.ImageURL) == "" {
		return nil, false
	}
	return &a1111Client{
		baseURL: strings.TrimRight(strings.TrimSpace(s.cfg.ImageURL), "/"),
		client:  &http.Client{Timeout: httpTimeout(s.cfg.ImageTimeoutSeconds)},
		cfg: imageConfig{
			URL:            s.cfg.ImageURL,
			TimeoutSeconds: s.cfg.ImageTimeoutSeconds,
			Steps:          s.cfg.ImageSteps,
			Model:          s.cfg.ImageModel,
			Negative:       s.cfg.ImageNegative,
			AutoLoad:       s.cfg.ImageAutoLoad,
		},
	}, true
}

// ImageStatus — доступна ли генерация сейчас и что об этом сказать человеку.
//
// Возвращает (доступна, пояснение). Пояснение — короткая фраза для интерфейса:
// «генератор не настроен», «сервер не отвечает: …», «готов: 3 модели».
func (s *Service) ImageStatus(ctx context.Context) (bool, string) {
	gen, ok := s.ImageGenerator()
	if !ok {
		return false, "генератор изображений не настроен (AI_IMAGE_URL)"
	}
	s.imageMu.Lock()
	if time.Since(s.imageCheckedAt) < availabilityTTL {
		available, note := s.imageOK, s.imageNote
		s.imageMu.Unlock()
		return available, note
	}
	s.imageMu.Unlock()

	probeCtx, cancel := context.WithTimeout(ctx, probeTimeout)
	defer cancel()
	models, err := gen.Models(probeCtx)
	available, note := false, ""
	switch {
	case err != nil:
		note = fmt.Sprintf("генератор не отвечает: %v", err)
	default:
		available = true
		note = fmt.Sprintf("генератор готов: моделей %d", len(models))
		if len(models) == 0 {
			note = "генератор отвечает, но моделей нет"
		}
	}
	s.imageMu.Lock()
	s.imageCheckedAt = time.Now()
	s.imageOK, s.imageNote, s.imageModels = available, note, models
	s.imageMu.Unlock()
	return available, note
}

// ImageModels — чекпойнты генератора (пусто, если он не настроен или не ответил).
func (s *Service) ImageModels(ctx context.Context) []string {
	gen, ok := s.ImageGenerator()
	if !ok {
		return nil
	}
	s.imageMu.Lock()
	if time.Since(s.imageCheckedAt) < availabilityTTL && s.imageModels != nil {
		models := append([]string(nil), s.imageModels...)
		s.imageMu.Unlock()
		return models
	}
	s.imageMu.Unlock()
	models, err := gen.Models(ctx)
	if err != nil {
		return nil
	}
	return models
}

// DefaultImageSteps — сколько шагов заказать у генератора.
func (s *Service) DefaultImageSteps() int {
	if s == nil || s.cfg.ImageSteps <= 0 {
		return defaultImageSteps
	}
	if s.cfg.ImageSteps > 150 {
		return 150
	}
	return s.cfg.ImageSteps
}

// DefaultImageNegative — негативный промпт стенда (пусто — не задавать).
func (s *Service) DefaultImageNegative() string {
	if s == nil {
		return ""
	}
	return strings.TrimSpace(s.cfg.ImageNegative)
}

// DefaultImageModel — чекпойнт стенда (пусто — тот, что выбран на сервере генерации).
func (s *Service) DefaultImageModel() string {
	if s == nil {
		return ""
	}
	return strings.TrimSpace(s.cfg.ImageModel)
}

// a1111Client — клиент A1111-совместимого API.
type a1111Client struct {
	baseURL string
	client  *http.Client
	cfg     imageConfig
}

func (c *a1111Client) Available(ctx context.Context) error {
	_, err := c.Models(ctx)
	return err
}

func (c *a1111Client) Models(ctx context.Context) ([]string, error) {
	var out []struct {
		Title     string `json:"title"`
		ModelName string `json:"model_name"`
	}
	if err := c.get(ctx, "/sdapi/v1/sd-models", &out); err != nil {
		return nil, err
	}
	names := make([]string, 0, len(out))
	for _, m := range out {
		name := firstNonEmpty(m.ModelName, m.Title)
		if name != "" {
			names = append(names, name)
		}
	}
	return names, nil
}

func (c *a1111Client) Generate(ctx context.Context, req ImageRequest) (ImageResult, error) {
	result, err := c.generateOnce(ctx, req)
	// Баллансер (llama-swap-подобные стеки) держит модели выгруженными и на запрос без
	// загруженной модели отвечает 503 с подсказкой «reload». Просить картинку у
	// выгруженного сервера бессмысленно, поэтому один раз пробуем загрузить модель сами
	// — иначе человек видел бы «генератор не отвечает» там, где нужно всего лишь
	// поднять модель. Если сервер такого эндпоинта не знает (обычный A1111), получим
	// 404 и вернём ИСХОДНУЮ ошибку, ничего не потеряв.
	if err != nil && c.cfg.AutoLoad && c.cfg.Model != "" && errors.Is(err, ErrImageUnavailable) &&
		strings.Contains(err.Error(), "image_model_error") {
		if loadErr := c.loadModel(ctx); loadErr == nil {
			return c.generateOnce(ctx, req)
		}
	}
	return result, err
}

// loadModel просит сервер поднять модель. Эндпоинт не из A1111: он есть у
// балансеров-«переключателей» (у них модели лежат на диске и грузятся по требованию).
func (c *a1111Client) loadModel(ctx context.Context) error {
	body := map[string]any{"name": c.cfg.Model}
	var out json.RawMessage
	return c.post(ctx, imageLoadPath, body, &out)
}

func (c *a1111Client) generateOnce(ctx context.Context, req ImageRequest) (ImageResult, error) {
	steps := req.Steps
	if steps <= 0 {
		steps = c.cfg.Steps
	}
	if steps <= 0 {
		steps = defaultImageSteps
	}
	width, height := clampSize(req.Width, req.Height)
	body := map[string]any{
		"prompt":          req.Prompt,
		"negative_prompt": strings.TrimSpace(req.Negative),
		"steps":           steps,
		"width":           width,
		"height":          height,
		"batch_size":      1,
		"n_iter":          1,
		"cfg_scale":       6.5,
		"sampler_name":    "DPM++ 2M",
	}
	if req.Seed > 0 {
		body["seed"] = req.Seed
	}
	if c.cfg.Model != "" {
		// Переопределение чекпойнта: у A1111 это отдельное поле.
		body["override_settings"] = map[string]any{"sd_model_checkpoint": c.cfg.Model}
	}

	var out struct {
		Images []string        `json:"images"`
		Info   string          `json:"info"`
		Detail json.RawMessage `json:"detail"`
	}
	if err := c.post(ctx, "/sdapi/v1/txt2img", body, &out); err != nil {
		return ImageResult{}, err
	}
	if len(out.Images) == 0 {
		return ImageResult{}, fmt.Errorf("%w: генератор не вернул картинку (%s)", ErrImageUnavailable, strings.TrimSpace(string(out.Detail)))
	}
	raw, err := base64.StdEncoding.DecodeString(out.Images[0])
	if err != nil {
		return ImageResult{}, fmt.Errorf("%w: картинка не разбирается: %v", ErrImageUnavailable, err)
	}
	result := ImageResult{Data: raw, MediaType: sniffImageType(raw)}
	// В info A1111 кладёт JSON с фактическими параметрами (в том числе seed).
	if info := parseA1111Info(out.Info); info != nil {
		result.Seed = int64FromAny(info["seed"])
		if name, ok := info["sd_model_checkpoint"].(string); ok {
			result.Model = name
		}
	}
	if result.Model == "" {
		result.Model = c.cfg.Model
	}
	return result, nil
}

func (c *a1111Client) get(ctx context.Context, path string, out any) error {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, c.baseURL+path, nil)
	if err != nil {
		return err
	}
	return c.do(req, out)
}

func (c *a1111Client) post(ctx context.Context, path string, body any, out any) error {
	raw, err := json.Marshal(body)
	if err != nil {
		return err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, c.baseURL+path, bytes.NewReader(raw))
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/json")
	return c.do(req, out)
}

func (c *a1111Client) do(req *http.Request, out any) error {
	resp, err := c.client.Do(req)
	if err != nil {
		return fmt.Errorf("%w: %s: %v", ErrImageUnavailable, c.baseURL, err)
	}
	defer resp.Body.Close()
	// Картинка в base64 занимает мегабайты, поэтому предел чтения щедрый.
	raw, err := io.ReadAll(io.LimitReader(resp.Body, 64<<20))
	if err != nil {
		return fmt.Errorf("%w: чтение ответа: %v", ErrImageUnavailable, err)
	}
	if resp.StatusCode >= 400 {
		return fmt.Errorf("%w: код %d: %s", ErrImageUnavailable, resp.StatusCode, strings.TrimSpace(string(raw)))
	}
	if err := json.Unmarshal(raw, out); err != nil {
		return fmt.Errorf("%w: разбор ответа: %v", ErrImageUnavailable, err)
	}
	return nil
}

// clampSize приводит размер к пределам: 16:9 по умолчанию, не больше 2048 по стороне и
// кратно 8 (иначе часть серверов отвечает ошибкой).
func clampSize(width, height int) (int, int) {
	if width <= 0 || height <= 0 {
		return defaultImageWidth, defaultImageHeight
	}
	if width > maxImageWidth {
		width = maxImageWidth
	}
	if height > maxImageHeight {
		height = maxImageHeight
	}
	round := func(v int) int {
		if v < 64 {
			return 64
		}
		return v - v%8
	}
	return round(width), round(height)
}

// sniffImageType — формат картинки по её первым байтам.
//
// A1111 отдаёт PNG, но полагаться на это нельзя: сервер может быть настроен на JPEG или
// WebP, а неправильный media type сломал бы пережатие и отдачу файла.
func sniffImageType(data []byte) string {
	switch {
	case len(data) > 8 && string(data[1:4]) == "PNG":
		return "image/png"
	case len(data) > 3 && data[0] == 0xFF && data[1] == 0xD8:
		return "image/jpeg"
	case len(data) > 12 && string(data[0:4]) == "RIFF" && string(data[8:12]) == "WEBP":
		return "image/webp"
	default:
		return "image/png"
	}
}

// parseA1111Info разбирает поле info: это JSON-строка внутри JSON-ответа.
func parseA1111Info(raw string) map[string]any {
	if strings.TrimSpace(raw) == "" {
		return nil
	}
	var info map[string]any
	if err := json.Unmarshal([]byte(raw), &info); err != nil {
		return nil
	}
	return info
}

// int64FromAny — число из JSON (A1111 отдаёт seed числом, но бывает и строкой).
func int64FromAny(value any) int64 {
	switch v := value.(type) {
	case float64:
		return int64(v)
	case int64:
		return v
	case string:
		var out int64
		_, _ = fmt.Sscanf(strings.TrimSpace(v), "%d", &out)
		return out
	default:
		return 0
	}
}

// Проверка, что клиент умеет то, что нужно сервису.
var _ ImageGenerator = (*a1111Client)(nil)
