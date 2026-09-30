/**
 * Текст события: `Y.Text` вместо скалярной строки.
 *
 * Почему. `title`/`body` были строковыми ключами `Y.Map`, то есть LWW на ключ:
 * победившая запись побеждала целиком, и набранное в это же время вторым автором
 * исчезало без следа. `Y.Text` вставляет символы с позиционными id, поэтому
 * вставки двух авторов сохраняются обе.
 *
 * Как уживаются старые данные. В существующих снапшотах лежат строки `title`/`body`,
 * и переписать их «на сервере» нечем — Yjs на бэкенде нет. Поэтому новые поля
 * `title_text`/`body_text` создаются **лениво из старой строки**, старая строка
 * остаётся как историческое значение и больше не пишется (кроме создания события —
 * см. `yAddEvent`: там она пишется один раз, чтобы вкладка со старым бандлом
 * показала хоть что-то).
 *
 * Правила чтения и записи:
 *   - `textString` — только чтение, ничего не создаёт: есть `Y.Text` → её текст,
 *     иначе старая строка. Так читают стадия, публичная страница и проекция дерева:
 *     страница только для чтения не должна менять документ.
 *   - `ensureText` — создаёт `Y.Text` из старой строки (одной транзакцией), если его
 *     ещё нет: нужен при первой правке поля. Проект целиком мигрирует СЕРВЕР
 *     (`backend/internal/collab/yjs`, EnsureTextFields) — он единственный писатель,
 *     и ветка Y.Text на ключе получается ровно одна. Клиент, мигрирующий сам, мог
 *     проиграть LWW соседу, сделавшему то же самое одновременно, и правки в его
 *     ветке стали бы невидимыми.
 *   - `setText` — правка: считает минимальный диф к текущему тексту и применяет его.
 *     Целиком значение не перезаписывается, иначе смысл `Y.Text` терялся бы.
 */

import * as Y from 'yjs'

/** Поля события, которые стали текстом. */
export type TextField = 'title' | 'body'

export type YMap = Y.Map<unknown>

const key = (field: TextField): string => `${field}_text`

/** Старое скалярное значение в CRDT (в новых событиях — только для совместимости). */
function legacyString(map: YMap, field: TextField): string {
  const value = map.get(field)
  return typeof value === 'string' ? value : ''
}

/** Только чтение: текст события без создания полей. */
export function textString(map: YMap, field: TextField): string {
  const value = map.get(key(field))
  if (value instanceof Y.Text) return value.toString()
  return legacyString(map, field)
}

/** Заголовок, обрезанный по краям: так его показывают навигатор и проекция. */
export function titleString(map: YMap): string {
  return textString(map, 'title').trim()
}

function transact(map: YMap, body: () => void, origin: string): void {
  const doc = map.doc
  if (doc) doc.transact(body, origin)
  else body()
}

/**
 * `Y.Text` поля, создавая его из старой строки при необходимости.
 *
 * Гонка двух клиентов, мигрирующих одно и то же событие, разрешается самим CRDT:
 * на ключе `title_text` окажутся два независимых `Y.Text`, и LWW выберет один —
 * одинаковый на всех клиентах. Проигравшая ветка никому не видна, а её содержимое
 * равно исходной строке, поэтому терять в ней нечего: миграция идёт до того, как
 * редакторы становятся доступны для ввода (см. `migrateTextFields`).
 */
export function ensureText(map: YMap, field: TextField): Y.Text {
  const existing = map.get(key(field))
  if (existing instanceof Y.Text) return existing

  const legacy = legacyString(map, field)
  const text = new Y.Text()
  transact(
    map,
    () => {
      if (legacy.length > 0) text.insert(0, legacy)
      map.set(key(field), text)
    },
    'text-migrate',
  )

  const after = map.get(key(field))
  return after instanceof Y.Text ? after : text
}

/**
 * Минимальная правка «было → стало»: общий префикс и общий суффикс отбрасываются,
 * остаётся одна замена посередине. Так набор текста превращается в вставку символа,
 * а не в перезапись всего абзаца, и чужие правки рядом не затираются.
 */
export function textDiff(
  before: string,
  after: string,
): { index: number; remove: number; insert: string } {
  if (before === after) return { index: 0, remove: 0, insert: '' }

  const max = Math.min(before.length, after.length)
  let prefix = 0
  while (prefix < max && before[prefix] === after[prefix]) prefix += 1

  let suffix = 0
  while (
    suffix < max - prefix &&
    before[before.length - 1 - suffix] === after[after.length - 1 - suffix]
  ) {
    suffix += 1
  }

  return {
    index: prefix,
    remove: before.length - prefix - suffix,
    insert: after.slice(prefix, after.length - suffix),
  }
}

/** Правка поля: применяется как диф к `Y.Text`. */
export function setText(map: YMap, field: TextField, next: string): void {
  const text = ensureText(map, field)
  const current = text.toString()
  if (current === next) return
  const { index, remove, insert } = textDiff(current, next)
  transact(
    map,
    () => {
      if (remove > 0) text.delete(index, remove)
      if (insert.length > 0) text.insert(index, insert)
    },
    'text-edit',
  )
}

/** Сколько первых символов совпадает: нужно, чтобы не стереть чужое. */
function commonPrefixLength(a: string, b: string): number {
  const max = Math.min(a.length, b.length)
  let i = 0
  while (i < max && a[i] === b[i]) i += 1
  return i
}

/**
 * Правка человека, когда текст в CRDT тем временем изменили другие.
 *
 * Зачем отдельно от `setText`. Пока человек печатает, в поле приезжают чужие
 * правки: DOM у него может отставать на один апдейт, и диф «строка в поле →
 * строка в CRDT» превратил бы чужую вставку в удаление — чужие буквы исчезали бы
 * (именно это и ломало одновременный набор). Поэтому:
 *
 *   1. считается только ЛОКАЛЬНАЯ правка `mine → next` — то, что человек сделал сам;
 *   2. её индекс сдвигается, если чужая правка была перед ней;
 *   3. удаление ограничивается тем, что в тексте реально совпадает, — чужой текст
 *      не стирается никогда: в худшем случае наша правка встанет рядом с чужой.
 */
export function applyLocalEdit(
  text: Y.Text,
  mine: string,
  next: string,
  remote: string,
): void {
  const local = textDiff(mine, next)
  let index = local.index
  let remove = local.remove

  if (remote !== mine && (local.remove > 0 || local.insert.length > 0)) {
    const foreign = textDiff(mine, remote)
    // Чужая правка целиком до нашей — сдвигаем индекс на её длину.
    if (foreign.index + foreign.remove <= index) {
      index += foreign.insert.length - foreign.remove
    }
    if (remove > 0) {
      const current = text.toString()
      const at = Math.max(0, Math.min(index, current.length))
      const want = mine.slice(local.index, local.index + remove)
      const available = current.slice(at, at + remove)
      // Стираем только совпадающий кусок: если чужой апдейт уже убрал или сдвинул
      // его, удаляем меньше (в пределе — ничего).
      remove = want === available ? remove : commonPrefixLength(want, available)
    }
  }

  index = Math.max(0, Math.min(index, text.length))
  if (remove === 0 && local.insert.length === 0) return

  const doc = text.doc
  const apply = () => {
    if (remove > 0) text.delete(index, remove)
    if (local.insert.length > 0) text.insert(index, local.insert)
  }
  if (doc) doc.transact(apply, 'text-edit')
  else apply()
}
