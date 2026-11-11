import { useEffect, useId, useRef } from 'react'
import type { ProjectFeature, ProjectStructure } from '../types'
import type { BuildingView } from './townModel'
import { TownFeaturePanel } from './TownFeaturePanel'
import { hasNativeModal } from '../ui/modalLayers'

export interface ProjectRoomContext { b: BuildingView; features: readonly ProjectFeature[] | null; structure?: ProjectStructure | null }

export function ProjectRoomDialog({ project, onClose }: { project: ProjectRoomContext; onClose: () => void }) {
  const id = useId(), panel = useRef<HTMLElement>(null), close = useRef<HTMLButtonElement>(null)
  useEffect(() => { close.current?.focus({ preventScroll: true }) }, [])
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (hasNativeModal()) return
      if (e.key === 'Escape') { e.preventDefault(); e.stopImmediatePropagation(); onClose(); return }
      if (e.key !== 'Tab') return
      const items = [...(panel.current?.querySelectorAll<HTMLElement>('button:not([disabled]):not([tabindex="-1"]), summary, [tabindex="0"]') ?? [])]
      const first = items[0], last = items.at(-1)
      if (e.shiftKey && (document.activeElement === first || !panel.current?.contains(document.activeElement))) { e.preventDefault(); last?.focus() }
      else if (!e.shiftKey && (document.activeElement === last || !panel.current?.contains(document.activeElement))) { e.preventDefault(); first?.focus() }
    }
    window.addEventListener('keydown', key, true)
    return () => window.removeEventListener('keydown', key, true)
  }, [onClose])
  return <div className="town-structure-scrim town-world-ui" onPointerDown={e => e.stopPropagation()} onClick={e => e.stopPropagation()} onWheel={e => e.stopPropagation()}>
    <section className="town-guide town-structure town-room-dialog town-world-ui" role="dialog" aria-modal="true" aria-labelledby={id} ref={panel}>
      <header className="structure-header"><div><p className="structure-eyebrow">项目自己的说明与事实</p><h2 id={id}>{project.b.name} 结构说明</h2></div><button type="button" ref={close} onClick={onClose}>关闭 <kbd>Esc</kbd></button></header>
      <TownFeaturePanel {...project} />
    </section>
  </div>
}
