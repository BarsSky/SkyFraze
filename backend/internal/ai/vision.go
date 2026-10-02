package ai

// vision.go — умеет ли модель смотреть картинки и как их передать.
//
// Зачем это отдельным слоем. Провайдеры сообщают о зрении по-разному (у Ollama это
// строка в списке возможностей модели, у OpenAI-совместимых — список модальностей
// входа), а часть вообще молчит: у Groq, Google и OpenAI в ответе `/models` про
// модальности ничего нет. Поэтому признак собирается из трёх источников:
//
//  1. метаданные провайдера — если он о зрении сказал, верим ему;
//  2. имя модели — для тех, кто молчит (список ниже);
//  3. ничего — считаем, что не умеет.
//
// Почему «не умеет», а не «попробуем». Отправить картинку модели, которая её не видит,
// значит получить ответ, в котором картинка молча проигнорирована, — а человек будет
// думать, что модель её посмотрела. Честнее сказать «эта модель картинок не видит» до
// отправки.

import (
	"context"
	"encoding/base64"
	"errors"
	"fmt"
	"strings"

	"github.com/google/uuid"
)

// Ограничения на приложенные картинки.
const (
	// MaxImagesPerMessage — сколько картинок можно приложить к одному вопросу.
	MaxImagesPerMessage = 3
	// MaxImageDataURLLen — предел на одну картинку вместе с data-заголовком.
	// 4 МБ в base64 — это примерно 3 МБ самого файла: скриншот или фотография телефона.
	MaxImageDataURLLen = 4 << 20
)

// ErrNoVision — выбранная модель не умеет смотреть картинки.
var ErrNoVision = errors.New("эта модель не видит изображения")

// allowedImageTypes — что принимаем. Список короткий и совпадает с тем, что понимают
// и Ollama, и OpenAI-совместимые серверы; экзотические форматы отвергаем словами, а не
// «ошибка 400 от провайдера».
var allowedImageTypes = []string{"image/png", "image/jpeg", "image/webp", "image/gif"}

// visionNameHints — известные «зрячие» семейства моделей.
//
// Эвристика по имени — не гадание, а вынужденная мера: у части провайдеров про
// модальности в API просто ничего нет. Список намеренно короткий и только про те
// семейства, где зрение есть во всех версиях: если модель не попала в список, кнопка
// «приложить картинку» не появится, и это безопасная сторона ошибки.
var visionNameHints = []string{
	"gpt-4o", "gpt-4.1", "gpt-5", "o3", "o4",
	"claude-3", "claude-4", "claude-sonnet", "claude-opus",
	"gemini-", "gemma-3", "gemma-4",
	"llava", "vision", "vl-", "-vl", "pixtral", "internvl", "minicpm-v", "moondream",
}

// supportsVisionCapability — сказал ли провайдер, что модель видит картинки.
//
// Пустой список возможностей означает «не знаем»: в отличие от инструментов (где мы
// пропускаем всё и полагаемся на ошибку модели), здесь неизвестность считается
// отказом — см. объяснение в начале файла.
func supportsVisionCapability(capabilities []string) bool {
	for _, c := range capabilities {
		if strings.EqualFold(strings.TrimSpace(c), "vision") {
			return true
		}
	}
	return false
}

// supportsVisionModality — есть ли «image» среди модальностей входа (OpenRouter).
func supportsVisionModality(modalities []string) bool {
	for _, m := range modalities {
		name := strings.ToLower(strings.TrimSpace(m))
		if name == "image" || name == "image_url" {
			return true
		}
	}
	return false
}

// looksLikeVisionModel — попадает ли имя модели в известные «зрячие» семейства.
func looksLikeVisionModel(name string) bool {
	lower := strings.ToLower(strings.TrimSpace(name))
	for _, hint := range visionNameHints {
		if strings.Contains(lower, hint) {
			return true
		}
	}
	return false
}

// ValidateImages проверяет приложенные картинки: формат, размер, что это вообще data URL
// с base64. Проверка здесь, а не в обработчике: этот же путь используется и обычным
// ответом, и потоком, и тестами — правило должно быть одно.
func ValidateImages(images []string) error {
	if len(images) == 0 {
		return nil
	}
	if len(images) > MaxImagesPerMessage {
		return fmt.Errorf("к одному вопросу можно приложить не больше %d картинок", MaxImagesPerMessage)
	}
	for i, image := range images {
		if err := validateImage(image); err != nil {
			return fmt.Errorf("картинка %d: %w", i+1, err)
		}
	}
	return nil
}

func validateImage(image string) error {
	if len(image) > MaxImageDataURLLen {
		return fmt.Errorf("слишком большая (предел %d МБ)", MaxImageDataURLLen>>20)
	}
	mediaType, _, err := splitDataURL(image)
	if err != nil {
		return err
	}
	for _, allowed := range allowedImageTypes {
		if mediaType == allowed {
			return nil
		}
	}
	return fmt.Errorf("формат %s не поддерживается (можно png, jpeg, webp, gif)", mediaType)
}

// splitDataURL разбирает `data:<тип>;base64,<данные>` и проверяет, что данные — base64.
func splitDataURL(image string) (mediaType, data string, err error) {
	if !strings.HasPrefix(image, "data:") {
		return "", "", errors.New("картинка должна приходить как data URL")
	}
	comma := strings.Index(image, ",")
	if comma < 0 {
		return "", "", errors.New("в data URL нет данных")
	}
	header := image[len("data:"):comma]
	data = image[comma+1:]
	if !strings.HasSuffix(header, ";base64") {
		return "", "", errors.New("картинка должна быть в base64")
	}
	mediaType = strings.TrimSuffix(header, ";base64")
	if data == "" {
		return "", "", errors.New("картинка пустая")
	}
	if _, err := base64.StdEncoding.DecodeString(data); err != nil {
		return "", "", errors.New("данные картинки не разбираются как base64")
	}
	return mediaType, data, nil
}

// rawImageData — данные без data-заголовка: так их ждёт Ollama.
func rawImageData(image string) string {
	if _, data, err := splitDataURL(image); err == nil {
		return data
	}
	return image
}

// SupportsVision — видит ли картинки модель этого провайдера.
//
// Спрашивает список моделей у провайдера (это один запрос, и только когда к сообщению
// приложены картинки) и смотрит на метаданные, а для молчащих провайдеров — на имя.
func (s *Service) SupportsVision(ctx context.Context, userID uuid.UUID, providerID, modelID string) (bool, error) {
	if s == nil || !s.Enabled() {
		return false, errors.New("ИИ-помощник выключен на этом стенде")
	}
	models, err := s.Models(ctx, userID, providerID)
	if err != nil {
		return false, err
	}
	for _, m := range models {
		if m.ID != modelID {
			continue
		}
		if m.Vision {
			return true, nil
		}
		// Метаданных нет — решает имя. Так же, как в списке моделей.
		return looksLikeVisionModel(m.ID), nil
	}
	// Модели нет в списке (например, её убрали с сервера): не берёмся утверждать, что
	// она зрячая, но и не мешаем — решает имя.
	return looksLikeVisionModel(modelID), nil
}
