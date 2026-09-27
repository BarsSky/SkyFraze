/**
 * Копирование текста в буфер обмена.
 *
 * `navigator.clipboard` доступен только в защищённом контексте: на стенде, открытом
 * по IP (`http://192.168.13.66`), его нет вовсе, и кнопка «скопировать» молча ничего
 * не делала. Запасной путь — скрытая textarea и `document.execCommand('copy')`.
 */
export async function copyText(text: string): Promise<boolean> {
  try {
    if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text)
      return true
    }
  } catch {
    // например, отказ в разрешении — пробуем запасной путь
  }

  try {
    const area = document.createElement('textarea')
    area.value = text
    area.setAttribute('readonly', '')
    area.style.position = 'fixed'
    area.style.top = '-1000px'
    area.style.opacity = '0'
    document.body.appendChild(area)
    area.select()
    const ok = document.execCommand('copy')
    area.remove()
    return ok
  } catch {
    return false
  }
}
