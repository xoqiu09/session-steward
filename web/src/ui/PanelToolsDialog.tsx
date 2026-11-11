import type { ReactNode } from 'react'
import { useNativeDialog } from './useNativeDialog'

/** Secondary tools stay reachable without competing with the town itself. */
export function PanelToolsDialog({ children, onClose }: { children: ReactNode; onClose: () => void }) {
  const dialog = useNativeDialog(onClose, '[data-close-panel-tools]')
  return <dialog {...dialog} className="panel-tools-dialog" aria-labelledby="panel-tools-heading" aria-modal="true">
    <header><div><span className="panel-tools-eyebrow">SESSION STEWARD</span><h2 id="panel-tools-heading">工具与近况</h2></div>
      <button className="btn small" data-close-panel-tools onClick={onClose} aria-label="关闭工具">关闭</button>
    </header>
    {children}
  </dialog>
}
