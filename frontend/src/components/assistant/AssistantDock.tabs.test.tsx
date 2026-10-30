import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { AssistantDock } from './AssistantDock'

/**
 * Две вкладки в плавающем окне (0.95.0): «Помощник» и «Чат проекта».
 *
 * Почему в одном окне: кнопка одна и узнаваемая, а человек либо спрашивает Нестора, либо пишет
 * участникам — переключение вкладкой дешевле второго плавающего окна. Проверяем: обе вкладки есть,
 * по умолчанию открыт помощник, панель помощника не размонтируется при переключении (иначе
 * потерялись бы история и черновик), а непрочитанное в чате видно на вкладке и на кнопке.
 */

vi.mock('./AssistantPanel', () => ({
  AssistantPanel: ({ open }: { open: boolean }) => (
    <div data-testid="assistant-pane" data-open={String(open)}>
      помощник
    </div>
  ),
}))

vi.mock('../chat/ProjectChat', () => ({
  ProjectChat: ({
    visible,
    onUnread,
  }: {
    visible: boolean
    onUnread?: (count: number) => void
  }) => (
    <div data-testid="chat-pane" data-visible={String(visible)}>
      чат
      <button type="button" onClick={() => onUnread?.(3)}>
        пришло три
      </button>
    </div>
  ),
}))

afterEach(() => cleanup())

const renderDock = (open = true) =>
  render(
    <AssistantDock
      projectId="p1"
      open={open}
      onOpenChange={() => {}}
      onProjectChanged={() => {}}
      onOpenEditors={() => {}}
    />,
  )

describe('AssistantDock — вкладки', () => {
  it('по умолчанию открыт помощник, чат — вторая вкладка', () => {
    renderDock()
    const tabs = screen.getAllByRole('tab')
    expect(tabs.map((tab) => tab.textContent)).toEqual(['Помощник', 'Чат проекта'])
    expect(tabs[0].getAttribute('aria-selected')).toBe('true')
    expect(screen.getByTestId('assistant-pane').getAttribute('data-open')).toBe('true')
    expect(screen.getByTestId('chat-pane').getAttribute('data-visible')).toBe('false')
  })

  it('переключение на чат не размонтирует помощника и меняет видимость', () => {
    renderDock()
    fireEvent.click(screen.getByRole('tab', { name: /Чат проекта/ }))
    expect(screen.getByRole('tab', { name: /Чат проекта/ }).getAttribute('aria-selected')).toBe('true')
    // Панель помощника на месте: её история и черновик переживают переключение.
    expect(screen.getByTestId('assistant-pane').getAttribute('data-open')).toBe('false')
    expect(screen.getByTestId('chat-pane').getAttribute('data-visible')).toBe('true')
  })

  it('непрочитанное в чате видно на вкладке и на кнопке', () => {
    renderDock()
    fireEvent.click(screen.getByRole('tab', { name: /Чат проекта/ }))
    fireEvent.click(screen.getByRole('button', { name: 'пришло три' }))
    // Счётчик стоит и на вкладке чата, и на плавающей кнопке — человек видит его в обоих местах.
    expect(screen.getAllByText('3')).toHaveLength(2)
    expect(screen.getByRole('button', { name: /непрочитанных/ })).toBeTruthy()
  })

  it('закрытое окно сохраняет обе панели в дереве', () => {
    renderDock(false)
    expect(screen.getByTestId('assistant-pane')).toBeTruthy()
    expect(screen.getByTestId('chat-pane')).toBeTruthy()
    // Окно скрыто атрибутом, а не размонтированием.
    expect(screen.getByRole('dialog', { hidden: true })).toBeTruthy()
  })

  /**
   * 0.132.0: «отправить в чат» и «спросить помощника» из меню выделения открывают окно СРАЗУ на
   * нужной вкладке — иначе человек попадал бы не туда и переключал вручную.
   */
  it('цитата для помощника открывает вкладку помощника, цитата для чата — вкладку чата', () => {
    const view = render(
      <AssistantDock
        projectId="p1"
        open
        onOpenChange={() => {}}
        onProjectChanged={() => {}}
        onOpenEditors={() => {}}
        prefill={{ tab: 'chat', nonce: 1, frameId: 'f1', frameTitle: 'Пролог', quote: 'Аня' }}
      />,
    )
    expect(screen.getByRole('tab', { name: /Чат проекта/ }).getAttribute('aria-selected')).toBe('true')

    view.rerender(
      <AssistantDock
        projectId="p1"
        open
        onOpenChange={() => {}}
        onProjectChanged={() => {}}
        onOpenEditors={() => {}}
        prefill={{ tab: 'assistant', nonce: 2, frameId: 'f1', frameTitle: 'Пролог', quote: 'Аня' }}
      />,
    )
    expect(screen.getByRole('tab', { name: /Помощник/ }).getAttribute('aria-selected')).toBe('true')
  })
})
