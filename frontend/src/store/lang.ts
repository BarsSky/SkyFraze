/**
 * Язык интерфейса (0.115.0).
 *
 * Устроен как `store/theme.ts`: модульное состояние, подписка для компонентов и `localStorage`.
 * Без провайдера и контекста: язык нужен почти каждому компоненту, но меняется редко, а
 * провайдер добавил бы обёртку в тесты и в каждый рендер дерева.
 *
 * Русский — ПО УМОЛЧАНИЮ. Это не только про аудиторию: 3334 строки в тестах проверяют русские
 * подписи, и смена языка по умолчанию переписала бы половину из них, ничего не проверив.
 *
 * `<html lang>` обновляется вместе с выбором: от него зависят переносы и озвучка скринридером.
 */
export type Lang = 'ru' | 'en'

import { useEffect, useState } from 'react'

const STORAGE_KEY = 'skyfraze-lang'
const listeners = new Set<(lang: Lang) => void>()

function readStored(): Lang {
  if (typeof window === 'undefined') return 'ru'
  try {
    const stored = window.localStorage.getItem(STORAGE_KEY)
    if (stored === 'ru' || stored === 'en') return stored
  } catch {
    /* приватный режим — игнорируем */
  }
  return 'ru'
}

let current: Lang = readStored()

function apply(lang: Lang) {
  if (typeof document === 'undefined') return
  document.documentElement.lang = lang
}

apply(current)

export function getLang(): Lang {
  return current
}

export function setLang(lang: Lang): void {
  current = lang
  apply(lang)
  try {
    window.localStorage.setItem(STORAGE_KEY, lang)
  } catch {
    /* ignore */
  }
  for (const listener of listeners) listener(lang)
}

export function toggleLang(): Lang {
  const next: Lang = current === 'ru' ? 'en' : 'ru'
  setLang(next)
  return next
}

/** Подписка на язык: `const [lang, setLang] = useLang()`. */
export function useLang(): [Lang, (lang: Lang) => void] {
  const [lang, setLocal] = useState<Lang>(current)
  useEffect(() => {
    const listener = (next: Lang) => setLocal(next)
    listeners.add(listener)
    // Пока компонент не подписался, язык могли переключить в другом месте — сверяемся.
    setLocal(current)
    return () => {
      listeners.delete(listener)
    }
  }, [])
  return [lang, setLang]
}

