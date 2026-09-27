import { useEffect, useState } from 'react'

/**
 * Тема оформления. Две палитры:
 *   dark  — брендовая тёмная (по умолчанию);
 *   light — кремово-мятная для чтения длинных текстов.
 *
 * Тема живёт в `data-theme` на <html>, поэтому CSS-токены (--bg/--fg/--sf-*)
 * переключаются одним атрибутом; выбор запоминается в localStorage.
 */

export type Theme = 'dark' | 'light'

const STORAGE_KEY = 'skyfraze-theme'
const listeners = new Set<(theme: Theme) => void>()

function readStored(): Theme {
  if (typeof window === 'undefined') return 'dark'
  try {
    const stored = window.localStorage.getItem(STORAGE_KEY)
    if (stored === 'light' || stored === 'dark') return stored
  } catch {
    /* приватный режим — игнорируем */
  }
  return 'dark'
}

let current: Theme = readStored()

function apply(theme: Theme) {
  if (typeof document === 'undefined') return
  document.documentElement.dataset.theme = theme
  document.documentElement.style.colorScheme = theme
}

apply(current)

export function getTheme(): Theme {
  return current
}

export function setTheme(theme: Theme): void {
  current = theme
  apply(theme)
  try {
    window.localStorage.setItem(STORAGE_KEY, theme)
  } catch {
    /* ignore */
  }
  for (const listener of listeners) listener(theme)
}

export function toggleTheme(): Theme {
  const next: Theme = current === 'dark' ? 'light' : 'dark'
  setTheme(next)
  return next
}

/** Подписка на тему (используется компонентами, которым нужна палитра). */
export function useTheme(): [Theme, (theme: Theme) => void] {
  const [theme, setLocal] = useState<Theme>(current)
  useEffect(() => {
    const listener = (t: Theme) => setLocal(t)
    listeners.add(listener)
    setLocal(current)
    return () => {
      listeners.delete(listener)
    }
  }, [])
  return [theme, setTheme]
}
