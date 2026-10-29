import type { ManagedSession, Session, Snapshot, WorkItem } from './types'
import { field } from './brief'
import { attentionManaged } from './workManagement'
import { groupByRepo, scopedAttention, type Group } from './model'
import { queueCount } from './Queue'
import { orderedProjects, PROJECT_RECENT_MS } from './projectActivity'
import { periodicView, queueLanes } from './workbench'

export const managedStateLabel: Record<ManagedSession['state'], string> = {
  starting: '启动中', running: '运行中', exited: '已退出', stopped: '已停止', failed: '启动失败', archived: '已归档',
}

export const managedFor = (snap: Snapshot, itemId: string) => (snap.managed ?? []).filter((m) => m.work_item_id === itemId && m.state !== 'archived')
export const managedOfSession = (snap: Snapshot, s: Session) => (snap.managed ?? []).find((m) => m.session_id === s.id || (m.state !== 'archived' && !!s.worktree && m.worktree === s.worktree))

const live = (s: Session) => s.data_source === 'live' && s.freshness === 'live'
const blocked = (w: WorkItem) => !attentionManaged(w) && (!!w.automatic_issue || !['done', 'abandoned', 'review'].includes(w.status) && (w.status === 'blocked' || !w.ready || !!field(w, 'blocker')?.text))

// 顶部一行汇总：只按实际事件、回报与审批计数，不估算进度。
export function liveSummary(snap: Snapshot, repoId: number | 'all' = 'all', provider = 'all') {
  const inRepo = (r: number | null | undefined) => repoId === 'all' || r === repoId
  const sessions = (snap.sessions ?? []).filter((s) => (provider === 'all' || s.provider === provider) && inRepo(s.repo_id))
  const current = orderedProjects(snap, groupByRepo(snap, { query: '', showDone: false, repoId, provider }), provider).filter(p => !p.quiet)
  const items = current.flatMap(p => p.group.items)
  const running = sessions.filter((s) => live(s) && (s.state === 'running' || s.state === 'waiting_permission')).length
  const managedRunning = (snap.managed ?? []).filter((m) => inRepo(m.repo_id) && (provider === 'all' || m.agent === provider) && m.state === 'running' && m.session_id == null).length
  return {
    waiting: queueCount(snap, repoId, provider),
    running: running + managedRunning,
    blocked: items.filter(blocked).length,
    quiet: sessions.filter((s) => s.data_source === 'live' && s.freshness === 'stale').length,
  }
}

export type Actor = 'user' | 'agent' | 'review' | 'issue' | 'external' | 'idle' | 'unknown'
export const actorLabel: Record<Actor, string> = { user: '需你处理', agent: 'Agent 在做', review: '待审阅／验收', issue: '自动任务需检查', external: '等外部', idle: '暂无进行中', unknown: '待回报' }

// Formal requests need action now; ordinary review does not imply execution is blocked.
export function projectActor(snap: Snapshot, repoId: number | null, scopedItems?: WorkItem[], provider = 'all'): Actor {
  const items = (scopedItems ?? periodicView(snap).current).filter((w) => w.repo_id === repoId && !['done', 'abandoned'].includes(w.status))
  if (!items.length) return 'idle'
  const ids = new Set(items.map((w) => w.id))
  const sessions = (snap.sessions ?? []).filter((s) => ids.has(s.work_item_id) && (provider === 'all' || s.provider === provider))
  const lanes = queueLanes(scopedAttention(snap, repoId ?? 'all', provider), snap.now)
  if (lanes.counts.action) return 'user'
  const reminders = items.filter(w => !attentionManaged(w))
  if (reminders.some(w => w.automatic_issue)) return 'issue'
  if (sessions.some((s) => live(s) && ['running', 'waiting_permission'].includes(s.state)) || (snap.managed ?? []).some((m) => ids.has(m.work_item_id) && m.state === 'running' && (provider === 'all' || m.agent === provider))) return 'agent'
  const recent = (at?: string) => Date.parse(snap.now) - Date.parse(at || '') >= 0 && Date.parse(snap.now) - Date.parse(at || '') < PROJECT_RECENT_MS
  if (!reminders.length) return 'idle'
  const reviewing = reminders.filter(w => w.status === 'review' || lanes.review.some(r => r.id === w.id))
  const owners = reminders.filter(w => !reviewing.includes(w)).map((w) => field(w, 'next_owner')).filter(f => f && recent(f.at)).map(f => f!.text)
  const agentOwns = owners.some((o) => o === 'agent' || o === 'claude' || o === 'codex')
  // A review delivered more than a day ago does not outrank another item an Agent reported owning today.
  // updated_at is not used as the delivery time because Git scans also move it.
  if (reviewing.some(w => recent(w.brief?.last_delivered_at)) || (reviewing.length && !agentOwns)) return 'review'
  if (agentOwns) return 'agent'
  if (owners.some((o) => o === 'external')) return 'external'
  return 'unknown'
}

export function projectActorRows(snap: Snapshot, groups: Group[], provider = 'all') {
  const rows = orderedProjects(snap, groups, provider).filter(p => p.group.repoId != null)
    .map(p => ({ ...p, actor: projectActor(snap, p.group.repoId, p.group.items, provider) }))
    .filter(p => p.actor !== 'idle')
  return { recent: rows.filter(p => !p.quiet), quiet: rows.filter(p => p.quiet) }
}


// 深链：#approval=ID、#item=ID、#session=N
export type Deep = { kind: 'item'; id: string } | { kind: 'session'; id: number } | { kind: 'approval'; id: string } | null
export function parseDeepLink(hash: string): Deep {
  const p = new URLSearchParams(hash.replace(/^#/, ''))
  if (p.get('approval')) return { kind: 'approval', id: p.get('approval')! }
  if (p.get('item')) return { kind: 'item', id: p.get('item')! }
  const s = Number(p.get('session'))
  if (Number.isInteger(s) && s > 0) return { kind: 'session', id: s }
  return null
}

// 审批深链落到对应工作项（没有工作项时落到会话），保持原有的允许/拒绝与指纹校验。
export function resolveDeepLink(snap: Snapshot, d: Deep): { kind: 'item'; id: string } | { kind: 'session'; id: number } | null {
  if (!d) return null
  if (d.kind !== 'approval') return d
  const a = (snap.approvals ?? []).find((x) => x.id === d.id)
  if (!a) return null
  const s = (snap.sessions ?? []).find((x) => x.id === a.session_id)
  const item = a.work_item_id || s?.work_item_id
  if (item) return { kind: 'item', id: item }
  return a.session_id != null ? { kind: 'session', id: a.session_id } : null
}
