import { http } from './client'
import type { Project } from './projects'

/** Порядок ленты: новые / по оценке / по просмотрам. */
export type FeedSort = 'new' | 'rating' | 'views'

/** Карточка ленты: проект + автор + агрегаты оценок и просмотров. */
export interface FeedItem {
  id: string
  title: string
  description: string
  slug: string
  published_at?: string | null
  views: number
  author: string
  /** 0 при rating_count = 0: «нет оценок» определяется по счётчику, не по среднему */
  rating_avg: number
  rating_count: number
  cover_asset_id?: string | null
}

export interface PublicAsset {
  id: string
  mime: string
  kind: string
  filename: string
  width?: number
  height?: number
}

export interface PublicEventRow {
  id: string
  parent_id: string | null
  position: number
  title: string
  body: string
}

export interface PublicStory {
  story: FeedItem
  assets: PublicAsset[]
  /** base64 CRDT-снапшота; пусто, если снапшота нет (тогда заполнен events) */
  state?: string
  events: PublicEventRow[]
  my_rating?: number
}

export interface RatingState {
  rating_avg: number
  rating_count: number
  my_rating: number | null
}

/** Публичный файл опубликованной истории — без авторизации. */
export function publicAssetUrl(assetId: string): string {
  return `/api/public/assets/${assetId}`
}

export async function listFeed(sort: FeedSort = 'new', limit = 24): Promise<{ items: FeedItem[]; sort: string }> {
  return await http
    .get('public/feed', {
      searchParams: { sort, limit: String(limit) },
      // Лента — публичная витрина: сеть может мигнуть, повторяем сами.
      timeout: 20000,
      retry: { limit: 2, methods: ['get'] },
    })
    .json<{ items: FeedItem[]; sort: string }>()
}

export async function getPublicStory(slug: string): Promise<PublicStory> {
  return await http
    .get(`public/stories/${encodeURIComponent(slug)}`, {
      // Ответ содержит CRDT-снапшот истории: даём больше времени, чем дефолтные
      // 10 секунд, и один автоматический повтор — обрыв связи не должен выглядеть
      // как «история не открылась».
      timeout: 25000,
      retry: { limit: 1, methods: ['get'] },
    })
    .json<PublicStory>()
}

export async function rateStory(slug: string, stars: number): Promise<RatingState> {
  return await http
    .post(`public/stories/${encodeURIComponent(slug)}/rating`, { json: { stars } })
    .json<RatingState>()
}

export async function unrateStory(slug: string): Promise<RatingState> {
  return await http.delete(`public/stories/${encodeURIComponent(slug)}/rating`).json<RatingState>()
}

/** Публикация/снятие с публикации — только владелец проекта. */
export async function setPublication(projectId: string, isPublic: boolean): Promise<Project> {
  return await http
    .post(`projects/${projectId}/publication`, { json: { is_public: isPublic } })
    .json<Project>()
}
