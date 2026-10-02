// Заглушка Ollama для e2e: проверяем помощника без сети и без настоящей модели.
//
// Зачем своя заглушка, а не живой провайдер. e2e должен быть детерминированным и
// бесплатным: настоящая модель отвечает по-разному, стоит денег и требует ключа.
// Здесь же ровно два ответа, как в реальном обмене с инструментами:
//
//   1-й запрос — модель «просит» создать главу (native tool-call);
//   2-й запрос — она «отвечает словами», увидев результат инструмента.
//
// Оба ответа отдаются ПОТОКОМ (backend просит stream: true), причём текст режется на
// куски: так e2e проверяет не «ответ дошёл», а весь путь потока — провайдер → сервер →
// SSE → браузер. Заглушка, отдающая готовый JSON, эту часть не проверяла бы вовсе.
//
// Порт берётся из AI_STUB_PORT (по умолчанию 11490) и должен совпадать с
// AI_OLLAMA_URL у backend: провайдер считает модель локальной, поэтому ключ и
// согласие в сценарии не нужны.

import { createServer } from 'node:http'

const port = Number(process.env.AI_STUB_PORT ?? 11490)

/** Сообщения из запроса /api/chat (нужны только роли). */
function parseBody(raw) {
  try {
    return JSON.parse(raw)
  } catch {
    return {}
  }
}

/** Режем текст на куски по границе слов: так видно, что поток действительно поток. */
function chunkText(text) {
  if (!text) return []
  const words = text.split(' ')
  if (words.length < 2) return [text]
  const pieces = []
  for (let i = 0; i < words.length; i += 2) {
    const piece = words.slice(i, i + 2).join(' ')
    pieces.push(i + 2 < words.length ? `${piece} ` : piece)
  }
  return pieces
}

const server = createServer((req, res) => {
  const send = (body) => {
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify(body))
  }

  if (req.method === 'GET' && req.url?.startsWith('/api/tags')) {
    send({
      models: [
        // vision — чтобы у модели в интерфейсе появилась кнопка «Картинка»: e2e
        // проверяет и приложенное изображение (см. assistant.spec.ts).
        { name: 'e2e-stub:latest', model: 'e2e-stub:latest', capabilities: ['tools', 'vision'] },
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
      const body = parseBody(raw)
      // Решение принимаем по СОДЕРЖИМОМУ запроса, а не по счётчику: счётчик зависит
      // от того, сколько раз сценарий уже прогоняли на этом стенде, и второй прогон
      // получил бы «ответ словами» вместо вызова инструмента. Признак того, что
      // инструмент уже выполнен, — сообщение с ролью tool в переписке.
      const messages = Array.isArray(body?.messages) ? body.messages : []
      // Картинка в запросе — отдельный ответ: так e2e видит, что изображение доехало
      // до провайдера, а не потерялось по дороге.
      const hasImage = messages.some(
        (message) => Array.isArray(message?.images) && message.images.length > 0,
      )
      const toolDone = messages.some((message) => message.role === 'tool')
      const answer = hasImage
        ? { content: 'Вижу картинку: на ней маяк.', toolCalls: [] }
        : toolDone
          ? { content: 'Создал главу «Пролог».', toolCalls: [] }
          : {
              content: '',
              toolCalls: [
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
            }

      if (!body?.stream) {
        send({
          model: 'e2e-stub:latest',
          message: { role: 'assistant', content: answer.content, tool_calls: answer.toolCalls },
          prompt_eval_count: 12,
          eval_count: 8,
        })
        return
      }

      // Поток: по строке JSON на кусок, последняя строка — done со счётчиками.
      res.writeHead(200, { 'Content-Type': 'application/x-ndjson' })
      for (const piece of chunkText(answer.content)) {
        res.write(
          `${JSON.stringify({
            model: 'e2e-stub:latest',
            done: false,
            message: { role: 'assistant', content: piece },
          })}\n`,
        )
      }
      res.end(
        `${JSON.stringify({
          model: 'e2e-stub:latest',
          done: true,
          message: { role: 'assistant', content: '', tool_calls: answer.toolCalls },
          prompt_eval_count: 12,
          eval_count: 8,
        })}\n`,
      )
    })
    return
  }

  res.writeHead(404, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify({ error: 'not found' }))
})

server.listen(port, '127.0.0.1', () => {
  console.log(`stub ollama слушает 127.0.0.1:${port}`)
})
