import { useEffect, useRef, useState, type ChangeEvent } from 'react'
import { createPortal } from 'react-dom'
import {
  importMarkdownFolder,
  previewMarkdownImport,
  readImportErrorMessage,
  type MarkdownImportPreview,
  type MarkdownImportSource,
} from '../api/storyFiles'
import { ErrorBanner } from './ErrorBanner'
import { localeOf, pluralWord, tStatic, useT } from '../i18n'
import { useLang } from '../store/lang'
import { importWeight } from '../lib/importWeight'
import { DIRECTORY_PICK } from '../lib/directoryPick'

interface Props {
  onClose: () => void
  /** Проект создан — страница открывает его (импорт всегда создаёт новый). */
  onCreated: (projectId: string) => void
}

type Busy = 'preview' | 'create' | null

interface Failure {
  error: unknown
  /** Повторить упавший шаг — кнопка появится только у временных сбоев. */
  retry?: () => void
}

/**
 * Импорт папки с md-файлами в новый проект.
 *
 * Окно нарочно двухшаговое: сначала сервер разбирает файлы и отдаёт дерево со
 * знаками и предупреждениями, и только по кнопке «Создать проект» появляется
 * проект. Так видно, что правила разбора (каталог = уровень, префикс = номер)
 * поняли файлы правильно, — до записи в базу, а не после.
 *
 * Внутри окна ничего не предугадывается: заголовок, дерево, статистика и
 * предупреждения — это ответ сервера. Ошибка сервера показывается плашкой, и
 * проект при этом не создаётся.
 */
export function ImportFolderModal({ onClose, onCreated }: Props) {
  const t = useT()
  const [lang] = useLang()
  const [selection, setSelection] = useState<MarkdownImportSource | null>(null)
  /** Что именно выбрал человек: окно должно называть папку или архив словами. */
  const [selectionLabel, setSelectionLabel] = useState('')
  const [preview, setPreview] = useState<MarkdownImportPreview | null>(null)
  const [title, setTitle] = useState('')
  const [busy, setBusy] = useState<Busy>(null)
  const [failure, setFailure] = useState<Failure | null>(null)

  const restoreFocus = useRef<HTMLElement | null>(null)
  const closeRef = useRef<HTMLButtonElement>(null)
  const creating = busy === 'create'

  // Фокус уходит в окно, страница под ним не прокручивается (класс общий с
  // просмотром картинок: html.sf-viewer-open запрещает прокрутку).
  useEffect(() => {
    restoreFocus.current = document.activeElement instanceof HTMLElement ? document.activeElement : null
    document.documentElement.classList.add('sf-viewer-open')
    closeRef.current?.focus()
    return () => {
      document.documentElement.classList.remove('sf-viewer-open')
      restoreFocus.current?.focus?.()
    }
  }, [])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      e.stopPropagation()
      // Пока проект создаётся, окно не закрываем: иначе потеряется ответ с его id.
      if (!creating) onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [creating, onClose])

  /** Предпросмотр: сервер ничего не пишет, поэтому его можно звать сколько угодно. */
  async function runPreview(source: MarkdownImportSource, label: string) {
    setSelection(source)
    setSelectionLabel(label)
    setPreview(null)
    setFailure(null)
    setBusy('preview')
    try {
      const data = await previewMarkdownImport(source)
      setPreview(data)
      setTitle(data.projectTitle)
    } catch (e) {
      setFailure(await describeImportFailure(e, () => void runPreview(source, label)))
    } finally {
      setBusy(null)
    }
  }

  function onPickFolder(e: ChangeEvent<HTMLInputElement>) {
    const files = Array.from(e.target.files ?? [])
    // Значение поля сбрасываем: иначе повторный выбор той же папки не вызовет change.
    e.target.value = ''
    if (files.length === 0) return
    const root = files[0].webkitRelativePath.split('/')[0]
    const count = `${files.length} ${pluralWord(lang, 'ed.unit.file', files.length)}`
    void runPreview(
      files,
      root && root !== files[0].name ? t('imp.folderLabel', { root, count }) : count,
    )
  }

  function onPickZip(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    e.target.value = ''
    if (!file) return
    void runPreview({ archive: file }, t('imp.archiveLabel', { name: file.name }))
  }

  async function onConfirm() {
    if (!selection || !preview) return
    setBusy('create')
    setFailure(null)
    try {
      const result = await importMarkdownFolder(selection, title)
      if (!result.projectId) throw new Error(t('imp.noProjectId'))
      onCreated(result.projectId)
    } catch (e) {
      setFailure(await describeImportFailure(e, () => void onConfirm()))
    } finally {
      setBusy(null)
    }
  }

  const stats = preview?.stats
  const nothingToCreate = preview !== null && preview.events.length === 0
  // Импорт создаёт НОВЫЙ проект, поэтому занятого места нет: сравниваем вес набора
  // только с пределом (его присылает сервер вместе с предпросмотром).
  const weight = preview ? importWeight(preview.stats, preview.quotaBytes, 0, lang) : null

  return createPortal(
    <div className="sf-import" role="dialog" aria-modal="true" aria-label={t('imp.dialogAria')}>
      <div className="sf-import__window">
        <div className="sf-import__head">
          <div className="sf-import__titles">
            <strong>{t('imp.title')}</strong>
            <span className="muted">{t('imp.subtitle')}</span>
          </div>
          <button
            ref={closeRef}
            type="button"
            className="secondary"
            onClick={onClose}
            disabled={creating}
            aria-label={t('imp.closeAria')}
          >
            {t('imp.close')}
          </button>
        </div>

        <div className="sf-import__body">
          <div className="sf-import__intro">
            {/* Правило разбора — первой строкой: от него зависит, что станет
                главой, и сюрпризов тут быть не должно. */}
            <p className="sf-import__hint sf-import__rule">
              {t('imp.hint1')}
            </p>
            <p className="muted sf-import__hint">
              {t('imp.hint2')}
            </p>
          </div>

          <div className="sf-import__ways">
            <label className={`sf-import__way${busy ? ' is-busy' : ''}`}>
              <input
                type="file"
                multiple
                disabled={busy !== null}
                onChange={onPickFolder}
                {...DIRECTORY_PICK}
              />
              <b>{t('imp.pickFolder')}</b>
              <span className="muted">{t('imp.pickFolderHint')}</span>
            </label>
            <label className={`sf-import__way${busy ? ' is-busy' : ''}`}>
              <input
                type="file"
                accept=".zip,application/zip"
                disabled={busy !== null}
                onChange={onPickZip}
              />
              <b>{t('imp.pickZip')}</b>
              <span className="muted">{t('imp.pickZipHint')}</span>
            </label>
          </div>

          {busy === 'preview' && (
            <p className="muted sf-import__status" role="status">{t('imp.parsing')}</p>
          )}

          {failure && (
            <ErrorBanner
              error={failure.error}
              subject="import"
              onRetry={failure.retry}
              actions={
                <button type="button" className="secondary" onClick={() => setFailure(null)}>
                  {t('imp.gotIt')}
                </button>
              }
            />
          )}

          {preview && (
            <>
              <p className="muted sf-import__chosen">{t('imp.chosen', { label: selectionLabel })}</p>

              <label className="sf-import__title">
                {t('imp.projectName')}
                <input
                  value={title}
                  placeholder={preview.projectTitle || t('imp.projectNamePlaceholder')}
                  onChange={(e) => setTitle(e.target.value)}
                />
              </label>

              {stats && (
                <div className="sf-import__stats" data-import-stats>
                  <span className="sf-import__stat">
                    <b>{stats.files}</b> {pluralWord(lang, 'ed.unit.file', stats.files)}
                  </span>
                  <span className="sf-import__stat">
                    <b>{stats.events}</b> {pluralWord(lang, 'ed.unit.event', stats.events)}
                  </span>
                  <span className="sf-import__stat">
                    <b>{stats.chars.toLocaleString(localeOf(lang))}</b>{' '}
                    {pluralWord(lang, 'ver.unit.char', stats.chars)}
                  </span>
                  <span className="sf-import__stat">
                    <b>{stats.imageLinks}</b>{' '}
                    {pluralWord(lang, 'imp.unit.imageLink', stats.imageLinks)}
                  </span>
                  {/* Вложения — не «сколько нашлось картинок», а сколько файлов
                      станут вложениями проекта: это то, что человек увидит в кадре. */}
                  <span className="sf-import__stat">
                    <b>{stats.attachments}</b>{' '}
                    {pluralWord(lang, 'ed.unit.attachment', stats.attachments)}
                  </span>
                  {/* Вес вложений: импорт подчиняется пределу проекта, и узнать об
                      этом лучше здесь, а не из отказа при создании. */}
                  {weight && <span className="sf-import__stat">{weight.text}</span>}
                </div>
              )}

              {weight?.warning && (
                <p className="sf-import__quota" role="status" data-import-quota>
                  {weight.warning}
                </p>
              )}

              {preview.warnings.length > 0 && (
                <div className="sf-import__warnings" role="note">
                  <b>{t('imp.noticed')}</b>
                  <ul className="sf-import__warning-list">
                    {preview.warnings.map((warning, index) => (
                      <li key={`${warning}-${index}`} className="sf-import__warning">{warning}</li>
                    ))}
                  </ul>
                </div>
              )}

              <div className="sf-import__section">
                <div className="sf-import__section-head">
                  <b>{t('imp.tree')}</b>
                  <span className="muted">{t('imp.treeHint')}</span>
                </div>
                {nothingToCreate ? (
                  <p className="muted sf-import__empty">
                    {t('imp.noEvents')}
                    {t('imp.noEventsHint')}
                  </p>
                ) : (
                  // Список с внутренней прокруткой: в папке бывает под тысячу файлов,
                  // и растягивать окно на них нельзя.
                  <ol className="sf-import__tree" data-import-tree>
                    {preview.events.map((event, index) => (
                      <li
                        key={`${event.path || event.number}-${index}`}
                        className="sf-import__node"
                        style={{ paddingLeft: 12 + Math.min(event.depth, 4) * 14 }}
                      >
                        <span className="sf-import__number">{event.number || '—'}</span>
                        <span className="sf-import__node-title">
                          {event.title || <em>{t('imp.untitledEvent')}</em>}
                        </span>
                        <span className="muted sf-import__chars">{t('imp.charsShort', { count: event.chars })}</span>
                        {event.warnings.length > 0 && (
                          <span className="sf-import__node-note">⚠ {event.warnings.join('; ')}</span>
                        )}
                      </li>
                    ))}
                  </ol>
                )}
              </div>
            </>
          )}
        </div>

        <div className="sf-import__foot">
          <span className="muted sf-import__foot-note">
            {t('imp.newProjectNote')}
          </span>
          <div className="row" style={{ gap: 8 }}>
            <button type="button" className="secondary" onClick={onClose} disabled={creating}>
              {t('imp.cancel')}
            </button>
            <button
              type="button"
              disabled={!preview || nothingToCreate || busy !== null}
              onClick={() => void onConfirm()}
            >
              {busy === 'create' ? t('imp.creating') : t('imp.create')}
            </button>
          </div>
        </div>
      </div>
    </div>,
    document.body,
  )
}

/** Ошибку импорта объясняем словами сервера: 400 у него содержательный. */
async function describeImportFailure(error: unknown, retry: () => void): Promise<Failure> {
  const message = await readImportErrorMessage(error)
  return { error: message ? new Error(message) : error, retry }
}
