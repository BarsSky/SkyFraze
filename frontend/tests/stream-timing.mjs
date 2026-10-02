// Измеряет, как приходят куски потока ответа помощника: время появления каждого
// куска от начала запроса. Нужен, чтобы отличить настоящий поток от буферизации
// (прокси или сервер копит ответ и отдаёт его одним куском в конце).
//
//   node stream-timing.mjs <url> <token> <model> [prompt]

const [url, token, model, prompt] = process.argv.slice(2)
const text = prompt || 'Три абзаца о маяке на краю мира.'

const started = Date.now()
const response = await fetch(url, {
  method: 'POST',
  headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
  body: JSON.stringify({ text, model }),
})
console.log(`HTTP ${response.status} ${response.headers.get('content-type')}`)

const reader = response.body.getReader()
const decoder = new TextDecoder()
let chunks = 0
let bytes = 0
for (;;) {
  const { value, done } = await reader.read()
  if (done) break
  chunks += 1
  bytes += value.length
  const piece = decoder.decode(value, { stream: true }).replace(/\s+/g, ' ').slice(0, 70)
  console.log(`+${((Date.now() - started) / 1000).toFixed(2)}s  кусок #${chunks} (${value.length}б): ${piece}`)
}
console.log(`итого: ${chunks} кусков, ${bytes} байт, ${((Date.now() - started) / 1000).toFixed(2)}s`)
