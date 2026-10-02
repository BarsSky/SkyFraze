// Заглушка Ollama для e2e: проверяем помощника без сети и без настоящей модели.
//
// Зачем своя заглушка, а не живой провайдер. e2e должен быть детерминированным и
// бесплатным: настоящая модель отвечает по-разному, стоит денег и требует ключа.
// Здесь же ровно два ответа, как в реальном обмене с инструментами:
//
//   1-й запрос — модель «просит» создать главу (native tool-call);
//   2-й запрос — она «отвечает словами», увидев результат инструмента.
//
// Порт берётся из AI_STUB_PORT (по умолчанию 11490) и должен совпадать с
// AI_OLLAMA_URL у backend: провайдер считает модель локальной, поэтому ключ и
// согласие в сценарии не нужны.

import { createServer } from 'node:http'

const port = Number(process.env.AI_STUB_PORT ?? 11490)
let requests = 0

/** Сообщения из запроса /api/chat (нужны только роли). */
function parseMessages(raw) {
  try {
    const body = JSON.parse(raw)
    return Array.isArray(body?.messages) ? body.messages : []
  } catch {
    return []
  }
}

const server = createServer((req, res) => {
  const send = (body) => {
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify(body))
  }

  if (req.method === 'GET' && req.url?.startsWith('/api/tags')) {
    send({
      models: [
        { name: 'e2e-stub:latest', model: 'e2e-stub:latest', capabilities: ['tools'] },
      ],
    })
    return
  }

  if (req.method === 'POST' && req.url?.startsWith('/api/chat')) {
    let raw = ''
    req.on('data', (chunk) => {
      raw += chunk
    })
    req.on('end', () => {
      requests += 1
      // Решение принимаем по СОДЕРЖИМОМУ запроса, а не по счётчику: счётчик зависит
      // от того, сколько раз сценарий уже прогоняли на этом стенде, и второй прогон
      // получил бы «ответ словами» вместо вызова инструмента. Признак того, что
      // инструмент уже выполнен, — сообщение с ролью tool в переписке.
      const messages = parseMessages(raw)
      const toolDone = messages.some((message) => message.role === 'tool')
      if (!toolDone) {
        send({
          model: 'e2e-stub:latest',
          message: {
            role: 'assistant',
            content: '',
            tool_calls: [
              {
                function: {
                  name: 'create_chapter',
                  arguments: {
                    title: 'Пролог',
                    body_md: '## Начало\n\nТак **начинается** история.',
                  },
                },
              },
            ],
          },
          prompt_eval_count: 12,
          eval_count: 8,
        })
        return
      }
      send({
        model: 'e2e-stub:latest',
        message: { role: 'assistant', content: 'Создал главу «Пролог».' },
        prompt_eval_count: 14,
        eval_count: 6,
      })
    })
    return
  }

  res.writeHead(404, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify({ error: 'not found' }))
})

server.listen(port, '127.0.0.1', () => {
  console.log(`stub ollama слушает 127.0.0.1:${port}`)
})
