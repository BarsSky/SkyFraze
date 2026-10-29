import { useCallback, useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import {
  deleteProjectVersion,
  getProjectVersion,
  listProjectVersions,
  restoreProjectVersion,
  saveProjectVersion,
  type ProjectVersion,
  type ProjectVersionPreview,
} from '../../api/versions'
import { serverErrorMessage } from '../../api/client'
import { formatBytes, formatDate } from '../../lib/format'
import { pluralWord, tStatic, useT } from '../../i18n'
import { useLang, type Lang } from '../../store/lang'

/** Дата и время версии: по одной дате «когда это было» не понять — версии идут парами в день. */
function formatStamp(iso: string): string {
  const date = formatDate(iso)
  const time = new Date(iso)
  if (Number.isNaN(time.getTime())) return date
  const pad = (value: number) => String(value).padStart(2, '0')
  return `${date} ${pad(time.getHours())}:${pad(time.getMinutes())}`.trim()
}

/**
 * «3 кадра» / «3 frames» (0.123.0): число и слово в нужной форме языка.
 *
 * Слова с формами — в словаре (`ver.unit.frame.*`), а склейку делает эта функция: держать
 * её в разметке значило бы повторять `${n} ${pluralWord(...)}` в пяти местах и однажды
 * забыть форму в одном из них.
 */
function withUnit(lang: Lang, prefix: string, count: number): string {
  return `${count} ${pluralWord(lang, prefix, count)}`
}

interface Props {
  projectId: string
  /** Владелец или редактор: у читателя кнопок нет. */
  canEdit: boolean
  onClose: () => void
  /** Проект изменился восстановлением — страница перечитывает состояние. */
  onRestored: () => void
  /**
   * Встроенный режим (0.83.0): история версий как ВКЛАДКА проекта, а не окно поверх него.
   *
   * Зачем: у владельца и соавторов «Редакторы», «Связи» и «Версии» — это режимы работы, и
   * переключение между ними не должно требовать модального окна (или прокрутки через полпроекта).
   * Разметка внутри та же (`.sf-versions__window`), поэтому вид не меняется: пропадает только
   * подложка-окно и блокировка прокрутки страницы.
   */
  embedded?: boolean
}

/**
 * История версий проекта.
 *
 * Зачем отдельным окном, а не разделом в редакторах: версии нужны редко и в момент
 * неприятности («переписал главу и стёр нужное»), поэтому окно открывается по кнопке из
 * стадии и не занимает места в обычной работе. С 0.83.0 у владельца и соавторов то же
 * содержимое показывается вкладкой — см. `embedded`.
 *
 * Что здесь принципиально:
 *   - версия восстанавливается НЕ вместо нынешнего состояния, а как обычная правка:
 *     сервер приводит документ к версии, и открытые вкладки видят результат сразу;
 *   - перед восстановлением показывается предпросмотр — «восстановить» без того, что
 *     именно вернётся, значит нажать кнопку вслепую;
 *   - восстановление и удаление подтверждаются вторым нажатием, потому что первое уже
 *     меняет проект.
 */
export function VersionsModal({
  projectId,
  canEdit,
  onClose,
  onRestored,
  embedded = false,
}: Props) {
  const t = useT()
  const [lang] = useLang()
  const [versions, setVersions] = useState<ProjectVersion[]>([])
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState<string | null>(null)
  const [note, setNote] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [label, setLabel] = useState('')
  const [preview, setPreview] = useState<ProjectVersionPreview | null>(null)
  /** Версия, для которой нажали «Восстановить»: второе нажатие применяет. */
  const [confirming, setConfirming] = useState<string | null>(null)
  const closeRef = useRef<HTMLButtonElement>(null)

  // Фокус уходит в окно, страница под ним не прокручивается (класс общий с другими
  // окнами: html.sf-viewer-open запрещает прокрутку). Во встроенном режиме (вкладка) ни
  // того, ни другого не нужно: страница — это и есть вкладка, и блокировать её прокрутку
  // значило бы «заморозить» сам интерфейс.
  useEffect(() => {
    if (embedded) return undefined
    document.documentElement.classList.add('sf-viewer-open')
    closeRef.current?.focus()
    return () => {
      document.documentElement.classList.remove('sf-viewer-open')
    }
  }, [embedded])

  const load = useCallback(async () => {
    setLoading(true)
    try {
      setVersions(await listProjectVersions(projectId))
      setError(null)
    } catch (e) {
      setError((await serverErrorMessage(e)) ?? tStatic('ver.errLoad'))
    } finally {
      setLoading(false)
    }
  }, [projectId])

  useEffect(() => {
    void load()
  }, [load])

  const save = useCallback(async () => {
    setBusy('save')
    setNote(null)
    setError(null)
    try {
      const created = await saveProjectVersion(projectId, label.trim())
      setLabel('')
      setNote(
        created
          ? tStatic('ver.savedDetailed', {
              frames: withUnit(lang, 'ver.unit.frame', created.events),
              bytes: formatBytes(created.size, lang),
            })
          : tStatic('ver.saved'),
      )
      await load()
    } catch (e) {
      setError((await serverErrorMessage(e)) ?? tStatic('ver.errSave'))
    } finally {
      setBusy(null)
    }
  }, [projectId, label, load, lang])

  const show = useCallback(
    async (version: ProjectVersion) => {
      setBusy(`show:${version.id}`)
      setError(null)
      try {
        setPreview(await getProjectVersion(projectId, version.id))
      } catch (e) {
        setError((await serverErrorMessage(e)) ?? tStatic('ver.errShow'))
      } finally {
        setBusy(null)
      }
    },
    [projectId],
  )

  const restore = useCallback(
    async (version: ProjectVersion) => {
      if (confirming !== version.id) {
        // Первое нажатие только спрашивает: восстановление меняет проект.
        setConfirming(version.id)
        return
      }
      setConfirming(null)
      setBusy(`restore:${version.id}`)
      setNote(null)
      setError(null)
      try {
        const result = await restoreProjectVersion(projectId, version.id)
        const parts: string[] = []
        if (result.added > 0) parts.push(tStatic('ver.partAdded', { count: result.added }))
        if (result.updated > 0) parts.push(tStatic('ver.partUpdated', { count: result.updated }))
        if (result.moved > 0) parts.push(tStatic('ver.partMoved', { count: result.moved }))
        if (result.removed > 0) parts.push(tStatic('ver.partRemoved', { count: result.removed }))
        setNote(
          result.warning ||
            (parts.length > 0 ? tStatic('ver.restored', { parts: parts.join(', ') }) : tStatic('ver.restoredNothing')),
        )
        setPreview(null)
        onRestored()
        await load()
      } catch (e) {
        setError((await serverErrorMessage(e)) ?? tStatic('ver.errRestore'))
      } finally {
        setBusy(null)
      }
    },
    [projectId, confirming, load, onRestored],
  )

  const remove = useCallback(
    async (version: ProjectVersion) => {
      setBusy(`delete:${version.id}`)
      setNote(null)
      setError(null)
      try {
        await deleteProjectVersion(projectId, version.id)
        if (preview?.version.id === version.id) setPreview(null)
        await load()
      } catch (e) {
        setError((await serverErrorMessage(e)) ?? tStatic('ver.errRemove'))
      } finally {
        setBusy(null)
      }
    },
    [projectId, preview, load],
  )

  // Одна и та же разметка в обоих режимах: во вкладке пропадает только подложка-окно,
  // поэтому вид истории не меняется (и e2e-селекторы `.sf-versions__window` тоже).
  const body = (
    <div className="sf-versions__window">
        <div className="sf-versions__head">
          <div className="sf-versions__titles">
            <strong>{t('ver.head')}</strong>
            <span className="muted">{t('ver.hint')}</span>
          </div>
          <button ref={closeRef} className="secondary" onClick={onClose} aria-label={t('ver.close')}>
            {t('ver.close')}
          </button>
        </div>

        <div className="sf-versions__body">
          {canEdit && (
            <div className="sf-versions__save">
              <input
                type="text"
                value={label}
                placeholder={t('ver.labelPlaceholder')}
                aria-label={t('ver.labelAria')}
                onChange={(e) => setLabel(e.target.value)}
              />
              <button onClick={() => void save()} disabled={busy === 'save'}>
                {busy === 'save' ? t('ver.saving') : t('ver.save')}
              </button>
            </div>
          )}

          {error != null && <p className="ai-error">{error}</p>}
          {note != null && (
            <p className="muted" data-versions-note>
              {note}
            </p>
          )}

          {loading ? (
            <p className="muted">{t('ver.loading')}</p>
          ) : versions.length === 0 ? (
            <p className="muted" data-versions-empty>
              {t('ver.empty')}
            </p>
          ) : (
            <ul className="sf-versions__list">
              {versions.map((version) => (
                <li key={version.id} className="sf-versions__item" data-version-id={version.id}>
                  <div className="sf-versions__meta">
                    <strong>
                      {version.kind === 'manual' ? t('ver.kindManual') : t('ver.kindAuto')}
                      {version.label ? ` · ${version.label}` : ''}
                    </strong>
                    <span className="muted">
                      {formatStamp(version.createdAt)} ·{' '}
                      {withUnit(lang, 'ver.unit.frame', version.events)} ·{' '}
                      {formatBytes(version.size, lang)}
                    </span>
                  </div>
                  <div className="sf-versions__actions">
                    <button
                      className="secondary"
                      onClick={() => void show(version)}
                      disabled={busy === `show:${version.id}`}
                    >
                      {t('ver.show')}
                    </button>
                    {canEdit && (
                      <>
                        <button
                          onClick={() => void restore(version)}
                          disabled={busy === `restore:${version.id}`}
                        >
                          {confirming === version.id ? t('ver.restoreConfirm') : t('ver.restore')}
                        </button>
                        <button
                          className="secondary"
                          onClick={() => void remove(version)}
                          disabled={busy === `delete:${version.id}`}
                          aria-label={t('ver.removeAria', { stamp: formatStamp(version.createdAt) })}
                        >
                          {t('ver.remove')}
                        </button>
                      </>
                    )}
                  </div>
                </li>
              ))}
            </ul>
          )}

          {preview != null && (
            <div className="sf-versions__preview" data-versions-preview>
              <strong>
                {t('ver.previewHead', {
                  stamp: formatStamp(preview.version.createdAt),
                  frames: withUnit(lang, 'ver.unit.frame', preview.frames.length),
                  chars: withUnit(lang, 'ver.unit.char', preview.chars),
                })}
              </strong>
              <ul>
                {preview.frames.map((frame) => (
                  <li key={frame.id} style={{ paddingLeft: `${frame.depth * 14}px` }}>
                    {frame.title || t('ver.untitled')}
                    {frame.date ? ` · ${frame.date}` : ''} ·{' '}
                    {withUnit(lang, 'ver.unit.char', frame.chars)}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
    </div>
  )

  if (embedded) {
    // Встроенный режим: обычная область страницы вкладки. `data-versions-embedded` — чтобы
    // сценарии и аудит отличали эту форму от окна.
    return (
      <section
        className="sf-versions sf-versions--embedded"
        role="region"
        aria-label={t('ver.head')}
        data-versions-embedded
      >
        {body}
      </section>
    )
  }

  return createPortal(
    <div className="sf-versions" role="dialog" aria-modal="true" aria-label={t('ver.head')}>
      {body}
    </div>,
    document.body,
  )
}
