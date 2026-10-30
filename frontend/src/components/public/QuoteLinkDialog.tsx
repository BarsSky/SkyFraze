import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useT } from '../../i18n'
import { copyText } from '../../lib/clipboard'

/**
 * Окно «ссылка на фразу» в публичной истории (0.136.0).
 *
 * Зачем окно, а не мгновенное копирование. Копирование в буфер — не всегда доступно: на стенде по
 * http (`navigator.clipboard` есть только в защищённом контексте) оно либо падает, либо требует
 * запасного пути. Поэтому ссылка сначала ПОКАЗЫВАЕТСЯ: текст в поле уже выделен, и её можно
 * скопировать руками, даже если кнопка не сработала. Кнопка — удобство, а не единственный путь.
 *
 * Почему адрес строится здесь, а не в меню. Меню выделения живёт в стадии и не знает ни slug
 * истории, ни происхождения страницы; страница знает и то и другое.
 */
interface Props {
  /** Готовый адрес публичной истории с кадром и фразой. */
  url: string
  onClose: () => void
}

export function QuoteLinkDialog({ url, onClose }: Props) {
  const t = useT()
  const fieldRef = useRef<HTMLInputElement | null>(null)
  const [note, setNote] = useState<string | null>(null)

  // Ссылку выделяем сразу: если скопировать не даст браузер, человек скопирует сам, не возясь.
  useEffect(() => {
    const field = fieldRef.current
    if (!field) return
    field.focus()
    field.select()
  }, [url])

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const copy = () => {
    void copyText(url).then((ok) => {
      setNote(ok ? t('pub.linkCopied') : t('pub.linkManual'))
      if (ok) {
        fieldRef.current?.focus()
        fieldRef.current?.select()
      }
    })
  }

  return createPortal(
    <div
      className="sf-quick-edit"
      role="dialog"
      aria-modal="true"
      aria-label={t('pub.linkTitle')}
      data-quote-link
    >
      <div className="sf-quick-edit__window">
        <header className="sf-quick-edit__head">
          <strong>{t('pub.linkTitle')}</strong>
          <button type="button" className="secondary" onClick={onClose} aria-label={t('pub.linkClose')}>
            ✕
          </button>
        </header>
        <p className="muted sf-quick-edit__hint">{t('pub.linkHint')}</p>
        <input
          ref={fieldRef}
          className="sf-quote-link__field"
          value={url}
          readOnly
          aria-label={t('pub.linkField')}
          data-quote-link-field
          onClick={(event) => event.currentTarget.select()}
        />
        {note !== null && (
          <p className="muted" role="status" data-quote-link-note>
            {note}
          </p>
        )}
        <footer className="sf-quick-edit__foot">
          <button type="button" onClick={copy} data-quote-link-copy>
            {t('pub.linkCopy')}
          </button>
          <button type="button" className="secondary" onClick={onClose} data-quote-link-close>
            {t('pub.linkClose')}
          </button>
        </footer>
      </div>
    </div>,
    document.body,
  )
}
