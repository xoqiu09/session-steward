import type { WorkItem } from './types'
import { stages, stageView } from './stage'
import { field } from './brief'

export function StageBand({ item, parallel = false }: { item: WorkItem; parallel?: boolean }) {
  const stage = parallel && !['done', 'abandoned'].includes(item.status) ? { key: 'unknown', label: '多会话协作', basis: '各会话阶段分别展示；不把最近发言者的阶段当成整个工作项的阶段' } : stageView(item)
  const basis = stage.key === 'accepted' ? '用户已标记完成' : stage.key === 'review' ? '已提交交付' : field(item, 'stage') && stage.key !== 'unknown' ? field(item, 'stage')?.kind === 'user' ? '用户更正' : 'Agent 回报' : ''
  const blocked = !!field(item, 'blocker') || item.status === 'blocked' || !item.ready
  return <div className={`stage-band stage-${stage.key}`}>
    <div className="stage-caption"><strong title={stage.basis}>{stage.label}</strong>{basis && <small className="muted">{basis}</small>}{blocked && <span className="stage-blocked">有卡点</span>}{item.brief?.stale && <span className="stage-stale">回报需刷新</span>}</div>
    <ol className="stage-track" aria-label="工作阶段" title="仅标出当前阶段，之前的步骤不代表全部通过">{stages.map((s) => <li key={s.key} aria-current={s.key === stage.key ? 'step' : undefined} className={s.key === stage.key ? 'current' : ''}><i aria-hidden="true" /><span>{s.label}</span></li>)}</ol>
  </div>
}
