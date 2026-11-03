package assistant

// knowledge.go — знания проекта (0.149.0): то, что остаётся от беседы после её удаления.
//
// Зачем отдельная сущность. Беседа — личные заметки одного человека: её нельзя показать
// соавтору, и она исчезает по сроку хранения. Знание — содержимое проекта: его читают все
// участники, его прикладывают к вопросу, и оно переживает автоочистку. Ровно поэтому
// автоочистка стала безопасной: человек сначала может превратить нужное в знание, а потом
// разрешить истории стареть.
//
// Кто укладывает беседу в знание. Модель — инструментом `save_knowledge` (она умеет сжать
// разговор до тезисов), человек — руками в той же вкладке. Предел знака один на оба пути:
// иначе «сохранённое моделью» и «сохранённое человеком» были бы разного качества, а
// инструкция «не влезает — разбей на несколько» работала бы только для модели.

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"time"
	"unicode"
	"unicode/utf8"

	"github.com/google/uuid"

	"github.com/skyfraze/backend/internal/store"
)

// Пределы знаний. Все они — про то, что читает человек: слишком длинное знание никто не
// открывает, а слишком короткое не отвечает на вопрос «о чём это».
const (
	// MaxKnowledgeChars — сколько знаков в ОДНОМ знании. Не влезает беседа — она
	// раскладывается на несколько знаний: по главам, темам или выводам.
	MaxKnowledgeChars = 4000
	// MaxKnowledgeEntries — сколько знаний можно создать за одно сообщение (пачкой).
	MaxKnowledgeEntries = 20
	// MaxKnowledgeTitle — заголовок строки в списке.
	MaxKnowledgeTitle = 120
	// MaxKnowledgeSummary — пометка «о чём это» под заголовком.
	MaxKnowledgeSummary = 400
	// MaxKnowledgeAttach — сколько знаний можно приложить к одному сообщению.
	// Десять — это уже 40 000 знаков контекста; больше не влезет в окно локальной модели.
	MaxKnowledgeAttach = 10
	// knowledgePromptChars — сколько знаков знаний уходит в ОДИН запрос к модели.
	// Ровно это, а не «сколько приложили»: приложить десять знаний по 4 000 знаков и
	// получить 413 от сервера модели хуже, чем получить первые два целиком и честную
	// пометку об остальных.
	knowledgePromptChars = 12000
)

// KnowledgeInput — что вписал человек или модель.
type KnowledgeInput struct {
	Title   string
	Summary string
	Body    string
}

// KnowledgeRef — вложение к сообщению: идентификатор и СНИМОК заголовка.
type KnowledgeRef struct {
	ID    uuid.UUID `json:"id"`
	Title string    `json:"title"`
}

// KnowledgeView — созданное знание в ответе помощника: интерфейс показывает карточку
// сразу после вызова инструмента, без перезагрузки списка.
type KnowledgeView struct {
	ID        uuid.UUID `json:"id"`
	Title     string    `json:"title"`
	Summary   string    `json:"summary"`
	Chars     int       `json:"chars"`
	CreatedAt time.Time `json:"created_at"`
}

// ValidateKnowledge проверяет одно знание и возвращает то, что пойдёт в базу.
//
// Проверки нарочно строгие и с числами в тексте: сообщение читает модель, и «слишком
// длинно» без числа не подсказывает, на сколько сократить.
func ValidateKnowledge(in KnowledgeInput, maxChars int) (store.KnowledgeInput, error) {
	// Заголовок чистим от обрамляющих кавычек и решёток: живой прогон на стенде (0.149.1)
	// дал «Проверка инструмента знаний« — модель обрамила им же придуманный заголовок.
	// Это не ошибка данных, но в списке знаний такие кавычки читаются как дефект.
	title := sanitizeKnowledgeTitle(in.Title)
	summary := strings.TrimSpace(in.Summary)
	body := strings.TrimSpace(in.Body)
	if title == "" {
		return store.KnowledgeInput{}, errors.New("не задан заголовок знания (title)")
	}
	if len([]rune(title)) > MaxKnowledgeTitle {
		return store.KnowledgeInput{}, fmt.Errorf(
			"заголовок знания длиннее %d знаков — сократите", MaxKnowledgeTitle)
	}
	if len([]rune(summary)) > MaxKnowledgeSummary {
		return store.KnowledgeInput{}, fmt.Errorf(
			"пометка знания (summary) длиннее %d знаков — сократите", MaxKnowledgeSummary)
	}
	if body == "" {
		return store.KnowledgeInput{}, errors.New("знание без текста (body) — терять нечего")
	}
	if maxChars <= 0 {
		maxChars = MaxKnowledgeChars
	}
	chars := utf8.RuneCountInString(body)
	if chars > maxChars {
		return store.KnowledgeInput{}, fmt.Errorf(
			"знание получилось %d знаков, а предел одного знания — %d: "+
				"сократите тезисы или разбейте их на несколько знаний по темам", chars, maxChars)
	}
	return store.KnowledgeInput{Title: title, Summary: summary, Body: body, Chars: chars}, nil
}

// knowledgeTitleTrim — что снимаем с краёв заголовка: кавычки всех видов и markdown-решётки.
const knowledgeTitleTrim = " \t\n\r«»\"'`„“”‘’#*_"

// sanitizeKnowledgeTitle снимает обрамляющие кавычки и украшения.
//
// Внутренние кавычки НЕ трогаем: «„Анна“ и „дом“» — законный заголовок, и вычищать из
// него всё, что похоже на кавычку, значило бы портить смысл.
func sanitizeKnowledgeTitle(title string) string {
	out := strings.TrimSpace(title)
	for {
		trimmed := strings.Trim(out, knowledgeTitleTrim)
		trimmed = strings.TrimSpace(trimmed)
		if trimmed == out {
			return out
		}
		out = trimmed
	}
}

// knowledgeLimit — предел знака для этого сервиса (тесты уменьшают).
func (s *Service) knowledgeLimit() int {
	if s.limits.KnowledgeChars > 0 {
		return s.limits.KnowledgeChars
	}
	return MaxKnowledgeChars
}

// knowledgeEntriesLimit — сколько знаний за раз (тесты уменьшают).
func (s *Service) knowledgeEntriesLimit() int {
	if s.limits.KnowledgeEntries > 0 {
		return s.limits.KnowledgeEntries
	}
	return MaxKnowledgeEntries
}

// KnowledgeList — знания проекта для списка и поиска (0.150.0: только соавторам).
//
// Почему редактор+, а не «любой участник». Знание — черновые исследования соавторов:
// модель укладывает туда «что решили» и «что выяснили» до того, как это стало текстом.
// Приглашённый читатель видит опубликованное, а не рабочие заметки, поэтому чтение
// знаний требует права писать.
func (s *Service) KnowledgeList(
	ctx context.Context, userID, projectID uuid.UUID, query string,
) ([]store.AIKnowledgeBrief, error) {
	if err := s.requireKnowledge(ctx, userID, projectID); err != nil {
		return nil, err
	}
	return s.store.ListAIKnowledge(ctx, projectID, query, 0)
}

// KnowledgeGet — одно знание целиком (тело читается при открытии).
func (s *Service) KnowledgeGet(
	ctx context.Context, userID, projectID, id uuid.UUID,
) (*store.AIKnowledge, error) {
	if err := s.requireKnowledge(ctx, userID, projectID); err != nil {
		return nil, err
	}
	return s.store.AIKnowledgeByID(ctx, projectID, id)
}

// requireKnowledge — доступ к знаниям: только соавторы (владелец и редакторы).
func (s *Service) requireKnowledge(ctx context.Context, userID, projectID uuid.UUID) error {
	if err := s.RequireProject(ctx, userID, projectID, true); err != nil {
		if errors.Is(err, ErrForbidden) {
			// Объяснение важнее кода: «forbidden» на вкладке знаний читается как поломка,
			// а «знания доступны соавторам» — как правило проекта.
			return fmt.Errorf("%w: знания проекта доступны соавторам", ErrForbidden)
		}
		return err
	}
	return nil
}

// KnowledgeCreate — знание, написанное человеком руками.
func (s *Service) KnowledgeCreate(
	ctx context.Context, userID, projectID uuid.UUID, in KnowledgeInput,
) (*store.AIKnowledge, error) {
	if err := s.RequireProject(ctx, userID, projectID, true); err != nil {
		return nil, err
	}
	checked, err := ValidateKnowledge(in, s.knowledgeLimit())
	if err != nil {
		return nil, err
	}
	return s.store.CreateAIKnowledge(ctx, projectID, userID, checked, nil)
}

// KnowledgeUpdate — правка знания человеком.
func (s *Service) KnowledgeUpdate(
	ctx context.Context, userID, projectID, id uuid.UUID, in KnowledgeInput,
) (*store.AIKnowledge, error) {
	if err := s.RequireProject(ctx, userID, projectID, true); err != nil {
		return nil, err
	}
	checked, err := ValidateKnowledge(in, s.knowledgeLimit())
	if err != nil {
		return nil, err
	}
	return s.store.UpdateAIKnowledge(ctx, projectID, id, checked)
}

// KnowledgeDelete — удаление знания. Может любой редактор: знание — общий артефакт
// проекта, и «удалить может только автор» превратило бы ушедшего соавтора в замок.
func (s *Service) KnowledgeDelete(ctx context.Context, userID, projectID, id uuid.UUID) error {
	if err := s.RequireProject(ctx, userID, projectID, true); err != nil {
		return err
	}
	ok, err := s.store.DeleteAIKnowledge(ctx, projectID, id)
	if err != nil {
		return err
	}
	if !ok {
		return store.ErrNotFound
	}
	return nil
}

// SaveKnowledgeEntries — пачка знаний (её приносит инструмент модели).
//
// Вся пачка проверяется ДО записи: половина уложенной беседы — худший исход, а
// транзакция в базе защищает только от сбоя, но не от «первое знание хорошее, второе
// слишком длинное».
func (s *Service) SaveKnowledgeEntries(
	ctx context.Context, userID, projectID uuid.UUID, source *uuid.UUID, entries []KnowledgeInput,
) ([]store.AIKnowledge, error) {
	if err := s.RequireProject(ctx, userID, projectID, true); err != nil {
		return nil, err
	}
	limit := s.knowledgeEntriesLimit()
	if len(entries) == 0 {
		return nil, errors.New("не передано ни одного знания")
	}
	if len(entries) > limit {
		return nil, fmt.Errorf("за раз можно сохранить не больше %d знаний, а передано %d",
			limit, len(entries))
	}
	checked := make([]store.KnowledgeInput, 0, len(entries))
	for i, in := range entries {
		item, err := ValidateKnowledge(in, s.knowledgeLimit())
		if err != nil {
			return nil, fmt.Errorf("знание №%d: %v", i+1, err)
		}
		checked = append(checked, item)
	}
	return s.store.CreateAIKnowledgeBatch(ctx, projectID, userID, checked, source)
}

// FilterKnowledgeDuplicates отсеивает знания, похожие на уже сохранённые (0.150.0).
//
// Зачем: модель, укладывая беседу, часто заводит «Решения по миру» поверх уже
// существующего «Решения по миру проекта». Дубли в списке хуже, чем чуть более строгое
// сохранение: человек ищет знания глазами, и две почти одинаковые строки — это шум.
//
// Возвращаем то, что можно записывать, и то, что пропущено, — модель должна сказать
// человеку «это уже есть», а не молча проглотить просьбу.
func (s *Service) FilterKnowledgeDuplicates(
	ctx context.Context, projectID uuid.UUID, entries []KnowledgeInput,
) ([]KnowledgeInput, []KnowledgeDuplicate, error) {
	if len(entries) == 0 {
		return nil, nil, nil
	}
	existing, err := s.store.FindSimilarKnowledge(ctx, projectID, 500)
	if err != nil {
		return nil, nil, err
	}
	kept := make([]KnowledgeInput, 0, len(entries))
	skipped := make([]KnowledgeDuplicate, 0)
	for _, item := range entries {
		var match *store.AIKnowledgeBrief
		for i := range existing {
			if similarKnowledgeTitle(item.Title, existing[i].Title) {
				match = &existing[i]
				break
			}
		}
		if match == nil {
			kept = append(kept, item)
			continue
		}
		skipped = append(skipped, KnowledgeDuplicate{
			Title: item.Title, ExistingID: match.ID, ExistingTitle: match.Title,
		})
	}
	return kept, skipped, nil
}

// KnowledgeDuplicate — знание, которое не записали: похожее уже есть.
type KnowledgeDuplicate struct {
	Title         string    `json:"title"`
	ExistingID    uuid.UUID `json:"existing_id"`
	ExistingTitle string    `json:"existing_title"`
}

// similarKnowledgeTitle — «похоже ли» два заголовка.
//
// Три правила, и все три дешёвые: равные после нормализации, вложенные друг в друга (от
// десяти знаков — иначе «Мир» и «Мир и война» считались бы одним знанием) и совпадение
// слов на 75% (короткий пересказ заголовка).
func similarKnowledgeTitle(a, b string) bool {
	left := normalizeKnowledgeTitle(a)
	right := normalizeKnowledgeTitle(b)
	if left == "" || right == "" {
		return false
	}
	if left == right {
		return true
	}
	longest := len([]rune(left))
	if len([]rune(right)) > longest {
		longest = len([]rune(right))
	}
	if longest >= 10 && (strings.Contains(left, right) || strings.Contains(right, left)) {
		return true
	}
	leftWords := knowledgeTitleWords(left)
	rightWords := knowledgeTitleWords(right)
	if len(leftWords) < 2 || len(rightWords) < 2 {
		return false
	}
	common := 0
	for word := range leftWords {
		if rightWords[word] {
			common++
		}
	}
	union := len(leftWords) + len(rightWords) - common
	return union > 0 && float64(common)/float64(union) >= 0.75
}

// knowledgeTitleWords — слова заголовка без однобуквенных частиц.
func knowledgeTitleWords(normalized string) map[string]bool {
	words := make(map[string]bool)
	for _, word := range strings.Fields(normalized) {
		if len([]rune(word)) >= 2 {
			words[word] = true
		}
	}
	return words
}

// normalizeKnowledgeTitle приводит заголовок к сравнимому виду: нижний регистр, ё→е,
// без пунктуации и лишних пробелов. Ровно то, что не меняет смысл заголовка.
func normalizeKnowledgeTitle(title string) string {
	var b strings.Builder
	for _, symbol := range strings.ToLower(strings.TrimSpace(title)) {
		switch {
		case symbol == 'ё':
			b.WriteRune('е')
		case unicode.IsLetter(symbol), unicode.IsDigit(symbol):
			b.WriteRune(symbol)
		default:
			b.WriteRune(' ')
		}
	}
	return strings.Join(strings.Fields(b.String()), " ")
}

// knowledgeForAttach готовит вложения к сообщению: сами знания (для запроса к модели) и
// ссылки со снимком заголовка (для истории и интерфейса).
//
// Порядок восстанавливаем по ids, а не по базе: карточки в вопросе должны идти так, как
// их приложил человек. Отсутствие в проекте — отказ, а не «молча пропустим»: человек
// выбрал это знание в списке проекта, и тихо выкинуть его значит ответить не по тому
// тексту, который он приложил.
func (s *Service) knowledgeForAttach(
	ctx context.Context, projectID uuid.UUID, ids []uuid.UUID,
) ([]store.AIKnowledge, []KnowledgeRef, error) {
	if len(ids) == 0 {
		return nil, nil, nil
	}
	if len(ids) > MaxKnowledgeAttach {
		return nil, nil, fmt.Errorf("к одному сообщению можно приложить не больше %d знаний",
			MaxKnowledgeAttach)
	}
	unique := make([]uuid.UUID, 0, len(ids))
	seen := make(map[uuid.UUID]bool, len(ids))
	for _, id := range ids {
		if seen[id] {
			continue
		}
		seen[id] = true
		unique = append(unique, id)
	}
	rows, err := s.store.AIKnowledgeByIDs(ctx, projectID, unique)
	if err != nil {
		return nil, nil, err
	}
	byID := make(map[uuid.UUID]store.AIKnowledge, len(rows))
	for _, k := range rows {
		byID[k.ID] = k
	}
	items := make([]store.AIKnowledge, 0, len(unique))
	refs := make([]KnowledgeRef, 0, len(unique))
	for _, id := range unique {
		k, ok := byID[id]
		if !ok {
			return nil, nil, fmt.Errorf("%w: знание %s не найдено в проекте", store.ErrNotFound, id)
		}
		items = append(items, k)
		refs = append(refs, KnowledgeRef{ID: k.ID, Title: k.Title})
	}
	return items, refs, nil
}

// KnowledgeBlock — что уходит модели вместе с вопросом: приложенные знания.
//
// Бюджет общий (knowledgePromptChars), а не «по каждому»: два знания по 4 000 знаков
// влезают, десять — нет, и лучше отдать первые целиком с пометкой «остальные можно
// прочитать инструментом read_knowledge», чем получить от сервера модели 413.
func KnowledgeBlock(items []store.AIKnowledge) string {
	if len(items) == 0 {
		return ""
	}
	var b strings.Builder
	b.WriteString("\n\nПриложенные знания проекта (это сохранённые выводы, а не текст кадров):\n")
	spent := 0
	for i, k := range items {
		body := k.Body
		room := knowledgePromptChars - spent
		if room <= 0 {
			fmt.Fprintf(&b, "\n[ещё знаний: %d — прочитать инструментом read_knowledge]\n",
				len(items)-i)
			break
		}
		trimmed := false
		if utf8.RuneCountInString(body) > room {
			body = truncateRunes(body, room)
			trimmed = true
		}
		spent += utf8.RuneCountInString(body)
		fmt.Fprintf(&b, "\n### %s", k.Title)
		if strings.TrimSpace(k.Summary) != "" {
			fmt.Fprintf(&b, " — %s", k.Summary)
		}
		fmt.Fprintf(&b, "\n%s\n", body)
		if trimmed {
			b.WriteString("[знание обрезано — полный текст через read_knowledge]\n")
		}
	}
	b.WriteString("Считай эти знания уже известными: не пересказывай их человеку, а используй.\n")
	return b.String()
}

// Retention — срок хранения бесед проекта в днях (0 — не удалять). Читает участник.
func (s *Service) Retention(ctx context.Context, userID, projectID uuid.UUID) (int, error) {
	if err := s.RequireProject(ctx, userID, projectID, false); err != nil {
		return 0, err
	}
	settings, err := s.store.AISettingsForProject(ctx, projectID)
	if err != nil {
		return 0, err
	}
	return settings.RetentionDays, nil
}

// SetRetention — включает автоочистку. Меняет только владелец: срок касается бесед всех
// соавторов проекта, и «я почистил историю коллегам» — не решение редактора.
func (s *Service) SetRetention(
	ctx context.Context, userID, projectID uuid.UUID, days int,
) (*Settings, error) {
	if err := s.RequireProject(ctx, userID, projectID, true); err != nil {
		return nil, err
	}
	if s.guard == nil {
		return nil, errors.New("помощник не настроен: нет доступа к проектам")
	}
	role, err := s.guard.Role(ctx, userID, projectID)
	if err != nil {
		return nil, err
	}
	if role != store.RoleOwner {
		return nil, ErrForbidden
	}
	if days < 0 || days > maxRetentionDays {
		return nil, fmt.Errorf("срок хранения — от 0 до %d дней (0 — не удалять)", maxRetentionDays)
	}
	if _, err := s.store.SetAIRetention(ctx, projectID, days); err != nil {
		return nil, err
	}
	s.logger.Info("ai: срок хранения бесед изменён",
		"user", userID, "project", projectID, "days", days)
	return s.ProjectSettings(ctx, userID, projectID)
}

// maxRetentionDays — десять лет: больше — это уже «не удалять», и пусть так и пишут.
const maxRetentionDays = 3650

// KeepConversation — «не удалять эту беседу» (или снять пометку).
func (s *Service) KeepConversation(
	ctx context.Context, userID, projectID, conversationID uuid.UUID, kept bool,
) error {
	if err := s.RequireProject(ctx, userID, projectID, true); err != nil {
		return err
	}
	conv, err := s.store.AIConversationByID(ctx, conversationID, userID)
	if err != nil {
		return err
	}
	if conv.ProjectID != projectID {
		return store.ErrNotFound
	}
	ok, err := s.store.SetAIConversationKept(ctx, conversationID, userID, kept)
	if err != nil {
		return err
	}
	if !ok {
		return store.ErrNotFound
	}
	return nil
}

// CleanupConversations — один проход автоочистки (его зовёт janitor по таймеру).
func (s *Service) CleanupConversations(ctx context.Context) (int64, error) {
	return s.store.CleanupAIConversations(ctx)
}
