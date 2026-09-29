// Package testyjs — настоящий Yjs-снапшот для тестов бэкенда.
//
// Зачем отдельная фикстура. Привязка «событие → вложения» живёт только внутри
// CRDT-снапшота, а его нельзя собрать руками: это бинарный update, который пишет
// сама Yjs. Поэтому снапшот один раз сгенерирован node-скриптом и лежит рядом в
// base64 (бинарный файл в репозитории прошёл бы через git-нормализацию
// `* text=auto` и мог испортиться).
//
// Что внутри: то же, что делает приложение, — YArray 'events' из Y.Map с ключами
// id/parent_id/title/body/assets/bg_kind/bg_asset, два «редактора» (второй
// домешивает состояние первого и правит ключи повторно, из-за чего часть items
// приходит без parent/parent_sub и восстанавливается по origin) и удаление ключа
// bg_asset. Привязки: Event1 → [Asset1, Asset2], Event2 → [Asset2], Event3 → [Asset3].
//
// Перегенерировать: node-скрипт с Y.encodeStateAsUpdate поверх doc'а с теми же
// id, результат — base64 в state.b64.
package testyjs

import (
	_ "embed"
	"encoding/base64"
	"strings"

	"github.com/google/uuid"
)

//go:embed state.b64
var stateB64 string

// ID внутри State: тесты, которым нужен снапшот, сеют проект ровно с ними.
var (
	Event1 = uuid.MustParse("11111111-1111-4111-8111-111111111111")
	Event2 = uuid.MustParse("22222222-2222-4222-8222-222222222222")
	Event3 = uuid.MustParse("33333333-3333-4333-8333-333333333333")

	Asset1 = uuid.MustParse("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa")
	Asset2 = uuid.MustParse("bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb")
	Asset3 = uuid.MustParse("cccccccc-cccc-4ccc-8ccc-cccccccccccc")
)

// State возвращает байты Yjs-update'а.
func State() []byte {
	raw, err := base64.StdEncoding.DecodeString(strings.TrimSpace(stateB64))
	if err != nil {
		panic("testyjs: state.b64 повреждён: " + err.Error())
	}
	return raw
}
