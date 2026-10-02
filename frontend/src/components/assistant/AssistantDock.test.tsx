import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { AssistantDock } from './AssistantDock'

/**
 * Плавающий помощник как окно: кнопка, раскрытие, маркер непрочитанного и Esc.
 *
 * Панель подменена заглушкой: проверяем именно поведение окна (что кнопка делает,
 * что показывает маркер, что делает Esc), а содержимое окна проверяется отдельно —
 * в AssistantPanel.test.tsx.
 */
const panel = vi.hoisted(() => ({ unread: null as null | (() => void), thinking: null as null | ((v: boolean) => void) }))

vi.mock('./AssistantPanel', () => ({
  AssistantPanel: (props: {
    open: boolean
    onUnread: () => void
    onThinkingChange: (v: boolean) => void
    onClose: () => void
  }) => {
    panel.unread = props.onUnread
    panel.thinking = props.onThinkingChange
    return (
      <div>
        <span data-testid="panel-open">{String(props.open)}</span>
        <button onClick={props.onUnread}>имитировать ответ в фоне</button>
        <button onClick={() => props.onThinkingChange(true)}>имитировать запрос</button>
      </div>
    )
  },
}))

function renderDock() {
  const onOpenChange = vi.fn()
  const view = render(
    <AssistantDock
      projectId="p1"
      open={false}
      onOpenChange={onOpenChange}
      onProjectChanged={() => {}}
      onOpenEditors={() => {}}
    />,
  )
  return { onOpenChange, view }
}

afterEach(() => cleanup())

describe('AssistantDock', () => {
  it('окно скрыто, кнопка предлагает открыть', () => {
    renderDock()
    expect(screen.getByRole('button', { name: 'Открыть помощника' })).toBeTruthy()
    const panelElement = document.querySelector('[data-assistant-panel]') as HTMLElement
    expect(panelElement.hidden).toBe(true)
  })

  it('кнопка открывает окно и сообщает об этом странице', () => {
    const { onOpenChange } = renderDock()
    fireEvent.click(screen.getByRole('button', { name: 'Открыть помощника' }))
    expect(onOpenChange).toHaveBeenCalledWith(true)
  })

  it('при открытом окне кнопка закрывает его', () => {
    const onOpenChange = vi.fn()
    render(
      <AssistantDock
        projectId="p1"
        open
        onOpenChange={onOpenChange}
        onProjectChanged={() => {}}
        onOpenEditors={() => {}}
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: 'Закрыть помощника' }))
    expect(onOpenChange).toHaveBeenCalledWith(false)
  })

  it('маркер показывает непрочитанные ответы и сбрасывается при открытии', () => {
    const { view, onOpenChange } = renderDock()
    // Ответ пришёл при закрытом окне — панель сообщает об этом.
    fireEvent.click(screen.getByText('имитировать ответ в фоне'))
    expect(screen.getByText('1')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'ИИ-помощник: непрочитанных ответов 1' })).toBeTruthy()

    fireEvent.click(screen.getByText('имитировать ответ в фоне'))
    expect(screen.getByText('2')).toBeTruthy()

    // Открыли — непрочитанное прочитано.
    view.rerender(
      <AssistantDock
        projectId="p1"
        open={false}
        onOpenChange={onOpenChange}
        onProjectChanged={() => {}}
        onOpenEditors={() => {}}
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: /непрочитанных ответов 2/ }))
    view.rerender(
      <AssistantDock
        projectId="p1"
        open
        onOpenChange={onOpenChange}
        onProjectChanged={() => {}}
        onOpenEditors={() => {}}
      />,
    )
    expect(screen.queryByText('2')).toBeNull()
  })

  it('Esc закрывает окно', () => {
    const onOpenChange = vi.fn()
    render(
      <AssistantDock
        projectId="p1"
        open
        onOpenChange={onOpenChange}
        onProjectChanged={() => {}}
        onOpenEditors={() => {}}
      />,
    )
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(onOpenChange).toHaveBeenCalledWith(false)
  })

  it('пока идёт запрос, кнопка показывает «думает»', () => {
    renderDock()
    fireEvent.click(screen.getByText('имитировать запрос'))
    const fab = document.querySelector('.ai-fab') as HTMLElement
    expect(fab.className).toContain('is-thinking')
    expect(panel.thinking).not.toBeNull()
  })
})
