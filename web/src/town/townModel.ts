// 把 SS Snapshot 适配成小镇画面模型。纯函数，不连接任何服务。
//
// 规则：
// - 一个 Session 一个角色，按 session.id 映射，不按 provider 合并。
// - Run 每个 id 一个包裹；同 id 的重复记录只保留更新的那条，重连不会多出包裹。
// - 旧 cursor 的快照不能覆盖新快照。
// - stale 会话显示“状态待更新”，history 会话不当成当前工作。
// - idle/ended 不等于完成；review 是“待验收”，只有用户能把它变成 done。
// - Run.outcome 只识别明确的字符串，其余原样显示，不猜测成功。
import type { Approval, Dep, Repo, Run, Session, Snapshot, WorkItem } from '../types'
import type { Relay } from './relays'
import { attentionManaged } from '../workManagement'
import { shownNo } from '../hub/ids'

export type ConnectionState = 'demo' | 'connecting' | 'live' | 'offline' | 'unauthorized'

export type CharacterStatus = 'working' | 'waiting' | 'error' | 'idle' | 'interrupted' | 'ended' | 'stale' | 'unknown'

export type ParcelPhase = 'moving' | 'delivered' | 'failed' | 'interrupted' | 'other'

export type Highlight = 'working' | 'waiting' | 'failed' | 'review' | 'stale'

export interface CharacterView {
  key: string
  session: Session
  status: CharacterStatus
  name: string
  item: WorkItem | null
  pendingApprovals: Approval[]
  runs: ParcelView[]
}

export interface ParcelView {
  key: string
  run: Run
  phase: ParcelPhase
  item: WorkItem | null
  session: Session | null
}

export interface BuildingView {
  key: string
  repo: Repo | null
  name: string
  characters: CharacterView[]
  /** 超出场景工位（MAX_SEATS）的角色数，只在列表里看得到。 */
  hiddenCharacters: number
  items: WorkItem[]
  parcels: ParcelView[]
}

export interface TownModel {
  now: string
  cursor: number
  buildings: BuildingView[]
  historySessions: Session[]
  pendingApprovals: Approval[]
  closedApprovals: Approval[]
  reviewItems: WorkItem[]
  deps: Dep[]
  /** 最近一天里，工作在不同 Agent 之间的交接和接力（小推车）。 */
  relays: Relay[]
  counts: Record<Highlight, number>
}

/** 每栋建筑前最多画几个工位。 */
export const MAX_SEATS = 3

const STALE_AFTER_MS = 30 * 60 * 1000

export function providerLabel(s: Pick<Session, 'provider' | 'client'>): string {
  if (s.provider === 'claude') return 'Claude'
  if (s.provider === 'codex') return 'Codex'
  return s.client || s.provider || '未知'
}

export const itemStatusLabel: Record<WorkItem['status'], string> = {
  todo: '待开始', in_progress: '进行中', blocked: '受阻', review: '待验收', done: '已完成', abandoned: '已放弃',
}

export const characterStatusLabel: Record<CharacterStatus, string> = {
  working: '工作中', waiting: '等你决定', error: '出错', idle: '空闲（未完成）', interrupted: '已中断', ended: '会话结束', stale: '状态待更新', unknown: '状态未知',
}

export const parcelPhaseLabel: Record<ParcelPhase, string> = {
  moving: '运行中', delivered: '已交付', failed: '失败', interrupted: '中断', other: '已结束',
}

export const approvalKindLabel: Record<Approval['kind'], string> = {
  permission: '权限请求', merge: '合并请求', decision: '需要决定', attention: '提醒',
}

export const approvalStatusLabel: Record<Approval['status'], string> = {
  pending: '等你决定', decided: '已决定，未送达', delivered: '已送达 Agent', confirmed: 'Agent 已确认', expired: '已过期', cancelled: '已取消',
}

/** 按字符截断，超出用 … 结尾。 */
export function clip(text: string, max: number): string {
  const chars = Array.from(text)
  return chars.length > max ? `${chars.slice(0, max - 1).join('')}…` : text
}

function time(s: string | null | undefined): number {
  if (!s) return 0
  const t = Date.parse(s)
  return Number.isNaN(t) ? 0 : t
}

/** 同 id 只保留 newer 判定为更新的那条，保持首次出现的顺序。 */
export function dedupeById<T, K>(list: readonly T[] | null | undefined, id: (x: T) => K, newer: (a: T, b: T) => boolean): T[] {
  const order: K[] = []
  const byId = new Map<K, T>()
  for (const x of list ?? []) {
    const k = id(x)
    const prev = byId.get(k)
    if (prev === undefined) { order.push(k); byId.set(k, x) } else if (newer(x, prev)) byId.set(k, x)
  }
  return order.map((k) => byId.get(k)!)
}

function runNewer(a: Run, b: Run): boolean {
  if (!!a.ended_at !== !!b.ended_at) return !!a.ended_at
  return time(a.ended_at || a.started_at) > time(b.ended_at || b.started_at)
}

const approvalStamp = (a: Approval) => Math.max(time(a.created_at), time(a.decided_at), time(a.delivered_at), time(a.confirmed_at), time(a.closed_at))

/** 旧 cursor 的快照不覆盖新快照。 */
export function mergeSnapshot(prev: Snapshot | null, next: Snapshot): Snapshot {
  if (prev && next.cursor < prev.cursor) return prev
  return next
}

export function runPhase(run: Run): ParcelPhase {
  if (!run.ended_at) return 'moving'
  const o = run.outcome.trim().toLowerCase()
  if (o === 'delivered') return 'delivered'
  if (o === 'failed' || o === 'error' || o.startsWith('failed')) return 'failed'
  if (o === 'interrupted' || o === 'cancelled') return 'interrupted'
  return 'other'
}

export function characterStatus(s: Session, pending: readonly Approval[], now: number): CharacterStatus {
  if (s.freshness === 'stale') return 'stale'
  if (s.state === 'running' && now - time(s.last_activity_at) > STALE_AFTER_MS) return 'stale'
  if (s.state === 'waiting_permission' || pending.length > 0) return 'waiting'
  switch (s.state) {
    case 'running': return 'working'
    case 'error': return 'error'
    case 'idle': return 'idle'
    case 'interrupted': return 'interrupted'
    case 'ended': return 'ended'
    default: return 'unknown'
  }
}

/** clientNow：客户端时钟。断线时快照停住，但时间照走，用它判断会话是否过期。 */
export function buildTown(snap: Snapshot, clientNow?: string): TownModel {
  const now = time(clientNow) || time(snap.now) || Date.now()
  const repos = dedupeById(snap.repos, (r) => r.id, () => true)
  const items = dedupeById(snap.work_items, (w) => w.id, (a, b) => time(a.updated_at) > time(b.updated_at))
  const sessions = dedupeById(snap.sessions, (s) => s.id, (a, b) => time(a.last_activity_at) > time(b.last_activity_at))
  const runs = dedupeById(snap.runs, (r) => r.id, runNewer)
  const approvals = dedupeById(snap.approvals, (a) => a.id, (a, b) => approvalStamp(a) > approvalStamp(b))
  const itemById = new Map(items.map((w) => [w.id, w]))
  const sessionById = new Map(sessions.map((s) => [s.id, s]))

  const pendingApprovals = approvals.filter((a) => a.status === 'pending')
  const closedApprovals = approvals.filter((a) => a.status !== 'pending')

  const parcels: ParcelView[] = runs.slice().sort((a, b) => a.attempt - b.attempt || a.id - b.id).map((run) => ({
    key: `run-${run.id}`, run, phase: runPhase(run), item: itemById.get(run.work_item_id) ?? null, session: sessionById.get(run.session_id) ?? null,
  }))

  const currentSessions = sessions.filter((s) => s.freshness !== 'history')
  const historySessions = sessions.filter((s) => s.freshness === 'history')

  const characters: CharacterView[] = currentSessions.map((s) => {
    const pending = pendingApprovals.filter((a) => a.session_id === s.id)
    return {
      key: `session-${s.id}`, session: s, status: characterStatus(s, pending, now), name: `${providerLabel(s)} #${shownNo(s.id)}`,
      item: itemById.get(s.work_item_id) ?? null, pendingApprovals: pending, runs: parcels.filter((p) => p.run.session_id === s.id),
    }
  })

  const repoOf = (repoId: number | null | undefined) => (repoId == null ? 'none' : String(repoId))
  const empty = (key: string, repo: Repo | null, name: string): BuildingView => ({ key, repo, name, characters: [], hiddenCharacters: 0, items: [], parcels: [] })
  const buildings = repos.map((repo) => empty(`repo-${repo.id}`, repo, repo.name))
  const unassigned = empty('repo-none', null, '未归属')
  const byRepo = new Map(buildings.map((b) => [repoOf(b.repo!.id), b]))
  const place = (repoId: number | null | undefined) => byRepo.get(repoOf(repoId)) ?? unassigned
  for (const c of characters) place(c.session.repo_id).characters.push(c)
  for (const w of items) place(w.repo_id).items.push(w)
  for (const p of parcels) place(p.item?.repo_id ?? p.session?.repo_id ?? null).parcels.push(p)
  if (unassigned.characters.length || unassigned.items.length || unassigned.parcels.length) buildings.push(unassigned)
  for (const b of buildings) b.hiddenCharacters = Math.max(0, b.characters.length - MAX_SEATS)

  const reviewItems = items.filter((w) => !attentionManaged(w) && w.status === 'review')
  return {
    now: snap.now, cursor: snap.cursor, buildings, historySessions, pendingApprovals, closedApprovals, reviewItems, deps: snap.deps ?? [], relays: snap.relays ?? [],
    counts: {
      working: characters.filter((c) => c.status === 'working').length,
      waiting: pendingApprovals.length,
      failed: parcels.filter((p) => p.phase === 'failed').length,
      review: reviewItems.length,
      stale: characters.filter((c) => c.status === 'stale').length,
    },
  }
}

/** 每个角色/包裹的状态摘要，用来找出这一版里刚变化的对象。 */
export function townSignature(model: TownModel): Map<string, string> {
  const out = new Map<string, string>()
  for (const b of model.buildings) {
    for (const c of b.characters) out.set(c.key, `${c.status}|${c.item?.status ?? ''}`)
    for (const p of b.parcels) out.set(p.key, p.phase)
  }
  return out
}

/** 与上一版相比状态变化或新出现的 key；没有上一版时为空。 */
export function changedKeys(before: ReadonlyMap<string, string> | null, after: ReadonlyMap<string, string>): Set<string> {
  if (!before) return new Set()
  return new Set([...after].filter(([k, v]) => before.get(k) !== v).map(([k]) => k))
}
