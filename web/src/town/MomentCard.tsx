import type { WorkItem } from '../types'
import { QuickClose } from '../ui/QuickClose'
import type { TownMoment } from './moments'

const KIND_LABEL: Record<TownMoment['kind'], string> = { decision: '等你决定', returned: '你回来过', stalled: '停在你手上', ripe: '菜熟了', merged: '合并完成', progress: '有进展' }

/** HTML 浮层。权限决定仍在 SS 的原有卡片里完成；“你回来过”可以在这里直接收下或退回，也可以不理它。 */
export function MomentCard({ moment, item, ripeCount, onOpen, onHarvest, onLater, onAcknowledge, onResolve, busy = false, error = '' }: {
  moment: TownMoment; item?: WorkItem; ripeCount: number; onOpen: () => void; onHarvest: () => void; onLater: () => void; onAcknowledge: () => void
  onResolve?: (status: 'done' | 'in_progress') => void; busy?: boolean; error?: string
}) {
  const resolve = (status: 'done' | 'in_progress') => onResolve?.(status)
  return <aside className={`town-moment-card is-${moment.kind}`} aria-label="项目新动态" onPointerDown={(e) => e.stopPropagation()}>
    <p className="town-moment-kind">{KIND_LABEL[moment.kind]}</p>
    <p className="town-moment-message">{moment.message}</p>
    {!moment.local && <p className="town-moment-note">这项工作在另一台电脑上，请到那台电脑处理。</p>}
    {moment.kind === 'returned' && moment.local && onResolve && <>
      <p className="town-moment-note">只记了你回来过的时间，没有读你说了什么。不点也行，它会留在待验收里。</p>
      <div className="town-moment-actions">
        <button type="button" className="is-primary" disabled={busy} onClick={() => resolve('done')}>已处理</button>
        <button type="button" disabled={busy} onClick={() => resolve('in_progress')}>退回修改</button>
        <button type="button" disabled={busy} onClick={onOpen}>看看</button>
        <button type="button" disabled={busy} onClick={onLater}>稍后</button>
      </div>
      {error && <p className="town-moment-note" role="alert">{error}</p>}
    </>}
    {moment.kind !== 'progress' && moment.kind !== 'returned' && <div className="town-moment-actions">
      {moment.local && <button type="button" className="is-primary" onClick={onOpen}>{moment.kind === 'ripe' ? '收这一棵' : moment.kind === 'decision' ? '去处理' : '看看'}</button>}
      {moment.local && moment.kind === 'ripe' && ripeCount > 0 && <button type="button" onClick={onHarvest}>开始收菜（{ripeCount} 棵）</button>}
      <button type="button" onClick={moment.kind === 'merged' ? onAcknowledge : onLater}>{moment.kind === 'merged' ? '好的' : '稍后'}</button>
    </div>}
    {moment.kind === 'stalled' && moment.local && item && <QuickClose item={item} only={['paused', 'abandoned', 'accepted']} />}
    {moment.kind === 'returned' && !moment.local && <div className="town-moment-actions"><button type="button" onClick={onLater}>稍后</button></div>}
  </aside>
}
