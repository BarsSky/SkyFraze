package store

// store_entity_proposals.go — предложения помощника «заведите карточки мира и связи между
// ними» (миграция 0033).
//
// Почему отдельная таблица, а не `ai_changes`: там обязателен `event_id`, потому что правка
// всегда про один кадр. Здесь кадров нет вовсе — есть пачка карточек и связей между ними.
//
// Связи хранятся ИМЕНАМИ карточек. На момент предложения карточек ещё нет, и идентификаторов
// взять неоткуда; при применении имена разрешаются в id — так одна и та же пачка работает и
// когда карточки создаются ею, и когда половина из них уже есть в проекте.

import (
	"context"
	"encoding/json"
	"time"

	"github.com/google/uuid"
)

// Состояния предложения карточек. Совпадают по смыслу с состояниями правки кадра, но
// `superseded` здесь нет: карточка не «меняется» под предложением, а имя либо свободно, либо
// занято — занятое имя пропускается при применении, и это видно человеку в отчёте.
const (
	EntityProposalPending   = "pending"
	EntityProposalApplied   = "applied"
	EntityProposalDiscarded = "discarded"
)

// ProposedCard — карточка, которую предлагает помощник.
//
// Идентификатора нет: карточка ещё не создана. Связи ссылаются на неё по имени — см. ниже.
type ProposedCard struct {
	Kind        string   `json:"kind"` // character | place | theme
	Name        string   `json:"name"`
	Aliases     []string `json:"aliases"`
	Description string   `json:"description"`
}

// ProposedLink — связь между карточками, предложенная вместе с ними.
//
// Оба конца — имена карточек: тех, что в этой же пачке, или тех, что уже есть в проекте.
// Label — подпись человека («живёт на»), направление — от `From` к `To`.
type ProposedLink struct {
	From  string `json:"from"`
	To    string `json:"to"`
	Label string `json:"label"`
}

// EntityProposal — предложение карточек мира.
type EntityProposal struct {
	ID             uuid.UUID      `db:"id" json:"id"`
	ProjectID      uuid.UUID      `db:"project_id" json:"project_id"`
	ConversationID *uuid.UUID     `db:"conversation_id" json:"conversation_id"`
	UserID         uuid.UUID      `db:"user_id" json:"user_id"`
	Note           string         `db:"note" json:"note"`
	Cards          []ProposedCard `db:"cards" json:"cards"`
	Links          []ProposedLink `db:"links" json:"links"`
	Status         string         `db:"status" json:"status"`
	CreatedAt      time.Time      `db:"created_at" json:"created_at"`
	AppliedAt      *time.Time     `db:"applied_at" json:"applied_at"`
}

const entityProposalColumns = `id, project_id, conversation_id, user_id, note, cards, links,
	status, created_at, applied_at`

// CreateEntityProposal сохраняет предложение карточек.
//
// JSON собирается здесь, а не отдаётся pgx: `cards` и `links` — колонки jsonb, и передавать
// их строкой с явным приведением `::jsonb` — тот же приём, что у снимка кадра в `ai_changes`
// (SetAIChangeFrame), то есть проверенный на живой базе.
func (s *Store) CreateEntityProposal(ctx context.Context, p EntityProposal) (*EntityProposal, error) {
	cards := p.Cards
	if cards == nil {
		cards = []ProposedCard{}
	}
	links := p.Links
	if links == nil {
		links = []ProposedLink{}
	}
	cardsJSON, err := json.Marshal(cards)
	if err != nil {
		return nil, err
	}
	linksJSON, err := json.Marshal(links)
	if err != nil {
		return nil, err
	}
	return qOne[EntityProposal](ctx, s.Pool,
		`INSERT INTO ai_entity_proposals (project_id, conversation_id, user_id, note, cards, links,
		                                  status)
		 VALUES ($1, $2, $3, $4, $5::jsonb, $6::jsonb, $7)
		 RETURNING `+entityProposalColumns,
		p.ProjectID, p.ConversationID, p.UserID, p.Note,
		string(cardsJSON), string(linksJSON), EntityProposalPending)
}

// EntityProposalByID читает предложение проекта.
//
// Проект — условием того же запроса, а не проверкой после чтения: идентификатор приходит из
// адреса, и «предложение принадлежит этому проекту» не должно проверяться отдельным шагом.
func (s *Store) EntityProposalByID(
	ctx context.Context, projectID, id uuid.UUID,
) (*EntityProposal, error) {
	return qOne[EntityProposal](ctx, s.Pool,
		`SELECT `+entityProposalColumns+` FROM ai_entity_proposals
		  WHERE id=$1 AND project_id=$2`, id, projectID)
}

// PendingEntityProposals — предложения, которые ждут решения этого человека.
//
// Только свои: предложение приходит из личной беседы, и показывать чужое «агент предлагает
// завести персонажей» значило бы раскрывать её содержание.
func (s *Store) PendingEntityProposals(
	ctx context.Context, projectID, userID uuid.UUID,
) ([]EntityProposal, error) {
	return qAll[EntityProposal](ctx, s.Pool,
		`SELECT `+entityProposalColumns+` FROM ai_entity_proposals
		  WHERE project_id=$1 AND user_id=$2 AND status=$3
		  ORDER BY created_at`, projectID, userID, EntityProposalPending)
}

// SetEntityProposalStatus переводит предложение в новое состояние.
//
// Условие «было from» — часть запроса: два нажатия «Добавить» (двойной клик, две вкладки) не
// должны создать карточки дважды. ErrNotFound означает, что предложение уже не в этом
// состоянии.
func (s *Store) SetEntityProposalStatus(ctx context.Context, id uuid.UUID, from, to string) error {
	tag, err := s.Pool.Exec(ctx,
		`UPDATE ai_entity_proposals
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
