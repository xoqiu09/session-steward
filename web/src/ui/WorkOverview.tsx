import type { Snapshot, WorkItem } from '../types'
import { field } from '../brief'
import { openApprovals, sessionsFor, ago } from '../model'
import { attentionManaged, managementLabel } from '../workManagement'

export function requestsForItem(snap: Snapshot, item: WorkItem) {
  const sessions = new Set(sessionsFor(snap, item.id).map(s => s.id))
  return openApprovals(snap).filter(a => a.work_item_id ? a.work_item_id === item.id : a.session_id != null && sessions.has(a.session_id))
}

export function nextActionFor(snap: Snapshot, item: WorkItem) {
  const requests = requestsForItem(snap, item)
  if (requests.some(a => a.kind === 'permission')) return '有一项操作权限需要你处理，请查看下方请求。'
  if (requests.some(a => a.kind === 'decision')) return 'Agent 有问题需要你回答，请查看下方问题。'
  if (requests.some(a => a.kind === 'merge' && a.status === 'pending')) return item.status === 'done'
    ? '这项工作已标记完成，还有一次代码合并等你决定。请核对下方改动后处理。'
    : '有一次代码合并等你决定。请核对下方改动后处理；工作交付仍需另行验收。'
  if (requests.some(a => a.kind === 'merge')) return '代码合并已经批准，结果尚待确认。下方可查看后续操作。'
  if (attentionManaged(item)) return `${managementLabel(item)}。需要恢复时，点右上角“管理状态”。`
  if (item.automatic_issue) return item.automatic_issue
  if (item.status === 'review' && item.completion_policy !== 'auto_history') return '这项工作已交付，等你处理。处理完可点“已处理”，需要补充就退回修改。'
  if (['done', 'abandoned'].includes(item.status)) return '目前没有需要你处理的请求。后续有变化时会重新提示。'
  if (!item.ready) return `先等上游工作 ${item.waiting.join('、')} 完成。`
  const next = field(item, 'next')?.text
  if (next) return next
  if (field(item, 'blocker') || item.status === 'blocked') return '有卡点需要跟进。可在右上角管理状态，或展开完整简报查看来源。'
  return '暂时没有明确交给你的下一步，可等 Agent 回报进展。'
}

export function WorkOverview({ snap, item }: { snap: Snapshot; item: WorkItem }) {
  if (item.completion_policy === 'auto_history') return <section className="work-overview" aria-label="记忆整理说明">
    <div><h3>{item.automatic_history ? '这轮整理已完成' : '记忆整理无需逐轮验收'}</h3>
      <p>普通整理完成后自动收进历史，无需逐轮验收。只有具体问题、操作权限或整理异常才会提醒你。</p>
    </div>
    {item.automatic_issue && item.automatic_issue_kind !== 'formal' && <div className="work-overview-blocker"><h3>需要检查的原因</h3><p>{item.automatic_issue}</p></div>}
  </section>
  const goal = field(item, 'goal')
  const report = field(item, 'summary') ?? field(item, 'progress')
  const blocker = !attentionManaged(item) && !['done', 'abandoned'].includes(item.status) ? field(item, 'blocker') : undefined
  const merge = !item.needs_merge ? '无需代码合并' : item.merge_state === 'merged' ? '代码合并已确认' : item.merge_state === 'approved' ? '合并已批准，结果待确认' : item.merge_state === 'awaiting' ? '代码合并待批准' : '代码合并尚未确认'
  return <section className="work-overview" aria-label="工作摘要">
    {goal && <div><h3>这项工作做什么</h3><p>{goal.text}</p><small className="muted">{goal.kind === 'user' ? '你填写的目标' : 'Agent 回报的目标'}</small></div>}
    <div><h3>最近进展</h3><p>{report?.text || '还没有收到工作进展说明。'}</p>
      {report && <small className="muted">{report.kind === 'user' ? '你填写或确认' : 'Agent 自述'} · {ago(report.at, snap.now)}</small>}
    </div>
    {blocker && <div className="work-overview-blocker"><h3>卡在哪里</h3><p>{blocker.text}</p></div>}
    <div className="work-overview-next"><h3>现在需要你做什么</h3><p>{nextActionFor(snap, item)}</p></div>
    <p className="work-overview-merge">{merge} · 工作完成与代码合并分别记录</p>
  </section>
}
