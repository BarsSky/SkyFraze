// Package transfer — перенос проекта между инсталляциями SkyFraze.
//
// Экспорт собирает один ZIP-архив, который потом можно загрузить на другом
// стенде: метаданные проекта, дерево событий, CRDT-снапшот (в нём живут тексты,
// фон кадров и привязки вложений) и сами файлы вложений.
//
// Почему идентификаторы сохраняются как есть: CRDT-снапшот — бинарный Yjs-update,
// и переписать ссылки на события/вложения внутри него без парсера Yjs невозможно.
// Поэтому импорт переносит id один в один, а повторную загрузку того же архива
// распознаёт по уже существующим id и объясняет это пользователю (ErrAlreadyImported).
package transfer

import (
	"archive/zip"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"strings"
	"time"

	"github.com/google/uuid"

	"github.com/skyfraze/backend/internal/entities"
	"github.com/skyfraze/backend/internal/events"
	"github.com/skyfraze/backend/internal/projects"
	"github.com/skyfraze/backend/internal/projecttemplate"
	"github.com/skyfraze/backend/internal/storage"
	"github.com/skyfraze/backend/internal/store"
)

// Формат и версия архива. Версия позволяет менять структуру, не ломая старые файлы.
const (
	FormatName    = "skyfraze-project"
	FormatVersion = 1

	manifestName = "manifest.json"
	stateName    = "state.bin"
	assetsDir    = "assets/"
	// templateFile — шаблон проекта: типы карточек и настройки помощника (0.85.0).
	//
	// Отдельным файлом, а не полем манифеста: шаблон — самостоятельный формат (его отдаёт
	// GET /api/projects/{id}/template и принимает POST), и держать его в двух видах значило бы
	// поддерживать два парсера одного JSON. Старые сборки этот файл просто не читают: импорт
	// ходит по манифесту, а лишние файлы в архиве уже есть (story.md).
	templateFile = "template.json"
	// conversationsFile — история бесед с помощником (0.148.0).
	//
	// Отдельным файлом и только СВОИ беседы выгружающего: переписка — личная, и чужие
	// разговоры в архив попадать не должны. Старые сборки файл не читают, новые читают
	// необязательным: архивы до 0.148.0 его не содержат, и это не ошибка.
	conversationsFile = "ai-history.json"
	// knowledgeFile — знания проекта (0.149.0). В отличие от истории бесед это СОДЕРЖИМОЕ
	// проекта, а не личные заметки: в архив попадают знания всех авторов, и импорт
	// восстанавливает их с исходными датами — «когда это придумали» часть работы.
	knowledgeFile = "ai-knowledge.json"

	// MaxBundleSize — потолок размера архива (nginx пускает столько же).
	MaxBundleSize = 200 << 20 // 200 MB
	// maxEntrySize — потолок на один файл внутри архива (совпадает с лимитом ассета).
	maxEntrySize = 50 << 20
	// maxEvents / maxAssets защищают от архива-«бомбы» с миллионом записей.
	maxEvents = 5000
	maxAssets = 500
	// maxConversations / maxMessagesPerConversation — те же предохранители для истории
	// бесед: переписка не должна превращать архив в бомбу.
	maxConversations           = 200
	maxMessagesPerConversation = 1000
	// maxKnowledge — тот же предохранитель для знаний: их число не должно превращать
	// архив в бомбу. Пятьсот знаний — это книга тезисов целиком.
	maxKnowledge = 500
)

var (
	ErrBadBundle         = errors.New("bad bundle")
	ErrUnsupportedFormat = errors.New("unsupported bundle format")
	ErrTooLarge          = errors.New("bundle too large")
	ErrAlreadyImported   = errors.New("bundle already imported")
	ErrForbidden         = errors.New("forbidden")
	ErrNotFound          = errors.New("not found")
	// ErrMarkdownTooDeep — импортируемый кусок не помещается в выбранное место:
	// уровень места плюс глубина куска больше предела дерева. Это отказ ДО записи:
	// события не вставлены ни в документ, ни в таблицу.
	ErrMarkdownTooDeep = errors.New("кусок не помещается в выбранное место")
	// ErrMarkdownBusy — документ комнаты проекта сейчас загружается, и трогать его
	// нельзя: запись в снапшот в этот момент затрётся состоянием комнаты. Запрос
	// повторяемый: место не изменено, кусок не вставлен.
	ErrMarkdownBusy = errors.New("документ проекта загружается, повторите запрос через секунду")
)

// Manifest — содержимое manifest.json.
type Manifest struct {
	Format     string        `json:"format"`
	Version    int           `json:"version"`
	ExportedAt time.Time     `json:"exported_at"`
	App        string        `json:"app"`
	Project    ProjectMeta   `json:"project"`
	Events     []EventRecord `json:"events"`
	Assets     []AssetRecord `json:"assets"`
	// Entities — карточки персонажей, мест и тем (0.69.0). Поле добавлено в ТУ ЖЕ версию
	// формата: старые архивы читаются (поля просто нет), а старые сборки, встретив его,
	// проигнорируют. Повышать версию значило бы «новые архивы не открываются старыми
	// сборками» ради поля, которое можно не заметить.
	Entities []EntityRecord `json:"entities,omitempty"`
	HasState bool           `json:"has_state"`
}

// EntityRecord — карточка сущности в архиве.
//
// Идентификатор не переносим: при импорте карточка — это имя в НОВОМ проекте, и её id всё
// равно будет свой (упоминания пока не хранятся на сервере, ссылаться не на что).
type EntityRecord struct {
	Kind        string   `json:"kind"`
	Name        string   `json:"name"`
	Aliases     []string `json:"aliases,omitempty"`
	Description string   `json:"description,omitempty"`
	Color       string   `json:"color,omitempty"`
}

type ProjectMeta struct {
	Title       string `json:"title"`
	Description string `json:"description"`
}

type EventRecord struct {
	ID        uuid.UUID  `json:"id"`
	ParentID  *uuid.UUID `json:"parent_id"`
	Position  int        `json:"position"`
	Depth     int16      `json:"depth"`
	Title     string     `json:"title"`
	Body      string     `json:"body"`
	EventDate *time.Time `json:"event_date,omitempty"`
}

type AssetRecord struct {
	ID       uuid.UUID `json:"id"`
	Filename string    `json:"filename"`
	Mime     string    `json:"mime"`
	Size     int64     `json:"size"`
	Kind     string    `json:"kind"`
	Width    *int      `json:"width,omitempty"`
	Height   *int      `json:"height,omitempty"`
	// File — путь внутри архива (assets/<id>).
	File string `json:"file"`
}

// ConversationsFile — история бесед с помощником в архиве (0.148.0).
//
// Пишем только реплики человека и текст ответов: служебные строки результатов инструментов
// (`role=tool`) — это внутренний протокол, в новой базе они не переигрываются (history()
// их и так не берёт), а размер архива увеличивали бы заметно.
type ConversationsFile struct {
	Conversations []ConversationRecord `json:"conversations"`
}

// ConversationRecord — одна беседа в архиве.
type ConversationRecord struct {
	Title     string          `json:"title"`
	Model     string          `json:"model"`
	CreatedAt time.Time       `json:"created_at"`
	Messages  []MessageRecord `json:"messages"`
}

// MessageRecord — реплика беседы в архиве.
type MessageRecord struct {
	Role    string `json:"role"`
	Content string `json:"content"`
	// Stopped — ответ оборван человеком: пометка «остановлено» должна пережить перенос.
	Stopped bool `json:"stopped,omitempty"`
	// Knowledge — знания, приложенные к реплике (0.150.0). Снимок заголовка, а не ссылка:
	// после импорта у знаний новые идентификаторы, но карточка под сообщением должна
	// остаться читаемой — по этому снимку она и рисуется.
	Knowledge []KnowledgeRefRecord `json:"knowledge,omitempty"`
	// ToolCalls/ToolResults — протокол вызовов (0.154.0). Строки `role=tool` раньше в архив
	// не попадали: «внутренний протокол, в новой базе не переигрывается». Но по ним видно,
	// что помощник читал и почему решил так, — это часть истории работы над проектом, и
	// вторая половина уезжала без неё. Поля необязательные: архивы до этой версии их не
	// содержат, а история (history()) их и не переигрывает — только показывает.
	ToolCalls   json.RawMessage `json:"tool_calls,omitempty"`
	ToolResults json.RawMessage `json:"tool_results,omitempty"`
}

// KnowledgeRefRecord — вложение к реплике в архиве.
type KnowledgeRefRecord struct {
	ID    uuid.UUID `json:"id"`
	Title string    `json:"title"`
	// Tags — снимок меток (0.154.0): карточка под сообщением показывает, о чём знание.
	Tags []string `json:"tags,omitempty"`
}

// KnowledgeFile — знания проекта в архиве (0.149.0).
type KnowledgeFile struct {
	Knowledge []KnowledgeRecord `json:"knowledge"`
}

// KnowledgeRecord — одно знание в архиве.
//
// Автор и дата — часть содержания: через год должно быть видно, что «решили в марте»,
// а не «импортировано вчера». Автора храним именем (снимком), потому что учётной записи
// из старой базы в новой может не быть.
type KnowledgeRecord struct {
	// ID — идентификатор в исходной базе (0.152.0). Нужен, чтобы переписать вложения
	// сообщений на новые знания: у реплик хранится снимок {id,title}, и без карты id
	// карточка после импорта осталась бы «мёртвой».
	ID        uuid.UUID `json:"id,omitempty"`
	Title     string    `json:"title"`
	Summary   string    `json:"summary,omitempty"`
	Body      string    `json:"body"`
	Tags      []string  `json:"tags,omitempty"`
	Chars     int       `json:"chars,omitempty"`
	Author    string    `json:"author,omitempty"`
	CreatedAt time.Time `json:"created_at"`
}

// ExportInfo — что получилось выгрузить (для заголовков ответа и лога).
type ExportInfo struct {
	Title    string
	Events   int
	Assets   int
	HasState bool
	Bytes    int64
	Filename string
}

// Result — итог импорта.
type Result struct {
	Project  *store.Project `json:"project"`
	Events   int            `json:"events"`
	Assets   int            `json:"assets"`
	HasState bool           `json:"has_state"`
	// Entities — сколько карточек мира перенесено (0.69.0).
	Entities int `json:"entities"`
	// Conversations — сколько бесед с помощником перенесено (0.148.0). Нет файла в
	// архиве — ноль и никакой ошибки: старые архивы его не содержат.
	Conversations int `json:"conversations"`
	// Knowledge — сколько знаний проекта перенесено (0.149.0).
	Knowledge int `json:"knowledge"`
	// Template — что принёс шаблон проекта (0.85.0): типы карточек и настройки помощника.
	// Нет в архиве шаблона — поля нет, и это не ошибка: старые архивы его не содержат.
	Template *projecttemplate.Report `json:"template,omitempty"`
}

type Service struct {
	store *store.Store
	obj   storage.ObjectStore
	proj  *projects.Service
	// live — документ живой комнаты проекта (см. LiveDoc): нужен импорту «в
	// место», чтобы вставка попала в документ, который видят редакторы.
	live LiveDoc
	// liveState — состояние живой комнаты (см. LiveState): по нему выгрузка берёт текст,
	// который сейчас в документе, а не тот, что успел доехать до таблицы событий.
	liveState LiveState
	// files — запись файлов проекта (assets.Service): импорт идёт тем же путём, что
	// и загрузка из интерфейса, иначе дедупликация по содержимому обходилась бы
	// стороной (см. FileStore).
	files FileStore
	// quotaSource — предел вложений проекта: предпросмотр показывает его человеку
	// (см. UseQuota). Без источника предел считается unlimited (0).
	quotaSource QuotaSource
	// entities — карточки мира: импорт архива переносит их вместе с проектом (0.69.0).
	entities *entities.Service
	// templates — шаблон проекта (0.85.0): архив возит типы карточек и настройки помощника
	// файлом template.json. Без подключённого шаблона архив просто не содержит этот файл.
	templates Templates
	// docxTemplates — шаблоны оформления DOCX (0.91.0): активный шаблон определяет вид
	// скачиваемого документа. Без подключённых шаблонов DOCX собирается встроенным оформлением.
	docxTemplates DocxTemplates
	// logger — предупреждения выгрузки (например, шаблон не применился). Необязателен.
	logger *slog.Logger
}

// UseDocxTemplates подключает шаблоны оформления DOCX (0.91.0).
func (s *Service) UseDocxTemplates(templates DocxTemplates) { s.docxTemplates = templates }

// UseLogger подключает лог для предупреждений выгрузки.
func (s *Service) UseLogger(logger *slog.Logger) { s.logger = logger }

// Templates — шаблон проекта (реализует projecttemplate.Service).
//
// Интерфейс, а не конкретный тип: transfer переносит содержимое, а устройство проекта — чужая
// забота, и связывать пакеты жёстко можно только ради двух вызовов. Импорт вызывает ApplyAs:
// права уже проверены тем, что проект только что создан этим же человеком.
type Templates interface {
	Build(ctx context.Context, projectID uuid.UUID, withCards bool) (*projecttemplate.Template, error)
	ApplyAs(ctx context.Context, userID, projectID uuid.UUID, t *projecttemplate.Template) (*projecttemplate.Report, error)
}

// UseTemplates подключает шаблон проекта: архив начнёт возить template.json.
func (s *Service) UseTemplates(t Templates) { s.templates = t }

func New(s *store.Store, obj storage.ObjectStore, proj *projects.Service) *Service {
	return &Service{store: s, obj: obj, proj: proj}
}

// SlugifyFileName — безопасное имя файла из заголовка проекта (кириллица
// отбрасывается, поэтому при пустом результате используется «project»).
func SlugifyFileName(title string) string {
	var b strings.Builder
	prevDash := false
	for _, r := range strings.ToLower(title) {
		switch {
		case r >= 'a' && r <= 'z', r >= '0' && r <= '9':
			b.WriteRune(r)
			prevDash = false
		case r == ' ' || r == '-' || r == '_' || r == '.':
			if !prevDash && b.Len() > 0 {
				b.WriteByte('-')
				prevDash = true
			}
		}
		if b.Len() >= 40 {
			break
		}
	}
	out := strings.Trim(b.String(), "-")
	if out == "" {
		return "project"
	}
	return out
}

// Export собирает архив проекта в w. Требуется роль viewer+ (читатель и так видит
// всё содержимое проекта, поэтому выгрузка не расширяет его права). Владельцу доступна и
// выгрузка проекта ИЗ КОРЗИНЫ: посмотреть, что удаляешь, — часть права на возврат, а не
// отдельное разрешение (см. projects.Service.GetForExport).
func (s *Service) Export(ctx context.Context, userID, projectID uuid.UUID, w io.Writer) (*ExportInfo, error) {
	p, err := s.proj.GetForExport(ctx, userID, projectID)
	if err != nil {
		if errors.Is(err, projects.ErrForbidden) {
			return nil, ErrForbidden
		}
		if errors.Is(err, projects.ErrNotFound) || errors.Is(err, store.ErrNotFound) {
			return nil, ErrNotFound
		}
		return nil, err
	}
	evs, err := s.store.ListEvents(ctx, projectID)
	if err != nil {
		return nil, err
	}
	assets, err := s.store.ListAssets(ctx, projectID)
	if err != nil {
		return nil, err
	}
	state, err := s.store.GetProjectEventState(ctx, projectID)
	if err != nil {
		return nil, err
	}

	m := Manifest{
		Format:     FormatName,
		Version:    FormatVersion,
		ExportedAt: time.Now().UTC(),
		App:        "SkyFraze",
		Project:    ProjectMeta{Title: p.Title, Description: p.Description},
		Events:     make([]EventRecord, 0, len(evs)),
		Assets:     make([]AssetRecord, 0, len(assets)),
	}
	for _, e := range evs {
		m.Events = append(m.Events, EventRecord{
			ID: e.ID, ParentID: e.ParentID, Position: e.Position, Depth: e.Depth,
			Title: e.Title, Body: e.Body, EventDate: e.EventDate,
		})
	}
	for _, a := range assets {
		m.Assets = append(m.Assets, AssetRecord{
			ID: a.ID, Filename: a.Filename, Mime: a.Mime, Size: a.Size, Kind: a.Kind,
			Width: a.Width, Height: a.Height, File: assetsDir + a.ID.String(),
		})
	}
	// Карточки мира едут вместе с проектом (0.69.0): без них импорт терял бы связи, ради
	// которых их и заводили.
	if list, err := s.store.ListEntities(ctx, projectID); err == nil {
		m.Entities = make([]EntityRecord, 0, len(list))
		for _, entity := range list {
			m.Entities = append(m.Entities, EntityRecord{
				Kind: entity.Kind, Name: entity.Name, Aliases: entity.Aliases,
				Description: entity.Description, Color: entity.Color,
			})
		}
	}
	var stateBytes []byte
	if state != nil && len(state.YjsState) > 0 {
		m.HasState = true
		stateBytes = state.YjsState
	}

	// Шаблон проекта (0.85.0) собираем ДО первой записи в поток: если он не собрался, ответ
	// должен быть честной ошибкой, а не полуархивом с оборванным zip.
	//
	// Карточки в шаблон архива не кладём: они уже едут в манифесте, и второе их появление
	// означало бы двойной проход при импорте.
	var templateBytes []byte
	if s.templates != nil {
		template, terr := s.templates.Build(ctx, projectID, false)
		if terr != nil {
			return nil, terr
		}
		templateBytes, err = json.MarshalIndent(template, "", "  ")
		if err != nil {
			return nil, err
		}
	}

	counter := &countingWriter{w: w}
	zw := zip.NewWriter(counter)

	// История бесед (0.148.0) — до первой записи в поток, как и шаблон: если она не собралась,
	// ответ должен быть ошибкой, а не полуархивом.
	conversationsBytes, err := s.buildConversations(ctx, userID, projectID)
	if err != nil {
		return nil, err
	}
	// Знания проекта (0.149.0) — там же и по той же причине. Знаний у проекта может не
	// быть: тогда файла в архиве нет вовсе.
	knowledgeBytes, err := s.buildKnowledge(ctx, projectID)
	if err != nil {
		return nil, err
	}

	manifestBytes, err := json.MarshalIndent(m, "", "  ")
	if err != nil {
		return nil, err
	}
	if err := writeZipFile(zw, manifestName, manifestBytes); err != nil {
		return nil, err
	}
	if templateBytes != nil {
		if err := writeZipFile(zw, templateFile, templateBytes); err != nil {
			return nil, err
		}
	}
	if conversationsBytes != nil {
		if err := writeZipFile(zw, conversationsFile, conversationsBytes); err != nil {
			return nil, err
		}
	}
	if knowledgeBytes != nil {
		if err := writeZipFile(zw, knowledgeFile, knowledgeBytes); err != nil {
			return nil, err
		}
	}
	if m.HasState {
		if err := writeZipFile(zw, stateName, state.YjsState); err != nil {
			return nil, err
		}
	}
	for _, a := range assets {
		rc, err := s.obj.Get(ctx, a.S3Key)
		if err != nil {
			// Файла нет в хранилище — не роняем весь экспорт: без него проект
			// всё равно переносится, а в лог попадает причина.
			continue
		}
		if err := writeZipStream(zw, assetsDir+a.ID.String(), rc); err != nil {
			rc.Close()
			return nil, err
		}
		rc.Close()
	}

	// Человекочитаемая версия проекта: та же лента, что отдаёт
	// GET /api/projects/{id}/export.md?assets=1, но ссылки указывают на файлы
	// ЭТОГО архива (assets/<id>). Манифест и раскладку вложений не меняем —
	// старые версии SkyFraze читают файлы по полю file, а новые просто находят
	// рядом со манифестом ещё и story.md со story/. Импорт переноса эти файлы
	// игнорирует (он ходит только по манифесту).
	storyLane, storyFiles := newStory(p, evs, assets, stateBytes).archiveStoryFiles()
	if err := writeZipFile(zw, storyFileName, storyLane); err != nil {
		return nil, err
	}
	for _, f := range storyFiles {
		if err := writeZipFile(zw, f.Name, f.Content); err != nil {
			return nil, err
		}
	}
	if err := zw.Close(); err != nil {
		return nil, err
	}

	return &ExportInfo{
		Title:    p.Title,
		Events:   len(m.Events),
		Assets:   len(m.Assets),
		HasState: m.HasState,
		Bytes:    counter.n,
		Filename: SlugifyFileName(p.Title) + ".skyfraze.zip",
	}, nil
}

// buildConversations собирает файл истории бесед для архива (0.148.0).
//
// Только беседы САМОГО выгружающего: переписка личная, и разговоры коллег в архив попадать
// не должны. Пустой набор — nil (файла нет), это нормальный случай: у проекта может не быть
// ни одной беседы.
func (s *Service) buildConversations(
	ctx context.Context, userID, projectID uuid.UUID,
) ([]byte, error) {
	list, err := s.store.ListAIConversations(ctx, projectID, userID)
	if err != nil {
		return nil, err
	}
	records := make([]ConversationRecord, 0, len(list))
	for _, conversation := range list {
		messages, merr := s.store.ListAIMessages(ctx, conversation.ID, maxMessagesPerConversation)
		if merr != nil {
			return nil, merr
		}
		record := ConversationRecord{
			Title: conversation.Title, Model: conversation.Model, CreatedAt: conversation.CreatedAt,
		}
		for _, message := range messages {
			if message.Role != "user" && message.Role != "assistant" && message.Role != "tool" {
				continue
			}
			// Строка инструмента без текста, но с вызовами — тоже след работы: сохраняем её,
			// если есть что перенести (0.154.0).
			if strings.TrimSpace(message.Content) == "" && len(message.ToolCalls) == 0 && len(message.ToolResults) == 0 {
				continue
			}
			record.Messages = append(record.Messages, MessageRecord{
				Role: message.Role, Content: message.Content, Stopped: message.Stopped,
				Knowledge:   decodeKnowledgeRefs(message.Knowledge),
				ToolCalls:   capToolPayload(message.ToolCalls),
				ToolResults: capToolPayload(message.ToolResults),
			})
		}
		if len(record.Messages) == 0 {
			continue
		}
		records = append(records, record)
		if len(records) >= maxConversations {
			break
		}
	}
	if len(records) == 0 {
		return nil, nil
	}
	return json.MarshalIndent(ConversationsFile{Conversations: records}, "", "  ")
}

// decodeKnowledgeRefs разбирает jsonb вложений сообщения в записи архива.
//
// Битый JSON — не ошибка архива: вложения вспомогательные, и терять из-за них переписку
// нельзя. Просто не переносим их.
func decodeKnowledgeRefs(raw json.RawMessage) []KnowledgeRefRecord {
	if len(raw) == 0 {
		return nil
	}
	var refs []KnowledgeRefRecord
	if err := json.Unmarshal(raw, &refs); err != nil {
		return nil
	}
	return refs
}

// encodeKnowledgeRefs — обратно в jsonb при импорте.
func encodeKnowledgeRefs(refs []KnowledgeRefRecord) json.RawMessage {
	if len(refs) == 0 {
		return nil
	}
	raw, err := json.Marshal(refs)
	if err != nil {
		return nil
	}
	return raw
}

// maxToolPayloadBytes — предел на одно поле протокола инструмента в архиве (0.154.0).
//
// 16 КиБ хватает на обычный вызов (абзацы, карточки), а всё, что больше, — это уже не
// «след работы», а второй проект: такой вызов не переносим, но строку оставляем с текстом.
const maxToolPayloadBytes = 16 << 10

// capToolPayload отсеивает отсутствующий, битый и слишком большой JSON протокола.
func capToolPayload(raw json.RawMessage) json.RawMessage {
	if len(raw) == 0 || !json.Valid(raw) {
		return nil
	}
	if len(raw) > maxToolPayloadBytes {
		return nil
	}
	return raw
}

// remapKnowledgeRefs переписывает ссылки на знания по карте «старый id → новый» (0.152.0).
func remapKnowledgeRefs(refs []KnowledgeRefRecord, remap map[uuid.UUID]uuid.UUID) []KnowledgeRefRecord {
	if len(refs) == 0 {
		return nil
	}
	out := make([]KnowledgeRefRecord, 0, len(refs))
	for _, ref := range refs {
		if newID, ok := remap[ref.ID]; ok {
			ref.ID = newID
		}
		out = append(out, ref)
	}
	return out
}

// buildKnowledge собирает файл знаний проекта для архива (0.149.0).
//
// Знания — содержимое проекта, поэтому едут ВСЕ, а не только свои (в отличие от истории
// бесед). Тела берём по одному запросу на знание: список отдаёт их без тела намеренно, и
// «загрузить все тела одним запросом» здесь стоило бы отдельного метода в базе ради
// одного места — выгрузки, которая и так читает весь проект.
func (s *Service) buildKnowledge(ctx context.Context, projectID uuid.UUID) ([]byte, error) {
	list, err := s.store.ListAIKnowledge(ctx, projectID, "", maxKnowledge)
	if err != nil {
		return nil, err
	}
	records := make([]KnowledgeRecord, 0, len(list))
	for _, brief := range list {
		full, kerr := s.store.AIKnowledgeByID(ctx, projectID, brief.ID)
		if kerr != nil {
			continue
		}
		records = append(records, KnowledgeRecord{
			ID: full.ID, Title: full.Title, Summary: full.Summary, Body: full.Body,
			Tags: full.Tags, Chars: full.Chars,
			Author: full.AuthorName, CreatedAt: full.CreatedAt,
		})
		if len(records) >= maxKnowledge {
			break
		}
	}
	if len(records) == 0 {
		return nil, nil
	}
	return json.MarshalIndent(KnowledgeFile{Knowledge: records}, "", "  ")
}

// ParsedBundle — разобранный архив, готовый к переносу в базу.
type ParsedBundle struct {
	Manifest Manifest
	State    []byte
	// Template — шаблон проекта из архива (0.85.0). nil означает «файла нет» — так выглядят
	// архивы, собранные до 0.85.0, и это нормальный случай, а не ошибка.
	Template *projecttemplate.Template
	// Conversations — история бесед с помощником (0.148.0). nil — файла нет (архивы до
	// 0.148.0), и это тоже нормальный случай.
	Conversations *ConversationsFile
	// Knowledge — знания проекта (0.149.0). nil — файла нет: архивы до 0.149.0.
	Knowledge *KnowledgeFile
	// AssetFiles — содержимое вложений по id (читается лениво из zip.Reader).
	zip *zip.Reader
}

// ParseBundle читает архив и проверяет его структуру. Ничего не пишет.
func ParseBundle(r io.ReaderAt, size int64) (*ParsedBundle, error) {
	if size <= 0 || size > MaxBundleSize {
		return nil, ErrTooLarge
	}
	zr, err := zip.NewReader(r, size)
	if err != nil {
		return nil, fmt.Errorf("%w: %v", ErrBadBundle, err)
	}

	b := &ParsedBundle{zip: zr}
	var total int64
	for _, f := range zr.File {
		if f.UncompressedSize64 > maxEntrySize {
			return nil, fmt.Errorf("%w: файл %s больше %d МБ", ErrTooLarge, f.Name, maxEntrySize>>20)
		}
		total += int64(f.UncompressedSize64)
		if total > MaxBundleSize*4 {
			return nil, ErrTooLarge
		}
		switch f.Name {
		case manifestName:
			data, err := readZipFile(f, 4<<20)
			if err != nil {
				return nil, err
			}
			if err := json.Unmarshal(data, &b.Manifest); err != nil {
				return nil, fmt.Errorf("%w: manifest.json не разобран: %v", ErrBadBundle, err)
			}
		case templateFile:
			// Битый шаблон НЕ отменяет импорт: содержимое проекта от него не зависит, а
			// потерять из-за настроек весь архив было бы хуже. Файл просто игнорируется —
			// ровно так же поступают старые сборки, которые его не читают вовсе.
			data, err := readZipFile(f, 1<<20)
			if err != nil {
				continue
			}
			var template projecttemplate.Template
			if err := json.Unmarshal(data, &template); err != nil {
				continue
			}
			b.Template = &template
		case stateName:
			data, err := readZipFile(f, MaxBundleSize)
			if err != nil {
				return nil, err
			}
			b.State = data
		case conversationsFile:
			// Битый файл истории НЕ отменяет импорт: содержимое проекта от него не зависит,
			// а потерять из-за переписки весь архив было бы хуже. Файл просто игнорируется.
			data, err := readZipFile(f, 32<<20)
			if err != nil {
				continue
			}
			var history ConversationsFile
			if err := json.Unmarshal(data, &history); err != nil {
				continue
			}
			b.Conversations = &history
		case knowledgeFile:
			// Битый файл знаний НЕ отменяет импорт — по той же причине, что и история
			// бесед: текст проекта важнее вспомогательной части архива.
			data, err := readZipFile(f, 64<<20)
			if err != nil {
				continue
			}
			var knowledge KnowledgeFile
			if err := json.Unmarshal(data, &knowledge); err != nil {
				continue
			}
			b.Knowledge = &knowledge
		}
	}

	m := b.Manifest
	if m.Format != FormatName {
		return nil, fmt.Errorf("%w: это не архив SkyFraze (format=%q)", ErrUnsupportedFormat, m.Format)
	}
	if m.Version <= 0 || m.Version > FormatVersion {
		return nil, fmt.Errorf("%w: версия архива %d не поддерживается", ErrUnsupportedFormat, m.Version)
	}
	if len(m.Events) > maxEvents || len(m.Assets) > maxAssets {
		return nil, fmt.Errorf("%w: в архиве %d событий и %d вложений", ErrTooLarge, len(m.Events), len(m.Assets))
	}
	return b, nil
}

// AssetReader отдаёт файл вложения из архива.
func (b *ParsedBundle) AssetReader(a AssetRecord) (io.ReadCloser, error) {
	name := a.File
	if name == "" {
		name = assetsDir + a.ID.String()
	}
	for _, f := range b.zip.File {
		if f.Name == name {
			return f.Open()
		}
	}
	return nil, fmt.Errorf("%w: файл %s отсутствует в архиве", ErrBadBundle, name)
}

// Import создаёт НОВЫЙ проект у пользователя userID по разобранному архиву.
//
// Импорт никогда не пишет в существующий проект: если id событий/вложений уже
// заняты (повторная загрузка того же архива), возвращается ErrAlreadyImported —
// «перезаписать» чужой проект молча нельзя, а отличить «свой» от «чужого» по
// архиву невозможно.
func (s *Service) Import(ctx context.Context, userID uuid.UUID, b *ParsedBundle) (*Result, error) {
	m := b.Manifest

	// 1. Проверка структуры дерева теми же правилами, что и обычная синхронизация.
	nodes := make([]events.NodeInput, 0, len(m.Events))
	eventIDs := make([]uuid.UUID, 0, len(m.Events))
	seen := make(map[uuid.UUID]bool, len(m.Events))
	for _, e := range m.Events {
		if e.ID == uuid.Nil || seen[e.ID] {
			return nil, fmt.Errorf("%w: некорректный или повторяющийся id события", ErrBadBundle)
		}
		seen[e.ID] = true
		eventIDs = append(eventIDs, e.ID)
		nodes = append(nodes, events.NodeInput{
			ID: e.ID, ParentID: e.ParentID, Position: e.Position,
			Title: e.Title, Body: e.Body,
			// В манифесте дата у события есть всегда (пусто — значит «её нет»),
			// поэтому здесь она авторитетна, а не «не пришла».
			EventDate: events.EventDatePatch{Set: true, Value: e.EventDate},
		})
	}
	normalized, err := events.NormalizeTree(nodes)
	if err != nil {
		return nil, fmt.Errorf("%w: дерево событий невалидно: %v", ErrBadBundle, err)
	}

	// 2. Конфликты id: значит, этот архив уже импортировали в эту базу.
	assetIDs := make([]uuid.UUID, 0, len(m.Assets))
	for _, a := range m.Assets {
		if a.ID == uuid.Nil {
			return nil, fmt.Errorf("%w: у вложения нет id", ErrBadBundle)
		}
		assetIDs = append(assetIDs, a.ID)
	}
	conflictEvents, err := s.store.ExistingEventIDs(ctx, eventIDs)
	if err != nil {
		return nil, err
	}
	conflictAssets, err := s.store.ExistingAssetIDs(ctx, assetIDs)
	if err != nil {
		return nil, err
	}
	if len(conflictEvents) > 0 || len(conflictAssets) > 0 {
		return nil, fmt.Errorf("%w: в этой базе уже есть %d событий и %d вложений из архива",
			ErrAlreadyImported, len(conflictEvents), len(conflictAssets))
	}

	// 3. Новый проект у импортирующего.
	title := strings.TrimSpace(m.Project.Title)
	if title == "" {
		title = "Импортированный проект"
	}
	p, err := s.proj.Create(ctx, userID, title, m.Project.Description)
	if err != nil {
		return nil, err
	}
	// Дальше любая ошибка должна убирать за собой: иначе останутся осиротевшие
	// файлы в хранилище и наполовину импортированный проект.
	written := make([]string, 0, len(m.Assets))
	cleanup := func() {
		for _, key := range written {
			_ = s.obj.Delete(ctx, key)
		}
		_ = s.store.DeleteProject(ctx, p.ID)
	}

	// 4. Вложения: файлы в хранилище + строки в БД (id сохраняем — на них
	//    ссылается CRDT-снапшот).
	for _, a := range m.Assets {
		rc, err := b.AssetReader(a)
		if err != nil {
			cleanup()
			return nil, err
		}
		key := fmt.Sprintf("%s/%s", p.ID.String(), a.ID.String())
		putErr := s.obj.Put(ctx, key, a.Mime, rc, a.Size)
		rc.Close()
		if putErr != nil {
			cleanup()
			return nil, fmt.Errorf("сохранить файл вложения: %w", putErr)
		}
		written = append(written, key)

		asset := &store.Asset{
			ID: a.ID, ProjectID: p.ID, OwnerID: userID, Filename: a.Filename,
			Mime: a.Mime, Size: a.Size, S3Key: key, Kind: a.Kind, Width: a.Width, Height: a.Height,
		}
		if err := s.store.InsertAsset(ctx, asset); err != nil {
			cleanup()
			return nil, err
		}
	}

	// 5. Дерево событий.
	rows := make([]store.Event, 0, len(normalized))
	for _, n := range normalized {
		rows = append(rows, store.Event{
			ID: n.ID, ProjectID: p.ID, ParentID: n.ParentID, Position: n.Position,
			Depth: n.Depth, Title: n.Title, Body: n.Body, EventDate: n.EventDate.Value,
			// Импорт архива авторитетен по датам: в манифесте они есть всегда
			// (у событий без даты — пусто), поэтому отсутствие даты здесь означает
			// «её и не было», и старую дату в базе перезаписываем как есть.
			EventDateSet: true,
			CreatedBy:    &userID, UpdatedBy: &userID,
		})
	}
	if len(rows) > 0 {
		if err := s.store.ReplaceEventTree(ctx, p.ID, userID, rows); err != nil {
			cleanup()
			return nil, err
		}
	}

	// 6. CRDT-снапшот: без него пропадут тексты в CRDT, фон кадров и привязки
	//    вложений (в базе их нет).
	hasState := len(b.State) > 0
	if hasState {
		if _, err := s.store.SaveProjectEventState(ctx, p.ID, userID, b.State, 0); err != nil {
			cleanup()
			return nil, err
		}
	}

	// 7. Шаблон проекта (0.85.0): типы карточек и настройки помощника. Раньше карточек — иначе
	//    первая же карточка своего типа нарушила бы внешний ключ на тип.
	//
	//    Ошибка шаблона не отменяет импорт: содержимое проекта уже перенесено, а настройки — это
	//    то, что можно применить повторно вручную (POST /template).
	var templateReport *projecttemplate.Report
	if m := b.Template; m != nil && s.templates != nil {
		if report, terr := s.templates.ApplyAs(ctx, userID, p.ID, m); terr == nil {
			templateReport = report
		}
	}

	// 8. Карточки мира (0.69.0). Ошибка одной карточки не отменяет импорт: занятое имя или
	//    неизвестный вид — это дефект архива, а не повод потерять весь проект. Пропущенные
	//    считаем и отдаём в результате, чтобы «импорт прошёл» не было полуправдой.
	importedEntities := 0
	for _, entity := range m.Entities {
		if _, err := s.entities.Create(ctx, userID, p.ID, entities.Input{
			Kind: entity.Kind, Name: entity.Name,
			Aliases: &entity.Aliases, Description: &entity.Description, Color: &entity.Color,
		}); err != nil {
			continue
		}
		importedEntities++
	}

	// 9. Знания проекта (0.149.0, порядок изменён в 0.152.0). Автор и дата сохраняются как в
	//    архиве: «когда это придумали» — часть содержания. Импортируются ДО бесед, потому что
	//    вложения сообщений ссылаются на id знания: после вставки мы знаем, какое старое
	//    знание стало каким новым, и переписываем ссылки. Ошибка записи знаний не отменяет
	//    импорт: текст проекта уже перенесён, а знания — то, что можно завести заново.
	importedKnowledge := 0
	knowledgeRemap := make(map[uuid.UUID]uuid.UUID)
	if knowledge := b.Knowledge; knowledge != nil {
		records := make([]store.AIKnowledgeImport, 0, len(knowledge.Knowledge))
		for _, record := range knowledge.Knowledge {
			if strings.TrimSpace(record.Title) == "" || strings.TrimSpace(record.Body) == "" {
				continue
			}
			chars := record.Chars
			if chars <= 0 {
				chars = len([]rune(record.Body))
			}
			records = append(records, store.AIKnowledgeImport{
				ID: record.ID, Title: record.Title, Summary: record.Summary, Body: record.Body,
				Tags: record.Tags, Chars: chars,
				AuthorName: record.Author, CreatedAt: record.CreatedAt,
			})
			if len(records) >= maxKnowledge {
				break
			}
		}
		if len(records) > 0 {
			if saved, kerr := s.store.ImportAIKnowledge(ctx, p.ID, records); kerr == nil {
				importedKnowledge = len(saved)
				for i, item := range saved {
					if records[i].ID != uuid.Nil {
						knowledgeRemap[records[i].ID] = item.ID
					}
				}
			}
		}
	}

	// 10. История бесед с помощником (0.148.0). Ошибка одной беседы не отменяет импорт: это
	//     вспомогательная часть архива, а не содержимое проекта. Время сообщений — момент
	//     импорта: сохранять исходный порядок важнее, чем исходные отметки времени, а порядок
	//     держится вставкой по одному.
	importedConversations := 0
	if history := b.Conversations; history != nil {
		for _, record := range history.Conversations {
			if len(record.Messages) == 0 {
				continue
			}
			conversation, cerr := s.store.CreateAIConversation(ctx, p.ID, userID, record.Title, record.Model)
			if cerr != nil {
				continue
			}
			ok := true
			for _, message := range record.Messages {
				if message.Role != "user" && message.Role != "assistant" && message.Role != "tool" {
					continue
				}
				if _, merr := s.store.AppendAIMessage(ctx, store.AIMessage{
					ConversationID: conversation.ID, Role: message.Role,
					Content: message.Content, Stopped: message.Stopped,
					Knowledge:   encodeKnowledgeRefs(remapKnowledgeRefs(message.Knowledge, knowledgeRemap)),
					ToolCalls:   message.ToolCalls,
					ToolResults: message.ToolResults,
				}); merr != nil {
					ok = false
					break
				}
			}
			if !ok {
				// Наполовину перенесённую беседу не оставляем: она выглядела бы как
				// оборванный разговор, которого не было.
				_, _ = s.store.DeleteAIConversation(ctx, conversation.ID, userID)
				continue
			}
			importedConversations++
		}
	}

	return &Result{
		Project: p, Events: len(rows), Assets: len(m.Assets), HasState: hasState,
		Entities: importedEntities, Conversations: importedConversations,
		Knowledge: importedKnowledge, Template: templateReport,
	}, nil
}

// ---------- вспомогательное ----------

type countingWriter struct {
	w io.Writer
	n int64
}

func (c *countingWriter) Write(p []byte) (int, error) {
	n, err := c.w.Write(p)
	c.n += int64(n)
	return n, err
}

func writeZipFile(zw *zip.Writer, name string, data []byte) error {
	w, err := zw.Create(name)
	if err != nil {
		return err
	}
	_, err = w.Write(data)
	return err
}

func writeZipStream(zw *zip.Writer, name string, r io.Reader) error {
	w, err := zw.Create(name)
	if err != nil {
		return err
	}
	_, err = io.Copy(w, r)
	return err
}

func readZipFile(f *zip.File, limit int64) ([]byte, error) {
	rc, err := f.Open()
	if err != nil {
		return nil, err
	}
	defer rc.Close()
	var buf bytes.Buffer
	if _, err := io.Copy(&buf, io.LimitReader(rc, limit)); err != nil {
		return nil, err
	}
	return buf.Bytes(), nil
}
