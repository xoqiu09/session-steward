import type { BriefField, Session, Snapshot, WorkItem } from './types'
import { field } from './brief'
import { providerLabel, sessionBuckets } from './model'

export const stages = [
  { key: 'planning', label: '准备' }, { key: 'implementing', label: '实施' },
  { key: 'validating', label: '验证' }, { key: 'review', label: '交付待处理' }, { key: 'accepted', label: '已处理' },
] as const
export type Stage = typeof stages[number]['key'] | 'unknown'

export function stageView(w: WorkItem): { key: Stage; label: string; basis: string } {
  if (w.status === 'done') return { key: 'accepted', label: '已处理', basis: '用户已将工作项标记为已处理' }
  if (w.status === 'abandoned') return { key: 'unknown', label: '已放弃', basis: '不计为完成' }
  const value = field(w, 'stage')
  const step = stages.find((s) => s.key === value?.text && ['planning', 'implementing', 'validating'].includes(s.key))
  if (w.status === 'review' && (!step || value!.at <= w.updated_at)) return { key: 'review', label: '等你处理', basis: '已提交交付，等待用户处理' }
  if (step) return { key: step.key, label: { planning: '准备中', implementing: '实施中', validating: '验证中', review: '', accepted: '' }[step.key], basis: value!.kind === 'user' ? '阶段更正' : 'Agent 回报，尚未替代服务校验或用户验收' }
  if (w.status === 'todo') return { key: 'planning', label: '尚未开始', basis: '工作项待开始' }
  return { key: 'unknown', label: '阶段待同步', basis: '没有有效阶段回报；不按运行时长或工具数量猜测' }
}

export function nextOwner(snap: Snapshot, w: WorkItem): string {
  if (w.status === 'review' && stageView(w).key === 'review') return '你'
  if (w.status === 'done' || w.status === 'abandoned') return '已结束'
  if (handoffAnswered(w)) return '已回应，等待 Agent 更新'
  return ownerLabel(snap, field(w, 'next_owner'))
}

export function handoffAnswered(w: WorkItem): boolean {
  const owner = field(w, 'next_owner')
  return owner?.text === 'user' && owner.source !== 'deliver' && !!w.brief?.input_resolved_at && w.brief.input_resolved_at > owner.at
}

export function ownerLabel(snap: Snapshot, owner?: BriefField): string {
  if (owner?.text === 'user') return '你'
  if (owner?.text === 'external') return '外部依赖方'
  if (owner?.text === 'claude' || owner?.text === 'codex') return providerLabel(owner.text)
  if (owner?.text === 'agent') {
    const reporter = (snap.sessions ?? []).find((s) => s.id === owner.session_id)
    return reporter ? providerLabel(reporter.provider) : '执行 Agent'
  }
  return '负责人待回报'
}

export function currentReporters(snap: Snapshot, w: WorkItem): Session[] {
  return sessionBuckets(snap).recent.filter((s) => s.work_item_id === w.id).sort((a, b) => a.id - b.id)
}

// A reporter's phase describes its own contribution, not another session's delivery.
export function reporterItem(w: WorkItem, session: Session): WorkItem {
  const brief = w.brief?.by_session?.[String(session.id)]
  const delivered = brief?.fields.stage?.text === 'review' && !brief.fields.stage.flagged
  return { ...w, status: delivered ? 'review' : 'in_progress', ready: true, waiting: [], brief }
}

export function primaryItem(snap: Snapshot, w: WorkItem): WorkItem {
  const current = currentReporters(snap, w)
  if (current.length !== 1 || !w.brief?.by_session) return w
  const source = w.brief.by_session[String(current[0].id)]
  const fields = { ...source?.fields }
  // Work-item corrections still take precedence over an individual report.
  for (const [key, value] of Object.entries(w.brief.fields)) {
    if (value?.kind === 'user') fields[key as keyof typeof fields] = value
  }
  return { ...w, brief: { ...source, fields, by_session: w.brief.by_session, last_delivered_at: w.brief.last_delivered_at, tool_events_since: source?.tool_events_since ?? 0, last_event_at: source?.last_event_at ?? '', stale: source?.stale ?? false } }
}

export function stageSummary(items: WorkItem[], snap?: Snapshot): string {
  const counts = new Map<Stage | 'parallel', number>()
  items.filter((w) => w.status !== 'abandoned').forEach((w) => {
    const key = snap && w.status !== 'done' && currentReporters(snap, w).length > 1 ? 'parallel' : stageView(w).key
    counts.set(key, (counts.get(key) ?? 0) + 1)
  })
  const summary = [...stages.map((s) => [s.key, s.label] as const), ['parallel', '并行推进'] as const, ['unknown', '待同步'] as const]
    .filter(([key]) => counts.has(key)).map(([key, label]) => `${label} ${counts.get(key)}`).join(' · ')
  const abandoned = items.filter((w) => w.status === 'abandoned').length
  return [summary, abandoned ? `放弃 ${abandoned}` : ''].filter(Boolean).join(' · ')
}

export function shortText(text: string, limit = 90) {
  const chars = Array.from(text)
  return chars.length > limit ? `${chars.slice(0, limit).join('')}…` : text
}
