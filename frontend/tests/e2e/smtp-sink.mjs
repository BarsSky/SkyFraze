// smtp-sink.mjs — крошечный SMTP-сервер для живой проверки писем о замечаниях.
//
// Зачем: на стенде почтового сервера нет, а проверить надо не тесты (они гоняют поддельный
// SMTP внутри Go), а весь путь целиком — backend собрал письмо и отправил его настоящим
// SMTP-клиентом. Этот скрипт принимает письмо и складывает в файл.
//
//   node tests/e2e/smtp-sink.mjs [порт] [файл]
//
// Никакой проверки подлинности: сервер слушает 127.0.0.1 и нужен на минуту.
import { createServer } from 'node:net'
import { appendFileSync, writeFileSync } from 'node:fs'

const port = Number(process.argv[2] ?? 2525)
const outFile = process.argv[3] ?? '/tmp/skyfraze-mails.txt'
writeFileSync(outFile, '')

createServer((socket) => {
  let buffer = ''
  let inData = false
  let message = ''
  socket.write('220 smtp-sink ready\r\n')

  socket.on('data', (chunk) => {
    buffer += chunk.toString('utf8')
    for (;;) {
      const index = buffer.indexOf('\r\n')
      if (index < 0) {
        // Данные письма могут прийти без перевода строки в конце — не теряем их.
        if (inData && buffer.startsWith('.')) {
          message += buffer
          buffer = ''
        }
        return
      }
      const line = buffer.slice(0, index)
      buffer = buffer.slice(index + 2)

      if (inData) {
        if (line === '.') {
          inData = false
          appendFileSync(outFile, message + '\n=== END ===\n')
          message = ''
          socket.write('250 queued\r\n')
          continue
        }
        message += line + '\r\n'
        continue
      }

      const command = line.toUpperCase()
      if (command.startsWith('EHLO') || command.startsWith('HELO')) {
        socket.write('250-smtp-sink\r\n250 SIZE 10485760\r\n')
      } else if (command.startsWith('MAIL FROM') || command.startsWith('RCPT TO') || command === 'RSET') {
        socket.write('250 ok\r\n')
      } else if (command === 'DATA') {
        inData = true
        socket.write('354 go ahead\r\n')
      } else if (command === 'QUIT') {
        socket.write('221 bye\r\n')
        socket.end()
        return
      } else {
        socket.write('250 ok\r\n')
      }
    }
  })
}).listen(port, '127.0.0.1', () => {
  console.log(`smtp-sink: 127.0.0.1:${port} → ${outFile}`)
})
