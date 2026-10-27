package entities

// match.go — поиск упоминаний карточек в тексте НА СЕРВЕРЕ.
//
// Зачем вторая реализация, если такая же есть на клиенте (frontend/src/collab/mentions.ts).
// Разные задачи: клиент считает упоминания на каждую правку кадра (мгновенно, без сети), а
// серверу они нужны там, где открытой вкладки нет вообще — например, помощнику, который
// отвечает «где появляется Анна», не читая документ в браузере.
//
// Почему не храним упоминания в таблице с якорями (как планировалось в docs/entity-links.md
// §3.1). Проекция дерева (`events`) уже содержит заголовок и текст каждого кадра, и она
// обновляется тем же сохранением, что и документ. Отдельная таблица с якорями добавила бы
// синхронизацию (после каждой правки), риск расхождения и уборку — ради данных, которые
// выводятся из уже имеющегося текста за миллисекунды. Якоря нужны там, где связь НЕ выводится
// из текста (замечания к фрагменту); здесь наоборот — связь и есть текст.
//
// Правила те же, что на клиенте (иначе одна и та же карточка находилась бы по-разному в
// зависимости от того, кто спрашивает): без учёта регистра, длинный алиас первым, границы по
// буквам/цифрам/подчёркиванию и дефису, алиас короче двух знаков не ищется.

import (
	"regexp"
	"sort"
	"strings"
	"unicode"
	"unicode/utf8"

	"github.com/skyfraze/backend/internal/store"
)

// Entity — карточка в том виде, в каком она нужна поиску (алиас на тип store).
type Entity = store.ProjectEntity

// MinAliasRunes — тот же предел, что на клиенте (MIN_ALIAS_LENGTH): «Я» находилось бы везде.
const MinAliasRunes = 2

// Mention — найденное упоминание: где и каким словом.
type Mention struct {
	EntityID   string
	EntityName string
	Field      string // title | body
	Quote      string
}

// TextFrame — кадр для поиска (то, что есть в проекции дерева).
type TextFrame struct {
	ID    string
	Title string
	Body  string
}

// FindMentions ищет упоминания карточек в одном тексте.
//
// Go-регулярки не умеют lookbehind, поэтому границы проверяются руками по соседним рунам:
// шаблон находит совпадение без учёта регистра, а «слово ли это» решает проверка слева и
// справа. Так же получается и «одно место — одно упоминание»: берём первое совпадение
// (длинное, потому что альтернативы идут от длинной), пропускаем перекрытые.
func FindMentions(text string, list []Entity, field string) []Mention {
	if text == "" || len(list) == 0 {
		return nil
	}
	pattern, aliases := aliasPattern(list)
	if pattern == nil {
		return nil
	}
	matches := pattern.FindAllStringIndex(text, -1)
	out := make([]Mention, 0, len(matches))
	for _, span := range matches {
		from, to := span[0], span[1]
		if !wordBoundary(text, from, to) {
			continue
		}
		entity, ok := aliases[strings.ToLower(text[from:to])]
		if !ok {
			continue
		}
		out = append(out, Mention{
			EntityID: entity.ID.String(), EntityName: entity.Name,
			Field: field, Quote: text[from:to],
		})
	}
	return out
}

// FrameMentions — упоминания кадра: заголовок и текст.
func FrameMentions(frame TextFrame, list []Entity) []Mention {
	out := FindMentions(frame.Title, list, "title")
	return append(out, FindMentions(frame.Body, list, "body")...)
}

// EntityUsageRow — строка сводки: сколько кадров и упоминаний у карточки.
type EntityUsageRow struct {
	Entity   Entity
	Frames   int
	Mentions int
}

// Usage считает, где каждая карточка встречается.
func Usage(frames []TextFrame, list []Entity) []EntityUsageRow {
	rows := make([]EntityUsageRow, 0, len(list))
	index := make(map[string]int, len(list))
	for i, entity := range list {
		rows = append(rows, EntityUsageRow{Entity: entity})
		index[entity.ID.String()] = i
	}
	for _, frame := range frames {
		seen := map[string]bool{}
		for _, mention := range FrameMentions(frame, list) {
			row := index[mention.EntityID]
			rows[row].Mentions++
			seen[mention.EntityID] = true
		}
		for id := range seen {
			rows[index[id]].Frames++
		}
	}
	// Порядок — по числу кадров: «сироты» (ноль) оказываются внизу, и их видно сразу.
	sort.SliceStable(rows, func(i, j int) bool { return rows[i].Frames > rows[j].Frames })
	return rows
}

// aliasPattern собирает одно выражение из имён и алиасов.
//
// `(?i)` — без учёта регистра (как на клиенте), альтернативы от длинной к короткой, чтобы
// «Анна Сергеевна» не давала вторым совпадением «Анну».
func aliasPattern(list []Entity) (*regexp.Regexp, map[string]Entity) {
	index := map[string]Entity{}
	aliases := make([]string, 0, len(list)*3)
	for _, entity := range list {
		for _, raw := range append([]string{entity.Name}, entity.Aliases...) {
			alias := strings.TrimSpace(raw)
			if utf8.RuneCountInString(alias) < MinAliasRunes {
				continue
			}
			key := strings.ToLower(alias)
			if _, seen := index[key]; seen {
				continue
			}
			index[key] = entity
			aliases = append(aliases, regexp.QuoteMeta(alias))
		}
	}
	if len(aliases) == 0 {
		return nil, index
	}
	sort.SliceStable(aliases, func(i, j int) bool { return len(aliases[i]) > len(aliases[j]) })
	pattern, err := regexp.Compile("(?i)(?:" + strings.Join(aliases, "|") + ")")
	if err != nil {
		return nil, index
	}
	return pattern, index
}

// wordBoundary проверяет, что совпадение — отдельное слово.
//
// Границей считается любой символ вне «буквы, цифры, подчёркивание, дефис». Дефис в списке
// потому, что «Анна-Мария» — другое имя, и «Анна» внутри него упоминанием не является.
func wordBoundary(text string, from, to int) bool {
	if from > 0 {
		before, _ := utf8.DecodeLastRuneInString(text[:from])
		if isWordRune(before) {
			return false
		}
	}
	if to < len(text) {
		after, _ := utf8.DecodeRuneInString(text[to:])
		if isWordRune(after) {
			return false
		}
	}
	return true
}

func isWordRune(r rune) bool {
	return unicode.IsLetter(r) || unicode.IsDigit(r) || r == '_' || r == '-'
}
