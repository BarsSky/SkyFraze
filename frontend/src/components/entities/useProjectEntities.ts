import { useCallback, useEffect, useState } from 'react'
import { listEntities, type ProjectEntity } from '../../api/entities'

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
  const [loaded, setLoaded] = useState(false)

  const reload = useCallback(async () => {
    if (!projectId) {
      setEntities([])
      setLoaded(true)
      return
    }
    try {
      setEntities(await listEntities(projectId))
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

  return { entities, loaded, reload }
}
