import { useEffect, useRef, type ReactEventHandler } from 'react'

/** Keep controlled dialogs in the browser's modal top layer and restore their trigger on unmount. */
export function openNativeDialog(dialog: HTMLDialogElement, initialFocusSelector?: string) {
  const previous = dialog.ownerDocument.activeElement as HTMLElement | null
  if (!dialog.open) dialog.showModal()
  if (initialFocusSelector) dialog.querySelector<HTMLElement>(initialFocusSelector)?.focus({ preventScroll: true })
  // WKWebView and browser chrome do not always keep the native Tab boundary.
  // Handle it inside this dialog so background/global keyboard handlers stay untouched.
  const onKey = (event: KeyboardEvent) => {
    if (event.key !== 'Tab') return
    const items = [...dialog.querySelectorAll<HTMLElement>('a[href], button:not(:disabled), input:not(:disabled):not([type="hidden"]), select:not(:disabled), textarea:not(:disabled), summary, [tabindex]')]
      .filter(item => item.tabIndex >= 0 && item.getClientRects().length > 0 && !item.closest('[inert], [aria-hidden="true"]'))
    const first = items[0], last = items.at(-1), active = dialog.ownerDocument.activeElement
    if (!first) { event.preventDefault(); dialog.focus({ preventScroll: true }); return }
    if (event.shiftKey && (active === first || !dialog.contains(active))) { event.preventDefault(); last?.focus({ preventScroll: true }) }
    else if (!event.shiftKey && (active === last || !dialog.contains(active))) { event.preventDefault(); first.focus({ preventScroll: true }) }
  }
  dialog.addEventListener('keydown', onKey)
  return () => {
    dialog.removeEventListener('keydown', onKey)
    if (dialog.open) dialog.close()
    if (previous?.isConnected && !dialog.contains(previous)) previous.focus({ preventScroll: true })
  }
}

/** The close callback can change each render without reopening the dialog or stealing focus. */
export function useNativeDialog(onClose: () => void, initialFocusSelector?: string) {
  const ref = useRef<HTMLDialogElement>(null)
  const close = useRef(onClose)
  const initialFocus = useRef(initialFocusSelector)
  close.current = onClose
  useEffect(() => {
    const dialog = ref.current
    return dialog ? openNativeDialog(dialog, initialFocus.current) : undefined
  }, [])
  const onCancel: ReactEventHandler<HTMLDialogElement> = event => {
    event.preventDefault()
    event.stopPropagation()
    close.current()
  }
  return { ref, onCancel }
}
