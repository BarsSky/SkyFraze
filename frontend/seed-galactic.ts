// Создаёт проект «Galactic Story — Слепой рывок» с 7 актами из романа Андрея Ливадного.
// Использует Yjs напрямую для кодирования state и REST API для создания проекта/сохранения state.

import * as Y from 'yjs'
import ky from 'ky'

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
  const email = 'galactic.test@e.com'
  const password = 'hunter22!'

  // 1. Login
  console.log('login...')
  const loginResp = await ky.post('http://localhost/api/auth/login', {
    json: { email, password },
  }).json<{ tokens: { access: string } }>()
  const token = loginResp.tokens.access
  const headers = { Authorization: `Bearer ${token}` }

  // 2. Create project
  console.log('create project...')
  const project = await ky.post('http://localhost/api/projects', {
    headers,
    json: {
      title: 'Galactic Story — Слепой рывок',
      description: 'Хронология научно-фантастической саги Андрея Ливадного «Абсолютное оружие». 2207–2214 годы. Корабли: Альфа, Нормандия, Игла, Ванкор, Орион, Аполло. Персонажи: Екатерина Римп, Иван Стожаров, Ульрих Фицджеральд, Эрик Подегро, Йоган Иванов-Шмидт, Майкл Торган, Джереми Уайт, Нуоми.',
    },
  }).json<{ id: string }>()
  const projectId = project.id
  console.log('project id:', projectId)

  // 3. Build Yjs state with all events
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

  // 4. PUT state to backend
  console.log('PUT state...')
  const blob = new Blob([new Uint8Array(state)], { type: 'application/octet-stream' })
  const putResp = await fetch(`http://localhost/api/projects/${projectId}/events/state`, {
    method: 'PUT',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/octet-stream' },
    body: blob,
  })
  console.log('PUT status:', putResp.status)

  // 5. Verify
  const getResp = await fetch(`http://localhost/api/projects/${projectId}/events/state`, {
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/octet-stream' },
  })
  const buf = await getResp.arrayBuffer()
  console.log('verify GET bytes:', buf.byteLength)

  console.log('\nDONE! Откройте http://localhost/projects/' + projectId)
  console.log('Логин: ' + email + ' / ' + password)
}

main().catch((e) => { console.error(e); process.exit(1) })
