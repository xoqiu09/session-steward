// 小镇的新动态只描述快照的变化；不写审批、验收、合并或任何服务端状态。
import type { Approval, Snapshot, WorkItem } from '../types'
import { HUB_STRIDE } from '../hub/ids'
import { attentionManaged } from '../workManagement'

export type MomentKind = 'decision' | 'ripe' | 'merged' | 'progress'
export interface TownMoment {
  key: string
  kind: MomentKind
  at: string
  buildingKey: string
  itemId?: string
  approvalId?: string
  local: boolean
  message: string
}

export const MOMENT_WINDOW_MS = 3000
export const MAP_QUIET_MS = 30_000
const PRIORITY: Record<MomentKind, number> = { decision: 1, ripe: 2, merged: 3, progress: 4 }
const time = (s: string | undefined) => Date.parse(s || '') || 0
const visibleItem = (w: WorkItem) => !attentionManaged(w) && w.completion_policy !== 'auto_history' && !w.automatic_history
const pending = (a: Approval, now: string) => a.status === 'pending' && (a.kind === 'permission' || a.kind === 'decision') &&
  !(a.kind === 'permission' && a.deadline && time(a.deadline) <= time(now))

/** 合并视图带设备名/偏移编号；缺少本机设备身份时也不把别台工作当成本机。 */
export function localMoment(s: Snapshot, repoId: number | null, itemId?: string, sessionId?: number | null): boolean {
  if ((repoId ?? 0) >= HUB_STRIDE || (sessionId ?? 0) >= HUB_STRIDE) return false
  const repo = (s.repos ?? []).find((r) => r.id === repoId)
  if (repo?.device) return repo.device === s.devices?.find((d) => d.self)?.name
  return !(s.devices?.length && itemId?.includes(':'))
}

export function sortMoments(moments: readonly TownMoment[]): TownMoment[] {
  return [...moments].sort((a, b) => PRIORITY[a.kind] - PRIORITY[b.kind] || time(b.at) - time(a.at) || a.key.localeCompare(b.key))
}

function itemMoment(s: Snapshot, w: WorkItem, kind: Exclude<MomentKind, 'decision'>, at: string): TownMoment {
  const repo = (s.repos ?? []).find((r) => r.id === w.repo_id)
  const project = repo?.name || '未归属'
  const message = kind === 'ripe' ? `${project}：${w.id} 熟了，可以收`
    : kind === 'merged' ? `${w.id} 已合并进 ${w.merge_evidence?.target_ref || repo?.target_ref || '目标分支'}`
    : `${project}：${w.id} 有了新进展`
  return { key: JSON.stringify([w.id, kind, at]), kind, at, buildingKey: `repo-${w.repo_id ?? 'none'}`, itemId: w.id,
    local: localMoment(s, w.repo_id, w.id), message }
}

function approvalMoment(s: Snapshot, a: Approval): TownMoment {
  const session = (s.sessions ?? []).find((v) => v.id === a.session_id)
  const itemId = a.work_item_id || session?.work_item_id || undefined
  const item = (s.work_items ?? []).find((w) => w.id === itemId)
  const repoId = a.repo_id ?? item?.repo_id ?? session?.repo_id ?? null
  const repo = (s.repos ?? []).find((r) => r.id === repoId)
  const agent = session?.provider === 'claude' ? 'Claude' : session?.provider === 'codex' ? 'Codex' : 'Agent'
  return { key: JSON.stringify([a.id, 'decision', a.created_at]), kind: 'decision', at: a.created_at,
    buildingKey: `repo-${repoId ?? 'none'}`, itemId, approvalId: a.id, local: localMoment(s, repoId, itemId, a.session_id),
    message: `${repo?.name || '未归属'}：${agent} ${a.kind === 'permission' ? '在等你允许一条命令' : '有个问题等你决定'}` }
}

function progressAt(w: WorkItem): string {
  const fields = [w.brief, ...Object.values(w.brief?.by_session ?? {})].flatMap((b) => b ? Object.values(b.fields) : [])
  return fields.filter((f) => f?.kind === 'agent' && f.source === 'report' && !f.flagged)
    .map((f) => f!.at).sort((a, b) => time(b) - time(a))[0] || ''
}

/** 首屏是基线；同状态的时间更新不是一次新交付。旧快照、重复记录不产生第二次动态。 */
export function momentsBetween(before: Snapshot | null, next: Snapshot): TownMoment[] {
  if (!before || (next.cursor < before.cursor && time(next.now) <= time(before.now))) return []
  const items = new Map((before.work_items ?? []).map((w) => [w.id, w]))
  const approvals = new Map((before.approvals ?? []).map((a) => [a.id, a]))
  const out: TownMoment[] = []
  for (const w of next.work_items ?? []) {
    if (!visibleItem(w)) continue
    const prev = items.get(w.id)
    if (prev && time(w.updated_at) < time(prev.updated_at)) continue
    if (w.status === 'review' && prev?.status !== 'review') out.push(itemMoment(next, w, 'ripe', w.brief?.last_delivered_at || w.updated_at))
    if (w.merge_state === 'merged' && prev?.merge_state !== 'merged') out.push(itemMoment(next, w, 'merged', w.merge_evidence?.checked_at || w.updated_at))
    const report = progressAt(w)
    if (!['done', 'abandoned', 'review'].includes(w.status) && ((report && (!prev || time(report) > time(progressAt(prev)))) ||
      (prev?.status === 'todo' && w.status === 'in_progress'))) out.push(itemMoment(next, w, 'progress', report || w.updated_at))
  }
  for (const a of next.approvals ?? []) {
    if (pending(a, next.now) && (!approvals.has(a.id) || !pending(approvals.get(a.id)!, before.now))) out.push(approvalMoment(next, a))
  }
  return sortMoments([...new Map(out.map((m) => [m.key, m])).values()])
}

export function momentCurrent(m: TownMoment, s: Snapshot): boolean {
  if (m.kind === 'decision') return (s.approvals ?? []).some((a) => a.id === m.approvalId && pending(a, s.now))
  const w = (s.work_items ?? []).find((w) => w.id === m.itemId)
  if (!w || !visibleItem(w)) return false
  return m.kind === 'ripe' ? w.status === 'review' : m.kind === 'merged' ? w.merge_state === 'merged' : !['done', 'abandoned'].includes(w.status)
}

export function updateMomentQueue(queue: readonly TownMoment[], incoming: readonly TownMoment[], s: Snapshot): TownMoment[] {
  // 低优先级进展只冒火花，不成为可导航、可弹卡片的待办。
  return sortMoments([...new Map([...queue, ...incoming].filter((m) => m.kind !== 'progress' && momentCurrent(m, s)).map((m) => [m.key, m])).values()])
}

/** 上次看过之后的熟菜和待决定只入离开提示，不触发首屏自动飞行。 */
export function momentsWhileAway(s: Snapshot, since: number | null): TownMoment[] {
  if (since == null) return []
  const items = (s.work_items ?? []).filter((w) => visibleItem(w) && w.status === 'review')
    .map((w) => itemMoment(s, w, 'ripe', w.brief?.last_delivered_at || w.updated_at))
  const decisions = (s.approvals ?? []).filter((a) => pending(a, s.now)).map((a) => approvalMoment(s, a))
  return sortMoments([...items, ...decisions].filter((m) => time(m.at) > since))
}

export interface FollowPreferences { enabled: boolean; includeMerged: boolean }
export const DEFAULT_FOLLOW: FollowPreferences = { enabled: true, includeMerged: false }
export const FOLLOW_KEY = 'ss.town.follow.v1'
export const LAST_SEEN_KEY = 'ss.town.lastSeen.v1'

export function autoMoment(m: TownMoment, p: FollowPreferences): boolean {
  return p.enabled && m.local && (m.kind === 'decision' || m.kind === 'ripe' || (m.kind === 'merged' && p.includeMerged))
}

export interface FollowGuard {
  now: number; lastTouch: number; lastFlight: number
  paused: boolean; inside: boolean; harvesting: boolean; replaying: boolean; guide: boolean; hidden: boolean; offline: boolean; presenting: boolean
}
export function canAutoFollow(g: FollowGuard): boolean {
  return g.now - g.lastTouch >= MAP_QUIET_MS && g.now - g.lastFlight >= MOMENT_WINDOW_MS &&
    !g.paused && !g.inside && !g.harvesting && !g.replaying && !g.guide && !g.hidden && !g.offline && !g.presenting
}
