/**
 * Подпись браузера по user-agent.
 *
 * Вынесено из компонентов, потому что одно и то же нужно и активным сеансам, и журналу
 * входов: две копии этого разбора разошлись бы в названиях («Chrome» против «Chrome Browser»)
 * и человек читал бы один и тот же сеанс по-разному в двух списках.
 */
import { translate } from '../i18n'
import type { Lang } from '../store/lang'

export function describeBrowser(userAgent: string, lang: Lang = 'ru'): string {
  const agent = userAgent || ''
  const browser = /Firefox/i.test(agent)
    ? 'Firefox'
    : /Edg\//i.test(agent)
      ? 'Edge'
      : /Chrome/i.test(agent)
        ? 'Chrome'
        : /Safari/i.test(agent)
          ? 'Safari'
          : translate(lang, 'agent.unknownBrowser')
  const platform = /Windows/i.test(agent)
    ? 'Windows'
    : /Android/i.test(agent)
      ? 'Android'
      : /iPhone|iPad/i.test(agent)
        ? 'iOS'
        : /Mac OS/i.test(agent)
          ? 'macOS'
          : /Linux/i.test(agent)
            ? 'Linux'
            : ''
  return [browser, platform].filter(Boolean).join(' · ')
}
