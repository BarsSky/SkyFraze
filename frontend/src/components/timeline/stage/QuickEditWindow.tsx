import { useEffect, useMemo, useState } from 'react'
import { createPortal } from 'react-dom'
import { useT } from '../../../i18n'
import { ensureText, setText, type YMap } from '../../../collab/text'
import type { QuoteEditRequest } from '../../../lib/storySelection'

/**
 * Быстрая правка выделенного фрагмента (0.132.0).
 *
 * Зачем отдельное окно, если есть редакторы. Частая правка — «поправить слово, запятую,
 * формулировку в одном абзаце»; ради неё уходить на вкладку редакторов, искать тот же кадр в
 * дереве и прокручивать форму до нужной строки — это пять шагов вместо одного. Окно показывает
 * ровно тот кусок, который человек выделил, и сохраняет правку в тот же CRDT-документ: результат
 * видят все, у кого проект открыт, как и после правки в редакторах.
 *
 * Почему правка применяется к ДИАПАЗОНУ в исходнике, а не к DOM. Текст кадра живёт в `Y.Text`, и
 * менять его можно только по смещениям; смещения пришли из `locateQuote` в момент выделения. Между
 * выделением и сохранением соавтор мог изменить текст — поэтому перед записью сверяем, что по этим
 * смещениям всё ещё лежит выделенная фраза. Не совпало — честно говорим об этом и предлагаем
 * открыть редакторы, а не «правим то, что теперь на этом месте».
 */
interface Props {
  request: QuoteEditRequest
  /** Документ кадра: по нему читаем текст и пишем правку. */
  ymap: YMap | null
  onClose: () => void
  /** Уйти в редакторы на этот же фрагмент (кнопка в окне). */
  onOpenEditors: () => void
  /**
   * Правка записана в документ (0.134.0).
   *
   * Зачем. Сервер строит свою проекцию дерева сам, но только у ПОДКЛЮЧЁННОГО клиента (правки
   * едут по сокету). Без сокета (прокси без Upgrade, мобильная сеть) проекцию двигает страница
   * своим REST-вызовом — и раньше этот вызов делала только панель редакторов. Значит правка из
   * показа оставалась невидимой серверу: цитата из неё потом не принималась в чате («такой фразы
   * в тексте кадра нет»), а публичная страница показывала старый текст. Это и поймал e2e.
   */
  onSaved?: () => void
}

/**
 * Совпадает ли то, что лежит по смещениям, с тем, что выделили.
 *
 * Смещения найдены по словам (`locateQuote`), поэтому внутри них может остаться разметка:
 * человек выделил «Дом стоял», а в исходнике `**Дом** стоял`. Сравнивать буквально значило бы
 * говорить «фрагмент не найден» там, где он найден, поэтому сверяем без разметки и без разницы
 * в пробелах. Подмены не боимся: совпасть должны все слова, а не одно.
 */
function sameFragment(atOffsets: string, quote: string): boolean {
  const normalize = (value: string) => value.replace(/[*_~`#>]/g, '').replace(/\s+/g, ' ').trim()
  return normalize(atOffsets) === normalize(quote)
}

export function QuickEditWindow({ request, ymap, onClose, onOpenEditors, onSaved }: Props) {
  const t = useT()
  const [value, setValue] = useState('')
  const [note, setNote] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const bodyText = useMemo(() => {
    if (!ymap) return ''
    try {
      return ensureText(ymap, 'body').toString()
    } catch {
      return ''
    }
  }, [ymap])

  // Исходное значение — то, что лежит в документе по найденным смещениям. Текст берём из
  // документа, а не из цитаты: в показе разметка снята, а править надо исходник, иначе первая же
  // правка вырезала бы `**` и курсив вместе с ним.
  useEffect(() => {
    if (!request.range) {
      setValue('')
      return
    }
    setValue(bodyText.slice(request.range.from, request.range.to))
  }, [bodyText, request.nonce, request.range])

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const save = () => {
    const range = request.range
    if (!range || !ymap) return
    const next = value
    if (next.trim() === '') {
      setNote(t('sel.quickEmpty'))
      return
    }
    setBusy(true)
    try {
      const current = ensureText(ymap, 'body').toString()
      const actual = current.slice(range.from, range.to)
      if (!sameFragment(actual, request.quote)) {
        // Текст на этом месте уже другой: писать поверх — значит потерять чужую правку.
        setNote(t('sel.quickNotFound'))
        return
      }
      setText(ymap, 'body', current.slice(0, range.from) + next + current.slice(range.to))
      setNote(t('sel.quickSaved'))
      // Сказать странице: правка в документе. Она проецирует дерево на сервер, если realtime не
      // поднялся (см. комментарий у `onSaved`).
      onSaved?.()
    } finally {
      setBusy(false)
    }
  }

  return createPortal(
    <div
      className="sf-quick-edit"
      role="dialog"
      aria-modal="true"
      aria-label={t('sel.quickTitle')}
      data-quick-edit
    >
      <div className="sf-quick-edit__window">
        <header className="sf-quick-edit__head">
          <strong>{t('sel.quickTitle')}</strong>
          <button type="button" className="secondary" onClick={onClose} aria-label={t('sel.quickClose')}>
            ✕
          </button>
        </header>
        <p className="muted sf-quick-edit__hint">{t('sel.quickHint', { frame: request.frameTitle })}</p>
        {request.range === null ? (
          <p className="sf-quick-edit__note" data-quick-edit-missing>
            {t('sel.quickNotFound')}
          </p>
        ) : (
          <textarea
            value={value}
            rows={6}
            onChange={(event) => {
              setValue(event.target.value)
              setNote(null)
            }}
            aria-label={t('sel.quickTitle')}
            data-quick-edit-field
            autoFocus
          />
        )}
        {note !== null && (
          <p className="muted" role="status" data-quick-edit-note>
            {note}
          </p>
        )}
        <footer className="sf-quick-edit__foot">
          <button type="button" className="secondary" onClick={onOpenEditors} data-quick-edit-editors>
            {t('sel.quickOpenEditors')}
          </button>
          {request.range !== null && (
            <button type="button" onClick={save} disabled={busy} data-quick-edit-save>
              {busy ? t('sel.quickSaving') : t('sel.quickSave')}
            </button>
          )}
          <button type="button" className="secondary" onClick={onClose}>
            {t('sel.quickCancel')}
          </button>
        </footer>
      </div>
    </div>,
    document.body,
  )
}
