import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  createAIKnowledge,
  deleteAIKnowledge,
  getAIKnowledge,
  getAISettings,
  listAIKnowledge,
  listAIKnowledgeTags,
  setAIRetention,
  updateAIKnowledge,
  type AIKnowledge,
  type AIKnowledgeBrief,
  type AIKnowledgeTag,
  type AISettings,
} from '../../api/assistant'
import { serverErrorMessage } from '../../api/client'
import { MarkdownBlock } from '../MarkdownBlock'
import { formatDate, formatNumber } from '../../i18n/format'
import { useT } from '../../i18n'
import { useLang } from '../../store/lang'

/**
 * Вкладка «Знания» (0.149.0).
 *
 * Зачем отдельная вкладка, а не блок в переписке. Знание — это то, что остаётся ПОСЛЕ
 * беседы: его ищут, листают и открывают заново, когда разговор уже удалён по сроку
 * хранения. В переписке его пришлось бы искать прокруткой до прошлой недели.
 *
 * Здесь же живёт срок хранения бесед: автоочистка безопасна ровно потому, что нужное
 * можно сохранить в знание, и две эти вещи должны стоять рядом — иначе человек включит
 * удаление, не увидев, куда девать выводы.
 *
 * Предел знака (KNOWLEDGE_MAX_CHARS) совпадает с серверным: счётчик и отказ должны
 * говорить одно и то же, иначе форма «сохранила» бы то, что сервер не примет.
 */
export const KNOWLEDGE_MAX_CHARS = 4000

/** Варианты срока хранения: 0 — не удалять. Чаще недели и реже года — уже не срок, а режим. */
const RETENTION_OPTIONS = [0, 7, 30, 90, 180, 365] as const

interface Props {
  projectId: string
  /** Открыта ли вкладка: первый запрос списка делаем только когда её видно. */
  visible: boolean
}

interface Draft {
  id: string | null
  title: string
  summary: string
  body: string
  /** Метки одной строкой через запятую (0.152.0): пять отдельных полей — это форма, а не ввод. */
  tags: string
}

const EMPTY_DRAFT: Draft = { id: null, title: '', summary: '', body: '', tags: '' }

/** Метки из строки: по запятой или пробелу. Сервер всё равно нормализует и ограничит пятью. */
function parseTags(text: string): string[] {
  return text
    .split(/[,;\n]+/)
    .map((tag) => tag.trim())
    .filter((tag) => tag !== '')
}

export function KnowledgeTab({ projectId, visible }: Props) {
  const t = useT()
  const [lang] = useLang()
  const [items, setItems] = useState<AIKnowledgeBrief[]>([])
  /** Метки проекта для автодополнения (0.153.0): единый словарь внутри проекта. */
  const [tagOptions, setTagOptions] = useState<AIKnowledgeTag[]>([])
  const [query, setQuery] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [settings, setSettings] = useState<AISettings | null>(null)
  const [retentionBusy, setRetentionBusy] = useState(false)
  const [draft, setDraft] = useState<Draft | null>(null)
  const [saving, setSaving] = useState(false)
  const [viewing, setViewing] = useState<AIKnowledge | null>(null)
  const [viewBusy, setViewBusy] = useState(false)
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null)
  const [deleting, setDeleting] = useState<string | null>(null)
  const [loaded, setLoaded] = useState(false)
  const searchRef = useRef<HTMLInputElement | null>(null)

  const load = useCallback(
    async (text: string) => {
      setLoading(true)
      setError(null)
      try {
        const list = await listAIKnowledge(projectId, text)
        setItems(list)
        setLoaded(true)
        // Метки проекта — для подсказки в форме (0.153.0). Ошибку не показываем: без
        // подсказок форма работает, это удобство, а не данные.
        void listAIKnowledgeTags(projectId)
          .then(setTagOptions)
          .catch(() => undefined)
      } catch (e) {
        setError((await serverErrorMessage(e)) ?? t('kn.errLoad'))
      } finally {
        setLoading(false)
      }
    },
    // t в зависимостях не нужен: перевод ошибки не меняет смысл загрузки.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [projectId],
  )

  // Первая загрузка — когда вкладку открыли впервые и роль уже известна. Список знаний
  // проекта маленький, но тянуть его при каждом открытии окна помощника незачем: это ещё
  // один запрос на старте. Читателю проекта (viewer) знания не грузим вовсе.
  useEffect(() => {
    if (!visible || loaded || settings === null || settings.canUseKnowledge === false) return
    void load('')
  }, [visible, loaded, load, settings])

  // Настройки нужны ради одного: может ли этот человек менять срок хранения. Тянем один раз.
  useEffect(() => {
    if (!visible || settings) return
    void getAISettings(projectId)
      .then(setSettings)
      .catch(() => setSettings(null))
  }, [visible, settings, projectId])

  const onSearch = useCallback(
    (value: string) => {
      setQuery(value)
      void load(value)
    },
    [load],
  )

  const openItem = useCallback(async (item: AIKnowledgeBrief) => {
    setViewBusy(true)
    setError(null)
    try {
      setViewing(await getAIKnowledge(projectId, item.id))
    } catch (e) {
      setError((await serverErrorMessage(e)) ?? t('kn.errLoad'))
    } finally {
      setViewBusy(false)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId])

  const startEdit = useCallback((item: AIKnowledge) => {
    setViewing(null)
    setDraft({
      id: item.id,
      title: item.title,
      summary: item.summary,
      body: item.body,
      tags: item.tags.join(', '),
    })
  }, [])

  const save = useCallback(async () => {
    if (!draft) return
    const title = draft.title.trim()
    const body = draft.body.trim()
    if (title === '' || body === '') {
      setError(t('kn.errEmpty'))
      return
    }
    setSaving(true)
    setError(null)
    try {
      if (draft.id) {
        await updateAIKnowledge(projectId, draft.id, {
          title,
          summary: draft.summary,
          body,
          tags: parseTags(draft.tags),
        })
      } else {
        await createAIKnowledge(projectId, {
          title,
          summary: draft.summary,
          body,
          tags: parseTags(draft.tags),
        })
      }
      setDraft(null)
      await load(query)
    } catch (e) {
      setError((await serverErrorMessage(e)) ?? t('kn.errSave'))
    } finally {
      setSaving(false)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draft, projectId, query, load])

  const remove = useCallback(
    async (id: string) => {
      setDeleting(id)
      setError(null)
      try {
        await deleteAIKnowledge(projectId, id)
        if (viewing?.id === id) setViewing(null)
        setConfirmDelete(null)
        await load(query)
      } catch (e) {
        setError((await serverErrorMessage(e)) ?? t('kn.errDelete'))
      } finally {
        setDeleting(null)
      }
      // eslint-disable-next-line react-hooks/exhaustive-deps
    },
    [projectId, query, load, viewing],
  )

  const changeRetention = useCallback(
    async (days: number) => {
      setRetentionBusy(true)
      setError(null)
      try {
        setSettings(await setAIRetention(projectId, days))
      } catch (e) {
        setError((await serverErrorMessage(e)) ?? t('kn.errRetention'))
      } finally {
        setRetentionBusy(false)
      }
      // eslint-disable-next-line react-hooks/exhaustive-deps
    },
    [projectId],
  )

  const retention = settings?.retentionDays ?? 0
  const canEditRetention = settings?.canEdit === true
  // Знания — черновые исследования соавторов (0.150.0): читатель проекта их не видит.
  // Пока настройки не пришли, не показываем ни списка, ни ошибки: иначе вкладка мигала
  // бы отказом на каждом открытии.
  const canUseKnowledge = settings?.canUseKnowledge !== false
  const knowledgeAllowed = settings === null || canUseKnowledge
  const bodyChars = draft ? draft.body.trim().length : 0
  const tooLong = bodyChars > KNOWLEDGE_MAX_CHARS

  const retentionWarning = useMemo(() => {
    if (retention <= 0 || !settings) return ''
    if (settings.retentionDue > 0) {
      return t('kn.retentionDue', {
        due: formatNumber(settings.retentionDue, lang),
        days: formatNumber(retention, lang),
      })
    }
    return t('kn.retentionNext', {
      days: formatNumber(settings.retentionNextDays, lang),
    })
  }, [retention, settings, lang, t])

  const retentionLabel = useMemo(() => {
    if (retention === 0) return t('kn.retentionOff')
    return t('kn.retentionDays', { days: formatNumber(retention, lang) })
  }, [retention, lang, t])

  return (
    <div className="knowledge" data-knowledge-tab>
      {/* Знания — черновые исследования соавторов (0.150.0). Читателю проекта здесь нечего
          делать: он видит опубликованное, а не рабочие заметки. */}
      {!knowledgeAllowed ? (
        <p className="ai-note ai-note--padded" data-knowledge-viewer-note>
          {t('kn.viewerNote')}
        </p>
      ) : (
        <>
          <div className="knowledge__head">
        <input
          ref={searchRef}
          type="search"
          className="knowledge__search"
          value={query}
          onChange={(e) => onSearch(e.target.value)}
          placeholder={t('kn.searchPlaceholder')}
          aria-label={t('kn.search')}
          data-knowledge-search
        />
        <button
          type="button"
          className="secondary"
          onClick={() => {
            setViewing(null)
            setDraft(EMPTY_DRAFT)
          }}
          data-knowledge-create
        >
          {t('kn.create')}
        </button>
      </div>

      {/* Срок хранения — рядом со знаниями: автоочистка безопасна, только когда видно,
          куда сохранять выводы. */}
      <div className="knowledge__retention" data-knowledge-retention-row>
        <label className="knowledge__retention-label">
          <span>{t('kn.retention')}</span>
          <select
            value={String(retention)}
            disabled={!canEditRetention || retentionBusy}
            onChange={(e) => void changeRetention(Number(e.target.value))}
            aria-label={t('kn.retention')}
            data-knowledge-retention
          >
            {RETENTION_OPTIONS.map((days) => (
              <option key={days} value={String(days)}>
                {days === 0
                  ? t('kn.retentionOff')
                  : t('kn.retentionDays', { days: formatNumber(days, lang) })}
              </option>
            ))}
            {!RETENTION_OPTIONS.includes(retention as (typeof RETENTION_OPTIONS)[number]) && (
              <option value={String(retention)}>{retentionLabel}</option>
            )}
          </select>
        </label>
        <span className="knowledge__hint">
          {canEditRetention ? t('kn.retentionHint') : t('kn.retentionOwner')}
        </span>
        {/* Предупреждение автоочистки (0.150.0): «включил срок — удалилось молча» выглядит
            как потеря данных. Показываем, сколько бесед уже за пределами срока. */}
        {retentionWarning !== '' && (
          <span className="knowledge__warning" data-knowledge-retention-warning>
            {retentionWarning}
          </span>
        )}
      </div>

      {error != null && (
        <p className="ai-error ai-error--padded" data-knowledge-error>
          {error}
        </p>
      )}

      {/* Форма: и создание, и правка. Одна форма на два случая — поля одни и те же, а
          две формы разошлись бы в проверках. */}
      {draft != null && (
        <form
          className="knowledge__form"
          data-knowledge-form
          onSubmit={(e) => {
            e.preventDefault()
            void save()
          }}
        >
          <input
            value={draft.title}
            onChange={(e) => setDraft({ ...draft, title: e.target.value })}
            placeholder={t('kn.titlePlaceholder')}
            aria-label={t('kn.titleField')}
            maxLength={120}
            data-knowledge-title
          />
          <input
            value={draft.summary}
            onChange={(e) => setDraft({ ...draft, summary: e.target.value })}
            placeholder={t('kn.summaryPlaceholder')}
            aria-label={t('kn.summaryField')}
            maxLength={400}
            data-knowledge-summary
          />
          <input
            value={draft.tags}
            onChange={(e) => setDraft({ ...draft, tags: e.target.value })}
            placeholder={t('kn.tagsPlaceholder')}
            aria-label={t('kn.tagsField')}
            list="knowledge-tag-options"
            data-knowledge-tags
          />
          {/* Подсказка из меток проекта: единый словарь вместо «канон/Канон/каноны». */}
          <datalist id="knowledge-tag-options" data-knowledge-tag-options>
            {tagOptions.map((option) => (
              <option key={option.tag} value={option.tag}>
                {option.count}
              </option>
            ))}
          </datalist>
          <textarea
            value={draft.body}
            onChange={(e) => setDraft({ ...draft, body: e.target.value })}
            placeholder={t('kn.bodyPlaceholder')}
            aria-label={t('kn.bodyField')}
            rows={6}
            data-knowledge-body
          />
          <div className="knowledge__form-foot">
            <span
              className={tooLong ? 'knowledge__counter is-over' : 'knowledge__counter'}
              data-knowledge-counter
            >
              {formatNumber(bodyChars, lang)} / {formatNumber(KNOWLEDGE_MAX_CHARS, lang)}
            </span>
            <button type="submit" disabled={saving || tooLong} data-knowledge-save>
              {saving ? t('kn.saving') : t('kn.save')}
            </button>
            <button type="button" className="secondary" onClick={() => setDraft(null)}>
              {t('kn.cancel')}
            </button>
          </div>
        </form>
      )}

      {/* Открытое знание: тело целиком. Читаем отдельным запросом — список тел не отдаёт. */}
      {viewing != null && (
        <article className="knowledge__view" data-knowledge-view>
          <h3 className="knowledge__view-title">{viewing.title}</h3>
          {viewing.summary !== '' && <p className="knowledge__view-summary">{viewing.summary}</p>}
          {(viewing.tags ?? []).length > 0 && (
            <div className="knowledge__tags" data-knowledge-view-tags>
              {(viewing.tags ?? []).map((tag) => (
                <span className="knowledge__tag" key={tag}>
                  {tag}
                </span>
              ))}
            </div>
          )}
          <MarkdownBlock source={viewing.body} className="knowledge__view-body" />
          <div className="knowledge__view-foot">
            <span className="knowledge__meta">
              {t('kn.meta', {
                chars: formatNumber(viewing.chars, lang),
                date: formatDate(viewing.createdAt, lang),
              })}
            </span>
            <button type="button" className="secondary" onClick={() => setViewing(null)}>
              {t('kn.close')}
            </button>
            <button type="button" className="secondary" onClick={() => startEdit(viewing)}>
              {t('kn.edit')}
            </button>
            <button
              type="button"
              className="secondary"
              disabled={deleting === viewing.id}
              onClick={() => void remove(viewing.id)}
            >
              {deleting === viewing.id ? t('kn.deleting') : t('kn.delete')}
            </button>
          </div>
        </article>
      )}

      {loading && <p className="ai-note ai-note--padded">{t('kn.loading')}</p>}
      {!loading && items.length === 0 && (
        <p className="ai-note ai-note--padded" data-knowledge-empty>
          {query.trim() === '' ? t('kn.empty') : t('kn.emptySearch')}
        </p>
      )}

      {items.length > 0 && (
        <ul className="knowledge__list" data-knowledge-list>
          {items.map((item) => (
            <li key={item.id} className="knowledge__item" data-knowledge-item={item.id}>
              <button
                type="button"
                className="knowledge__open"
                onClick={() => void openItem(item)}
                disabled={viewBusy}
              >
                {item.title || t('kn.untitled')}
              </button>
              {item.summary !== '' && <p className="knowledge__summary">{item.summary}</p>}
              {(item.tags ?? []).length > 0 && (
                <div className="knowledge__tags" data-knowledge-item-tags={item.id}>
                  {(item.tags ?? []).map((tag) => (
                    <span className="knowledge__tag" key={tag}>
                      {tag}
                    </span>
                  ))}
                </div>
              )}
              <span className="knowledge__meta">
                {t('kn.metaAuthor', {
                  chars: formatNumber(item.chars, lang),
                  date: formatDate(item.createdAt, lang),
                  author: item.authorName || t('kn.anonymous'),
                })}
              </span>
              <span className="knowledge__actions">
                <button
                  type="button"
                  className="secondary"
                  onClick={() => void openItem(item)}
                  disabled={viewBusy}
                >
                  {t('kn.open')}
                </button>
                {/* Удаление — в два нажатия: знание может быть единственной записью
                    решения, принятого месяц назад, и восстановить его будет нечем. */}
                <button
                  type="button"
                  className="secondary"
                  disabled={deleting === item.id}
                  onClick={() => {
                    if (confirmDelete === item.id) void remove(item.id)
                    else setConfirmDelete(item.id)
                  }}
                  data-knowledge-delete={item.id}
                >
                  {deleting === item.id
                    ? t('kn.deleting')
                    : confirmDelete === item.id
                      ? t('kn.deleteConfirm')
                      : t('kn.delete')}
                </button>
              </span>
            </li>
          ))}
            </ul>
          )}
        </>
      )}
    </div>
  )
}
