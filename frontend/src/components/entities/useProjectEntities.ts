import { useCallback, useEffect, useState } from 'react'
import {
  listEntities,
  listEntityLinks,
  type EntityLink,
  type ProjectEntity,
} from '../../api/entities'
import { ENTITIES_CHANGED_EVENT } from '../../api/assistant'

/**
 * Карточки мира проекта, загруженные один раз для всей панели редакторов.
 *
 * Почему хук, а не загрузка внутри компонента-панели: карточки нужны в ДВУХ местах сразу —
 * в списке «Связи проекта» и в поиске упоминаний в тексте кадра. Две независимые загрузки
 * одного и того же списка разъезжались бы: создал карточку — упоминания появились бы только
 * после перезагрузки страницы.
 *
 * `reload` дёргает панель после своих правок (создать/переименовать/удалить): список один, и
 * обновляет его владелец данных, а не каждый потребитель.
 */
export function useProjectEntities(projectId?: string) {
  const [entities, setEntities] = useState<ProjectEntity[]>([])
  const [links, setLinks] = useState<EntityLink[]>([])
  const [loaded, setLoaded] = useState(false)

  const reload = useCallback(async () => {
    if (!projectId) {
      setEntities([])
      setLoaded(true)
      return
    }
    try {
      // Карточки и связи грузим вместе: граф и чипы связей — одна картина, и два запроса
      // подряд разъезжались бы в момент открытия проекта.
      const [cards, links] = await Promise.all([listEntities(projectId), listEntityLinks(projectId)])
      setEntities(cards)
      setLinks(links)
    } catch {
      // Проект может быть недоступен (закрыт доступ): пустой список лучше вечной загрузки.
      setEntities([])
    } finally {
      setLoaded(true)
    }
  }, [projectId])

  useEffect(() => {
    setLoaded(false)
    void reload()
  }, [reload])

  // Карточки мог создать не этот компонент: помощник предложил их из своего окна, человек
  // нажал «Добавить» (0.77.0). Без этого события панель связей показывала бы старый список до
  // перезагрузки страницы — ровно та жалоба, с которой начиналась вся эта ветка.
  useEffect(() => {
    const onChanged = () => void reload()
    window.addEventListener(ENTITIES_CHANGED_EVENT, onChanged)
    return () => window.removeEventListener(ENTITIES_CHANGED_EVENT, onChanged)
  }, [reload])

  return { entities, links, loaded, reload }
}
