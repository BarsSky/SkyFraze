package store

// store_knowledge.go — знания проекта (0.149.0).
//
// Знание — это сохранённые выводы: тезисы, которые человек (или агент по его просьбе)
// вынес из беседы и оставил проекту. В отличие от беседы знание не личное: его читают и
// прикладывают к вопросу все участники проекта, и оно переживает и беседу, и автоочистку.
//
// Почему не «просто длинное сообщение в беседе». Беседа удаляется по сроку хранения, а
// знание — нет; беседу одного человека не видит другой, а знание видят все. Одно поле в
// сообщении не дало бы ни первого, ни второго, и «сохранённое» исчезало бы вместе с
// историей, ради освобождения которой всё и затевалось.

import (
	"context"
	"errors"
	"strings"
	"time"
	"unicode"

	"github.com/google/uuid"
)

// AIKnowledgeBrief — знание без тела: то, что нужно списку и пикеру.
//
// Тело отдельно, потому что список знаний проекта — это сотня строк по несколько тысяч
// знаков; отдавать их целиком на каждое открытие вкладки значит гонять мегабайты ради
// заголовков и пометок, по которым человек и выбирает.
type AIKnowledgeBrief struct {
	ID         uuid.UUID  `db:"id" json:"id"`
	ProjectID  uuid.UUID  `db:"project_id" json:"project_id"`
	CreatedBy  *uuid.UUID `db:"created_by" json:"created_by,omitempty"`
	AuthorName string     `db:"author_name" json:"author_name"`
	Title      string     `db:"title" json:"title"`
	Summary    string     `db:"summary" json:"summary"`
	// Tags — метки для поиска (0.152.0): темы, имена, линии. Модель ставит их при
	// сохранении, человек может поправить. По ним поиск находит знание, даже когда в
	// тексте другое слово («драконы» ↔ «канон мира»).
	Tags  []string `db:"tags" json:"tags"`
	Chars int      `db:"chars" json:"chars"`
	// SourceConversationID — откуда знание выросло. Может пропасть: беседу удалили (в том
	// числе автоочисткой). Знание при этом остаётся.
	SourceConversationID *uuid.UUID `db:"source_conversation_id" json:"source_conversation_id,omitempty"`
	CreatedAt            time.Time  `db:"created_at" json:"created_at"`
	UpdatedAt            time.Time  `db:"updated_at" json:"updated_at"`
}

// AIKnowledge — знание целиком, с телом.
type AIKnowledge struct {
	ID                   uuid.UUID  `db:"id" json:"id"`
	ProjectID            uuid.UUID  `db:"project_id" json:"project_id"`
	CreatedBy            *uuid.UUID `db:"created_by" json:"created_by,omitempty"`
	AuthorName           string     `db:"author_name" json:"author_name"`
	Title                string     `db:"title" json:"title"`
	Summary              string     `db:"summary" json:"summary"`
	Body                 string     `db:"body" json:"body"`
	Tags                 []string   `db:"tags" json:"tags"`
	Chars                int        `db:"chars" json:"chars"`
	SourceConversationID *uuid.UUID `db:"source_conversation_id" json:"source_conversation_id,omitempty"`
	CreatedAt            time.Time  `db:"created_at" json:"created_at"`
	UpdatedAt            time.Time  `db:"updated_at" json:"updated_at"`
}

// Brief отдаёт знание без тела.
func (k AIKnowledge) Brief() AIKnowledgeBrief {
	return AIKnowledgeBrief{
		ID: k.ID, ProjectID: k.ProjectID, CreatedBy: k.CreatedBy, AuthorName: k.AuthorName,
		Title: k.Title, Summary: k.Summary, Chars: k.Chars, Tags: k.Tags,
		SourceConversationID: k.SourceConversationID,
		CreatedAt:            k.CreatedAt, UpdatedAt: k.UpdatedAt,
	}
}

// KnowledgeInput — что человек или агент вписал в знание.
//
// Chars считает вызывающий: он же проверяет предел, и ему нужно знать, сколько знаков
// получилось ДО записи (отказ с числом полезнее отказа без числа).
type KnowledgeInput struct {
	Title   string
	Summary string
	Body    string
	Tags    []string
	Chars   int
}

const aiKnowledgeColumns = `id, project_id, created_by, author_name, title, summary, body, tags, chars,
	source_conversation_id, created_at, updated_at`

const aiKnowledgeBriefColumns = `id, project_id, created_by, author_name, title, summary, tags, chars,
	source_conversation_id, created_at, updated_at`

// CreateAIKnowledge записывает одно знание.
//
// Имя автора берём из `users` подзапросом, а не аргументом: снимок имени должен
// получиться из одного источника, иначе в знаниях оказались бы разные написания одного
// человека. `created_by` может быть пустым (удалённый автор) — тогда имя тоже пустое.
func (s *Store) CreateAIKnowledge(
	ctx context.Context, projectID uuid.UUID, by uuid.UUID, k KnowledgeInput, source *uuid.UUID,
) (*AIKnowledge, error) {
	var author *uuid.UUID
	if by != uuid.Nil {
		author = &by
	}
	return qOne[AIKnowledge](ctx, s.Pool,
		`INSERT INTO ai_knowledge
		   (project_id, created_by, author_name, title, summary, body, tags, chars, source_conversation_id)
		 VALUES ($1, $2, COALESCE((SELECT display_name FROM users WHERE id = $2), ''),
		         $3, $4, $5, COALESCE($6::text[], '{}'), $7, $8)
		 RETURNING `+aiKnowledgeColumns,
		projectID, author, strings.TrimSpace(k.Title), strings.TrimSpace(k.Summary),
		k.Body, k.Tags, k.Chars, source)
}

// CreateAIKnowledgeBatch записывает пачку знаний одной транзакцией.
//
// Транзакция не украшение: агент раскладывает одну беседу на несколько знаний, и
// половина уложенной пачки — худший из возможных исходов. Либо все, либо ни одного.
func (s *Store) CreateAIKnowledgeBatch(
	ctx context.Context, projectID uuid.UUID, by uuid.UUID, entries []KnowledgeInput, source *uuid.UUID,
) ([]AIKnowledge, error) {
	if len(entries) == 0 {
		return nil, errors.New("пустая пачка знаний")
	}
	tx, err := s.Pool.Begin(ctx)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()

	var author *uuid.UUID
	if by != uuid.Nil {
		author = &by
	}
	out := make([]AIKnowledge, 0, len(entries))
	for _, k := range entries {
		row, err := qOne[AIKnowledge](ctx, tx,
			`INSERT INTO ai_knowledge
			   (project_id, created_by, author_name, title, summary, body, tags, chars, source_conversation_id)
			 VALUES ($1, $2, COALESCE((SELECT display_name FROM users WHERE id = $2), ''),
			         $3, $4, $5, COALESCE($6::text[], '{}'), $7, $8)
			 RETURNING `+aiKnowledgeColumns,
			projectID, author, strings.TrimSpace(k.Title), strings.TrimSpace(k.Summary),
			k.Body, k.Tags, k.Chars, source)
		if err != nil {
			return nil, err
		}
		out = append(out, *row)
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	return out, nil
}

// ListAIKnowledge — знания проекта без тел, при поиске — по релевантности (0.152.0).
//
// Ранжирование, а не «где-то встречается»: раньше список при поиске шёл по дате, и самое
// подходящее знание могло оказаться последним. Теперь score = заголовок (вес 3) + пометка
// (2) + тело (word_similarity) + тег (1.5); ILIKE остаётся как точное вхождение для
// коротких запросов, где триграммы почти не работают.
//
// Запрос и данные приводим к одному виду (нижний регистр, ё→е) — иначе «Драконы» не
// находились бы по «драконы».
func (s *Store) ListAIKnowledge(
	ctx context.Context, projectID uuid.UUID, query string, limit int,
) ([]AIKnowledgeBrief, error) {
	if limit <= 0 || limit > 200 {
		limit = 200
	}
	q := normalizeSearchText(query)
	if q == "" {
		return qAll[AIKnowledgeBrief](ctx, s.Pool,
			`SELECT `+aiKnowledgeBriefColumns+`
			   FROM ai_knowledge
			  WHERE project_id = $1
			  ORDER BY created_at DESC, id DESC
			  LIMIT $2`, projectID, limit)
	}
	return qAll[AIKnowledgeBrief](ctx, s.Pool,
		`WITH search AS (
		   SELECT plainto_tsquery('russian', $2) AS query
		 )
		 SELECT id, project_id, created_by, author_name, title, summary, tags, chars,
		        source_conversation_id, created_at, updated_at
		   FROM (
		     SELECT k.id, k.project_id, k.created_by, k.author_name, k.title, k.summary,
		            k.tags, k.chars, k.source_conversation_id, k.created_at, k.updated_at,
		            -- Морфология (0.153.0): словарь russian приводит «дракон» и «драконами» к
		            -- одной основе. Вес 10 — полнотекстовое совпадение важнее похожести.
		            10.0 * ts_rank(
		              to_tsvector('russian',
		                k.title || ' ' || k.summary || ' ' || k.body || ' ' ||
		                sf_tags_text(k.tags)),
		              search.query)
		            + 3.0 * similarity(replace(lower(k.title), 'ё', 'е'), $2)
		            + 2.0 * similarity(replace(lower(k.summary), 'ё', 'е'), $2)
		            + 1.5 * CASE WHEN EXISTS (
		                SELECT 1 FROM unnest(k.tags) AS tag
		                 WHERE replace(lower(tag), 'ё', 'е') LIKE '%' || $2 || '%'
		              ) THEN 1 ELSE 0 END AS score,
		            search.query @@ to_tsvector('russian',
		              k.title || ' ' || k.summary || ' ' || k.body || ' ' ||
		              sf_tags_text(k.tags)) AS fts_hit
		       FROM ai_knowledge k, search
		      WHERE k.project_id = $1
		   ) ranked
		  WHERE score > 0.05
		     OR fts_hit
		     OR replace(lower(title), 'ё', 'е') LIKE '%' || $2 || '%'
		     OR replace(lower(summary), 'ё', 'е') LIKE '%' || $2 || '%'
		     OR EXISTS (
		          SELECT 1 FROM unnest(tags) AS tag
		           WHERE replace(lower(tag), 'ё', 'е') LIKE '%' || $2 || '%'
		        )
		  ORDER BY score DESC, created_at DESC
		  LIMIT $3`, projectID, q, limit)
}

// AIKnowledgeTag — метка и сколько знаний её используют (0.153.0).
type AIKnowledgeTag struct {
	Tag   string `db:"tag" json:"tag"`
	Count int    `db:"count" json:"count"`
}

// ListAIKnowledgeTags отдаёт метки проекта для автодополнения, частые сверху.
//
// Почему счётчик, а не просто список: человеку полезнее видеть «канон (12)», чем
// алфавитный перечень, и это же подсказывает единый словарь меток внутри проекта.
func (s *Store) ListAIKnowledgeTags(
	ctx context.Context, projectID uuid.UUID, limit int,
) ([]AIKnowledgeTag, error) {
	if limit <= 0 || limit > 200 {
		limit = 100
	}
	return qAll[AIKnowledgeTag](ctx, s.Pool,
		`SELECT tag, count(*)::int
		   FROM ai_knowledge k, unnest(k.tags) AS tag
		  WHERE k.project_id = $1
		  GROUP BY tag
		  ORDER BY count(*) DESC, tag
		  LIMIT $2`, projectID, limit)
}

// normalizeSearchText приводит запрос к виду хранения: нижний регистр, ё→е, без
// пунктуации и лишних пробелов. Своя копия, а не вызов из пакета assistant: store не должен
// зависеть от помощника, а правило короткое и стабильное.
func normalizeSearchText(text string) string {
	var b strings.Builder
	for _, symbol := range strings.ToLower(strings.TrimSpace(text)) {
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

// AIKnowledgeImport — знание из архива: с автором и датой создания.
//
// Отдельный тип, а не KnowledgeInput: при переносе проекта «когда это придумали» — часть
// содержания. Если бы знания импортировались с датой импорта, вся картина работы над
// историей съехала бы в один день.
type AIKnowledgeImport struct {
	// ID — идентификатор в исходной базе (0.152.0). Нужен, чтобы перенести вложения
	// сообщений: у них снимок {id,title} старого знания, и после импорта ссылку надо
	// переписать на новое знание, иначе карточка осталась бы «мёртвой».
	ID         uuid.UUID
	Title      string
	Summary    string
	Body       string
	Tags       []string
	Chars      int
	AuthorName string
	CreatedAt  time.Time
}

// ImportAIKnowledge записывает знания из архива, сохраняя имя автора и дату создания.
//
// `created_by` пустой: автора из архива в этой базе может не быть, а привязывать его
// знание к импортирующему человеку значило бы приписать ему чужие выводы. Имя остаётся
// снимком — ровно так же, как в общем чате.
//
// Возвращает записанные знания: импорт бесед переписывает вложения по id старого знания.
func (s *Store) ImportAIKnowledge(
	ctx context.Context, projectID uuid.UUID, records []AIKnowledgeImport,
) ([]AIKnowledge, error) {
	if len(records) == 0 {
		return nil, nil
	}
	tx, err := s.Pool.Begin(ctx)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()

	done := make([]AIKnowledge, 0, len(records))
	for _, r := range records {
		createdAt := r.CreatedAt
		if createdAt.IsZero() {
			createdAt = time.Now()
		}
		row, err := qOne[AIKnowledge](ctx, tx,
			`INSERT INTO ai_knowledge
			   (project_id, created_by, author_name, title, summary, body, tags, chars, created_at, updated_at)
			 VALUES ($1, NULL, $2, $3, $4, $5, COALESCE($6::text[], '{}'), $7, $8, $8)
			 RETURNING `+aiKnowledgeColumns,
			projectID, strings.TrimSpace(r.AuthorName), strings.TrimSpace(r.Title),
			strings.TrimSpace(r.Summary), r.Body, r.Tags, r.Chars, createdAt)
		if err != nil {
			return nil, err
		}
		done = append(done, *row)
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	return done, nil
}

// AIKnowledgeByID — знание проекта целиком. Чужой проект неотличим от «нет такого».
func (s *Store) AIKnowledgeByID(
	ctx context.Context, projectID, id uuid.UUID,
) (*AIKnowledge, error) {
	return qOne[AIKnowledge](ctx, s.Pool,
		`SELECT `+aiKnowledgeColumns+` FROM ai_knowledge
		  WHERE project_id = $1 AND id = $2`, projectID, id)
}

// AIKnowledgeByIDs — пачка знаний для вложений к сообщению.
//
// Возвращаем в порядке created_at, а порядок, в котором человек их выбрал, восстанавливает
// вызывающий: SQL-порядок для этого не годится, а карточки в вопросе должны идти так, как
// их приложили.
func (s *Store) AIKnowledgeByIDs(
	ctx context.Context, projectID uuid.UUID, ids []uuid.UUID,
) ([]AIKnowledge, error) {
	if len(ids) == 0 {
		return nil, nil
	}
	return qAll[AIKnowledge](ctx, s.Pool,
		`SELECT `+aiKnowledgeColumns+` FROM ai_knowledge
		  WHERE project_id = $1 AND id = ANY($2)
		  ORDER BY created_at, id`, projectID, ids)
}

// UpdateAIKnowledge переписывает знание. Пустой заголовок не принимаем: знание без
// заголовка не найти в списке, а список — единственный способ к нему вернуться.
func (s *Store) UpdateAIKnowledge(
	ctx context.Context, projectID, id uuid.UUID, k KnowledgeInput,
) (*AIKnowledge, error) {
	return qOne[AIKnowledge](ctx, s.Pool,
		`UPDATE ai_knowledge
		    SET title = $3, summary = $4, body = $5, tags = COALESCE($6::text[], '{}'), chars = $7, updated_at = now()
		  WHERE project_id = $1 AND id = $2
		  RETURNING `+aiKnowledgeColumns,
		projectID, id, strings.TrimSpace(k.Title), strings.TrimSpace(k.Summary), k.Body,
		k.Tags, k.Chars)
}

// DeleteAIKnowledge удаляет знание. Вложения в сообщениях остаются: у них снимок
// заголовка, и сообщение не должно превращаться в пустую карточку.
func (s *Store) DeleteAIKnowledge(ctx context.Context, projectID, id uuid.UUID) (bool, error) {
	tag, err := s.Pool.Exec(ctx,
		`DELETE FROM ai_knowledge WHERE project_id = $1 AND id = $2`, projectID, id)
	if err != nil {
		return false, err
	}
	return tag.RowsAffected() > 0, nil
}

// SetAIConversationKept — «не удалять эту беседу» (0.149.0).
//
// Нужно отдельно от «сохранить в знание»: переписка с черновиками и отказами модели
// бывает дороже выводов, и человек вправе оставить именно её.
func (s *Store) SetAIConversationKept(
	ctx context.Context, id, userID uuid.UUID, kept bool,
) (bool, error) {
	tag, err := s.Pool.Exec(ctx,
		`UPDATE ai_conversations SET kept = $3 WHERE id = $1 AND user_id = $2`, id, userID, kept)
	if err != nil {
		return false, err
	}
	return tag.RowsAffected() > 0, nil
}

// SetAIRetention задаёт срок хранения бесед проекта (0 — не удалять).
//
// Строку настроек может не быть — тогда вставляем: умолчания остальных полей берёт
// схема, и включение срока не должно обнулять роль и указания агента.
func (s *Store) SetAIRetention(
	ctx context.Context, projectID uuid.UUID, days int,
) (*ProjectAISettings, error) {
	return qOne[ProjectAISettings](ctx, s.Pool,
		`INSERT INTO project_ai_settings (project_id, retention_days)
		 VALUES ($1, $2)
		 ON CONFLICT (project_id) DO UPDATE
		    SET retention_days = EXCLUDED.retention_days,
		        updated_at = now()
		 RETURNING project_id, role, instructions, enabled, generation, image_style,
		           image_negative, retention_days, updated_at, updated_by`,
		projectID, days)
}

// AIRetentionPreview — что автоочистка сделает по нынешнему сроку (0.150.0).
//
// Зачем: без предупреждения «включил срок — история удалилась молча» выглядит как потеря
// данных. Считаем на сервере, а не в интерфейсе, потому что ответ нужен один и по всему
// проекту: беседы соавторов стареют вместе.
type AIRetentionPreview struct {
	// Total — сколько бесед проекта (не помеченных «не удалять») вообще участвует.
	Total int
	// Due — сколько из них старше срока и удалится на следующем проходе.
	Due int
	// NextDays — через сколько дней удалится ближайшая (0 — уже за пределами срока).
	NextDays int
}

// AIRetentionPreview считает предупреждение для владельца проекта.
//
// Один запрос, а не «выбрать беседы и посчитать в Go»: важно только «сколько старых» и
// «когда ближайшая», и база отвечает на это без пересылки строк.
func (s *Store) AIRetentionPreview(
	ctx context.Context, projectID uuid.UUID, days int,
) (AIRetentionPreview, error) {
	var out AIRetentionPreview
	if days <= 0 {
		return out, nil
	}
	var due int
	var oldestDays float64
	err := s.Pool.QueryRow(ctx,
		`SELECT count(*)::int,
		        count(*) FILTER (WHERE updated_at < now() - make_interval(days => $2))::int,
		        COALESCE(EXTRACT(EPOCH FROM now() - max(updated_at)) / 86400, 0)::float8
		   FROM ai_conversations
		  WHERE project_id = $1 AND kept = false`, projectID, days).Scan(&out.Total, &due, &oldestDays)
	if err != nil {
		return out, err
	}
	out.Due = due
	if out.Total > 0 {
		next := days - int(oldestDays)
		if next < 0 {
			next = 0
		}
		out.NextDays = next
	}
	return out, nil
}

// FindSimilarKnowledge отдаёт знания проекта для поиска дублей (0.150.0).
//
// Сравнение — на стороне Go, без pg_trgm: расширение пришлось бы ставить на каждую базу
// (включая тестовую), а знаний у проекта сотни, не миллионы — загрузить заголовки и
// пометки дешевле, чем тянуть зависимость ради одного сравнения.
func (s *Store) FindSimilarKnowledge(
	ctx context.Context, projectID uuid.UUID, limit int,
) ([]AIKnowledgeBrief, error) {
	if limit <= 0 {
		limit = 500
	}
	return qAll[AIKnowledgeBrief](ctx, s.Pool,
		`SELECT `+aiKnowledgeBriefColumns+`
		   FROM ai_knowledge
		  WHERE project_id = $1
		  ORDER BY created_at DESC
		  LIMIT $2`, projectID, limit)
}

// CleanupAIConversations удаляет беседы, которые старше срока хранения проекта.
//
// Одним запросом, а не «выбрать проекты и удалять по одному»: срок живёт в настройках
// проекта, и решение «эта беседа старая» принимает база — иначе между выборкой и
// удалением кто-то успел бы дописать сообщение, и свежая беседа исчезла бы.
//
// Что НЕ удаляется: беседы с флагом `kept` (человек попросил оставить) и проекты с
// нулевым сроком. Сообщения уходят каскадом вместе с беседой.
func (s *Store) CleanupAIConversations(ctx context.Context) (int64, error) {
	tag, err := s.Pool.Exec(ctx,
		`DELETE FROM ai_conversations c
		  USING project_ai_settings s
		  WHERE s.project_id = c.project_id
		    AND s.retention_days > 0
		    AND c.kept = false
		    AND c.updated_at < now() - make_interval(days => s.retention_days)`)
	if err != nil {
		return 0, err
	}
	return tag.RowsAffected(), nil
}
