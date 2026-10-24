import type { Approval, FeatureContribution, ProjectFeature, Snapshot, WorkItem } from './types'
import type { ReportedHandoff } from './model'

// Only explicitly recurring titles and the built-in memory maintenance family are folded.
// Similar business task titles, different branches, and live/blocked rounds remain separate.
export function recurringKey(w: WorkItem): string | null {
  const title = (w.title ?? '').trim().toLowerCase().replace(/\s+/g, '')
  const memory = /^(整合|整理)(本地)?(代理|agent)?记忆$/.test(title)
  if (!memory && !/^(每小时|每日|每天|每周|每月|定期|周期|daily|weekly|monthly)/.test(title)) return null
  return JSON.stringify([w.repo_id, w.branch, memory ? 'memory-maintenance' : title])
}

function reportedAt(w: WorkItem) {
  return [w.created_at, ...Object.values(w.brief?.fields ?? {}).map(f => f?.at ?? '')].sort().at(-1) ?? w.created_at
}

export function periodicView(snap: Snapshot, items: WorkItem[] = snap.work_items ?? []) {
  const groups = new Map<string, WorkItem[]>()
  for (const w of items) {
    if (w.completion_policy === 'auto_history') continue
    const key = recurringKey(w)
    if (key) groups.set(key, [...(groups.get(key) ?? []), w])
  }
  const history: WorkItem[] = []
  for (const w of items) if (w.completion_policy === 'auto_history' && w.automatic_history && !w.automatic_issue) history.push(w)
  for (const rounds of groups.values()) {
    rounds.sort((a, b) => reportedAt(b).localeCompare(reportedAt(a)) || b.created_at.localeCompare(a.created_at) || b.id.localeCompare(a.id))
    for (const w of rounds.slice(1)) {
      const sessionIds = new Set((snap.sessions ?? []).filter(s => s.work_item_id === w.id).map(s => s.id))
      const request = (snap.approvals ?? []).some(a => ['pending', 'decided'].includes(a.status) && ['permission', 'decision', 'merge'].includes(a.kind) && (a.work_item_id ? a.work_item_id === w.id : a.session_id != null && sessionIds.has(a.session_id)))
      const active = (snap.sessions ?? []).some(s => sessionIds.has(s.id) && s.freshness === 'live' && s.data_source === 'live' && ['running', 'waiting_permission'].includes(s.state))
      if (['review', 'done', 'abandoned'].includes(w.status) && !active && !request) history.push(w)
    }
  }
  const hidden = new Set(history.map(w => w.id))
  return { current: items.filter(w => !hidden.has(w.id)), history, hidden }
}

export interface MergeGroup { key: string; primary: Approval; members: Approval[]; workItemIds: string[]; stale: boolean; valid: boolean }
export function mergeGroups(approvals: Approval[]): MergeGroup[] {
  const groups = new Map<string, MergeGroup>()
  for (const a of approvals) {
    const p = a.payload
    const parts = [a.repo_id ?? p.repo_id, p.source_ref, p.source_head_sha, p.target_ref, p.target_base_sha]
    const complete = typeof parts[0] === 'number' && parts[0] > 0 && parts.slice(1).every(v => typeof v === 'string' && v.length > 0)
    const key = complete ? JSON.stringify(parts) : a.id
    const group = groups.get(key) ?? { key, primary: a, members: [], workItemIds: [], stale: false, valid: complete }
    group.members.push(a)
    group.stale ||= !!p.stale
    if (a.work_item_id && !group.workItemIds.includes(a.work_item_id)) group.workItemIds.push(a.work_item_id)
    groups.set(key, group)
  }
  for (const g of groups.values()) {
    g.members.sort((a, b) => Number(b.status === 'pending') - Number(a.status === 'pending') || Number(!!b.payload.copied_at) - Number(!!a.payload.copied_at) || b.created_at.localeCompare(a.created_at) || a.id.localeCompare(b.id))
    g.primary = g.members[0]
  }
  return [...groups.values()]
}

// Same-named distinct repositories keep their identity, with an explicit path label.
export function repoLabel(snap: Snapshot, id: number | null): string {
  const repo = (snap.repos ?? []).find(r => r.id === id)
  if (!repo) return '未关联仓库'
  if ((snap.repos ?? []).filter(r => r.name.toLowerCase() === repo.name.toLowerCase()).length < 2) return repo.name
  const path = repo.common_dir.replace(/^dir:/, '').replace(/\/\.git$/, '')
  return `${repo.name} · ${path.split('/').slice(-3).join('/')}`
}

export interface FeatureAdvice { feature: ProjectFeature; contribution: FeatureContribution }
export interface AdviceGroup { id: string; reported: ReportedHandoff[]; features: FeatureAdvice[] }
export interface RawAttention { permission: Approval[]; decision: Approval[]; merge: Approval[]; attention: Approval[]; reported: ReportedHandoff[]; features: FeatureAdvice[]; blocked: WorkItem[]; review: WorkItem[] }

export function organizeAttention(q: RawAttention) {
  const merge = mergeGroups(q.merge)
  const mergedItems = new Set(merge.flatMap(g => g.workItemIds))
  const groups = new Map<string, AdviceGroup>()
  const get = (id: string) => {
    const g = groups.get(id) ?? { id, reported: [], features: [] }
    groups.set(id, g); return g
  }
  for (const r of q.reported) get(r.item.id).reported.push(r)
  for (const f of q.features) get(f.contribution.work_item_id).features.push(f)
  const allAdvisories = [...groups.values()]
  const covered = new Set([...mergedItems, ...groups.keys()])
  const blocked = q.blocked.filter(w => !covered.has(w.id))
  const blockedIds = new Set(blocked.map(w => w.id))
  return { ...q, merge, allAdvisories, allReview: q.review, advisories: allAdvisories.filter(g => !mergedItems.has(g.id)),
    review: q.review.filter(w => !covered.has(w.id) && !blockedIds.has(w.id)), blocked }
}

export function attentionCount(q: ReturnType<typeof organizeAttention>) {
  return q.permission.length + q.decision.length + q.merge.length + q.advisories.length + q.blocked.length + q.review.length
}

export interface ReviewGroup { id: string; item?: WorkItem; advice?: AdviceGroup }
export interface QueueCounts { action: number; review: number; tracking: number }

// Formal requests, ordinary review and execution follow-up are independent lanes.
// An approval never silently accepts the associated work item.
export function queueLanes(q: ReturnType<typeof organizeAttention>, now?: string) {
  const permission = q.permission.filter(a => a.status === 'pending' && !(a.deadline && Date.parse(a.deadline) <= Date.parse(now || '')))
  const decision = q.decision.filter(a => a.status === 'pending')
  const merge = q.merge.filter(g => g.primary.status === 'pending' && !g.stale && g.valid)
  const reviews = new Map<string, ReviewGroup>()
  for (const item of q.allReview) reviews.set(item.id, { id: item.id, item })
  for (const advice of q.allAdvisories) reviews.set(advice.id, { ...reviews.get(advice.id), id: advice.id, advice })
  const followingPermission = q.permission.filter(a => !permission.includes(a))
  const followingDecision = q.decision.filter(a => a.status !== 'pending')
  const followingMerge = q.merge.filter(g => !merge.includes(g))
  const review = [...reviews.values()]
  const counts: QueueCounts = { action: permission.length + decision.length + merge.length, review: review.length,
    tracking: followingPermission.length + followingDecision.length + followingMerge.length + q.blocked.length }
  return { permission, decision, merge, review, followingPermission, followingDecision, followingMerge, blocked: q.blocked, counts }
}
