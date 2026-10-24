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
import { formatBytes, formatDate, plural } from '../../lib/format'

/** Дата и время версии: по одной дате «когда это было» не понять — версии идут парами в день. */
function formatStamp(iso: string): string {
  const date = formatDate(iso)
  const time = new Date(iso)
  if (Number.isNaN(time.getTime())) return date
  const pad = (value: number) => String(value).padStart(2, '0')
  return `${date} ${pad(time.getHours())}:${pad(time.getMinutes())}`.trim()
}

interface Props {
  projectId: string
  /** Владелец или редактор: у читателя кнопок нет. */
  canEdit: boolean
  onClose: () => void
  /** Проект изменился восстановлением — страница перечитывает состояние. */
  onRestored: () => void
}

/**
 * История версий проекта.
 *
 * Зачем отдельным окном, а не разделом в редакторах: версии нужны редко и в момент
 * неприятности («переписал главу и стёр нужное»), поэтому окно открывается по кнопке из
 * стадии и не занимает места в обычной работе.
 *
 * Что здесь принципиально:
 *   - версия восстанавливается НЕ вместо нынешнего состояния, а как обычная правка:
 *     сервер приводит документ к версии, и открытые вкладки видят результат сразу;
 *   - перед восстановлением показывается предпросмотр — «восстановить» без того, что
 *     именно вернётся, значит нажать кнопку вслепую;
 *   - восстановление и удаление подтверждаются вторым нажатием, потому что первое уже
 *     меняет проект.
 */
export function VersionsModal({ projectId, canEdit, onClose, onRestored }: Props) {
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
  // окнами: html.sf-viewer-open запрещает прокрутку).
  useEffect(() => {
    document.documentElement.classList.add('sf-viewer-open')
    closeRef.current?.focus()
    return () => {
      document.documentElement.classList.remove('sf-viewer-open')
    }
  }, [])

  const load = useCallback(async () => {
    setLoading(true)
    try {
      setVersions(await listProjectVersions(projectId))
      setError(null)
    } catch (e) {
      setError((await serverErrorMessage(e)) ?? 'Не удалось прочитать историю версий.')
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
          ? `Версия сохранена: ${plural(created.events, 'кадр', 'кадра', 'кадров')}, ${formatBytes(created.size)}.`
          : 'Версия сохранена.',
      )
      await load()
    } catch (e) {
      setError((await serverErrorMessage(e)) ?? 'Не удалось сохранить версию.')
    } finally {
      setBusy(null)
    }
  }, [projectId, label, load])

  const show = useCallback(
    async (version: ProjectVersion) => {
      setBusy(`show:${version.id}`)
      setError(null)
      try {
        setPreview(await getProjectVersion(projectId, version.id))
      } catch (e) {
        setError((await serverErrorMessage(e)) ?? 'Не удалось прочитать версию.')
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
        if (result.added > 0) parts.push(`возвращено ${result.added}`)
        if (result.updated > 0) parts.push(`переписано ${result.updated}`)
        if (result.moved > 0) parts.push(`переставлено ${result.moved}`)
        if (result.removed > 0) parts.push(`удалено ${result.removed}`)
        setNote(
          result.warning ||
            (parts.length > 0
              ? `Проект восстановлен: ${parts.join(', ')}.`
              : 'Проект уже в этом состоянии — менять нечего.'),
        )
        setPreview(null)
        onRestored()
        await load()
      } catch (e) {
        setError((await serverErrorMessage(e)) ?? 'Не удалось восстановить версию.')
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
        setError((await serverErrorMessage(e)) ?? 'Не удалось удалить версию.')
      } finally {
        setBusy(null)
      }
    },
    [projectId, preview, load],
  )

  return createPortal(
    <div className="sf-versions" role="dialog" aria-modal="true" aria-label="История версий">
      <div className="sf-versions__window">
        <div className="sf-versions__head">
          <div className="sf-versions__titles">
            <strong>История версий</strong>
            <span className="muted">
              Версии снимаются сами по ходу работы и по кнопке. Восстановление — обычная
              правка: открытые вкладки увидят её сразу.
            </span>
          </div>
          <button ref={closeRef} className="secondary" onClick={onClose} aria-label="Закрыть">
            Закрыть
          </button>
        </div>

        <div className="sf-versions__body">
          {canEdit && (
            <div className="sf-versions__save">
              <input
                type="text"
                value={label}
                placeholder="подпись версии (необязательно)"
                aria-label="Подпись версии"
                onChange={(e) => setLabel(e.target.value)}
              />
              <button onClick={() => void save()} disabled={busy === 'save'}>
                {busy === 'save' ? 'Сохраняю…' : 'Сохранить версию'}
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
            <p className="muted">Читаю историю…</p>
          ) : versions.length === 0 ? (
            <p className="muted" data-versions-empty>
              Версий пока нет. Первая появится сама после первых правок — или нажмите
              «Сохранить версию».
            </p>
          ) : (
            <ul className="sf-versions__list">
              {versions.map((version) => (
                <li key={version.id} className="sf-versions__item" data-version-id={version.id}>
                  <div className="sf-versions__meta">
                    <strong>
                      {version.kind === 'manual' ? 'Вручную' : 'Автоматически'}
                      {version.label ? ` · ${version.label}` : ''}
                    </strong>
                    <span className="muted">
                      {formatStamp(version.createdAt)} ·{' '}
                      {version.events} {plural(version.events, 'кадр', 'кадра', 'кадров')} ·{' '}
                      {formatBytes(version.size)}
                    </span>
                  </div>
                  <div className="sf-versions__actions">
                    <button
                      className="secondary"
                      onClick={() => void show(version)}
                      disabled={busy === `show:${version.id}`}
                    >
                      Показать
                    </button>
                    {canEdit && (
                      <>
                        <button
                          onClick={() => void restore(version)}
                          disabled={busy === `restore:${version.id}`}
                        >
                          {confirming === version.id ? 'Точно восстановить?' : 'Восстановить'}
                        </button>
                        <button
                          className="secondary"
                          onClick={() => void remove(version)}
                          disabled={busy === `delete:${version.id}`}
                          aria-label={`Удалить версию ${formatStamp(version.createdAt)}`}
                        >
                          Удалить
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
                В версии {formatStamp(preview.version.createdAt)}:{' '}
                {preview.frames.length} {plural(preview.frames.length, 'кадр', 'кадра', 'кадров')}, {preview.chars}{' '}
                {plural(preview.chars, 'знак', 'знака', 'знаков')}
              </strong>
              <ul>
                {preview.frames.map((frame) => (
                  <li key={frame.id} style={{ paddingLeft: `${frame.depth * 14}px` }}>
                    {frame.title || '(без названия)'}
                    {frame.date ? ` · ${frame.date}` : ''} · {frame.chars}{' '}
                    {plural(frame.chars, 'знак', 'знака', 'знаков')}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      </div>
    </div>,
    document.body,
  )
}
