import { describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { afterEach } from 'vitest'
import { TabBar } from './ProjectTimelinePage'
import { setLang } from '../store/lang'

/**
 * Строка вкладок проекта (0.94.1).
 *
 * Отчёт: «кнопки Настройки проекта тоже нигде не видно — может добавить её в ряд к Проект
 * Редакторы Связи Версии». Проверяем именно это: «Настройки» стоит в том же ряду, ведёт на
 * страницу настроек, а вкладки режима по-прежнему переключаются кнопками.
 */

afterEach(() => {
  cleanup()
  // Язык — модульное состояние: без сброса английский «протёк» бы в соседние тесты.
  setLang('ru')
})

const renderTabs = (view: 'project' | 'editors' | 'relations' | 'versions' = 'project') => {
  const onChange = vi.fn()
  render(
    <MemoryRouter initialEntries={['/projects/p1']}>
      <TabBar view={view} projectId="p1" onChange={onChange} />
    </MemoryRouter>,
  )
  return onChange
}

describe('TabBar', () => {
  it('ряд содержит Проект, Редакторы, Связи, Версии и Настройки', () => {
    renderTabs()
    const tabs = screen.getAllByRole('tab')
    expect(tabs.map((tab) => tab.textContent)).toEqual([
      'Проект',
      'Редакторы',
      'Связи',
      'Версии',
      'Настройки',
    ])
  })

  it('«Настройки» — ссылка на страницу настроек проекта, а не переключение режима', () => {
    const onChange = renderTabs()
    const settings = screen.getByRole('tab', { name: 'Настройки' }) as HTMLAnchorElement
    expect(settings.tagName).toBe('A')
    expect(settings.getAttribute('href')).toBe('/projects/p1/settings')
    fireEvent.click(settings)
    // Клик по ссылке не переключает режим: это другая страница.
    expect(onChange).not.toHaveBeenCalled()
  })

  it('активная вкладка помечена, и клик по ней переключает режим', () => {
    const onChange = renderTabs('editors')
    const editors = screen.getByRole('tab', { name: 'Редакторы' })
    expect(editors.getAttribute('aria-selected')).toBe('true')
    fireEvent.click(screen.getByRole('tab', { name: 'Связи' }))
    expect(onChange).toHaveBeenCalledWith('relations')
  })

  /**
   * Подписи вкладок — из словаря (0.117.0), а не константы модуля.
   *
   * Что закрепляем: после переключения языка вкладки меняются БЕЗ перезагрузки. До 0.117.0
   * `PROJECT_TABS` был массивом строк, и английский интерфейс оставлял «Проект · Редакторы ·
   * Связи · Версии» русскими — то есть весь переход в проект оставался непереведённым.
   */
  it('на английском вкладки переведены, включая «Настройки»', () => {
    setLang('en')
    renderTabs()
    const tabs = screen.getAllByRole('tab')
    expect(tabs.map((tab) => tab.textContent)).toEqual([
      'Project',
      'Editors',
      'Relations',
      'Versions',
      'Settings',
    ])
    expect(screen.getByRole('tablist').getAttribute('aria-label')).toBe('Project view')
    const settings = screen.getByRole('tab', { name: 'Settings' }) as HTMLAnchorElement
    expect(settings.getAttribute('href')).toBe('/projects/p1/settings')
  })
})
