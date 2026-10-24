import type { Snapshot, WorkItem } from './types'
import { ago, itemStatusLabel } from './model'

export function HistoryItems({ snap, items, onSelect }: { snap: Snapshot; items: WorkItem[]; onSelect: (id: string) => void }) {
  if (!items.length) return null
  const automatic = items.some(w => w.completion_policy === 'auto_history')
  return <details className="periodic-history"><summary>{automatic ? '自动任务历史' : '周期任务历史'} · {items.length} 轮</summary>
    <p className="hint">{automatic ? '成功的例行整理按规则归档，无需逐轮验收。完成来自 Agent 回报；失败、卡点和正式决定仍会显示。' : '默认只展示最近回报的一轮。旧轮次、会话和验收状态全部保留；这里没有自动验收。'}</p>
    {items.map(w => <button className="q-line" key={w.id} onClick={() => onSelect(w.id)}><span className="pill">{w.id}</span><span>{w.title}<small className="muted"> · {w.automatic_history ? '已归档（Agent 回报完成）' : itemStatusLabel[w.status]} · {ago(w.brief?.last_delivered_at || w.updated_at, snap.now)}</small></span></button>)}
  </details>
}
