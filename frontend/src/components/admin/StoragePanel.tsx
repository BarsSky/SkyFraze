import { useCallback, useEffect, useState } from 'react'
import { localeOf, useT } from '../../i18n'
import { useLang } from '../../store/lang'

import {
  getStorageReport,
  recompressStorage,
  sweepStorage,
  type RecompressReport,
  type StorageReport,
} from '../../api/admin'
import { serverErrorMessage } from '../../api/client'
import { formatBytes } from '../../lib/format'

/**
 * Хранилище: сколько занимает база, что лежит в каталоге файлов и что с этим можно
 * сделать.
 *
 * Ручки отчёта, уборки и пережатия существовали и раньше, но пользоваться ими
 * приходилось через curl — то есть на практике никто не смотрел, кончается ли
 * место. Здесь три вещи, которые нужны от этого экрана:
 *
 *  1. **Видно, что занимает место** — база, снапшоты поимённо (самые тяжёлые),
 *     текст проекции, вложения; и расхождения каталога с базой (файлы без строк и
 *     строки без файлов).
 *  2. **Уборка** — удаление файлов без строк; безопасно (только старше суток), но
 *     кнопка отдельная и с подтверждением, потому что удаляет с диска.
 *  3. **Пережатие** — сначала сухой прогон (сколько даст), потом применение.
 *     Применение необратимо: оригиналы картинок не хранятся (это решение записано
 *     в docs/storage-compression.md), поэтому «применить» — вторая кнопка, а не
 *     галочка где-то рядом.
 *
 * Отчёт читается при открытии страницы: он только читает (обход каталога + запросы)
 * и на стенде занимает десятки миллисекунд; время обхода показано в самом отчёте,
 * чтобы это было видно, а не подразумевалось.
 */
export function StoragePanel() {
  const t = useT()
  const [lang] = useLang()
  const [report, setReport] = useState<StorageReport | null>(null)
  const [recompress, setRecompress] = useState<RecompressReport | null>(null)
  const [busy, setBusy] = useState<'load' | 'sweep' | 'dry' | 'apply' | null>('load')
  const [note, setNote] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async () => {
    setBusy('load')
    try {
      setReport(await getStorageReport())
      setError(null)
    } catch (e) {
      setError((await serverErrorMessage(e)) ?? t('sto.reportFailed'))
    } finally {
      setBusy(null)
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  async function onSweep() {
    if (!window.confirm(t('sto.confirmSweep'))) return
    setBusy('sweep')
    setNote(null)
    try {
      const after = await sweepStorage()
      setReport(after)
      setNote(
        after.removed_files > 0
          ? t('sto.swept', {
          count: after.removed_files,
          size: formatBytes(after.removed_bytes, lang),
          })
          : t('sto.sweptNothing'),
      )
      setError(null)
    } catch (e) {
      setError((await serverErrorMessage(e)) ?? t('sto.sweepFailed'))
    } finally {
      setBusy(null)
    }
  }

  async function onRecompress(apply: boolean) {
    if (apply && !window.confirm(t('sto.confirmRecompress'))) return
    setBusy(apply ? 'apply' : 'dry')
    setNote(null)
    try {
      const result = await recompressStorage(apply)
      setRecompress(result)
      setReport(await getStorageReport())
      setNote(
        apply
          ? t('sto.recompressed', {
          count: result.changed,
          from: formatBytes(result.bytes_from, lang),
          to: formatBytes(result.bytes_to, lang),
          })
          : result.changed > 0
            ? t('sto.canSave', {
            size: formatBytes(result.bytes_from - result.bytes_to, lang),
            count: result.changed,
            })
            : t('sto.nothingToRecompress'),
      )
      setError(null)
    } catch (e) {
      setError((await serverErrorMessage(e)) ?? t('sto.recompressFailed'))
    } finally {
      setBusy(null)
    }
  }

  return (
    <section className="card admin__storage">
      <div className="admin__storage-head">
        <h3 style={{ margin: 0 }}>{t('sto.title')}</h3>
        <button type="button" className="secondary" disabled={busy !== null} onClick={() => void load()}>
          {busy === 'load' ? t('sto.counting') : t('sto.refresh')}
        </button>
      </div>

      {error && <p className="error" role="alert">{error}</p>}
      {note && <p className="ed-panel__note ed-panel__note--upload" role="status">{note}</p>}

      {!report && !error && <p className="muted">{t('sto.sizes')}</p>}

      {report && (
        <>
          <div className="admin__storage-grid">
            <div>
              <span className="muted">{t('sto.db')}</span>
              <b>{formatBytes(report.database_bytes)}</b>
            </div>
            <div>
              <span className="muted">{t('sto.snapshots')}</span>
              <b>
                {formatBytes(report.snapshot_bytes)}
                <span className="muted"> · {report.snapshot_count}</span>
              </b>
            </div>
            <div>
              <span className="muted">{t('sto.projection')}</span>
              <b>
                {formatBytes(report.event_text_bytes)}
                <span className="muted"> · {report.event_rows}</span>
              </b>
            </div>
            <div>
              <span className="muted">{t('sto.attachments')}</span>
              <b>
                {formatBytes(report.asset_bytes)}
                <span className="muted"> · {report.asset_rows}</span>
              </b>
            </div>
            <div>
              <span className="muted">{t('sto.disk')}</span>
              <b>
                {formatBytes(report.file_bytes)}
                <span className="muted"> · {report.file_count}</span>
              </b>
            </div>
            <div>
              <span className="muted">{t('sto.projects')}</span>
              <b>{report.projects}</b>
            </div>
          </div>

          <p className="muted admin__storage-scan">
            {t('sto.scanLine', {
            ms: report.scan_ms,
            when: new Date(report.scanned_at).toLocaleString(localeOf(lang)),
            })}
          </p>

          {(report.orphan_files > 0 || report.pending_files > 0 || report.missing_files > 0) && (
            <div className="admin__storage-diff">
              {report.orphan_files > 0 && (
                <p>
                  <b>{report.orphan_files}</b>
                  {t('sto.orphans1')} {formatBytes(report.orphan_bytes, lang)}
                  {t('sto.orphans2')}
                </p>
              )}
              {report.pending_files > 0 && (
                <p className="muted">
                  {report.pending_files} {t('sto.pending')}
                </p>
              )}
              {report.missing_files > 0 && (
                <p className="error">
                  {report.missing_files} {t('sto.missing')}
                  {report.missing_examples?.[0] ? ` (${report.missing_examples[0].key})` : ''}
                </p>
              )}
            </div>
          )}

          {report.projects_usage && report.projects_usage.length > 0 && (
            <details className="admin__storage-more" open>
              <summary>{t('sto.projectsUsage', { count: report.projects_usage.length })}</summary>
              <ul>
                {report.projects_usage.map((p) => (
                  <li key={p.id}>
                    {/* Название — только у публичных проектов. У приватного его
                        заменяют владелец и короткий id: админу нужно понимать, с кем
                        говорить про уборку, а не что человек пишет. */}
                    {p.is_public && p.title ? (
                      <span>
                        {p.title} <span className="muted">{t('sto.public')}</span>
                      </span>
                    ) : (
                      <span title={p.id}>
                        {t('sto.privateProject')}{' '}
                        <span className="muted">
                        {p.owner_email || t('sto.unknownOwner')}
                        </span>
                      </span>
                    )}
                    {/* Вес по частям: вложения (их можно удалить) и снапшот (история
                        правок — техническая, пользователю о ней знать нечего). */}
                    <span className="muted">
                      {t('sto.projectSizes', {
                      assets: formatBytes(p.asset_bytes, lang),
                      snapshots: formatBytes(p.snapshot_bytes, lang),
                      total: formatBytes(p.asset_bytes + p.snapshot_bytes, lang),
                      })}{' '}
                      {formatBytes(p.asset_bytes + p.snapshot_bytes)}
                    </span>
                  </li>
                ))}
              </ul>
              <p className="muted admin__storage-note">
                {t('sto.privacyNote')}
              </p>
            </details>
          )}

          {report.tables.length > 0 && (
            <details className="admin__storage-more">
              <summary>{t('sto.tables')}</summary>
              <ul>
                {report.tables.slice(0, 12).map((t) => (
                  <li key={t.name}>
                    <span>{t.name}</span>
                    <span className="muted">{formatBytes(t.bytes)}</span>
                  </li>
                ))}
              </ul>
            </details>
          )}

          <div className="row admin__storage-actions">
            <button type="button" className="secondary" disabled={busy !== null} onClick={() => void onSweep()}>
              {busy === 'sweep' ? t('sto.sweeping') : t('sto.sweep')}
            </button>
            <button type="button" className="secondary" disabled={busy !== null} onClick={() => void onRecompress(false)}>
              {busy === 'dry' ? t('sto.counting') : t('sto.dryRun')}
            </button>
            {recompress && !recompress.applied && recompress.changed > 0 && (
              <button type="button" disabled={busy !== null} onClick={() => void onRecompress(true)}>
                {busy === 'apply' ? t('sto.applying') : t('sto.apply', { count: recompress.changed })}
              </button>
            )}
          </div>

          {recompress && (
            <p className="muted admin__storage-recompress">
              {t('sto.recompressLine', {
              files: recompress.files,
              images: recompress.images,
              changed: recompress.changed,
              skipped: recompress.skipped,
              damaged: recompress.damaged,
              failed: recompress.failed,
              })}
              {recompress.damaged_examples?.length
              ? t('sto.damagedExample', { name: recompress.damaged_examples[0] })
              : ''}
            </p>
          )}
        </>
      )}
    </section>
  )
}
