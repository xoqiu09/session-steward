// 直播展示的第二道防线：服务端已经脱敏；这里在前端再按白名单重建一次，
// 即使有人误把完整快照传进展示视图，画面上也不会出现项目名、路径、标题等文字。
import type { Dep, Repo, Run, Session, Signal, Snapshot, WorkItem } from '../types'

/** 按名次给出通用项目名：项目 A … 项目 Z，之后是“项目 27”。与服务端同一规则。 */
export function liveProjectName(rank: number): string {
  return rank >= 0 && rank < 26 ? `项目 ${String.fromCharCode(65 + rank)}` : `项目 ${rank + 1}`
}

/** 项目编号按升序排名映射成通用名；新增更大编号的项目不改变已有名称。 */
export function liveProjectNames(ids: readonly number[]): Map<number, string> {
  const out = new Map<number, string>()
  for (const id of [...new Set(ids)].sort((a, b) => a - b)) out.set(id, liveProjectName(out.size))
  return out
}

const oneOf = <T extends string>(v: unknown, allowed: readonly T[], fallback: T | '' = ''): T | '' => (allowed as readonly unknown[]).includes(v) ? v as T : fallback
const time = (v: unknown): string => (typeof v === 'string' && v && !Number.isNaN(Date.parse(v)) ? v : '')
const provider = (p: unknown): string => (p === 'claude' || p === 'codex' || p === 'gemini' || p === 'cursor' || p === 'opencode' ? p : p ? 'other' : '')
const CHANNELS = ['hook', 'transcript', 'process', 'git', 'github', 'hub', 'model', 'user'] as const
const signal = (s: Signal | undefined): Signal | undefined => (s && oneOf(s.channel, CHANNELS) && time(s.at) ? { channel: s.channel, at: s.at } : undefined)

/** 已经是服务端换过的不透明编号就沿用；否则在前端换一个（同一页面里稳定）。 */
function itemId(id: unknown): string {
  if (typeof id !== 'string' || !id) return ''
  if (/^item-[0-9a-f]{6,16}$/.test(id)) return id
  let h = 0x811c9dc5
  for (const ch of id) h = Math.imul(h ^ ch.codePointAt(0)!, 0x01000193) >>> 0
  return `item-${h.toString(16).padStart(8, '0')}`
}

const OUTCOMES = ['delivered', 'failed', 'error', 'interrupted', 'cancelled', 'abandoned', 'acknowledged', 'unsent', 'uncertain', 'handed_off', 'attribution_reverted', 'historical', 'ended', 'ended_with_question', 'stopped', 'held'] as const

/** 白名单重建：只保留画面需要的编号、关联、状态和时间。 */
export function liveScrub(s: Snapshot): Snapshot {
  const names = liveProjectNames((s.repos ?? []).map((r) => r.id))
  const repos: Repo[] = (s.repos ?? []).map((r) => ({
    id: r.id, name: names.get(r.id)!, common_dir: '', is_git: !!r.is_git, target_ref: '',
    ...(oneOf(r.activity, ['active', 'quiet', 'dormant'] as const) ? { activity: r.activity } : {}),
    ...(time(r.last_activity_at) ? { last_activity_at: r.last_activity_at } : {}),
  }))
  const sessions: Session[] = (s.sessions ?? []).map((x) => ({
    id: x.id, host_id: '', provider: provider(x.provider), provider_session_id: '', client: '', version: '', cwd: '', worktree: '', branch: '',
    repo_id: x.repo_id ?? null,
    // 展示画面不出现“等你决定”：等权限的会话按空闲画。
    state: (x.state === 'waiting_permission' ? 'idle' : oneOf(x.state, ['running', 'idle', 'interrupted', 'error', 'ended', 'unknown'] as const, 'unknown')) as Session['state'],
    state_reason: '', data_source: oneOf(x.data_source, ['live', 'history'] as const, 'history') as Session['data_source'],
    freshness: oneOf(x.freshness, ['live', 'history', 'stale'] as const, 'history') as Session['freshness'],
    suggested_work_item: '', first_seen_at: time(x.first_seen_at), last_activity_at: time(x.last_activity_at), last_progress_at: time(x.last_progress_at),
    work_item_id: itemId(x.work_item_id), binding: '', worktree_conflict: !!x.worktree_conflict, resume_command: '', title: '',
    ...(time(x.last_tool_at) ? { last_tool_at: x.last_tool_at } : {}), ...(signal(x.signal) ? { signal: signal(x.signal) } : {}),
  }))
  const items: WorkItem[] = (s.work_items ?? []).map((w) => ({
    id: itemId(w.id), repo_id: w.repo_id ?? null, title: '工作项',
    status: oneOf(w.status, ['todo', 'in_progress', 'blocked', 'review', 'done', 'abandoned'] as const, 'todo') as WorkItem['status'],
    acceptance: '', branch: '', merge_state: oneOf(w.merge_state, ['none', 'not_ready', 'awaiting', 'approved', 'merged'] as const, 'none') as WorkItem['merge_state'],
    needs_merge: !!w.needs_merge, created_at: time(w.created_at), updated_at: time(w.updated_at), ready: !!w.ready,
    waiting: (w.waiting ?? []).map(itemId), agents: (w.agents ?? []).map(provider), brief: null,
    ...(time(w.returned_at) ? { returned_at: w.returned_at } : {}), ...(signal(w.signal) ? { signal: signal(w.signal) } : {}),
  }))
  const deps: Dep[] = (s.deps ?? []).map((d) => ({ upstream: itemId(d.upstream), downstream: itemId(d.downstream), cond: d.cond === 'merged' ? 'merged' : 'accepted', satisfied: !!d.satisfied }))
  const runs: Run[] = (s.runs ?? []).map((r) => ({
    id: r.id, work_item_id: itemId(r.work_item_id), session_id: r.session_id, provider: provider(r.provider), attempt: r.attempt, binding: '',
    started_at: time(r.started_at), ended_at: time(r.ended_at),
    outcome: typeof r.outcome === 'string' && r.outcome.startsWith('failed') ? 'failed' : oneOf(r.outcome, OUTCOMES),
  }))
  return { cursor: s.cursor, now: time(s.now) || new Date().toISOString(), repos, sessions, work_items: items, deps, runs, approvals: [] }
}
