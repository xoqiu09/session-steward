import type { TownMoment } from './moments'

/** HTML 浮层只导航，验收和权限决定仍在 SS 的原有卡片里由用户完成。 */
export function MomentCard({ moment, ripeCount, onOpen, onHarvest, onLater, onAcknowledge }: {
  moment: TownMoment; ripeCount: number; onOpen: () => void; onHarvest: () => void; onLater: () => void; onAcknowledge: () => void
}) {
  return <aside className={`town-moment-card is-${moment.kind}`} aria-label="项目新动态" onPointerDown={(e) => e.stopPropagation()}>
    <p className="town-moment-kind">{moment.kind === 'decision' ? '等你决定' : moment.kind === 'ripe' ? '菜熟了' : moment.kind === 'merged' ? '合并完成' : '有进展'}</p>
    <p className="town-moment-message">{moment.message}</p>
    {!moment.local && <p className="town-moment-note">这项工作在另一台电脑上，请到那台电脑处理。</p>}
    {moment.kind !== 'progress' && <div className="town-moment-actions">
      {moment.local && <button type="button" className="is-primary" onClick={onOpen}>{moment.kind === 'ripe' ? '收这一棵' : moment.kind === 'decision' ? '去处理' : '看看'}</button>}
      {moment.local && moment.kind === 'ripe' && ripeCount > 0 && <button type="button" onClick={onHarvest}>开始收菜（{ripeCount} 棵）</button>}
      <button type="button" onClick={moment.kind === 'merged' ? onAcknowledge : onLater}>{moment.kind === 'merged' ? '好的' : '稍后'}</button>
    </div>}
  </aside>
}
