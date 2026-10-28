package store

// store_chat_reactions.go — отметки на сообщениях чата (миграция 0041, 0.98.0).
//
// Отметка — не сообщение: она не занимает строки в ленте и не создаёт уведомлений. Три вида, все
// про работу над проектом: «согласен» (мысль принята), «надо сделать» (из этого следует правка) и
// «вопрос» (нужно уточнить). Набор фиксирован схемой, а не «любой эмодзи»: чат проекта — разговор о
// тексте, и голосование за сообщения превращало бы его в рейтинг.
//
// Отдельно от реакций замечаний (0025): у тех свои виды («согласен», «сделано») и своя таблица.
// Общая таблица с полиморфной ссылкой «на что» потребовала бы проверки целостности руками, а
// внешние ключи — единственное, что здесь действительно держит данные.

import (
	"context"

	"github.com/google/uuid"
)

// ChatReactionKind — вид отметки в чате.
type ChatReactionKind string

const (
	// ChatReactionAgree — «согласен»: с мыслью согласны, делать ничего не нужно.
	ChatReactionAgree ChatReactionKind = "agree"
	// ChatReactionTodo — «надо сделать»: из сообщения следует правка в проекте.
	ChatReactionTodo ChatReactionKind = "todo"
	// ChatReactionQuestion — «вопрос»: нужно уточнить, что имелось в виду.
	ChatReactionQuestion ChatReactionKind = "question"
)

// ParseChatReactionKind разбирает вид отметки из строки запроса.
func ParseChatReactionKind(raw string) (ChatReactionKind, bool) {
	switch ChatReactionKind(raw) {
	case ChatReactionAgree:
		return ChatReactionAgree, true
	case ChatReactionTodo:
		return ChatReactionTodo, true
	case ChatReactionQuestion:
		return ChatReactionQuestion, true
	default:
		return "", false
	}
}

// ChatReactions — сколько отметок каждого вида у сообщения и какие из них мои.
//
// `Mine` — список видов, а не «моя ли отметка»: у одного человека на сообщении может стоять и
// «согласен», и «надо сделать» (согласен с мыслью, беру в работу), и интерфейс должен подсветить обе
// кнопки. Считать это в браузере по списку людей — лишний круг данных.
type ChatReactions struct {
	Agree    int      `json:"agree"`
	Todo     int      `json:"todo"`
	Question int      `json:"question"`
	Mine     []string `json:"mine"`
}

// Empty — «отметок нет» с пустым списком, а не nil: интерфейс читает `reactions.mine` без проверок,
// и `null` в JSON там был бы поводом для отдельной ветки на клиенте.
func (r ChatReactions) Empty() bool {
	return r.Agree == 0 && r.Todo == 0 && r.Question == 0
}

// AddChatReaction ставит отметку. Повтор не ошибка и новых строк не создаёт.
func (s *Store) AddChatReaction(
	ctx context.Context, messageID, userID uuid.UUID, kind ChatReactionKind,
) error {
	_, err := s.Pool.Exec(ctx,
		`INSERT INTO project_chat_reactions (message_id, user_id, kind)
		 VALUES ($1, $2, $3)
		 ON CONFLICT (message_id, user_id, kind) DO NOTHING`,
		messageID, userID, string(kind))
	return err
}

// RemoveChatReaction снимает отметку. Отсутствующая отметка — не ошибка: снятие идемпотентно,
// чтобы двойное нажатие не выглядело поломкой.
func (s *Store) RemoveChatReaction(
	ctx context.Context, messageID, userID uuid.UUID, kind ChatReactionKind,
) error {
	_, err := s.Pool.Exec(ctx,
		`DELETE FROM project_chat_reactions
		  WHERE message_id = $1 AND user_id = $2 AND kind = $3`,
		messageID, userID, string(kind))
	return err
}

// ChatReactionStats — отметки по набору сообщений одним запросом.
//
// Один запрос, а не «по запросу на сообщение»: окно чата показывает до сотни сообщений, и N+1 здесь
// заметен сразу — лента перечитывается после каждого чужого сообщения.
func (s *Store) ChatReactionStats(
	ctx context.Context, messageIDs []uuid.UUID, userID uuid.UUID,
) (map[uuid.UUID]ChatReactions, error) {
	out := make(map[uuid.UUID]ChatReactions, len(messageIDs))
	if len(messageIDs) == 0 {
		return out, nil
	}
	rows, err := s.Pool.Query(ctx,
		`SELECT message_id,
		        count(*) FILTER (WHERE kind = 'agree')    AS agree,
		        count(*) FILTER (WHERE kind = 'todo')     AS todo,
		        count(*) FILTER (WHERE kind = 'question') AS question,
		        bool_or(user_id = $2 AND kind = 'agree')    AS mine_agree,
		        bool_or(user_id = $2 AND kind = 'todo')     AS mine_todo,
		        bool_or(user_id = $2 AND kind = 'question') AS mine_question
		   FROM project_chat_reactions
		  WHERE message_id = ANY($1::uuid[])
		  GROUP BY message_id`,
		messageIDs, userID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	for rows.Next() {
		var (
			id                         uuid.UUID
			agree, todo, question      int
			mineAgree, mineTodo, mineQ bool
		)
		if err := rows.Scan(&id, &agree, &todo, &question, &mineAgree, &mineTodo, &mineQ); err != nil {
			return nil, err
		}
		stats := ChatReactions{Agree: agree, Todo: todo, Question: question, Mine: []string{}}
		if mineAgree {
			stats.Mine = append(stats.Mine, string(ChatReactionAgree))
		}
		if mineTodo {
			stats.Mine = append(stats.Mine, string(ChatReactionTodo))
		}
		if mineQ {
			stats.Mine = append(stats.Mine, string(ChatReactionQuestion))
		}
		out[id] = stats
	}
	return out, rows.Err()
}
