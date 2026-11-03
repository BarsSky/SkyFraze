import { useCallback, useEffect, useState } from 'react'
import {
  listAIKnowledge,
  type AIKnowledgeBrief,
} from '../../api/assistant'
import { serverErrorMessage } from '../../api/client'
import { formatDate } from '../../i18n/format'
import { useT } from '../../i18n'
import { useLang } from '../../store/lang'

/**
 * Выбор знаний, которые прикладываются к сообщению (0.149.0).
 *
 * Почему модальное окно поверх чата, а не список прямо в поле ввода. Знаний у живого
 * проекта десятки, и развёрнутый список съел бы поле вопроса целиком — на телефоне от
 * него не осталось бы ничего. Здесь есть поиск, отметки и явная кнопка «Приложить».
 *
 * Предел — 10 знаний на один вопрос: сервер режет по этому же числу, и отказ должен
 * приходить до отправки, а не после.
 */
export const MAX_KNOWLEDGE_ATTACH = 10

interface Props {
  projectId: string
  open: boolean
  onClose: () => void
  /** Уже приложенные знания: их отметки должны быть на месте, чтобы человек видел состав. */
  selected: AIKnowledgeBrief[]
  onConfirm: (items: AIKnowledgeBrief[]) => void
}

export function KnowledgePicker({ projectId, open, onClose, selected, onConfirm }: Props) {
  const t = useT()
  const [lang] = useLang()
  const [items, setItems] = useState<AIKnowledgeBrief[]>([])
  const [query, setQuery] = useState('')
  const [picked, setPicked] = useState<Record<string, AIKnowledgeBrief>>({})
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)

  // Открыли — читаем список и восстанавливаем отметки из уже приложенных.
  useEffect(() => {
    if (!open) return
    setPicked(Object.fromEntries(selected.map((item) => [item.id, item])))
    setError(null)
    setLoading(true)
    void listAIKnowledge(projectId)
      .then(setItems)
      .catch(async (e) => setError((await serverErrorMessage(e)) ?? t('kn.errLoad')))
      .finally(() => setLoading(false))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, projectId])

  // Esc закрывает: это окно поверх окна, и без клавиши человек в нём застревает.
  useEffect(() => {
    if (!open) return undefined
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, onClose])

  const search = useCallback(
    async (value: string) => {
      setQuery(value)
      setLoading(true)
      try {
        setItems(await listAIKnowledge(projectId, value))
      } catch (e) {
        setError((await serverErrorMessage(e)) ?? t('kn.errLoad'))
      } finally {
        setLoading(false)
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [projectId],
  )

  const toggle = useCallback((item: AIKnowledgeBrief) => {
    setPicked((current) => {
      if (current[item.id]) {
        const next = { ...current }
        delete next[item.id]
        return next
      }
      if (Object.keys(current).length >= MAX_KNOWLEDGE_ATTACH) return current
      return { ...current, [item.id]: item }
    })
  }, [])

  if (!open) return null

  const count = Object.keys(picked).length
  return (
    <div className="knowledge-picker" role="dialog" aria-modal="true" aria-label={t('kn.pick.aria')}>
      <div className="knowledge-picker__box" data-knowledge-picker>
        <header className="knowledge-picker__head">
          <h3 className="knowledge-picker__title">{t('kn.pick.title')}</h3>
          <button
            type="button"
            className="knowledge-picker__close"
            aria-label={t('kn.pick.close')}
            onClick={onClose}
            data-knowledge-picker-close
          >
            ×
          </button>
        </header>
        <input
          type="search"
          value={query}
          onChange={(e) => void search(e.target.value)}
          placeholder={t('kn.searchPlaceholder')}
          aria-label={t('kn.search')}
          data-knowledge-picker-search
        />
        {error != null && <p className="ai-error ai-error--padded">{error}</p>}
        {loading && <p className="ai-note ai-note--padded">{t('kn.loading')}</p>}
        {!loading && items.length === 0 && (
          <p className="ai-note ai-note--padded">{t('kn.pick.empty')}</p>
        )}
        <ul className="knowledge-picker__list">
          {items.map((item) => {
            const checked = picked[item.id] !== undefined
            return (
              <li key={item.id}>
                <label className={checked ? 'knowledge-picker__row is-picked' : 'knowledge-picker__row'}>
                  <input
                    type="checkbox"
                    checked={checked}
                    onChange={() => toggle(item)}
                    data-knowledge-picker-item={item.id}
                  />
                  <span className="knowledge-picker__text">
                    <span className="knowledge-picker__name">{item.title || t('kn.untitled')}</span>
                    {item.summary !== '' && (
                      <span className="knowledge-picker__summary">{item.summary}</span>
                    )}
                    {(item.tags ?? []).length > 0 && (
                      <span className="knowledge-picker__tags">
                        {(item.tags ?? []).map((tag) => (
                          <span className="knowledge__tag" key={tag}>
                            {tag}
                          </span>
                        ))}
                      </span>
                    )}
                    <span className="knowledge__meta">
                      {t('kn.meta', {
                        chars: String(item.chars),
                        date: formatDate(item.createdAt, lang),
                      })}
                    </span>
                  </span>
                </label>
              </li>
            )
          })}
        </ul>
        <footer className="knowledge-picker__foot">
          <span className="knowledge__hint">
            {t('kn.pick.limit', { limit: MAX_KNOWLEDGE_ATTACH, count: count })}
          </span>
          <button
            type="button"
            onClick={() => onConfirm(Object.values(picked))}
            data-knowledge-picker-confirm
          >
            {t('kn.pick.confirm')}
          </button>
        </footer>
      </div>
    </div>
  )
}
