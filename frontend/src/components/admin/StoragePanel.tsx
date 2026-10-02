import { useCallback, useEffect, useState } from 'react'

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
      setError((await serverErrorMessage(e)) ?? 'Не удалось получить отчёт о хранилище.')
    } finally {
      setBusy(null)
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  async function onSweep() {
    if (!window.confirm('Удалить файлы, на которые нет строк в базе (старше суток)?')) return
    setBusy('sweep')
    setNote(null)
    try {
      const after = await sweepStorage()
      setReport(after)
      setNote(
        after.removed_files > 0
          ? `Убрано ${after.removed_files} файлов на ${formatBytes(after.removed_bytes)}`
          : 'Лишних файлов не нашлось',
      )
      setError(null)
    } catch (e) {
      setError((await serverErrorMessage(e)) ?? 'Уборка не удалась.')
    } finally {
      setBusy(null)
    }
  }

  async function onRecompress(apply: boolean) {
    if (apply && !window.confirm('Пережать картинки? Оригиналы не сохраняются — вернуть их будет нельзя.')) return
    setBusy(apply ? 'apply' : 'dry')
    setNote(null)
    try {
      const result = await recompressStorage(apply)
      setRecompress(result)
      setReport(await getStorageReport())
      setNote(
        apply
          ? `Пережато ${result.changed} файлов: ${formatBytes(result.bytes_from)} → ${formatBytes(result.bytes_to)}`
          : result.changed > 0
            ? `Можно сэкономить ${formatBytes(result.bytes_from - result.bytes_to)} на ${result.changed} файлах`
            : 'Пережимать нечего',
      )
      setError(null)
    } catch (e) {
      setError((await serverErrorMessage(e)) ?? 'Пережатие не удалось.')
    } finally {
      setBusy(null)
    }
  }

  return (
    <section className="card admin__storage">
      <div className="admin__storage-head">
        <h3 style={{ margin: 0 }}>Хранилище</h3>
        <button type="button" className="secondary" disabled={busy !== null} onClick={() => void load()}>
          {busy === 'load' ? 'Считаю…' : 'Обновить отчёт'}
        </button>
      </div>

      {error && <p className="error" role="alert">{error}</p>}
      {note && <p className="ed-panel__note ed-panel__note--upload" role="status">{note}</p>}

      {!report && !error && <p className="muted">Считаю размеры…</p>}

      {report && (
        <>
          <div className="admin__storage-grid">
            <div>
              <span className="muted">База</span>
              <b>{formatBytes(report.database_bytes)}</b>
            </div>
            <div>
              <span className="muted">Снапшоты</span>
              <b>
                {formatBytes(report.snapshot_bytes)}
                <span className="muted"> · {report.snapshot_count}</span>
              </b>
            </div>
            <div>
              <span className="muted">Текст проекции</span>
              <b>
                {formatBytes(report.event_text_bytes)}
                <span className="muted"> · {report.event_rows}</span>
              </b>
            </div>
            <div>
              <span className="muted">Вложения</span>
              <b>
                {formatBytes(report.asset_bytes)}
                <span className="muted"> · {report.asset_rows}</span>
              </b>
            </div>
            <div>
              <span className="muted">Файлы на диске</span>
              <b>
                {formatBytes(report.file_bytes)}
                <span className="muted"> · {report.file_count}</span>
              </b>
            </div>
            <div>
              <span className="muted">Проектов</span>
              <b>{report.projects}</b>
            </div>
          </div>

          <p className="muted admin__storage-scan">
            обход каталога: {report.scan_ms} мс · отчёт снят {new Date(report.scanned_at).toLocaleString('ru-RU')}
          </p>

          {(report.orphan_files > 0 || report.pending_files > 0 || report.missing_files > 0) && (
            <div className="admin__storage-diff">
              {report.orphan_files > 0 && (
                <p>
                  <b>{report.orphan_files}</b> файлов без строк в базе на {formatBytes(report.orphan_bytes)} — их
                  снимет уборка
                </p>
              )}
              {report.pending_files > 0 && (
                <p className="muted">
                  {report.pending_files} свежих файлов без строк — их не трогаем: так выглядит идущий импорт
                </p>
              )}
              {report.missing_files > 0 && (
                <p className="error">
                  {report.missing_files} строк без файла: содержимое проекта, о нём только сообщаем
                  {report.missing_examples?.[0] ? ` (${report.missing_examples[0].key})` : ''}
                </p>
              )}
            </div>
          )}

          {report.projects_usage && report.projects_usage.length > 0 && (
            <details className="admin__storage-more" open>
              <summary>Проекты и их вес ({report.projects_usage.length})</summary>
              <ul>
                {report.projects_usage.map((p) => (
                  <li key={p.id}>
                    {/* Название — только у публичных проектов. У приватного его
                        заменяют владелец и короткий id: админу нужно понимать, с кем
                        говорить про уборку, а не что человек пишет. */}
                    {p.is_public && p.title ? (
                      <span>
                        {p.title} <span className="muted">публичный</span>
                      </span>
                    ) : (
                      <span title={p.id}>
                        приватный проект <span className="muted">{p.owner_email || 'владелец неизвестен'}</span>
                      </span>
                    )}
                    {/* Вес по частям: вложения (их можно удалить) и снапшот (история
                        правок — техническая, пользователю о ней знать нечего). */}
                    <span className="muted">
                      файлы {formatBytes(p.asset_bytes)} · история {formatBytes(p.snapshot_bytes)} · всего{' '}
                      {formatBytes(p.asset_bytes + p.snapshot_bytes)}
                    </span>
                  </li>
                ))}
              </ul>
              <p className="muted admin__storage-note">
                Видны вес, владелец и названия только опубликованных проектов. Название приватного проекта — тоже
                содержимое: администратор отвечает за инсталляцию, а не за истории.
              </p>
            </details>
          )}

          {report.tables.length > 0 && (
            <details className="admin__storage-more">
              <summary>Таблицы базы</summary>
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
              {busy === 'sweep' ? 'Убираю…' : 'Убрать лишние файлы'}
            </button>
            <button type="button" className="secondary" disabled={busy !== null} onClick={() => void onRecompress(false)}>
              {busy === 'dry' ? 'Считаю…' : 'Пережать картинки: посчитать'}
            </button>
            {recompress && !recompress.applied && recompress.changed > 0 && (
              <button type="button" disabled={busy !== null} onClick={() => void onRecompress(true)}>
                {busy === 'apply' ? 'Пережимаю…' : `Пережать ${recompress.changed} файлов`}
              </button>
            )}
          </div>

          {recompress && (
            <p className="muted admin__storage-recompress">
              просмотрено файлов: {recompress.files} · картинок: {recompress.images} · пережато:{' '}
              {recompress.changed} · без выигрыша: {recompress.skipped} · не разобралось: {recompress.damaged} ·
              ошибок: {recompress.failed}
              {recompress.damaged_examples?.length ? ` (например, ${recompress.damaged_examples[0]})` : ''}
            </p>
          )}
        </>
      )}
    </section>
  )
}
