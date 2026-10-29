import { useEffect, useState } from 'react'
import { downloadDocxSample } from '../../api/docxTemplates'
import { useT, type Key } from '../../i18n'

/**
 * Справка «Как сделать шаблон оформления DOCX» (0.94.0).
 *
 * Зачем отдельное окно, а не абзац в настройках. Фича выглядела нерабочей ровно потому, что
 * человек не знал трёх вещей: что нужно положить в шаблон, что программа вообще воспринимает из
 * текста и какими словами называются стили. Инструкция в настройках была бы прочитана один раз и
 * забыта (а из редактора её не видно вовсе), поэтому справка — одно и то же окно в двух местах:
 * в блоке «Оформление DOCX» и в панели «Разметка DOCX» рядом с кнопками маркеров.
 *
 * Текст справки повторяет РЕАЛЬНЫЕ правила разбора и выгрузки (`backend/internal/docxtpl`
 * и `backend/internal/transfer/export_docx.go`); расхождение здесь хуже отсутствия справки.
 */
interface Props {
  /** Проект нужен, чтобы предложить скачать пример; в редакторе его может не быть. */
  projectId?: string
  onClose: () => void
}

/** Что берётся из текста кадров при сборке документа: подписи — ключи словаря. */
const FROM_TEXT: Array<{ what: Key; how: Key }> = [
  { what: 'dh.rowChapters', how: 'dh.rowChaptersHow' },
  { what: 'dh.rowDate', how: 'dh.rowDateHow' },
  { what: 'dh.rowParagraphs', how: 'dh.rowParagraphsHow' },
  { what: 'dh.rowQuotes', how: 'dh.rowQuotesHow' },
  { what: 'dh.rowCode', how: 'dh.rowCodeHow' },
  { what: 'dh.rowLists', how: 'dh.rowListsHow' },
  { what: 'dh.rowTables', how: 'dh.rowTablesHow' },
  { what: 'dh.rowImages', how: 'dh.rowImagesHow' },
]

/** Маркеры — строки, которые понимает только DOCX. */
const MARKERS: Array<{ marker: string; what: Key }> = [
  { marker: '<!-- sf:pagebreak -->', what: 'dh.markerPagebreak' },
  { marker: '<!-- sf:toc -->', what: 'dh.markerToc' },
  { marker: '<!-- sf:style=Имя -->', what: 'dh.markerStyle' },
  { marker: '<!-- sf:begin=Имя --> … <!-- sf:end -->', what: 'dh.markerBegin' },
]

export function DocxHelp({ projectId, onClose }: Props) {
  const t = useT()
  const [busy, setBusy] = useState(false)
  const [note, setNote] = useState<string | null>(null)

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const download = async () => {
    if (!projectId) return
    setBusy(true)
    setNote(null)
    try {
      const name = await downloadDocxSample(projectId)
      setNote(t('dh.sampleReady', { name }))
    } catch {
      setNote(t('dh.sampleFailed'))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div
      className="docx-help"
      role="dialog"
      aria-modal="true"
      aria-label={t('dh.aria')}
      data-docx-help
    >
      <div className="docx-help__window">
        <header className="docx-help__head">
          <strong>{t('dh.title')}</strong>
          <button type="button" className="secondary" onClick={onClose} aria-label={t('dh.closeAria')}>
            {t('dh.close')}
          </button>
        </header>

        <div className="docx-help__body">
          <section>
            <h3>{t('dh.step1')}</h3>
            <p>
              {t('dh.step1Hint1')}{' '}
              <code>{'{{content}}'}</code>
              {t('dh.step1Hint2')}
            </p>
            {projectId && (
              <p>
                <button type="button" onClick={() => void download()} disabled={busy} data-docx-help-sample>
                  {busy ? t('dh.preparing') : t('dh.downloadSample')}
                </button>
              </p>
            )}
            {note !== null && <p className="muted">{note}</p>}
          </section>

          <section>
            <h3>{t('dh.step2', { placeholder: '{{content}}' })}</h3>
            <p>
              {t('dh.step2Hint1')} <code>{'{{content}}'}</code> {t('dh.step2Hint2')}
            </p>
          </section>

          <section>
            <h3>{t('dh.step3')}</h3>
            <p>
              {t('dh.step3Hint')}
            </p>
            <ul className="docx-help__list">
              <li>
                <b>Title</b>{t('dh.styleTitleParen')} — {t('dh.styleTitleWhat')}
              </li>
              <li>
                <b>Heading1–Heading4</b>{t('dh.styleHeadingsParen')} — {t('dh.styleHeadingsWhat')}
              </li>
              <li>
                <b>Quote</b>{t('dh.styleQuoteParen')}, <b>Code</b>{t('dh.styleCodeParen')},{' '}
                <b>Date</b>{t('dh.styleDateParen')}
              </li>
              <li>
                <b>ListParagraph</b>{t('dh.styleListParen')} — {t('dh.styleListWhat')}
              </li>
            </ul>
            <p>
              {t('dh.step3Fallback')}
            </p>
          </section>

          <section>
            <h3>{t('dh.step4')}</h3>
            <p>
              {t('dh.step4Hint')}
            </p>
          </section>

          <section>
            <h3>{t('dh.fromText')}</h3>
            <table className="docx-help__table">
              <tbody>
                {FROM_TEXT.map((row) => (
                  <tr key={row.what}>
                    <th scope="row">{t(row.what)}</th>
                    <td>{t(row.how)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>

          <section>
            <h3>{t('dh.markers')}</h3>
            <p>
              {t('dh.markersHint')}
            </p>
            <table className="docx-help__table">
              <tbody>
                {MARKERS.map((row) => (
                  <tr key={row.marker}>
                    <th scope="row">
                      <code>{row.marker}</code>
                    </th>
                    <td>{t(row.what)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>

          <section>
            <h3>{t('dh.notDoing')}</h3>
            <ul className="docx-help__list">
              <li>{t('dh.notDoing1')}</li>
              <li>{t('dh.notDoing2')}</li>
              <li>{t('dh.notDoing3')}</li>
              <li>{t('dh.notDoing4')}</li>
            </ul>
          </section>
        </div>
      </div>
    </div>
  )
}
