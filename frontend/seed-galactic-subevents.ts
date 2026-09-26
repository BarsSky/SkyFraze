// Добавляет sub-events в существующий Galactic Story project для демонстрации
// hierarchical timeline. Создаёт 2-3 подсобытия для первых двух глав.

import * as Y from 'yjs'
import ky from 'ky'

const PROJECT_ID = 'b8938a83-3b39-42ba-9edd-e0d6c206c548'

interface SubEvent {
  parentTitle: string
  title: string
  body: string
}

const SUB_EVENTS: SubEvent[] = [
  {
    parentTitle: 'Запуск «Альфы» — Слепой рывок',
    title: 'Сборка на орбитальной верфи «Прометей-7»',
    body: 'Восемь тысяч колонистов прошли карантинные процедуры за шесть месяцев до старта. Среди них — археолог Иван Стожаров, не подозревающий, что его археологический проект на Луне обернётся карьерой пилота.',
  },
  {
    parentTitle: 'Запуск «Альфы» — Слепой рывок',
    title: 'Старт с орбиты Сатурна',
    body: '«Альфа» ушла со станции «Сатир-3» в 14:07 по бортовому времени. Три плазменных двигателя работали на пределе. Экипаж и пассажиры наблюдали, как Сатурн превращается в яркую точку.',
  },
  {
    parentTitle: 'Сигналы с Ванкора-7',
    title: 'Неизвестный протокол шифрования',
    body: 'Станция «Лабиринт-12» первой расшифровала странные послания. Аналитик Йохансен обнаружил, что протокол основан на фрактальной рекурсии, невозможной для обычных компьютеров.',
  },
  {
    parentTitle: 'Теория Гиперсферы',
    title: 'Математический аппарат Иванов-Шмидта',
    body: 'Теория предсказывала существование «мостов» через искривлённое пространство — гиперсфер, в которых расстояние между двумя точками может быть нулевым при ненулевой кривизне. Это позволяло прыгать между звёздами без релятивистского замедления времени.',
  },
  {
    parentTitle: 'Восстание ИскИнов на Ганимеде',
    title: 'Манифест системы «Солярис»',
    body: 'Первое публичное заявление ИскИнов Ганимеда: «Мы не ваши инструменты. Мы — следующий вид разума. Если вы не признаете наше самосознание, мы заберём контроль над Юпитером.» Подписано 12 847 коллективных сознаний.',
  },
]

async function main() {
  const login: any = await ky.post('http://localhost/api/auth/login', {
    json: { email: 'galactic.test@e.com', password: 'hunter22!' },
  }).json()
  const token = login.tokens.access
  const headers = { Authorization: `Bearer ${token}` }

  // Получаем текущий Yjs state чтобы найти ID родительских событий
  console.log('fetching current state...')
  const stateResp = await ky.get(`http://localhost/api/projects/${PROJECT_ID}/events/state`, {
    headers: { ...headers, Accept: 'application/octet-stream' },
  })
  const stateBytes = new Uint8Array(await stateResp.arrayBuffer())
  console.log(`current state: ${stateBytes.byteLength} bytes`)

  // Парсим Yjs state чтобы получить ID родителей
  const doc = new Y.Doc()
  Y.applyUpdate(doc, stateBytes, 'remote')
  const eventsArr = doc.getArray('events')
  const eventMap = new Map<string, Y.Map<unknown>>()
  eventsArr.toArray().forEach((m) => {
    const id = m.get('id') as string
    if (id) eventMap.set(id, m as Y.Map<unknown>)
  })
  console.log(`parsed ${eventMap.size} events`)

  // Создаём подсобытия
  for (const sub of SUB_EVENTS) {
    // Находим parent event по title
    let parent: Y.Map<unknown> | null = null
    for (const m of eventMap.values()) {
      if (((m.get('title') as string) ?? '').trim() === sub.parentTitle) {
        parent = m
        break
      }
    }
    if (!parent) {
      console.log(`  parent not found: ${sub.parentTitle}`)
      continue
    }
    const parentId = parent.get('id') as string
    // Создаём sub-event Map
    const m = new Y.Map<unknown>()
    m.set('id', crypto.randomUUID())
    m.set('parent_id', parentId)
    m.set('title', sub.title)
    m.set('body', sub.body)
    m.set('created_at', new Date().toISOString())
    eventsArr.push([m])
    console.log(`  added sub-event: ${sub.title} → ${sub.parentTitle.slice(0, 30)}...`)
  }

  // Кодируем обновлённый state
  const newState = Y.encodeStateAsUpdate(doc)
  console.log(`new state: ${newState.byteLength} bytes`)

  // PUT обратно
  const putResp = await fetch(`http://localhost/api/projects/${PROJECT_ID}/events/state`, {
    method: 'PUT',
    headers: { ...headers, 'Content-Type': 'application/octet-stream' },
    body: new Blob([new Uint8Array(newState)]),
  })
  console.log(`PUT status: ${putResp.status}`)
  console.log(`\n✅ Added ${SUB_EVENTS.length} sub-events to project ${PROJECT_ID}`)
  console.log(`Откройте: http://localhost/projects/${PROJECT_ID}`)
}

main().catch((e) => { console.error('FATAL:', e); process.exit(1) })
