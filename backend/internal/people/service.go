// Package people — каталог зарегистрированных участников («резидентов»):
// список людей с краткими сведениями и специализациями.
//
// Каталог — витрина инсталляции, а не социальная сеть. Он показывает только то,
// что человек сам о себе рассказал (bio и crafts из users), и уважает галочку
// «не показывать меня» (users.discoverable): скрытый человек не находится ни
// здесь, ни в поиске соавторов, но свой профиль видит всегда.
//
// Отношения (relation) те же, что в поиске соавторов: каталог и поиск — две
// двери в один круг людей, и понимать «мы уже соавторы» нужно в обеих.
package people

import (
	"context"
	"errors"
	"strings"
	"unicode/utf8"

	"github.com/google/uuid"

	"github.com/skyfraze/backend/internal/store"
)

var (
	// ErrBadArgument — параметры страницы не имеют смысла: отрицательные
	// limit/offset или специализация длиннее 60 рун (таких в каталоге подсказок
	// не бывает, значит это опечатка или попытка нагрузить базу длинным LIKE).
	ErrBadArgument = errors.New("bad argument")
	// ErrNotFound — человека нет или он скрыт от каталога.
	ErrNotFound = errors.New("user not found")
)

const (
	// defaultLimit — размер страницы, если её не задали: 24 карточки — три ряда
	// по восемь на широком экране, столько же, сколько в публичной ленте.
	defaultLimit = 24
	// maxLimit — предел страницы: каталог не должен превращаться в выгрузку всей
	// инсталляции одним запросом.
	maxLimit = 50
	// minQueryLen — короткий запрос не ищем: одна буква вернула бы почти всех, и
	// это уже не поиск, а сканирование. Те же 2 символа, что в поиске соавторов.
	minQueryLen = 2
	// maxCraftRunes — предел специализации: столько же, сколько в профиле
	// (store.MaxCraftRunes). Значение приходит из интерфейса, поэтому бэкенд
	// проверяет его сам, а не доверяет форме.
	maxCraftRunes = store.MaxCraftRunes
)

// Filter — параметры страницы каталога. Craft — ТОЧНОЕ значение специализации:
// каталог подсказок живёт в интерфейсе, поэтому бэкенд принимает любую строку и
// ищет её вхождение в массив (никаких «похожих» специализаций).
type Filter struct {
	Q      string
	Craft  string
	Limit  int
	Offset int
}

// CatalogPage — страница каталога. Total — сколько людей подходит под фильтр
// всего (не размер страницы): интерфейсу нужен счётчик для «показать ещё».
type CatalogPage struct {
	Items  []store.UserPublic `json:"items"`
	Total  int                `json:"total"`
	Limit  int                `json:"limit"`
	Offset int                `json:"offset"`
}

// Profile — публичный профиль: та же карточка, что в каталоге, плюс
// опубликованные истории человека.
type Profile struct {
	store.UserPublic
	Stories []store.UserPublicStory `json:"stories"`
}

type Service struct {
	store *store.Store
}

func New(s *store.Store) *Service {
	return &Service{store: s}
}

// Catalog — страница каталога глазами запрашивающего: его самого в выдаче нет,
// а relation показывает, что связывает его с каждым человеком.
//
// Пустой q — это каталог целиком (люди без поиска), короткий q — пустая выдача
// без запроса в базу: правило «одна буква не ищет» должно быть видно вызывающему
// сразу, а не как странная выборка.
func (s *Service) Catalog(ctx context.Context, userID uuid.UUID, f Filter) (CatalogPage, error) {
	f.Q = strings.TrimSpace(f.Q)
	f.Craft = strings.TrimSpace(f.Craft)

	if utf8.RuneCountInString(f.Craft) > maxCraftRunes {
		return CatalogPage{}, ErrBadArgument
	}
	if f.Limit < 0 || f.Offset < 0 {
		return CatalogPage{}, ErrBadArgument
	}
	if f.Limit == 0 {
		f.Limit = defaultLimit
	}
	if f.Limit > maxLimit {
		f.Limit = maxLimit
	}

	page := CatalogPage{Items: []store.UserPublic{}, Limit: f.Limit, Offset: f.Offset}
	if n := utf8.RuneCountInString(f.Q); n > 0 && n < minQueryLen {
		return page, nil
	}

	items, total, err := s.store.CatalogUsers(ctx, userID, store.UserFilter{
		Q: f.Q, Craft: f.Craft, Limit: f.Limit, Offset: f.Offset,
	})
	if err != nil {
		return CatalogPage{}, err
	}
	page.Items = items
	page.Total = total
	return page, nil
}

// Profile — публичный профиль человека.
//
// Скрытый человек для чужих — 404, а не 403: иначе перебором id можно было бы
// отличить «спрятался» от «не существует», а галочка «не показывать меня»
// обещает именно невидимость. Себе свой профиль виден всегда — иначе человек не
// увидел бы, как выглядит его карточка, пока скрыт.
func (s *Service) Profile(ctx context.Context, userID, targetID uuid.UUID) (Profile, error) {
	u, stories, err := s.store.GetUserPublic(ctx, targetID)
	if err != nil {
		if errors.Is(err, store.ErrNotFound) {
			return Profile{}, ErrNotFound
		}
		return Profile{}, err
	}
	if !u.Discoverable && targetID != userID {
		return Profile{}, ErrNotFound
	}

	relation, err := s.relation(ctx, userID, targetID)
	if err != nil {
		return Profile{}, err
	}
	u.Relation = relation

	if stories == nil {
		stories = []store.UserPublicStory{}
	}
	return Profile{UserPublic: *u, Stories: stories}, nil
}

// relation — как запрашивающий связан с человеком. Значения те же, что отдаёт
// поиск соавторов (coauthor / request-incoming / request-outgoing / пусто):
// интерфейс рисует по ним одну и ту же плашку в обеих дверях.
func (s *Service) relation(ctx context.Context, viewerID, targetID uuid.UUID) (string, error) {
	if viewerID == targetID {
		return "", nil
	}
	link, err := s.store.GetCoauthorLink(ctx, viewerID, targetID)
	if err != nil {
		if errors.Is(err, store.ErrNotFound) {
			return "", nil
		}
		return "", err
	}
	switch {
	case link.Status == store.CoauthorAccepted:
		return "coauthor", nil
	case link.Status == store.CoauthorPending && link.AddresseeID == viewerID:
		return "request-incoming", nil
	case link.Status == store.CoauthorPending:
		return "request-outgoing", nil
	}
	// Отклонённая заявка — не отношение: показывать «вы связаны» нечем.
	return "", nil
}
