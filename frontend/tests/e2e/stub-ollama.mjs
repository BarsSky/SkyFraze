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

/**
 * Первый идентификатор кадра из системного сообщения.
 *
 * Сервер печатает дерево проекта списком `id | уровень | заголовок | дата`, и настоящая
 * модель берёт идентификатор оттуда. Заглушка делает то же самое: сценарий не должен
 * знать идентификаторы заранее (их выдают при создании кадра).
 */
function firstEventID(systemText) {
  const match = systemText.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i)
  return match ? match[0] : null
}

/**
 * Идентификатор замечания из результата `read_comments`.
 *
 * Сервер отвечает и структурой (`comments[].comment_id`), и человекочитаемыми строками
 * `#<uuid> Автор: текст` — заглушка разбирает uuid из этих строк: так она не зависит от того,
 * в каком виде провайдер получает результат инструмента (текст, а не JSON).
 */
function firstCommentID(toolMessages) {
  for (const message of toolMessages) {
    const text = typeof message?.content === 'string' ? message.content : ''
    const match = text.match(/"comment_id"\s*:\s*"([0-9a-f-]{36})"/i) ?? text.match(/#([0-9a-f-]{36})/i)
    if (match) return match[1]
  }
  return null
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
      // «Инструмент уже выполнен» считаем ТОЛЬКО в пределах текущего хода: в переписке
      // остались результаты прошлых вопросов, и по ним второй вопрос получал бы ответ
      // словами вместо нового вызова (на этом и споткнулся сценарий правки).
      const lastUserIndex = messages.map((message) => message.role).lastIndexOf('user')
      const toolDone = messages
        .slice(lastUserIndex + 1)
        .some((message) => message.role === 'tool')
      // Просьба переписать существующий кадр — отдельная ветка для сценария «правки по
      // подтверждению»: модель должна ПРЕДЛОЖИТЬ правку (update_event_text), а не
      // применить её. Идентификатор кадра берём из системного сообщения — там сервер
      // печатает дерево проекта (`id | уровень | заголовок | дата`), и модель в бою
      // берёт его оттуда же.
      const lastUser = lastUserIndex >= 0 ? messages[lastUserIndex] : undefined
      const wantsUpdate =
        typeof lastUser?.content === 'string' &&
        lastUser.content.toLowerCase().includes('перепиши')
      // Просьба удалить кадр — вторая ветка того же сценария: удаление тоже
      // предлагается, а не делается, и его можно вернуть (снимок кадра).
      const wantsDelete =
        typeof lastUser?.content === 'string' &&
        lastUser.content.toLowerCase().includes('удали')
      // Дата кадра (0.106.0): отдельная ветка, чтобы сценарий «поставь 5 марта» проверял именно
      // update_event_date, а не «правку текста», и человек видел предложение только даты.
      const wantsDate =
        typeof lastUser?.content === 'string' &&
        lastUser.content.toLowerCase().includes('дату')
      // Правка по замечанию к фрагменту (docs/fragment-comments.md §6). Здесь нужен настоящий
      // двухшаговый обмен, как у живой модели: сначала `read_comments` — иначе идентификатора
      // замечания неоткуда взять, — и только потом `propose_fragment_edit`. Заглушка делает то
      // же, что модель в бою: берёт id кадра из системного сообщения (дерево проекта), а id
      // замечания — из результата своего же чтения.
      const wantsFragment =
        typeof lastUser?.content === 'string' &&
        lastUser.content.toLowerCase().includes('фрагмент')
      const systemText = messages.find((message) => message.role === 'system')?.content ?? ''
      const eventID =
        wantsUpdate || wantsDelete || wantsFragment || wantsDate ? firstEventID(systemText) : null
      // Результаты инструментов В ЭТОМ ХОДЕ: по их числу решается, какой шаг следующий.
      const toolMessages = messages.slice(lastUserIndex + 1).filter((m) => m.role === 'tool')
      const commentID = wantsFragment ? firstCommentID(toolMessages) : null
      const answer = hasImage
        ? { content: 'Вижу картинку: на ней маяк.', toolCalls: [] }
        : wantsDate
          ? toolDone || !eventID
            ? { content: 'Предлагаю поставить кадру дату — подтвердите в окне помощника.', toolCalls: [] }
            : {
                content: '',
                toolCalls: [
                  {
                    function: {
                      name: 'update_event_date',
                      arguments: {
                        id: eventID,
                        date: '2026-03-05',
                        reason: 'проверка e2e: дата по подтверждению',
                      },
                    },
                  },
                ],
              }
          : wantsFragment
          ? !eventID
            ? { content: 'Не нашёл кадр, о котором речь.', toolCalls: [] }
            : toolMessages.length === 0
              ? {
                  content: '',
                  toolCalls: [
                    {
                      function: {
                        name: 'read_comments',
                        arguments: { id: eventID },
                      },
                    },
                  ],
                }
              : toolMessages.length === 1 && commentID
                ? {
                    content: '',
                    toolCalls: [
                      {
                        function: {
                          name: 'propose_fragment_edit',
                          arguments: {
                            comment_id: commentID,
                            replacement: 'Заменённый фрагмент текста.',
                            reason: 'проверка e2e: правка по замечанию к фрагменту',
                          },
                        },
                      },
                    ],
                  }
                : {
                    content: 'Предлагаю заменить фрагмент — примените правку, если согласны.',
                    toolCalls: [],
                  }
          : wantsDelete
          ? toolDone || !eventID
            ? { content: 'Предлагаю удалить кадр — подтвердите, если согласны.', toolCalls: [] }
            : {
                content: '',
                toolCalls: [
                  {
                    function: {
                      name: 'delete_event',
                      arguments: {
                        id: eventID,
                        reason: 'проверка e2e: удаление по подтверждению',
                      },
                    },
                  },
                ],
              }
          : wantsUpdate
            ? toolDone || !eventID
              ? { content: 'Предлагаю переписать кадр — примените правку, если согласны.', toolCalls: [] }
              : {
                  content: '',
                  toolCalls: [
                    {
                      function: {
                        name: 'update_event_text',
                        arguments: {
                          id: eventID,
                          body_md: 'Переписанный текст кадра.',
                          reason: 'проверка e2e: правка по подтверждению',
                        },
                      },
                    },
                  ],
                }
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
