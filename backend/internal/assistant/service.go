package assistant

// service.go — беседа с моделью о проекте: контекст, вызовы инструментов, история.
//
// Как устроен один вопрос человека:
//
//	1. проверяем права (editor+) и согласие на отправку текста провайдеру;
//	2. собираем запрос: правила + оглавление проекта + история беседы + вопрос;
//	3. идём к модели. Если она просит инструменты — выполняем их САМИ (модель не
//	   трогает проект) и отдаём ей результаты, пока она не ответит текстом;
//	4. записываем в историю и вопрос, и ответ, и что именно было сделано.
//
// Почему выполнение инструментов на сервере, а не «модель сама поправит документ».
// Модель — внешний сервис, и доверять ей прямой доступ к проекту нельзя: она не знает
// ни прав, ни пределов дерева, ни того, что документ живёт в CRDT-комнате. Сервер
// проверяет параметры, ставит лимит на число изменений и делает вставку тем же путём,
// что и импорт Markdown, — иначе открытые вкладки не увидят созданное.
//
// Лимиты здесь не украшение: без них один вопрос «сделай мне 500 глав» стоил бы денег
// и превратил проект в мусор. Поэтому ограничены и число вызовов за сообщение, и число
// раундов общения с моделью, и длина текста кадра.

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"strings"

	"github.com/google/uuid"

	"github.com/skyfraze/backend/internal/ai"
	"github.com/skyfraze/backend/internal/events"
	"github.com/skyfraze/backend/internal/projects"
	"github.com/skyfraze/backend/internal/store"
	"github.com/skyfraze/backend/internal/transfer"
)

// Ошибки, которые обработчик переводит в понятные коды ответа.
var (
	// ErrDisabled — помощник выключен на стенде (AI_ENABLED=false).
	ErrDisabled = errors.New("ИИ-помощник выключен на этом стенде")
	// ErrConsent — человек ещё не разрешил отправлять текст проекта этому провайдеру.
	ErrConsent = errors.New("нужно согласие на отправку текста проекта провайдеру модели")
	// ErrForbidden — у пользователя нет прав менять этот проект.
	ErrForbidden = errors.New("недостаточно прав для изменения проекта")
	// ErrModelRequired — не выбрана модель (и модель по умолчанию не задана).
	ErrModelRequired = errors.New("выберите модель: у помощника нет модели по умолчанию")
	// ErrProjectDisabled — владелец выключил агента в этом проекте (настройки проекта,
	// а не стенда: можно попросить помощника не трогать одну историю).
	ErrProjectDisabled = errors.New("агент выключен в этом проекте — включить может владелец")
	// ErrTokenBudget — на стенде задан предел расхода на сутки, и человек его выбрал.
	ErrTokenBudget = errors.New("исчерпан предел расхода токенов на сутки")
	// ErrImagesUnavailable — в проекте выбран режим с картинками, но генерация
	// изображений на стенде невозможна (не настроена, не отвечает или ещё не сделана).
	ErrImagesUnavailable = errors.New("генерация изображений недоступна")
)

// maxInstructionsChars — предел на указания владельца: они уходят в каждый запрос к
// модели, и простыня на десять тысяч знаков просто вытеснила бы контекст проекта.
const maxInstructionsChars = 4000

// maxImageStyleChars — предел на стиль иллюстраций: он дописывается в каждый промпт
// генератора, а промпт уходит в модель картинок целиком.
const maxImageStyleChars = 400

// Guard — проверка доступа к проекту (реализует projects.Service).
//
// Две проверки, а не одна: чтение беседы доступно тому, кто проект хотя бы видит, а
// создание беседы — тому, кто в нём может писать. Без этих проверок беседы становятся
// «ручкой в никуда»: посторонний мог бы завести беседу с чужим project_id, а любой
// запрос к чужому проекту отвечал бы 200 (проверено на живом стенде — так и было).
type Guard interface {
	RequireViewer(ctx context.Context, userID, projectID uuid.UUID) error
	RequireEditor(ctx context.Context, userID, projectID uuid.UUID) error
	// Role — роль человека в проекте: роль и поведение агента меняет только владелец
	// (агент — участник проекта, и его характер — решение владельца, а не редактора).
	Role(ctx context.Context, userID, projectID uuid.UUID) (store.Role, error)
}

// Inserter — вставка куска Markdown в живой проект (реализует transfer.Service).
//
// Именно этот путь, а не прямая запись в таблицу событий: источник правды проекта —
// CRDT-документ, и вставка через него сразу рассылается открытым вкладкам, попадает
// в снапшот и в проекцию.
type Inserter interface {
	ImportMarkdownInto(ctx context.Context, userID, projectID uuid.UUID,
		parsed *transfer.ParsedMarkdown, place transfer.InsertPlace) (transfer.ImportIntoResult, error)
	// ImportMarkdownIntoAs — то же, но с отдельным автором правок: помощник пишет
	// кадры сам, и в истории должен стоять ОН, а не человек, нажавший «спросить».
	ImportMarkdownIntoAs(ctx context.Context, actorID, userID, projectID uuid.UUID,
		parsed *transfer.ParsedMarkdown, place transfer.InsertPlace) (transfer.ImportIntoResult, error)
	// AttachAssetToEvent — привязать вложение к существующему кадру (иллюстрация).
	// Тот же путь записи в документ, что у импорта, и по той же причине: правка мимо
	// комнаты была бы затёрта ближайшим сохранением.
	AttachAssetToEvent(ctx context.Context, actorID, userID, projectID uuid.UUID,
		eventID, assetID string, asBackground bool) (string, error)
}

// AssetStore — сохранение сгенерированной картинки в проект (реализует assets.Service).
//
// Отдельным интерфейсом, а не зависимостью на пакет assets: помощнику от хранилища нужен
// один метод, и подменять его в тестах должно быть так же просто, как всё остальное.
type AssetStore interface {
	// StoreGenerated кладёт готовые байты в проект и возвращает вложение: имя, тип и
	// данные задаёт вызывающий, дальше — обычный путь загрузки (квота, пережатие,
	// дедупликация).
	StoreGenerated(ctx context.Context, actorID, projectID uuid.UUID,
		filename, contentType string, data []byte) (*store.Asset, error)
}

// Service — беседы с моделью внутри проекта.
type Service struct {
	store    *store.Store
	models   *ai.Service
	inserter Inserter
	guard    Guard
	logger   *slog.Logger
	limits   Limits
	// assets — куда класть сгенерированные картинки. Необязателен: без него помощник
	// работает как раньше, а инструмент иллюстраций просто не предлагается.
	assets AssetStore
}

// New собирает сервис. Отсутствие вставки или прав не валит сервер: помощник —
// необязательная функция, и честная ошибка лучше падения на старте.
func New(st *store.Store, models *ai.Service, guard Guard, inserter Inserter, maxToolCalls int, logger *slog.Logger) *Service {
	return &Service{
		store:    st,
		models:   models,
		inserter: inserter,
		guard:    guard,
		logger:   logger,
		limits:   DefaultLimits(maxToolCalls),
	}
}

// SetLimits заменяет пределы (тесты: не ждать трёх раундов там, где хватит одного).
func (s *Service) SetLimits(l Limits) { s.limits = l }

// UseAssets подключает хранилище файлов: без него инструмент иллюстраций не предлагается
// (картинку некуда положить), и это честнее, чем нарисовать её в никуда.
func (s *Service) UseAssets(store AssetStore) { s.assets = store }

// Limits — действующие пределы (интерфейс показывает их в подсказке).
func (s *Service) Limits() Limits { return s.limits }

// Enabled — работает ли помощник.
func (s *Service) Enabled() bool { return s != nil && s.models != nil && s.models.Enabled() }

// Settings — роль и поведение агента в проекте: то, что видит и настраивает владелец.
type Settings struct {
	// AgentName/AgentID — имя и идентификатор агента: зашиты в коде, не настраиваются.
	AgentName string    `json:"agent_name"`
	AgentID   uuid.UUID `json:"agent_id"`
	// Role — выбранная роль (пусто — «как внимательный соавтор»).
	Role string `json:"role"`
	// RoleTitle/RoleHint — как роль называется и что делает (для интерфейса).
	RoleTitle string `json:"role_title"`
	RoleHint  string `json:"role_hint"`
	// Instructions — указания владельца, дописываются к правилам.
	Instructions string `json:"instructions"`
	// Enabled — выключен ли агент в этом проекте.
	Enabled bool `json:"enabled"`
	// CanEdit — можно ли менять настройки: только владелец проекта.
	CanEdit bool `json:"can_edit"`
	// Member — участвует ли агент в проекте как соавтор (строка в участниках).
	Member bool `json:"member"`
	// Roles — доступные роли (пресеты).
	Roles []ai.AgentRole `json:"roles"`
	// Generation — режим генерации в проекте (auto|text|images|both).
	Generation string `json:"generation"`
	// ImageStyle — стиль иллюстраций словами.
	ImageStyle string `json:"image_style"`
	// Capabilities — что агент умеет СЕЙЧАС (стенд + разрешение владельца + реализация).
	Capabilities Capabilities `json:"capabilities"`
	// Generations — какие режимы можно выбрать и почему нельзя остальные.
	Generations []GenerationOption `json:"generations"`
	// ImageAvailable/ImageNote — состояние генератора на стенде (для строки «что умеет»).
	ImageAvailable bool   `json:"image_available"`
	ImageNote      string `json:"image_note"`
}

// GenerationOption — один режим генерации для интерфейса.
type GenerationOption struct {
	ID    string `json:"id"`
	Title string `json:"title"`
	Hint  string `json:"hint"`
	// Available — можно ли выбрать его сейчас (генератор доступен И инструмент есть).
	Available bool `json:"available"`
}

// capabilities считает, что агенту доступно в проекте.
func (s *Service) capabilities(ctx context.Context, settings *store.ProjectAISettings) Capabilities {
	mode := store.GenerationAuto
	if settings != nil && settings.Generation != "" {
		mode = settings.Generation
	}
	available, note := s.models.ImageStatus(ctx)
	imagesWanted := mode == store.GenerationAuto || mode == store.GenerationImages ||
		mode == store.GenerationBoth
	cap := Capabilities{
		// Текст доступен всегда, кроме режима «только картинки»: там владелец прямо
		// попросил не трогать текст.
		Text:       mode != store.GenerationImages,
		Images:     imagesWanted && available && ImageToolAvailable && s.assets != nil,
		Generation: mode,
		ImageNote:  imageNote(mode, available, note),
	}
	if settings != nil {
		cap.ImageStyle = strings.TrimSpace(settings.ImageStyle)
	}
	return cap
}

// imageNote объясняет, почему картинок нет или как они работают. Причина всегда одна из
// трёх (не реализовано / генератор недоступен / запрещено владельцем), и человеку — а
// через правила и модели — нужно знать, какая именно.
func imageNote(mode string, available bool, standNote string) string {
	switch {
	case !ImageToolAvailable:
		return "эта версия помощника ещё не умеет генерировать иллюстрации"
	case mode == store.GenerationText:
		return "владелец проекта выбрал режим «только текст»"
	case !available:
		return standNote
	default:
		return standNote
	}
}

// generationOptions — режимы для интерфейса: недоступные тоже показываем, но с причиной
// (владелец должен видеть, что режим есть, а не искать его).
func (s *Service) generationOptions(ctx context.Context) []GenerationOption {
	available, note := s.models.ImageStatus(ctx)
	imagesPossible := available && ImageToolAvailable
	imageHint := note
	if !ImageToolAvailable {
		imageHint = "пока недоступно: " + note
	}
	return []GenerationOption{
		{
			ID: store.GenerationAuto, Available: true,
			Title: "Как получится",
			Hint:  "оба, если генератор картинок доступен, иначе только текст",
		},
		{
			ID: store.GenerationText, Available: true,
			Title: "Только текст",
			Hint:  "агент пишет главы и под-события и не рисует",
		},
		{
			ID: store.GenerationImages, Available: imagesPossible,
			Title: "Только картинки",
			Hint:  "иллюстрации без правки текста — " + imageHint,
		},
		{
			ID: store.GenerationBoth, Available: imagesPossible,
			Title: "Текст и картинки",
			Hint:  "агент и пишет, и рисует — " + imageHint,
		},
	}
}

// ProjectSettings читает настройки агента и права спрашивающего.
func (s *Service) ProjectSettings(ctx context.Context, userID, projectID uuid.UUID) (*Settings, error) {
	if err := s.RequireProject(ctx, userID, projectID, false); err != nil {
		return nil, err
	}
	if s.guard == nil {
		return nil, errors.New("помощник не настроен: нет доступа к проектам")
	}
	stored, err := s.store.AISettingsForProject(ctx, projectID)
	if err != nil {
		return nil, err
	}
	role, err := s.guard.Role(ctx, userID, projectID)
	if err != nil {
		return nil, err
	}
	_, memberErr := s.store.GetMembership(ctx, projectID, ai.AgentUserID)
	caps := s.capabilities(ctx, stored)
	imageAvailable, imageNote := s.models.ImageStatus(ctx)
	out := &Settings{
		AgentName:      ai.AgentName,
		AgentID:        ai.AgentUserID,
		Role:           stored.Role,
		Instructions:   stored.Instructions,
		Enabled:        stored.Enabled,
		CanEdit:        role == store.RoleOwner,
		Member:         memberErr == nil,
		Roles:          ai.AgentRolePresets,
		Generation:     caps.Generation,
		ImageStyle:     stored.ImageStyle,
		Capabilities:   caps,
		Generations:    s.generationOptions(ctx),
		ImageAvailable: imageAvailable,
		ImageNote:      imageNote,
	}
	if preset, ok := ai.AgentRoleByID(stored.Role); ok {
		out.RoleTitle = preset.Title
		out.RoleHint = preset.Hint
	}
	return out, nil
}

// SaveProjectSettings записывает роль и поведение агента. Менять может только владелец
// проекта: агент — участник, и его характер — решение владельца, а не редактора.
//
// Заодно владелец «берёт агента в соавторы»: строка участия с ролью editor появляется
// при первом сохранении настроек (и восстанавливается, если её убрали).
func (s *Service) SaveProjectSettings(
	ctx context.Context, userID, projectID uuid.UUID, role, instructions string, enabled bool,
	generation, imageStyle string,
) (*Settings, error) {
	if err := s.RequireProject(ctx, userID, projectID, true); err != nil {
		return nil, err
	}
	if s.guard == nil {
		return nil, errors.New("помощник не настроен: нет доступа к проектам")
	}
	actual, err := s.guard.Role(ctx, userID, projectID)
	if err != nil {
		return nil, err
	}
	if actual != store.RoleOwner {
		return nil, ErrForbidden
	}
	role = strings.TrimSpace(role)
	if role != "" {
		if _, ok := ai.AgentRoleByID(role); !ok {
			return nil, fmt.Errorf("неизвестная роль агента: %s", role)
		}
	}
	instructions = strings.TrimSpace(instructions)
	if len([]rune(instructions)) > maxInstructionsChars {
		return nil, fmt.Errorf("указания длиннее %d символов — сократите", maxInstructionsChars)
	}
	generation = strings.TrimSpace(generation)
	if !store.ValidGeneration(generation) {
		return nil, fmt.Errorf("неизвестный режим генерации: %s", generation)
	}
	if generation == "" {
		// «Не менять»: берём то, что уже выбрано (интерфейс может сохранять форму, не
		// трогая режим — как он делает с выключателем агента).
		current, err := s.store.AISettingsForProject(ctx, projectID)
		if err != nil {
			return nil, err
		}
		generation = current.Generation
		if generation == "" {
			generation = store.GenerationAuto
		}
	}
	// Режим, требующий генератора, не принимаем, если генерация картинок невозможна:
	// иначе владелец выбрал бы «только картинки» и получил агента, который ничего не
	// делает, без объяснения причины.
	if generation == store.GenerationImages || generation == store.GenerationBoth {
		available, note := s.models.ImageStatus(ctx)
		if !available || !ImageToolAvailable {
			return nil, fmt.Errorf("%w: %s", ErrImagesUnavailable, note)
		}
	}
	imageStyle = strings.TrimSpace(imageStyle)
	if len([]rune(imageStyle)) > maxImageStyleChars {
		return nil, fmt.Errorf("стиль иллюстраций длиннее %d символов — сократите", maxImageStyleChars)
	}
	if _, err := s.store.SaveAISettings(ctx, projectID, userID, role, instructions, enabled,
		generation, imageStyle); err != nil {
		return nil, err
	}
	// Агент — соавтор проекта: его правки должны быть видны в списке участников.
	// Роль editor: он пишет текст, но не распоряжается проектом (не публикует, не
	// удаляет, не приглашает) — те же права, что у соавтора-редактора.
	if err := s.store.AddMembership(ctx, projectID, ai.AgentUserID, store.RoleEditor); err != nil {
		return nil, err
	}
	s.logger.Info("ai: настройки агента сохранены",
		"user", userID, "project", projectID, "role", role, "enabled", enabled)
	return s.ProjectSettings(ctx, userID, projectID)
}

// RequireProject проверяет доступ к проекту: чтение — viewer+, запись — editor+.
//
// Ошибки проектов переводим в свои: обработчик отвечает по ним 403/404, а не 500
// (та же схема, что у импорта и выгрузки).
func (s *Service) RequireProject(ctx context.Context, userID, projectID uuid.UUID, edit bool) error {
	if s.guard == nil {
		return errors.New("помощник не настроен: нет доступа к проектам")
	}
	var err error
	if edit {
		err = s.guard.RequireEditor(ctx, userID, projectID)
	} else {
		err = s.guard.RequireViewer(ctx, userID, projectID)
	}
	switch {
	case err == nil:
		return nil
	case errors.Is(err, projects.ErrForbidden):
		return ErrForbidden
	case errors.Is(err, store.ErrNotFound):
		return store.ErrNotFound
	default:
		return err
	}
}

// Call — что делал один инструмент. Уходит человеку вместе с ответом: по нему видно,
// что именно произошло, не читая JSON в тексте модели.
type Call struct {
	Name   string `json:"name"`
	OK     bool   `json:"ok"`
	Detail string `json:"detail,omitempty"`
	Error  string `json:"error,omitempty"`
}

// ChangeImageCreated — к кадру нарисована и привязана иллюстрация.
const ChangeImageCreated = "image_created"

// Change — изменение в проекте, которое сделал помощник. Отдельным блоком, а не
// строкой в тексте ответа: человек должен видеть, что изменилось, и уметь открыть кадр.
type Change struct {
	Action string     `json:"action"` // created_chapter | created_sub_event | image_created
	ID     uuid.UUID  `json:"id"`
	Title  string     `json:"title"`
	Parent *uuid.UUID `json:"parent_id,omitempty"`
}

// Turn — результат одного вопроса: ответ модели, что она делала и что изменила.
type Turn struct {
	ConversationID uuid.UUID       `json:"conversation_id"`
	Message        store.AIMessage `json:"message"`
	Answer         string          `json:"answer"`
	Model          string          `json:"model"`
	Calls          []Call          `json:"calls"`
	Changes        []Change        `json:"changes"`
	// Stopped — ответ оборван человеком (кнопка «стоп»). В истории уже лежит то,
	// что модель успела сказать, и интерфейс по этому признаку говорит «остановлено».
	Stopped bool `json:"stopped,omitempty"`
	// Suggestions — что можно сделать дальше: считает сервер по состоянию проекта и
	// возможностям (см. suggestions.go). Пусто — предлагать нечего.
	Suggestions []Suggestion `json:"suggestions,omitempty"`
}

// Send отправляет вопрос модели и выполняет то, что она попросила.
func (s *Service) Send(ctx context.Context, userID, projectID, conversationID uuid.UUID, modelRef, text string) (*Turn, error) {
	return s.SendStream(ctx, userID, projectID, conversationID, modelRef, text, nil)
}

// SendStream — то же, что Send, но по ходу дела отдаёт события (emitter).
//
// emitter == nil — обычный ответ одним JSON-ом: так работает прежняя ручка
// `/messages`, и так же ведут себя тесты. Отдельной реализации для потока нет
// намеренно: цикл «спросили модель → выполнили инструменты → спросили снова» должен
// существовать в одном месте, иначе поток и обычный ответ разойдутся в поведении
// (лимиты, согласие, порядок событий).
func (s *Service) SendStream(
	ctx context.Context, userID, projectID, conversationID uuid.UUID, modelRef, text string, emit Emitter,
) (*Turn, error) {
	return s.SendStreamImages(ctx, userID, projectID, conversationID, modelRef, text, nil, emit)
}

// SendStreamImages — тот же вопрос, но с приложенными картинками (data URL).
//
// Отдельным методом, а не лишним аргументом в SendStream: вопреки распространённому
// мнению, картинки к сообщению — редкий случай, и тащить их через все вызовы (включая
// тесты) ради одного сценария значит усложнить обычный путь. SendStream остаётся тем же
// и просто передаёт «картинок нет».
//
// Картинки НЕ сохраняются в истории беседы: они нужны для одного запроса, а в базе
// лежали бы мегабайтами, которые никто не перечитывает. Ответ модели остаётся в истории
// текстом — и если человек захочет показать картинку снова, он приложит её снова.
func (s *Service) SendStreamImages(
	ctx context.Context, userID, projectID, conversationID uuid.UUID, modelRef, text string,
	images []string, emit Emitter,
) (*Turn, error) {
	if !s.Enabled() {
		return nil, ErrDisabled
	}
	text = strings.TrimSpace(text)
	if text == "" {
		return nil, errors.New("пустое сообщение")
	}
	if len([]rune(text)) > 4000 {
		return nil, errors.New("сообщение длиннее 4000 символов — разделите его на части")
	}
	if s.inserter == nil {
		return nil, errors.New("помощник не настроен: нет доступа к проектам")
	}
	if err := s.RequireProject(ctx, userID, projectID, true); err != nil {
		return nil, err
	}

	// Роль и поведение агента — настройка проекта: владелец мог попросить помощника
	// не трогать эту историю, не выключая его для всего стенда.
	settings, err := s.store.AISettingsForProject(ctx, projectID)
	if err != nil {
		return nil, err
	}
	if !settings.Enabled {
		return nil, ErrProjectDisabled
	}
	// Возможности: что умеет стенд, что разрешил владелец и что реализовано. Без них
	// модель обещала бы то, чего нет, а интерфейс не мог бы объяснить отказ.
	caps := s.capabilities(ctx, settings)
	if !caps.Text && !caps.Images {
		// Владелец выбрал режим «только картинки», а генерации нет: звать модель
		// незачем — она всё равно ничего не сможет сделать, и человек получил бы
		// пустой ответ вместо причины.
		return nil, fmt.Errorf("%w: %s", ErrImagesUnavailable, caps.ImageNote)
	}

	provider, model, err := s.resolveModel(modelRef)
	if err != nil {
		return nil, err
	}
	// Согласие — до всего остального: пока человек не разрешил отправку, ни вопрос,
	// ни оглавление проекта никуда не уходят. Спрашиваем по конкретной МОДЕЛИ:
	// облачная модель Ollama (`…:cloud`) считается на чужом сервере, хотя провайдер
	// тот же, что у локальной, — и согласие для неё обязательно.
	allowed, err := s.models.HasConsentFor(ctx, userID, provider, model)
	if err != nil {
		return nil, err
	}
	if !allowed {
		// В сообщении называем модель, а не только провайдера: у Ollama облачная
		// модель требует согласия наравне с чужим сервисом, и «разрешите отправку
		// провайдеру Ollama» звучало бы как разрешение говорить со своей машиной.
		label := s.models.ProviderTitleFor(ctx, userID, provider)
		if ai.IsCloudModelRef(model) {
			label = fmt.Sprintf("облачная модель %s (%s)", model, label)
		}
		return nil, fmt.Errorf("%w (%s)", ErrConsent, label)
	}
	// Предел расхода проверяем ДО создания беседы и записи вопроса: если человек
	// упёрся в предел, в истории не должно остаться вопроса без ответа.
	if err := s.checkBudget(ctx, userID); err != nil {
		return nil, err
	}
	// Картинки: проверяем формат и размер до всего остального — незачем заводить беседу
	// и записывать вопрос, чтобы потом отказать из-за формата файла.
	if err := ai.ValidateImages(images); err != nil {
		return nil, err
	}
	if len(images) > 0 {
		// Умеет ли модель смотреть картинки — спрашиваем у провайдера, а не надеемся,
		// что «как-нибудь разберётся»: модель, которая картинок не видит, ответит так,
		// будто их не было, и человек будет думать, что она их посмотрела.
		vision, err := s.models.SupportsVision(ctx, userID, provider, model)
		if err != nil {
			return nil, err
		}
		if !vision {
			return nil, fmt.Errorf("%w: %s", ai.ErrNoVision, model)
		}
	}

	conversation, err := s.conversation(ctx, userID, projectID, conversationID, modelRef, text)
	if err != nil {
		return nil, err
	}

	project, err := s.store.GetProject(ctx, projectID)
	if err != nil {
		return nil, err
	}
	list, err := s.store.ListEvents(ctx, projectID)
	if err != nil {
		return nil, err
	}

	history, err := s.history(ctx, conversation.ID)
	if err != nil {
		return nil, err
	}

	// Вопрос записываем ДО ответа: если провайдер не ответит, история всё равно
	// покажет, что человек спрашивал (иначе вопрос исчез бы вместе с ошибкой).
	if _, err := s.store.AppendAIMessage(ctx, store.AIMessage{
		ConversationID: conversation.ID, Role: "user", Content: text,
	}); err != nil {
		return nil, err
	}

	// Первое событие потока — идентификатор беседы. При «новой беседе» он известен
	// только сейчас, а без него остановленный ответ остался бы в беседе, о которой
	// интерфейс не знает: следующий вопрос завёл бы вторую, и кусок ответа потерялся
	// бы из переписки.
	if emit != nil {
		if err := emit(Event{Type: EventStart, ConversationID: conversation.ID.String()}); err != nil {
			return s.finishStopped(ctx, conversation, model, "", 0, 0)
		}
	}

	messages := make([]ai.Message, 0, len(history)+3)
	messages = append(messages, ai.Message{
		Role: "system",
		Content: systemPrompt(project, personaOf(settings), s.limits.MaxToolCalls, caps) + "\n\n" +
			treeContext(list, s.limits.MaxEventsInPrompt),
	})
	messages = append(messages, history...)
	// Картинки идут с вопросом человека и только с ним: в историю они не пишутся (см.
	// SendStreamImages), а в этом запросе модель должна их видеть.
	messages = append(messages, ai.Message{Role: "user", Content: text, Images: images})

	// Кадры помощник создаёт САМ: автором правок становится агент, а не человек,
	// который нажал «спросить» (права при этом проверяются по человеку).
	turn, err := s.converse(ctx, ai.AgentUserID, userID, provider, model, conversation, messages, caps, emit)
	if err != nil {
		return nil, err
	}
	// Предложения следующих шагов — по состоянию проекта ПОСЛЕ ответа: агент мог только
	// что создать главу, и предлагать сделанное было бы издевательством.
	turn.Suggestions = s.suggestionsFor(context.WithoutCancel(ctx), projectID, caps)
	// Отметка «свежая» — тем же контекстом без отмены: если человек нажал «стоп»,
	// беседа всё равно должна обновиться (ответ-то в ней уже есть).
	if err := s.store.TouchAIConversation(context.WithoutCancel(ctx), conversation.ID, modelRef); err != nil {
		// История важнее отметки «свежая»: сбой обновления времени не повод терять ответ.
		s.logger.Warn("ai: не удалось обновить беседу", "conversation", conversation.ID, "err", err)
	}
	if len(turn.Changes) > 0 {
		s.logger.Info("ai: помощник изменил проект",
			"user", userID, "project", projectID, "provider", provider,
			"changes", len(turn.Changes), "calls", len(turn.Calls), "stopped", turn.Stopped)
	}
	return turn, nil
}

// checkBudget проверяет предел расхода за сутки.
//
// Предел задаёт админ стенда (AI_TOKENS_PER_DAY); 0 — без предела. Сбой подсчёта НЕ
// запрещает разговор: это ограничение расходов, а не защита секретов, и падать из-за
// него в самый неподходящий момент было бы хуже, чем потерять контроль за сутки.
func (s *Service) checkBudget(ctx context.Context, userID uuid.UUID) error {
	limit := s.models.TokensPerDay()
	if limit <= 0 {
		return nil
	}
	spent, err := s.models.SpentTokens(ctx, userID)
	if err != nil {
		s.logger.Warn("ai: расход за сутки не посчитан", "user", userID, "err", err)
		return nil
	}
	if spent >= limit {
		return fmt.Errorf("%w: израсходовано %d из %d за последние сутки", ErrTokenBudget, spent, limit)
	}
	return nil
}

// resolveModel выбирает модель: явную или модель по умолчанию стенда.
func (s *Service) resolveModel(ref string) (provider, model string, err error) {
	if strings.TrimSpace(ref) == "" {
		ref = s.models.DefaultModel()
	}
	if strings.TrimSpace(ref) == "" {
		return "", "", ErrModelRequired
	}
	return ai.ParseModelRef(ref)
}

// conversation находит беседу или заводит новую.
func (s *Service) conversation(
	ctx context.Context, userID, projectID, conversationID uuid.UUID, modelRef, text string,
) (*store.AIConversation, error) {
	if conversationID == uuid.Nil {
		return s.store.CreateAIConversation(ctx, projectID, userID, titleFromText(text), modelRef)
	}
	conversation, err := s.store.AIConversationByID(ctx, conversationID, userID)
	if err != nil {
		return nil, err
	}
	// Беседа принадлежит проекту: подставить чужой идентификатор и писать в проект,
	// к которому беседа не относится, нельзя — это была бы запись не туда.
	if conversation.ProjectID != projectID {
		return nil, store.ErrNotFound
	}
	return conversation, nil
}

// history готовит историю переписки для модели.
//
// Только реплики человека и текст ответов: служебные tool-сообщения прошлых вопросов
// не переигрываем. Протокол инструментов требует пары «вызов → результат» внутри
// одного обмена, а из истории видно лишь часть, и модель получила бы висящий вызов.
// Итог сказанного моделью и так в тексте ответа.
func (s *Service) history(ctx context.Context, conversationID uuid.UUID) ([]ai.Message, error) {
	stored, err := s.store.ListAIMessages(ctx, conversationID, s.limits.MaxHistory)
	if err != nil {
		return nil, err
	}
	out := make([]ai.Message, 0, len(stored))
	for _, m := range stored {
		switch m.Role {
		case "user":
			out = append(out, ai.Message{Role: "user", Content: m.Content})
		case "assistant":
			if strings.TrimSpace(m.Content) == "" {
				continue
			}
			out = append(out, ai.Message{Role: "assistant", Content: m.Content})
		}
	}
	return out, nil
}

// converse — цикл «спросили модель → выполнили инструменты → спросили снова».
//
// actorID — от чьего имени помощник правит проект (агент), userID — чьими правами он
// это делает (человек, нажавший «спросить»). Две разные вещи: агент участник проекта,
// но действует только там, где человек имеет право писать.
//
// emit == nil — человек ждёт один JSON; иначе текст уходит кусками по мере генерации,
// а вызовы инструментов — событиями сразу после выполнения.
func (s *Service) converse(
	ctx context.Context, actorID, userID uuid.UUID, provider, model string,
	conversation *store.AIConversation, messages []ai.Message, caps Capabilities, emit Emitter,
) (*Turn, error) {
	turn := &Turn{
		ConversationID: conversation.ID,
		Model:          model,
		Calls:          []Call{},
		Changes:        []Change{},
	}
	used := 0
	answer := ""
	tokensIn, tokensOut := 0, 0

	// ask — один запрос к модели. Потоком, если события нужны, и обычным запросом,
	// если нет. Возвращает и то, что уже ушло человеку кусками: при обрыве это
	// единственный текст, который у него есть, и его надо сохранить.
	//
	// Куски проходят через streamGate: модель может отвечать не текстом, а вызовом
	// инструмента или рассуждениями в служебном канале, и показывать это человеку
	// нельзя (подробности — в stream_gate.go).
	//
	// Счётчики токенов: у провайдера они точные, но приходят не от всех серверов
	// (в потоке — далеко не от всех). Если счётчика нет, считаем оценкой: иначе расход
	// молча оказался бы нулевым и предел не работал бы ровно там, где он нужен.
	fillTokens := func(req ai.Request, reply ai.Reply) ai.Reply {
		if reply.TokensIn <= 0 {
			reply.TokensIn = ai.EstimateRequestTokens(req)
		}
		if reply.TokensOut <= 0 {
			reply.TokensOut = ai.EstimateTokens(reply.Content)
		}
		return reply
	}
	ask := func(req ai.Request) (ai.Reply, string, error) {
		if emit == nil {
			reply, err := s.models.Chat(ctx, userID, provider, req)
			return fillTokens(req, reply), "", err
		}
		gate := newStreamGate(func(text string) error {
			if err := emit(Event{Type: EventDelta, Text: text}); err != nil {
				// Писать больше некуда: прекращаем генерацию, а не копим текст в никуда.
				return errStreamStopped
			}
			return nil
		})
		reply, err := s.models.StreamChat(ctx, userID, provider, req, gate.feed)
		if err == nil {
			// Раунд кончился: придержанное начало (короткий ответ) пора показать.
			if finishErr := gate.finish(); finishErr != nil {
				err = finishErr
			}
		}
		return fillTokens(req, reply), gate.visibleText(), err
	}

	for round := 0; round < s.limits.MaxRounds; round++ {
		reply, partial, err := ask(ai.Request{
			Model:       model,
			Messages:    messages,
			Tools:       ToolDefs(caps),
			Temperature: 0.4,
		})
		if err != nil {
			if stoppedByClient(err) {
				return s.finishStopped(ctx, conversation, model, partial, tokensIn, tokensOut)
			}
			return nil, err
		}
		tokensIn += reply.TokensIn
		tokensOut += reply.TokensOut

		content, calls := reply.Content, reply.ToolCalls
		if len(calls) == 0 {
			// Текстовый протокол: модель написала вызов блоком ```skyfraze-tools.
			content, calls = ParseTextToolCalls(content)
		}
		if len(calls) == 0 {
			answer = strings.TrimSpace(content)
			break
		}

		// Модель просит изменения: сначала записываем её ход в историю, потом
		// выполняем — порядок тот же, что у человека в интерфейсе.
		if _, err := s.store.AppendAIMessage(ctx, store.AIMessage{
			ConversationID: conversation.ID, Role: "assistant",
			Content: content, ToolCalls: mustJSON(calls), Model: model,
			TokensIn: reply.TokensIn, TokensOut: reply.TokensOut,
		}); err != nil {
			return nil, err
		}
		messages = append(messages, ai.Message{Role: "assistant", Content: content, ToolCalls: calls})

		results := make([]toolResult, 0, len(calls))
		for _, call := range calls {
			if used >= s.limits.MaxToolCalls {
				results = append(results, refusedCall(call,
					fmt.Sprintf("лимит изменений за одно сообщение исчерпан (%d)", s.limits.MaxToolCalls)))
				continue
			}
			used++
			results = append(results, s.execute(ctx, actorID, userID, conversation.ProjectID, call, caps))
		}

		payload := make([]toolPayload, 0, len(results))
		for _, res := range results {
			turn.Calls = append(turn.Calls, res.report)
			if res.change != nil {
				turn.Changes = append(turn.Changes, *res.change)
			}
			payload = append(payload, toolPayload{
				ToolCallID: res.call.ID, Name: res.call.Name, Result: res.payload,
			})
			messages = append(messages, ai.Message{
				Role: "tool", ToolCallID: res.call.ID, Name: res.call.Name,
				Content: string(mustJSON(res.payload)),
			})
		}
		if _, err := s.store.AppendAIMessage(ctx, store.AIMessage{
			ConversationID: conversation.ID, Role: "tool",
			Content:     summary(results),
			ToolResults: mustJSON(payload),
		}); err != nil {
			return nil, err
		}
		// События — ПОСЛЕ записи в историю: человек должен видеть только то, что уже
		// не потеряется, если он закроет окно через секунду.
		if emit != nil {
			for _, res := range results {
				report := res.report
				if err := emit(Event{Type: EventCall, Call: &report}); err != nil {
					return s.finishStopped(ctx, conversation, model, "", tokensIn, tokensOut)
				}
				if res.change != nil {
					change := *res.change
					if err := emit(Event{Type: EventChange, Change: &change}); err != nil {
						return s.finishStopped(ctx, conversation, model, "", tokensIn, tokensOut)
					}
				}
			}
		}
	}

	if answer == "" {
		// Раунды кончились на вызовах: просим итог словами, уже без инструментов —
		// человек должен получить ответ, а не молчание с созданными кадрами.
		reply, partial, err := ask(ai.Request{Model: model, Messages: messages, Temperature: 0.4})
		if err != nil {
			if stoppedByClient(err) {
				return s.finishStopped(ctx, conversation, model, partial, tokensIn, tokensOut)
			}
			return nil, err
		}
		tokensIn += reply.TokensIn
		tokensOut += reply.TokensOut
		answer = strings.TrimSpace(reply.Content)
	}
	if answer == "" {
		answer = "Готово."
	}

	saved, err := s.store.AppendAIMessage(ctx, store.AIMessage{
		ConversationID: conversation.ID, Role: "assistant", Content: answer,
		Model: model, TokensIn: tokensIn, TokensOut: tokensOut,
	})
	if err != nil {
		return nil, err
	}
	turn.Message = *saved
	turn.Answer = answer
	return turn, nil
}

// finishStopped сохраняет то, что модель успела сказать, и возвращает итог с пометкой
// «остановлено».
//
// Контекст берём без отмены: запрос уже оборван, и обычный ctx не дал бы записать
// ровно то, ради чего всё делается. Пустой текст не сохраняем — сообщения-призрака без
// содержания в истории быть не должно (вопрос человека там уже есть, и его отсутствие
// ответа — правда).
func (s *Service) finishStopped(
	ctx context.Context, conversation *store.AIConversation, model, partial string, tokensIn, tokensOut int,
) (*Turn, error) {
	turn := &Turn{
		ConversationID: conversation.ID,
		Model:          model,
		Stopped:        true,
		Calls:          []Call{},
		Changes:        []Change{},
	}
	if strings.TrimSpace(partial) == "" {
		return turn, nil
	}
	// Расход оборванного ответа оцениваем: провайдер счётчиков уже не пришлёт, а
	// сказанное моделью было потрачено по-настоящему.
	tokensOut += ai.EstimateTokens(partial)
	saved, err := s.store.AppendAIMessage(context.WithoutCancel(ctx), store.AIMessage{
		ConversationID: conversation.ID, Role: "assistant", Content: partial,
		Model: model, TokensIn: tokensIn, TokensOut: tokensOut, Stopped: true,
	})
	if err != nil {
		return nil, err
	}
	turn.Message = *saved
	turn.Answer = partial
	return turn, nil
}

// titleFromText — заголовок беседы по первому вопросу: иначе список бесед состоял бы
// из одинаковых «Новая беседа».
func titleFromText(text string) string {
	line := text
	if idx := strings.IndexAny(line, "\r\n"); idx >= 0 {
		line = line[:idx]
	}
	runes := []rune(strings.TrimSpace(line))
	if len(runes) > 60 {
		return strings.TrimSpace(string(runes[:60])) + "…"
	}
	return string(runes)
}

// toolPayload — результат одного вызова, который уходит модели и в историю.
type toolPayload struct {
	ToolCallID string `json:"tool_call_id"`
	Name       string `json:"name"`
	Result     any    `json:"result"`
}

// summary — человеческая строка «что сделали» для истории беседы.
func summary(results []toolResult) string {
	parts := make([]string, 0, len(results))
	for _, res := range results {
		switch {
		case !res.report.OK:
			parts = append(parts, res.call.Name+": ошибка — "+res.report.Error)
		case res.report.Detail != "":
			parts = append(parts, res.call.Name+": "+res.report.Detail)
		default:
			parts = append(parts, res.call.Name+": выполнено")
		}
	}
	return strings.Join(parts, "; ")
}

// mustJSON сериализует то, что уже сериализуемо по построению (карты и срезы из
// аргументов модели). Ошибка здесь означала бы неверный тип у нас, а не у модели.
func mustJSON(v any) json.RawMessage {
	raw, err := json.Marshal(v)
	if err != nil {
		return json.RawMessage("[]")
	}
	return raw
}

// depthLimitError — отказ по глубине в понятных словах.
func depthLimitError() error {
	return fmt.Errorf("под этот кадр нельзя вложить ещё один: %s (%d)", maxDepthHint(), events.MaxDepth)
}
