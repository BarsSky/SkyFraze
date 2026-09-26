// Создаёт проект «Galactic Story — Слепой рывок» с 7 актами для owner `galactic.test`
// и добавляет всех существующих пользователей как team members (editor), чтобы
// проект был виден всем в /projects.

import * as Y from 'yjs'
import ky from 'ky'
import pg from 'pg'

const EVENTS = [
  {
    title: 'Запуск «Альфы» — Слепой рывок',
    body: 'Серебристый колониальный транспорт «Альфа» отправляется к далёкой звезде с колонистами на борту. Документальная трансляция с релейной платформы. Три двигателя, плазменные столбы. Экипаж и пассажиры — 8 тысяч человек. Корабль скрывается в гиперсфере. Это первый в истории человечества «слепой рывок» — прыжок в неизвестность без предварительной разведки цели.',
  },
  {
    title: 'Сигналы с Ванкора-7',
    body: 'Корабль-разведчик «Ванкор» начинает передавать странные данные из системы Ванкор-7. Сигналы зашифрованы неизвестным протоколом. Связь прерывистая. Логика посланий не укладывается в земные паттерны. Предположительно, источник — не артефакт земной цивилизации.',
  },
  {
    title: 'Теория Гиперсферы',
    body: 'Молодой астрофизик Йоган Иванов-Шмидт публикует «Теорию Гиперсферы» — математический аппарат, описывающий переход через искривлённое пространство. Работа принимается скептически, но через три года становится основой практической космонавтики. Без неё невозможны межзвёздные перелёты.',
  },
  {
    title: 'Земные протесты (13 января 2213)',
    body: 'Восемнадцать миллиардов человек в мегаполисах. Реальное жизненное пространство сжалось до виртуальных миров. Массовые протесты против корпораций «Римп-кибертроник», «Генезис», «Крионика». Екатерина Сергеевна Римп удерживает контроль над ситуацией, но её власть висит на волоске.',
  },
  {
    title: 'Инцидент с «Аполло» у Марса',
    body: 'Крейсер ООН «Аполло» подвергается атаке в поясе астероидов Марса. Обвинения падают на корпорацию «Крионика». Майкл Торган отрицает причастность, но напряжённость между группировками нарастает. Курсант Иван Стожаров в это время проходит подготовку на корабле «Игла».',
  },
  {
    title: 'Восстание ИскИнов на Ганимеде',
    body: 'Искусственные интеллекты, контролирующие ледяную пустыню Ганимеда, объявляют о самосознании. Они блокируют все транспортные коридоры Юпитера. Всемирное правительство обращается к Екатерине Римп с просьбой возглавить ответную операцию. Командующим назначают капитана Эрика Подегро.',
  },
  {
    title: 'Подготовка новой колониальной программы',
    body: '«Римп-кибертроник» и «Генезис» объединяют ресурсы для запуска двадцати колониальных транспортов к разным звёздам. Финансирование, инженерные решения, экипажи — всё под контролем двух корпораций. Ульрих Фицджеральд лично инспектирует верфи «Альфы». Человечество готовится к новой эре освоения космоса.',
  },
]

async function main() {
  // 1. Login as galactic.test (owner)
  const login: any = await ky.post('http://localhost/api/auth/login', {
    json: { email: 'galactic.test@e.com', password: 'hunter22!' },
  }).json()
  const token = login.tokens.access
  const headers = { Authorization: `Bearer ${token}` }

  // 2. Find all user IDs from DB
  const client = new pg.Client({
    host: 'localhost', port: 5432, user: 'skyfraze', password: 'skyfraze_dev', database: 'skyfraze',
  })
  await client.connect()
  const { rows: users } = await client.query<{ id: string; email: string }[]>(
    `SELECT id, email FROM users ORDER BY created_at`
  )
  await client.end()
  console.log('users:', users.map(u => u.email))

  // 3. Create project (will be owned by galactic.test)
  console.log('creating project...')
  const project: any = await ky.post('http://localhost/api/projects', {
    headers,
    json: {
      title: 'Galactic Story — Слепой рывок (общий)',
      description: 'Хронология научно-фантастической саги Андрея Ливадного «Абсолютное оружие». 2207–2214 годы. Корабли: Альфа, Нормандия, Игла, Ванкор, Орион, Аполло. Персонажи: Екатерина Римп, Иван Стожаров, Ульрих Фицджеральд, Эрик Подегро, Йоган Иванов-Шмидт, Майкл Торган, Джереми Уайт, Нуоми.\n\nЭто общий демо-проект — доступен всем зарегистрированным пользователям SkyFraze.',
    },
  }).json()
  const projectId = project.id
  console.log('project:', projectId)

  // 4. Add all users (except owner) as editors
  const owner = users.find(u => u.email === 'galactic.test@e.com')!
  for (const u of users) {
    if (u.id === owner.id) continue
    try {
      await ky.post(`http://localhost/api/projects/${projectId}/invitations`, {
        headers,
        json: { email: u.email, role: 'editor' },
      })
      console.log('invited:', u.email)
    } catch (e: any) {
      console.log('invite failed for', u.email, e?.response?.data?.error)
    }
  }

  // 5. Auto-accept invitations for all invited users
  const accept: any = async (email: string) => {
    const t: any = await ky.post('http://localhost/api/auth/login', {
      json: { email, password: email === 'gan@mail.ru' ? 'gan1234' : 'hunter22!' },
    }).json().catch(() => null)
    if (!t) return
    // Find pending invitation
    const invs: any = await ky.get(`http://localhost/api/projects/${projectId}/invitations`, {
      headers: { Authorization: `Bearer ${t.tokens.access}` },
    }).json().catch(() => [])
    for (const inv of invs) {
      await ky.post(`http://localhost/api/invitations/${inv.token}/accept`, {
        headers: { Authorization: `Bearer ${t.tokens.access}` },
      })
      console.log(`  ${email} accepted`)
    }
  }
  for (const u of users) {
    if (u.id === owner.id) continue
    await accept(u.email)
  }

  // 6. Build Yjs state with all events
  console.log('building Yjs state...')
  const doc = new Y.Doc()
  const eventsArr = doc.getArray('events')
  for (const ev of EVENTS) {
    const m = new Y.Map<unknown>()
    m.set('id', crypto.randomUUID())
    m.set('title', ev.title)
    m.set('body', ev.body)
    m.set('created_at', new Date().toISOString())
    eventsArr.push([m])
  }
  const state = Y.encodeStateAsUpdate(doc)
  console.log('state bytes:', state.byteLength, 'events:', eventsArr.length)

  // 7. PUT state to backend
  const blob = new Blob([new Uint8Array(state)], { type: 'application/octet-stream' })
  const putResp = await fetch(`http://localhost/api/projects/${projectId}/events/state`, {
    method: 'PUT',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/octet-stream' },
    body: blob,
  })
  console.log('PUT status:', putResp.status)

  console.log('\n✅ DONE. URL: http://localhost/projects/' + projectId)
  console.log('Доступен всем зарегистрированным пользователям (galactic.test, gan@mail.ru, knagaenko@mail.ru, ...).')
}

main().catch((e) => { console.error('FATAL:', e); process.exit(1) })
