/**
 * Замер пересчёта упоминаний (0.97.4).
 *
 * В docs/entity-links.md §5 у риска «пересчёт на каждом нажатии клавиши тормозит» стоял замер
 * «100 кадров × 2000 знаков, 30 карточек — < 16 мс» — но замера не существовало: цифра была
 * обещанием. Скрипт делает его настоящим: строит ровно такой проект и меряет три вещи, которые
 * действительно вызываются на правку (см. EditorsPanel/RelationsPanel — все три под useMemo на
 * списке кадров): использование карточек, хронологию и матрицу.
 *
 * Бюджет — не «красивое» число, а рабочий порог: пересчёт запускается на каждое обновление CRDT,
 * то есть на каждую паузу в наборе, и всё, что дольше 300 мс (наш debounce сохранения), человек
 * уже почувствует как рывок при печати.
 *
 * Запуск: cd frontend && npx tsx tests/diag-mentions-perf.ts
 */
import {
  entityUsage,
  frameMentions,
  framesByEntity,
  mentionMatrix,
  type MentionEntity,
  type MentionFrame,
} from '../src/collab/mentions'

const FRAMES = 100
const FRAME_CHARS = 2000
const CARDS = 30
const RUNS = 7

/** Карточки с алиасами — как в жизни: имя, короткая форма, падежи. */
function buildEntities(): MentionEntity[] {
  const kinds = [
    ['Анна', 'Аня', 'Анны', 'Анне'],
    ['Борис', 'Боря', 'Бориса'],
    ['Вера', 'Веры', 'Вере'],
    ['Земля', 'Земле', 'Земли'],
    ['Письмо', 'Письма', 'Письму'],
  ]
  return Array.from({ length: CARDS }, (_, index) => {
    const [name, ...aliases] = kinds[index % kinds.length]
    return { id: `e${index}`, name: `${name} ${index + 1}`, aliases: [...aliases, `${name}${index + 1}`] }
  })
}

/** Текст на 2000 знаков с редкими упоминаниями — так выглядит глава, а не список имён. */
function buildBody(index: number, entities: MentionEntity[]): string {
  const filler =
    'Ветер шёл с моря, и дом на холме скрипел ставнями. Никто не спал в эту ночь: ' +
    'слышно было, как вода бьёт в сваи, как перекликаются на пристани. '
  const mentioned = entities[(index * 7) % entities.length]
  const pieces: string[] = []
  while (pieces.join(' ').length < FRAME_CHARS) {
    pieces.push(filler)
    // Одно-два упоминания на кадр: в тексте книги их и не больше.
    if (pieces.length % 3 === 0) pieces.push(`${mentioned.name} молчала и смотрела на воду.`)
  }
  return pieces.join(' ').slice(0, FRAME_CHARS)
}

function buildFrames(entities: MentionEntity[]): MentionFrame[] {
  return Array.from({ length: FRAMES }, (_, index) => ({
    id: `f${index}`,
    title: `Глава ${index + 1}`,
    body: buildBody(index, entities),
  }))
}

function stats(label: string, values: number[], budget: number) {
  const sorted = [...values].sort((a, b) => a - b)
  const min = sorted[0]
  const median = sorted[Math.floor(sorted.length / 2)]
  const max = sorted[sorted.length - 1]
  console.log(`${label}: минимум ${min.toFixed(2)} мс, медиана ${median.toFixed(2)} мс, максимум ${max.toFixed(2)} мс`)
  return { label, min, median, max, budget }
}

function measure(label: string, action: () => unknown, budget: number) {
  const values: number[] = []
  for (let run = 0; run < RUNS; run += 1) {
    const started = performance.now()
    action()
    values.push(performance.now() - started)
  }
  return stats(label, values, budget)
}

const entities = buildEntities()
const frames = buildFrames(entities)
const chapters = Array.from({ length: 10 }, (_, index) => ({ id: `ch${index}`, title: `Глава ${index}`, number: `${index + 1}` }))
const frameChapters = frames.map((frame, index) => ({ frameId: frame.id, chapterId: `ch${index % 10}` }))
const dated = frames.map((frame, index) => ({ ...frame, date: '', number: `${index + 1}`, order: index }))

console.log(`проект: ${FRAMES} кадров × ${FRAME_CHARS} знаков, ${CARDS} карточек`)

const results = [
  measure('одна карточка в одном кадре (frameMentions)', () => frameMentions(frames[0], entities), 16),
  measure('использование всех карточек (entityUsage)', () => entityUsage(frames, entities), 300),
  measure('хронология (framesByEntity)', () => framesByEntity(dated, entities), 300),
  measure('матрица персонажи × главы (mentionMatrix)', () => mentionMatrix(frames, frameChapters, chapters, entities), 300),
  // Всё, что панели пересчитывают на одно обновление CRDT: три memo на одном списке кадров.
  measure(
    'всё вместе (как на правку кадра)',
    () => {
      entityUsage(frames, entities)
      framesByEntity(dated, entities)
      mentionMatrix(frames, frameChapters, chapters, entities)
    },
    300,
  ),
]

// Проверяем, что работа действительно сделана: иначе «быстрый» замер ничего не мерил.
const usage = entityUsage(frames, entities)
const mentioned = Object.values(usage).filter((entry) => entry.mentions > 0).length
console.log(`карточек с упоминаниями: ${mentioned} из ${CARDS}`)
const problems: string[] = []
if (mentioned === 0) problems.push('замер ничего не нашёл: упоминаний нет, цифры бессмысленны')
for (const result of results) {
  if (result.max > result.budget) {
    problems.push(`${result.label}: ${result.max.toFixed(2)} мс больше бюджета ${result.budget} мс`)
  }
}

if (problems.length > 0) {
  console.log('проблемы:')
  for (const problem of problems) console.log(` - ${problem}`)
  process.exitCode = 1
} else {
  console.log('проблемы: нет')
}
