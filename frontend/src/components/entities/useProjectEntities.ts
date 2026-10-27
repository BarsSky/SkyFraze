import { useCallback, useEffect, useState } from 'react'
import {
  listEntities,
  listEntityLinks,
  type EntityLink,
  type ProjectEntity,
} from '../../api/entities'
import { listEntityTypes, type EntityType } from '../../api/entityTypes'
import { ENTITIES_CHANGED_EVENT } from '../../api/assistant'

/**
 * Карточки мира проекта, их связи и ТИПЫ — один список на всю страницу (0.68.0 → 0.81.0).
 *
 * Почему хук, а не загрузка внутри компонента-панели: карточки нужны в ДВУХ местах сразу — в
 * области «Связи» (список, граф, матрица) и в поиске упоминаний в тексте кадра (панель
 * редакторов). Две независимые загрузки одного и того же списка разъезжались бы: создал карточку —
 * упоминания появились бы только после перезагрузки страницы.
 *
 * `reload` дёргает панель после своих правок (создать/переименовать/удалить): список один, и
 * обновляет его владелец данных, а не каждый потребитель.
 */
export function useProjectEntities(projectId?: string) {
  const [entities, setEntities] = useState<ProjectEntity[]>([])
  const [links, setLinks] = useState<EntityLink[]>([])
  const [types, setTypes] = useState<EntityType[]>([])
  const [loaded, setLoaded] = useState(false)

  const reload = useCallback(async () => {
    if (!projectId) {
      setEntities([])
      setLinks([])
      setTypes([])
      setLoaded(true)
      return
    }
    try {
      // Карточки, связи и типы грузим вместе: граф, чипы и подписи видов — одна картина, и
      // три запроса подряд разъезжались бы в момент открытия проекта.
      const [cards, entityLinks, entityTypes] = await Promise.all([
        listEntities(projectId),
        listEntityLinks(projectId),
        listEntityTypes(projectId),
      ])
      setEntities(cards)
      setLinks(entityLinks)
      setTypes(entityTypes)
    } catch {
      // Проект может быть недоступен (закрыт доступ): пустой список лучше вечной загрузки.
      setEntities([])
      setLinks([])
      setTypes([])
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

  return { entities, links, types, loaded, reload }
}
