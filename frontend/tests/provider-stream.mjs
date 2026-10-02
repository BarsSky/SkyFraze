// Прямой запрос к серверу моделей (без SkyFraze): проверяем, отдаёт ли он ответ
// потоком. Нужно, чтобы отличить «поток не работает у нас» от «провайдер копит ответ».
//
//   node provider-stream.mjs <baseUrl> <model> [prompt]

const [baseUrl, model, prompt] = process.argv.slice(2)
const started = Date.now()
const response = await fetch(`${baseUrl}/chat/completions`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    model,
    stream: true,
    messages: [{ role: 'user', content: prompt || 'Придумай три названия глав.' }],
  }),
})
console.log(`HTTP ${response.status} ${response.headers.get('content-type')}`)
const reader = response.body.getReader()
const decoder = new TextDecoder()
let chunks = 0
for (;;) {
  const { value, done } = await reader.read()
  if (done) break
  chunks += 1
  console.log(`+${((Date.now() - started) / 1000).toFixed(2)}s  #${chunks} ${decoder.decode(value, { stream: true }).replace(/\s+/g, ' ').slice(0, 60)}`)
}
console.log(`итого: ${chunks} кусков, ${((Date.now() - started) / 1000).toFixed(2)}s`)
