// Генератор фикстур Yjs для серверной стороны (Фаза 3: слияние на сервере).
//
// Серверный CRDT (`backend/internal/collab/yjs`, порт Yjs на Go) обязан читать и
// сливать ровно те обновления, которые пишет наш клиент. Проверять это «на глаз»
// нельзя, поэтому здесь фиксируются байты: базовый снапшот документа в формате
// Фазы 2, две расходящиеся правки одного поля и ожидаемый результат их слияния.
//
// Что внутри документа — как в приложении: YArray 'events' из Y.Map с ключами
// id/parent_id/title_text/body_text/event_date/assets, где текст — Y.Text
// (скалярные title/body остаются историей и в фикстуре не участвуют).
//
// Запуск (нужен установленный yjs — он уже в зависимостях фронтенда):
//   cd frontend && npx tsx tests/yjs-fixtures.ts
// Результат: backend/internal/collab/yjs/testdata/*.bin + expected.json

import * as fs from 'fs'
import * as path from 'path'
import { fileURLToPath } from 'node:url'
import * as Y from 'yjs'

// ESM: __dirname отсутствует, путь считаем от самого файла.
const OUT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../backend/internal/collab/yjs/testdata')

const EVENT_CHAPTER = '11111111-1111-4111-8111-111111111111'
const EVENT_STEP = '22222222-2222-4222-8222-222222222222'
const CHAPTER_TITLE = 'Запуск «Альфы»'
const CHAPTER_BODY = 'Общее начало истории.'

/** Y.Text с начальным содержимым — так же, как его создаёт клиент (collab/text.ts). */
function text(value: string): Y.Text {
  const t = new Y.Text()
  if (value.length > 0) t.insert(0, value)
  return t
}

/** Базовый документ проекта: глава с под-событием. */
function baseDoc(): Y.Doc {
  const doc = new Y.Doc()
  const events = doc.getArray<Y.Map<unknown>>('events')

  const chapter = new Y.Map<unknown>()
  chapter.set('id', EVENT_CHAPTER)
  chapter.set('title_text', text(CHAPTER_TITLE))
  chapter.set('body_text', text(CHAPTER_BODY))
  chapter.set('event_date', '2789-04-12')
  chapter.set('assets', ['asset-1'])
  events.push([chapter])

  const step = new Y.Map<unknown>()
  step.set('id', EVENT_STEP)
  step.set('parent_id', EVENT_CHAPTER)
  step.set('title_text', text('Сборка «Прометей-7»'))
  step.set('body_text', text('Три двигателя, плазменные столбы.'))
  events.push([step])

  return doc
}

/** Копия документа из снапшота: с ней правит «второй автор». */
function fromState(state: Uint8Array): Y.Doc {
  const doc = new Y.Doc()
  Y.applyUpdate(doc, state)
  return doc
}

const chapterText = (doc: Y.Doc, field: 'title_text' | 'body_text'): Y.Text =>
  doc.getArray<Y.Map<unknown>>('events').get(0)!.get(field) as Y.Text

function write(name: string, bytes: Uint8Array) {
  fs.writeFileSync(path.join(OUT, name), Buffer.from(bytes))
  console.log(`  ${name}: ${bytes.byteLength} байт`)
}

function main() {
  fs.mkdirSync(OUT, { recursive: true })
  console.log('генерация фикстур в', OUT)

  const base = baseDoc()
  const baseState = Y.encodeStateAsUpdate(base)
  const baseVector = Y.encodeStateVector(base)
  write('base.bin', baseState)

  // Автор A правит начало текста, автор B — конец. Обе правки расходятся от одной
  // базы и обязаны сохраниться обе (ради этого вводился Y.Text в Фазе 2).
  const docA = fromState(baseState)
  chapterText(docA, 'body_text').insert(0, 'Аня: ')
  const editA = Y.encodeStateAsUpdate(docA, baseVector)
  write('edit-a.bin', editA)

  const docB = fromState(baseState)
  const bodyB = chapterText(docB, 'body_text')
  bodyB.insert(bodyB.length, ' (правка Бориса)')
  const editB = Y.encodeStateAsUpdate(docB, baseVector)
  write('edit-b.bin', editB)

  // Ожидаемый результат: Yjs применяет базу и обе правки в любом порядке.
  const merged = fromState(baseState)
  Y.applyUpdate(merged, editA)
  Y.applyUpdate(merged, editB)
  const mergedReverse = fromState(baseState)
  Y.applyUpdate(mergedReverse, editB)
  Y.applyUpdate(mergedReverse, editA)

  const mergedBody = chapterText(merged, 'body_text').toString()
  const reverseBody = chapterText(mergedReverse, 'body_text').toString()
  if (mergedBody !== reverseBody) {
    throw new Error(`слияние не коммутативно: ${JSON.stringify([mergedBody, reverseBody])}`)
  }

  // Слияние отдельных апдейтов тем же способом, каким это будет делать сервер.
  const mergedUpdate = Y.mergeUpdates([editA, editB])
  const mergedFromUpdates = fromState(baseState)
  Y.applyUpdate(mergedFromUpdates, mergedUpdate)
  const afterMergeUpdates = chapterText(mergedFromUpdates, 'body_text').toString()

  const expected = {
    note: 'Сгенерировано frontend/tests/yjs-fixtures.ts — не править руками',
    chapterId: EVENT_CHAPTER,
    stepId: EVENT_STEP,
    base: {
      title: CHAPTER_TITLE,
      body: CHAPTER_BODY,
      stepTitle: 'Сборка «Прометей-7»',
      eventDate: '2789-04-12',
      assets: ['asset-1'],
    },
    edits: { a: 'Аня: ', b: ' (правка Бориса)' },
    mergedBody,
    mergedUpdateBody: afterMergeUpdates,
  }
  fs.writeFileSync(path.join(OUT, 'expected.json'), JSON.stringify(expected, null, 2) + '\n')
  console.log('  expected.json')
  console.log('слияние правок:', JSON.stringify(mergedBody))
  if (afterMergeUpdates !== mergedBody) {
    throw new Error(`mergeUpdates дал другой текст: ${JSON.stringify(afterMergeUpdates)}`)
  }
}

main()
