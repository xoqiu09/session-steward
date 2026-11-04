import { useEffect, useRef } from 'react'

/** 当作下拉菜单用的 <details>：点它以外的地方或按 Esc 就收起。 */
export function useDismissibleDetails() {
  const ref = useRef<HTMLDetailsElement>(null)
  useEffect(() => {
    const away = (e: PointerEvent) => { const d = ref.current; if (d?.open && !d.contains(e.target as Node)) d.open = false }
    const esc = (e: KeyboardEvent) => { const d = ref.current; if (e.key === 'Escape' && d?.open) { d.open = false; d.querySelector('summary')?.focus() } }
    window.addEventListener('pointerdown', away, true)
    window.addEventListener('keydown', esc)
    return () => { window.removeEventListener('pointerdown', away, true); window.removeEventListener('keydown', esc) }
  }, [])
  return ref
}
