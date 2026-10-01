import type { APIRequestContext } from 'playwright'

/**
 * Базовая ревизия снапшота для проекции дерева.
 *
 * `PUT /events/tree` — ПОЛНАЯ замена дерева проекта, поэтому сервер требует
 * ревизию снапшота, которую клиент считает актуальной (`X-Skyfraze-Base-Revision`,
 * та же оптимистичная блокировка, что у `PUT /events/state`), и без заголовка
 * отвечает 428, а при устаревшей базе — 409. Клиент берёт ревизию из
 * `GET /events/state`; у только что созданного проекта снапшота нет, и ревизия
 * равна нулю.
 *
 * Тестам, которые сеют дерево по REST, эта ревизия нужна так же, как интерфейсу:
 * без неё строка «дерево сохранено» на деле получала 428, проект оставался пустым,
 * и проверки падали уже на пустой странице.
 */
export async function treeBaseRevision(
  api: APIRequestContext,
  base: string,
  projectId: string,
  headers: Record<string, string>,
): Promise<string> {
  const res = await api.get(`${base}/api/projects/${projectId}/events/state`, { headers })
  if (!res.ok()) return '0'
  return res.headers()['x-skyfraze-revision'] ?? '0'
}
