package store

// store_ai_changes.go — предложенные агентом правки существующих кадров (миграция 0015).
//
// Обычная таблица, а не поля в сообщении беседы, по двум причинам:
//
//   - предложение живёт СВОЕЙ жизнью: его можно применить через полчаса, отклонить или
//     отменить, и всё это не меняет историю переписки;
//   - «применено» — это факт о проекте, а не о сообщении, и подтверждать его должен
//     сервер, а не браузер (иначе достаточно было бы отправить запрос руками).

import (
	"context"
	"encoding/json"
	"time"

	"github.com/google/uuid"
)

// Виды предложений.
const (
	// AIChangeUpdateText — переписать заголовок и/или текст существующего кадра.
	AIChangeUpdateText = "update_text"
	// AIChangeDeleteEvent — удалить кадр.
	AIChangeDeleteEvent = "delete_event"
	// AIChangeUpdateSpan — заменить ФРАГМЕНТ текста кадра (правка по замечанию к фрагменту,
	// миграция 0027). Отдельный вид, а не update_text: сверка при применении идёт по
	// фрагменту, иначе чужая правка в соседнем абзаце отменяла бы законное предложение.
	AIChangeUpdateSpan = "update_span"
)

// Состояния предложения.
const (
	AIChangePending = "pending"
	// AIChangeApplied — человек подтвердил, правка в документе.
	AIChangeApplied = "applied"
	// AIChangeDiscarded — человек отказался.
	AIChangeDiscarded = "discarded"
	// AIChangeUpdateDate — поставить или снять ДАТУ кадра (0.106.0).
	//
	// Отдельный вид, а не «правка текста с датой»: дата — скалярное поле документа, её меняют
	// отдельным действием («перенеси этот кадр на 3 марта»), и «Вернуть» должно отменять
	// ровно дату, а не текст вместе с ней.
	AIChangeUpdateDate = "update_date"
	// AIChangeMoveEvent — перенести кадр к другому родителю (0.108.0).
	//
	// Место в дереве — не текст и не дата: проверять «изменилось ли» надо по родителю, а
	// «Вернуть» возвращает прежнего родителя. Своё значение kind, потому что у этого вида
	// предложения другие поля и другие проверки.
	AIChangeMoveEvent = "move_event"
	// AIChangeSuperseded — кадр изменился (или удалён) до подтверждения: применять
	// старое предложение нельзя, иначе оно затрёт чужие правки.
	AIChangeSuperseded = "superseded"
)

// AIChange — предложенная правка.
//
// Old* — снимок кадра на момент предложения. Он нужен трижды: показать «было»,
// проверить, что кадр не изменился, и вернуть прежний текст кнопкой «Вернуть».
//
// Frame — снимок удалённого кадра (только у kind=delete_event, миграция 0017). Появляется
// он не вместе с предложением, а в момент применения: снимок берётся из документа той же
// операцией, что удаляет кадр, — иначе между «запомнили» и «удалили» кадр успел бы
// измениться, и «Вернуть» вернуло бы не то, что удалили.
type AIChange struct {
	ID             uuid.UUID       `db:"id" json:"id"`
	ProjectID      uuid.UUID       `db:"project_id" json:"project_id"`
	ConversationID *uuid.UUID      `db:"conversation_id" json:"conversation_id"`
	UserID         uuid.UUID       `db:"user_id" json:"user_id"`
	Kind           string          `db:"kind" json:"kind"`
	EventID        uuid.UUID       `db:"event_id" json:"event_id"`
	EventTitle     string          `db:"event_title" json:"event_title"`
	OldTitle       string          `db:"old_title" json:"old_title"`
	OldBody        string          `db:"old_body" json:"old_body"`
	NewTitle       string          `db:"new_title" json:"new_title"`
	NewBody        string          `db:"new_body" json:"new_body"`
	Status         string          `db:"status" json:"status"`
	CreatedAt      time.Time       `db:"created_at" json:"created_at"`
	AppliedAt      *time.Time      `db:"applied_at" json:"applied_at"`
	Frame          json.RawMessage `db:"frame" json:"-"`
	// CommentID — замечание, по которому предложена правка фрагмента (kind=update_span).
	CommentID *uuid.UUID `db:"comment_id" json:"comment_id,omitempty"`
	// AnchorStart/AnchorEnd — копия якоря на момент предложения: комментарий могли удалить
	// или связать с другим местом, а предложение обязано остаться проверяемым.
	AnchorStart []byte `db:"anchor_start" json:"-"`
	AnchorEnd   []byte `db:"anchor_end" json:"-"`
	// OldSpan/NewSpan — текст фрагмента «было» и «станет». Сверка при применении идёт по
	// OldSpan: «фрагмент не изменился» — то же правило, что у правки кадра, но уровнем ниже.
	OldSpan string `db:"old_span" json:"old_span"`
	NewSpan string `db:"new_span" json:"new_span"`
	// OldParentID/NewParentID — перенос по дереву (kind=move_event, миграция 0044). nil —
	// корень: глава верхнего уровня. Заголовки родителей хранятся рядом, потому что интерфейс
	// показывает «место: Глава 1 → Глава 2», а переименование главы не должно переписывать
	// историю предложения.
	OldParentID    *uuid.UUID `db:"old_parent_id" json:"old_parent_id,omitempty"`
	NewParentID    *uuid.UUID `db:"new_parent_id" json:"new_parent_id,omitempty"`
	OldParentTitle string     `db:"old_parent_title" json:"old_parent_title"`
	NewParentTitle string     `db:"new_parent_title" json:"new_parent_title"`
	// OldDate/NewDate — дата кадра «было» и «станет» в формате YYYY-MM-DD (kind=update_date,
	// миграция 0043). Пустая строка — «даты нет»: это и осознанная очистка, и исходное
	// состояние кадра без даты.
	OldDate string `db:"old_date" json:"old_date"`
	NewDate string `db:"new_date" json:"new_date"`
}

const aiChangeColumns = `id, project_id, conversation_id, user_id, kind, event_id, event_title,
	old_title, old_body, new_title, new_body, status, created_at, applied_at, frame,
	comment_id, anchor_start, anchor_end, old_span, new_span, old_date, new_date,
	old_parent_id, new_parent_id, old_parent_title, new_parent_title`

// CreateAIChange сохраняет предложение.
func (s *Store) CreateAIChange(ctx context.Context, c AIChange) (*AIChange, error) {
	return qOne[AIChange](ctx, s.Pool,
		`INSERT INTO ai_changes (project_id, conversation_id, user_id, kind, event_id, event_title,
		                         old_title, old_body, new_title, new_body, status,
		                         comment_id, anchor_start, anchor_end, old_span, new_span,
		                         old_date, new_date,
		                         old_parent_id, new_parent_id, old_parent_title, new_parent_title)
		 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18,
		         $19, $20, $21, $22)
		 RETURNING `+aiChangeColumns,
		c.ProjectID, c.ConversationID, c.UserID, c.Kind, c.EventID, c.EventTitle,
		c.OldTitle, c.OldBody, c.NewTitle, c.NewBody, AIChangePending,
		c.CommentID, c.AnchorStart, c.AnchorEnd, c.OldSpan, c.NewSpan,
		c.OldDate, c.NewDate,
		c.OldParentID, c.NewParentID, c.OldParentTitle, c.NewParentTitle)
}

// AIChangeByID читает предложение проекта.
//
// Проект — отдельным условием, а не проверкой после чтения: идентификатор приходит из
// адреса запроса, и «предложение принадлежит этому проекту» должно проверяться тем же
// запросом, иначе между чтением и проверкой остаётся щель.
func (s *Store) AIChangeByID(ctx context.Context, projectID, id uuid.UUID) (*AIChange, error) {
	return qOne[AIChange](ctx, s.Pool,
		`SELECT `+aiChangeColumns+` FROM ai_changes WHERE id=$1 AND project_id=$2`, id, projectID)
}

// PendingAIChanges — предложения, которые ждут решения этого человека.
//
// Только свои: беседа, из которой предложение пришло, — личная, и показывать чужие
// «агент предлагает переписать главу» значило бы раскрывать её содержание.
func (s *Store) PendingAIChanges(ctx context.Context, projectID, userID uuid.UUID) ([]AIChange, error) {
	return qAll[AIChange](ctx, s.Pool,
		`SELECT `+aiChangeColumns+` FROM ai_changes
		  WHERE project_id=$1 AND user_id=$2 AND status=$3
		  ORDER BY created_at`, projectID, userID, AIChangePending)
}

// AppliedAIChanges — применённые правки, которые ещё можно вернуть.
//
// Зачем показывать их, а не только ожидающие: «Вернуть» — это снимок старого текста,
// он лежит в базе. Прятать его после перезагрузки страницы значило бы давать отмену
// только тем, кто не закрыл вкладку. Окно отмены ограничено неделей: месяц спустя
// «вернуть прежний текст» — это уже не отмена, а откат проекта.
func (s *Store) AppliedAIChanges(ctx context.Context, projectID, userID uuid.UUID) ([]AIChange, error) {
	return qAll[AIChange](ctx, s.Pool,
		`SELECT `+aiChangeColumns+` FROM ai_changes
		  WHERE project_id=$1 AND user_id=$2 AND status=$3
		    AND applied_at IS NOT NULL AND applied_at > now() - interval '7 days'
		  ORDER BY applied_at DESC
		  LIMIT 20`, projectID, userID, AIChangeApplied)
}

// SetAIChangeStatus переводит предложение в новое состояние.
//
// Условие «было from» — часть запроса, а не проверка перед ним: два нажатия «Применить»
// (двойной клик, две вкладки) не должны применить одну правку дважды. ErrNotFound
// означает, что предложение уже не в этом состоянии.
func (s *Store) SetAIChangeStatus(ctx context.Context, id uuid.UUID, from, to string) error {
	tag, err := s.Pool.Exec(ctx,
		`UPDATE ai_changes
		    SET status=$3,
		        applied_at = CASE WHEN $3='applied' THEN now() ELSE applied_at END
		  WHERE id=$1 AND status=$2`, id, from, to)
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		return ErrNotFound
	}
	return nil
}

// SetAIChangeFrame сохраняет снимок удалённого кадра.
//
// Отдельным запросом, а не полем в CreateAIChange: снимка в момент предложения ещё нет —
// он берётся из документа тогда, когда человек подтвердил удаление. Запись идёт после
// удаления, поэтому ошибка здесь — не повод считать удаление неудачным: кадр уже убран,
// и врать человеку «не получилось» было бы хуже, чем потерять возможность отмены
// (вызывающий пишет об этом в журнал).
func (s *Store) SetAIChangeFrame(ctx context.Context, id uuid.UUID, frame json.RawMessage) error {
	if len(frame) == 0 {
		return nil
	}
	_, err := s.Pool.Exec(ctx,
		`UPDATE ai_changes SET frame=$2::jsonb WHERE id=$1`, id, string(frame))
	return err
}

// SetAIChangeSpanAnchor обновляет якорь предложения правки фрагмента.
//
// Нужно после каждой успешной замены: `Delete` + `Insert` уносит элементы, к которым был
// привязан прежний якорь, и следующее действие («Вернуть», повторное «Применить») без нового
// якоря уже не найдёт фрагмент. Обновляем тем якорем, который рассчитал документ.
func (s *Store) SetAIChangeSpanAnchor(ctx context.Context, id uuid.UUID, start, end []byte) error {
	_, err := s.Pool.Exec(ctx,
		`UPDATE ai_changes SET anchor_start = $2, anchor_end = $3 WHERE id = $1`, id, start, end)
	return err
}
