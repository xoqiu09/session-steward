import { expect, it, vi } from 'vitest'
import { openNativeDialog } from './useNativeDialog'

function dialogFixture() {
  const trigger = { isConnected: true, focus: vi.fn() }
  const initial = { focus: vi.fn() }
  const handlers: Record<string, (event: any) => void> = {}
  const dialog = {
    open: false,
    ownerDocument: { activeElement: trigger },
    showModal: vi.fn(() => { dialog.open = true }),
    close: vi.fn(() => { dialog.open = false }),
    querySelector: vi.fn(() => initial),
    querySelectorAll: vi.fn(() => [] as unknown[]),
    contains: vi.fn(() => false),
    addEventListener: vi.fn((name: string, handler: (event: any) => void) => { handlers[name] = handler }),
    removeEventListener: vi.fn((name: string) => { delete handlers[name] }),
  }
  return { dialog, trigger, initial, handlers }
}

it('opens in the native modal layer, applies initial focus and restores the connected trigger', () => {
  const { dialog, trigger, initial } = dialogFixture()
  const cleanup = openNativeDialog(dialog as unknown as HTMLDialogElement, '[aria-checked="true"]')
  expect(dialog.showModal).toHaveBeenCalledOnce()
  expect(dialog.querySelector).toHaveBeenCalledWith('[aria-checked="true"]')
  expect(initial.focus).toHaveBeenCalledWith({ preventScroll: true })
  cleanup()
  expect(dialog.close).toHaveBeenCalledOnce()
  expect(trigger.focus).toHaveBeenCalledWith({ preventScroll: true })
  expect(dialog.removeEventListener).toHaveBeenCalledWith('keydown', expect.any(Function))
})

it('keeps Tab and Shift+Tab inside the visible enabled controls without a global listener', () => {
  const { dialog, handlers } = dialogFixture()
  const item = () => ({ isConnected: true, focus: vi.fn(), tabIndex: 0, getClientRects: () => [{}], closest: () => null })
  const first = item(), last = item(), hidden = { ...item(), getClientRects: () => [] }
  dialog.querySelectorAll.mockReturnValue([first, hidden, last])
  dialog.contains.mockImplementation((node?: unknown) => node === first || node === last)
  const cleanup = openNativeDialog(dialog as unknown as HTMLDialogElement)
  dialog.ownerDocument.activeElement = last
  const tab = { key: 'Tab', shiftKey: false, preventDefault: vi.fn() }
  handlers.keydown(tab)
  expect(tab.preventDefault).toHaveBeenCalledOnce()
  expect(first.focus).toHaveBeenCalledWith({ preventScroll: true })
  dialog.ownerDocument.activeElement = first
  handlers.keydown({ ...tab, shiftKey: true })
  expect(last.focus).toHaveBeenCalledWith({ preventScroll: true })
  cleanup()
  expect(handlers.keydown).toBeUndefined()
})

it('does not show an already open dialog again or focus a removed launcher', () => {
  const { dialog, trigger } = dialogFixture()
  dialog.open = true
  const cleanup = openNativeDialog(dialog as unknown as HTMLDialogElement)
  expect(dialog.showModal).not.toHaveBeenCalled()
  trigger.isConnected = false
  cleanup()
  expect(trigger.focus).not.toHaveBeenCalled()
})
