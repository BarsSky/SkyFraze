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
	Chars      int        `db:"chars" json:"chars"`
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
	Chars                int        `db:"chars" json:"chars"`
	SourceConversationID *uuid.UUID `db:"source_conversation_id" json:"source_conversation_id,omitempty"`
	CreatedAt            time.Time  `db:"created_at" json:"created_at"`
	UpdatedAt            time.Time  `db:"updated_at" json:"updated_at"`
}

// Brief отдаёт знание без тела.
func (k AIKnowledge) Brief() AIKnowledgeBrief {
	return AIKnowledgeBrief{
		ID: k.ID, ProjectID: k.ProjectID, CreatedBy: k.CreatedBy, AuthorName: k.AuthorName,
		Title: k.Title, Summary: k.Summary, Chars: k.Chars,
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
	Chars   int
}

const aiKnowledgeColumns = `id, project_id, created_by, author_name, title, summary, body, chars,
	source_conversation_id, created_at, updated_at`

const aiKnowledgeBriefColumns = `id, project_id, created_by, author_name, title, summary, chars,
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
		   (project_id, created_by, author_name, title, summary, body, chars, source_conversation_id)
		 VALUES ($1, $2, COALESCE((SELECT display_name FROM users WHERE id = $2), ''),
		         $3, $4, $5, $6, $7)
		 RETURNING `+aiKnowledgeColumns,
		projectID, author, strings.TrimSpace(k.Title), strings.TrimSpace(k.Summary),
		k.Body, k.Chars, source)
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
			   (project_id, created_by, author_name, title, summary, body, chars, source_conversation_id)
			 VALUES ($1, $2, COALESCE((SELECT display_name FROM users WHERE id = $2), ''),
			         $3, $4, $5, $6, $7)
			 RETURNING `+aiKnowledgeColumns,
			projectID, author, strings.TrimSpace(k.Title), strings.TrimSpace(k.Summary),
			k.Body, k.Chars, source)
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

// ListAIKnowledge — знания проекта без тел, свежие сверху.
//
// query ищет по заголовку, пометке и телу: человек помнит фразу, а не то, в каком поле
// она лежала. Пустой запрос — весь список.
func (s *Store) ListAIKnowledge(
	ctx context.Context, projectID uuid.UUID, query string, limit int,
) ([]AIKnowledgeBrief, error) {
	if limit <= 0 || limit > 200 {
		limit = 200
	}
	q := strings.TrimSpace(query)
	return qAll[AIKnowledgeBrief](ctx, s.Pool,
		`SELECT `+aiKnowledgeBriefColumns+`
		   FROM ai_knowledge
		  WHERE project_id = $1
		    AND ($2 = '' OR title ILIKE '%' || $2 || '%'
		                 OR summary ILIKE '%' || $2 || '%'
		                 OR body ILIKE '%' || $2 || '%')
		  ORDER BY created_at DESC, id DESC
		  LIMIT $3`, projectID, q, limit)
}

// AIKnowledgeImport — знание из архива: с автором и датой создания.
//
// Отдельный тип, а не KnowledgeInput: при переносе проекта «когда это придумали» — часть
// содержания. Если бы знания импортировались с датой импорта, вся картина работы над
// историей съехала бы в один день.
type AIKnowledgeImport struct {
	Title      string
	Summary    string
	Body       string
	Chars      int
	AuthorName string
	CreatedAt  time.Time
}

// ImportAIKnowledge записывает знания из архива, сохраняя имя автора и дату создания.
//
// `created_by` пустой: автора из архива в этой базе может не быть, а привязывать его
// знание к импортирующему человеку значило бы приписать ему чужие выводы. Имя остаётся
// снимком — ровно так же, как в общем чате.
func (s *Store) ImportAIKnowledge(
	ctx context.Context, projectID uuid.UUID, records []AIKnowledgeImport,
) (int, error) {
	if len(records) == 0 {
		return 0, nil
	}
	tx, err := s.Pool.Begin(ctx)
	if err != nil {
		return 0, err
	}
	defer func() { _ = tx.Rollback(ctx) }()

	done := 0
	for _, r := range records {
		createdAt := r.CreatedAt
		if createdAt.IsZero() {
			createdAt = time.Now()
		}
		if _, err := tx.Exec(ctx,
			`INSERT INTO ai_knowledge
			   (project_id, created_by, author_name, title, summary, body, chars, created_at, updated_at)
			 VALUES ($1, NULL, $2, $3, $4, $5, $6, $7, $7)`,
			projectID, strings.TrimSpace(r.AuthorName), strings.TrimSpace(r.Title),
			strings.TrimSpace(r.Summary), r.Body, r.Chars, createdAt); err != nil {
			return 0, err
		}
		done++
	}
	if err := tx.Commit(ctx); err != nil {
		return 0, err
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
		    SET title = $3, summary = $4, body = $5, chars = $6, updated_at = now()
		  WHERE project_id = $1 AND id = $2
		  RETURNING `+aiKnowledgeColumns,
		projectID, id, strings.TrimSpace(k.Title), strings.TrimSpace(k.Summary), k.Body, k.Chars)
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
