package store

import (
	"errors"
	"strings"
	"unicode/utf8"
)

// ErrInvalidCrafts — специализации не помещаются в разумные пределы.
var ErrInvalidCrafts = errors.New("invalid crafts")

// Пределы специализаций: список свободный (каталог подсказок живёт в интерфейсе),
// но его нельзя превратить в свалку.
const (
	MaxCrafts     = 12
	MaxCraftRunes = 60
)

// CleanCrafts приводит список специализаций к аккуратному виду: без пустых,
// без дублей (регистр не важен), с ограничением длины и количества.
//
// Живёт в store, а не в одном из сервисов, потому что список нужен сразу двум
// контурам — профилю человека (auth) и связи соавторов (coauthors), — а
// импортировать их друг из друга нельзя: coauthors уже зависит от auth.
func CleanCrafts(in []string) ([]string, error) {
	if len(in) > MaxCrafts {
		return nil, ErrInvalidCrafts
	}
	seen := make(map[string]bool, len(in))
	out := make([]string, 0, len(in))
	for _, raw := range in {
		craft := strings.TrimSpace(raw)
		if craft == "" {
			continue
		}
		if utf8.RuneCountInString(craft) > MaxCraftRunes {
			return nil, ErrInvalidCrafts
		}
		key := strings.ToLower(craft)
		if seen[key] {
			continue
		}
		seen[key] = true
		out = append(out, craft)
	}
	return out, nil
}
