import { useCallback, useEffect, useState } from 'react'
import { activateDocxTemplate, listDocxTemplates, type DocxTemplate } from '../../api/docxTemplates'

/**
 * Компактный переключатель оформления DOCX в меню «Книга» (0.93.1).
 *
 * Зачем здесь, а не только в настройках: оформление выбирают ПЕРЕД скачиванием — «сейчас отдам
 * редактору рукопись, а не самиздат». Раньше за этим нужно было уйти в настройки проекта, найти
 * блок «Оформление DOCX» и вернуться к меню; здесь переключатель стоит прямо над кнопкой
 * «Скачать .docx» и говорит, что применится.
 *
 * Шаблонов может быть несколько, активный один: смена активного — отдельный запрос, после
 * которого скачивание собирается уже в другом пакете. Читателю переключатель виден, но выключен:
 * оформление одно на всех, и менять его вправе редактор.
 *
 * Список грузится ЛЕНИВО — при первом показе меню: иначе страница со списком проектов делала бы
 * по запросу на каждый проект ради меню, которое чаще всего не открывают.
 */
interface Props {
  projectId: string
  /** Может ли человек менять оформление (редактор и выше). */
  canEdit: boolean
}

export function DocxTemplateSwitch({ projectId, canEdit }: Props) {
  const [templates, setTemplates] = useState<DocxTemplate[] | null>(null)
  const [busy, setBusy] = useState(false)
  const [note, setNote] = useState<string | null>(null)

  useEffect(() => {
    let alive = true
    listDocxTemplates(projectId)
      .then((list) => {
        if (alive) setTemplates(list)
      })
      .catch(() => {
        // Настройки оформления — не повод ломать меню выгрузки: без них скачивание работает
        // (встроенное оформление), и человек не должен видеть ошибку загрузки списка.
        if (alive) setTemplates([])
      })
    return () => {
      alive = false
    }
  }, [projectId])

  const activate = useCallback(
    async (id: string) => {
      if (!id) return
      setBusy(true)
      setNote(null)
      try {
        const list = await activateDocxTemplate(projectId, id)
        setTemplates(list)
      } catch {
        setNote('Не удалось переключить оформление.')
      } finally {
        setBusy(false)
      }
    },
    [projectId],
  )

  if (templates === null) return null
  if (templates.length === 0) {
    return (
      <p className="dl-menu__note muted" data-docx-switch-empty>
        Шаблон оформления не загружен — скачается встроенное оформление.
      </p>
    )
  }
  const active = templates.find((template) => template.is_active) ?? templates[0]
  return (
    <div className="dl-menu__note" data-docx-switch>
      <label className="dl-menu__note-label" htmlFor={`docx-template-${projectId}`}>
        Оформление
      </label>
      <select
        id={`docx-template-${projectId}`}
        className="dl-menu__select"
        value={active.id}
        disabled={!canEdit || busy || templates.length === 1}
        title={
          canEdit
            ? 'Каким шаблоном соберётся .docx'
            : 'Оформление меняет редактор проекта'
        }
        onChange={(event) => void activate(event.target.value)}
        data-docx-switch-select
      >
        {templates.map((template) => (
          <option key={template.id} value={template.id}>
            {template.name}
          </option>
        ))}
      </select>
      {note !== null && <span className="muted">{note}</span>}
    </div>
  )
}
