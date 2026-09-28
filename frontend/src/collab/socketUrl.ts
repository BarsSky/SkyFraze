/**
 * Адрес realtime-канала (Yjs WebSocket).
 *
 * Схему нельзя задавать константой `ws://`: на странице, открытой по HTTPS
 * (домен через reverse proxy), браузер запрещает небезопасное WebSocket и
 * конструктор бросает SecurityError. Исключение внутри эффекта роняло всё дерево
 * React — страница проекта превращалась в пустой экран без меню и редакторов
 * (и на компьютере, и на телефоне). Поэтому схема берётся из адреса страницы.
 *
 * Вынесено в отдельную функцию, чтобы это покрывалось тестом.
 */
export interface LocationLike {
  protocol: string
  host: string
}

export function collabSocketUrl(projectId: string, location: LocationLike = globalThis.location): string {
  const scheme = location.protocol === 'https:' ? 'wss:' : 'ws:'
  const host = location.host || 'localhost'
  return `${scheme}//${host}/api/projects/${encodeURIComponent(projectId)}/collab`
}
