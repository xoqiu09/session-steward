// 村庄与野外：按近 7 天的活动判断“常开发”，按真实关联把常开发的项目聚成村庄；不常动的散到野外。
// 关联只看快照里的事实：同一会话在几个项目间干活、跨项目依赖、名字同一前缀。结果稳定：同样的数据得到同样的分组。
import type { Snapshot } from '../types'

export const WEEK_MS = 7 * 24 * 3600_000

export interface Village {
  key: string
  name: string
  repoIds: number[]
  activity: number
}

export interface WorldPlan {
  /** 常开发但和别的项目没有关联的：围着中央广场。 */
  central: number[]
  /** 常开发且彼此相关的：各成一个村庄，按活动量从多到少。 */
  villages: Village[]
  /** 近 7 天没有动静的：野外小屋。 */
  wild: number[]
  activity: ReadonlyMap<number, number>
}

const recent = (at: string | undefined, now: number) => {
  const t = Date.parse(at ?? '')
  return Number.isFinite(t) && now - t >= 0 && now - t < WEEK_MS
}

/** 每个项目近 7 天的活动量：会话、工作项更新、运行、审批各算一次。 */
export function activityByRepo(snap: Snapshot, now: number): Map<number, number> {
  const out = new Map<number, number>()
  const add = (repo: number | null | undefined, n = 1) => { if (repo != null) out.set(repo, (out.get(repo) ?? 0) + n) }
  const itemRepo = new Map((snap.work_items ?? []).map((w) => [w.id, w.repo_id]))
  for (const s of snap.sessions ?? []) if (recent(s.last_activity_at, now)) add(s.repo_id, 2)
  for (const w of snap.work_items ?? []) if (recent(w.updated_at, now)) add(w.repo_id)
  for (const r of snap.runs ?? []) if (recent(r.ended_at || r.started_at, now)) add(itemRepo.get(r.work_item_id) ?? null)
  for (const a of snap.approvals ?? []) if (recent(a.created_at, now)) add(a.repo_id ?? itemRepo.get(a.work_item_id ?? '') ?? null, 2)
  return out
}

const pairKey = (a: number, b: number) => (a < b ? `${a}-${b}` : `${b}-${a}`)

/** 项目之间的关联：同一会话近 7 天的运行落在不同项目的工作项上、跨项目依赖。 */
export function projectLinks(snap: Snapshot, now: number): Map<string, number> {
  const out = new Map<string, number>()
  const bump = (a: number | null | undefined, b: number | null | undefined, n: number) => {
    if (a == null || b == null || a === b) return
    const k = pairKey(a, b)
    out.set(k, (out.get(k) ?? 0) + n)
  }
  const itemRepo = new Map((snap.work_items ?? []).map((w) => [w.id, w.repo_id]))
  const reposBySession = new Map<number, Set<number>>()
  for (const r of snap.runs ?? []) {
    if (!recent(r.ended_at || r.started_at, now)) continue
    const repo = itemRepo.get(r.work_item_id)
    if (repo == null) continue
    const set = reposBySession.get(r.session_id) ?? new Set<number>()
    set.add(repo)
    reposBySession.set(r.session_id, set)
  }
  for (const s of snap.sessions ?? []) {
    if (s.repo_id == null || !recent(s.last_activity_at, now)) continue
    const set = reposBySession.get(s.id) ?? new Set<number>()
    set.add(s.repo_id)
    reposBySession.set(s.id, set)
  }
  for (const set of reposBySession.values()) {
    const list = [...set]
    for (let i = 0; i < list.length; i++) for (let j = i + 1; j < list.length; j++) bump(list[i], list[j], 2)
  }
  for (const d of snap.deps ?? []) bump(itemRepo.get(d.upstream), itemRepo.get(d.downstream), 3)
  return out
}

/** 名字的“家族”：第一个分隔符前的部分，至少 3 个字符，例如 grok-bot-workbench → grok。 */
export function nameFamily(name: string): string {
  const head = name.toLowerCase().split(/[-_. /]/)[0] ?? ''
  return head.length >= 3 ? head : ''
}

export function planWorld(repos: readonly { id: number; name: string }[], snap: Snapshot, now: number): WorldPlan {
  const activity = activityByRepo(snap, now)
  const links = projectLinks(snap, now)
  const ids = repos.map((r) => r.id)
  const active = ids.filter((id) => (activity.get(id) ?? 0) > 0)
  const nameOf = new Map(repos.map((r) => [r.id, r.name]))

  // 并查集：有关联、或同一名字家族（家族里至少两个常开发项目）的连在一起。
  const parent = new Map(active.map((id) => [id, id]))
  const find = (x: number): number => { let r = x; while (parent.get(r) !== r) r = parent.get(r)!; parent.set(x, r); return r }
  const union = (a: number, b: number) => { const ra = find(a), rb = find(b); if (ra !== rb) parent.set(Math.max(ra, rb), Math.min(ra, rb)) }
  const activeSet = new Set(active)
  for (const [k, w] of links) {
    if (w <= 0) continue
    const [a, b] = k.split('-').map(Number)
    if (activeSet.has(a) && activeSet.has(b)) union(a, b)
  }
  const families = new Map<string, number[]>()
  for (const id of active) {
    const f = nameFamily(nameOf.get(id) ?? '')
    if (f) families.set(f, [...(families.get(f) ?? []), id])
  }
  for (const members of families.values()) for (let i = 1; i < members.length; i++) union(members[0], members[i])

  const groups = new Map<number, number[]>()
  for (const id of active) groups.set(find(id), [...(groups.get(find(id)) ?? []), id])
  const score = (id: number) => activity.get(id) ?? 0
  const villages: Village[] = []
  const central: number[] = []
  for (const members of groups.values()) {
    if (members.length < 2) { central.push(members[0]); continue }
    members.sort((a, b) => score(b) - score(a) || a - b)
    const fams = new Set(members.map((id) => nameFamily(nameOf.get(id) ?? '')))
    const fam = fams.size === 1 ? [...fams][0] : ''
    const name = fam ? `${fam} 村` : `${nameOf.get(members[0])} 一带`
    villages.push({ key: `v-${members[0]}`, name, repoIds: members, activity: members.reduce((n, id) => n + score(id), 0) })
  }
  villages.sort((a, b) => b.activity - a.activity || a.repoIds[0] - b.repoIds[0])
  central.sort((a, b) => score(b) - score(a) || a - b)
  const wild = ids.filter((id) => !activeSet.has(id)).sort((a, b) => a - b)
  return { central, villages, wild, activity }
}
