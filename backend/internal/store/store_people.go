// Каталог людей: чтение карточек зарегистрированных участников.
//
// Отдельный файл, потому что это отдельный контур доступа: здесь нет проверок
// членства в проектах, а есть только витрина человека (bio, crafts) и его
// опубликованные истории. Источник истины — users.discoverable: скрытый человек
// не попадает ни в каталог, ни в поиск (см. SearchUsers).
package store

import (
	"context"
	"strings"
	"unicode/utf8"

	"github.com/google/uuid"
)

// UserPublic — карточка человека в каталоге и в профиле.
//
// Total — не свойство человека, а размер всей выборки (COUNT(*) OVER () из
// CatalogUsers): интерфейсу нужен счётчик страниц, а второй запрос с тем же
// набором условий легко разошёлся бы с первым.
type UserPublic struct {
	ID           uuid.UUID `db:"id" json:"id"`
	Username     string    `db:"username" json:"username"`
	DisplayName  string    `db:"display_name" json:"display_name"`
	Bio          string    `db:"bio" json:"bio"`
	Crafts       []string  `db:"crafts" json:"crafts"`
	Discoverable bool      `db:"discoverable" json:"-"`
	// PublicStories — сколько историй человек опубликовал.
	PublicStories int `db:"public_stories" json:"public_stories"`
	// Relation: coauthor | request-incoming | request-outgoing | "" (как в поиске
	// соавторов) — что связывает человека с тем, кто смотрит каталог.
	Relation string `db:"relation" json:"relation"`
	Total    int    `db:"total" json:"-"`
}

// UserPublicStory — опубликованная история в профиле человека.
type UserPublicStory struct {
	ID    uuid.UUID `db:"id" json:"id"`
	Title string    `db:"title" json:"title"`
	Slug  string    `db:"public_slug" json:"slug"`
}

// UserFilter — параметры страницы каталога. Значения приходят уже проверенными
// сервисом: здесь только SQL, без разбора пользовательского ввода.
type UserFilter struct {
	Q      string
	Craft  string
	Limit  int
	Offset int
}

// userPublicFrom — общая часть каталога и профиля: карточка человека и число его
// публичных историй. Публичность считается так же, как в публичной ленте
// (store_feed.go): is_public + выданный public_slug, иначе ссылки на историю нет.
const userPublicFrom = `
	  FROM users u
	  LEFT JOIN LATERAL (
	      SELECT COUNT(*) AS cnt
	        FROM projects p
	       WHERE p.owner_id = u.id AND p.is_public AND p.public_slug IS NOT NULL
	  ) st ON true`

const userPublicColumns = `u.id, u.username, u.display_name, u.bio, u.crafts,
	u.discoverable, COALESCE(st.cnt, 0)::int AS public_stories`

// CatalogUsers — страница каталога и общее число подходящих людей.
//
// viewerID исключается из выдачи: себя в списке искать незачем, а карточка
// «это я» уже есть в профиле. Скрытые (discoverable = false) не показываются
// никому, включая себя: каталог — это чужие люди.
//
// Сортировка: сначала совпадение по префиксу ника (человек, которого набирают
// по @nick, должен быть первым), затем ник — ники уникальны, поэтому порядок
// страниц стабилен и offset не «перескакивает» между запросами.
func (s *Store) CatalogUsers(ctx context.Context, viewerID uuid.UUID, f UserFilter) ([]UserPublic, int, error) {
	q := strings.TrimSpace(f.Q)
	// Короткий запрос отсекаем и здесь, а не только в сервисе: так правило
	// «одна буква — не поиск» не зависит от того, кто вызвал store.
	if q != "" && utf8.RuneCountInString(q) < 2 {
		return []UserPublic{}, 0, nil
	}
	var patternArg any
	if q != "" {
		patternArg = escapeLike(q)
	}
	var craftArg any
	if c := strings.TrimSpace(f.Craft); c != "" {
		craftArg = c
	}

	rows, err := qAll[UserPublic](ctx, s.Pool,
		`SELECT `+userPublicColumns+`,
		        CASE
		          WHEN l.status = 'accepted' THEN 'coauthor'
		          WHEN l.status = 'pending' AND l.addressee_id = $1 THEN 'request-incoming'
		          WHEN l.status = 'pending' THEN 'request-outgoing'
		          ELSE ''
		        END AS relation,
		        COUNT(*) OVER ()::int AS total`+
			userPublicFrom+`
	  LEFT JOIN coauthor_links l
	         ON (l.requester_id = $1 AND l.addressee_id = u.id)
	         OR (l.addressee_id = $1 AND l.requester_id = u.id)
	 WHERE u.discoverable
	   AND u.id <> $1
	   AND ($2::text IS NULL OR u.username ILIKE $2 || '%' OR u.display_name ILIKE '%' || $2 || '%')
	   AND ($3::text IS NULL OR $3 = ANY(u.crafts))
	 ORDER BY (CASE WHEN $2::text IS NULL THEN false ELSE u.username ILIKE $2 || '%' END) DESC,
	          u.username
	 LIMIT $4 OFFSET $5`,
		viewerID, patternArg, craftArg, f.Limit, f.Offset)
	if err != nil {
		return nil, 0, err
	}
	total := 0
	if len(rows) > 0 {
		total = rows[0].Total
	}
	return normalizePublicCrafts(rows), total, nil
}

// GetUserPublic — карточка человека и его опубликованные истории.
//
// Скрытость здесь НЕ проверяется: доступ решает people.Service.Profile, потому
// что правило «скрыт от чужих, но виден себе» знает только он (store не получает
// того, кто смотрит).
func (s *Store) GetUserPublic(ctx context.Context, id uuid.UUID) (*UserPublic, []UserPublicStory, error) {
	u, err := qOne[UserPublic](ctx, s.Pool,
		`SELECT `+userPublicColumns+userPublicFrom+`
	 WHERE u.id = $1`, id)
	if err != nil {
		return nil, nil, err
	}
	stories, err := qAll[UserPublicStory](ctx, s.Pool,
		`SELECT id, title, public_slug
		   FROM projects
		  WHERE owner_id = $1 AND is_public AND public_slug IS NOT NULL
		  ORDER BY published_at DESC NULLS LAST, created_at DESC`, id)
	if err != nil {
		return nil, nil, err
	}
	if u.Crafts == nil {
		u.Crafts = []string{}
	}
	return u, stories, nil
}

// normalizePublicCrafts — пустой массив должен уезжать в JSON как [], а не null:
// интерфейс итерирует по crafts и на null ломается.
func normalizePublicCrafts(rows []UserPublic) []UserPublic {
	for i := range rows {
		if rows[i].Crafts == nil {
			rows[i].Crafts = []string{}
		}
	}
	return rows
}
