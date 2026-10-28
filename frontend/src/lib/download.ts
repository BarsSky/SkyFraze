/**
 * Скачивание файла, полученного с сервера (blob).
 *
 * Один приём на все выгрузки: временная ссылка + клик по `<a download>`. Держим в одном месте,
 * чтобы «скачать .md», «скачать .docx», «скачать пример шаблона» не расходились в поведении
 * (в частности, в отзыве URL — без него blob живёт до перезагрузки вкладки).
 */
export function saveBlob(blob: Blob, name: string): void {
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = name
  document.body.appendChild(a)
  a.click()
  a.remove()
  URL.revokeObjectURL(url)
}
