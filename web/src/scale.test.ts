// 规模测试：500 工作项 / 10 仓库 / 600 依赖 / 300 会话，纯数据，不渲染 DOM。
// 计时取法：每个函数先预热 3 次，再跑 15 次取中位数断言 < 50ms（中位数抗 GC/JIT 抖动），
// 同时打印最大值供参考。最大值容易被一次偶发 GC 拉高，不适合作为 CI 断言。
import { describe, expect, it } from 'vitest'
import { groupByRepo, layers, relatedIds } from './model'
import type { Dep, ItemStatus, Repo, Session, Snapshot, WorkItem } from './types'

// 可复现的伪随机数（mulberry32）
function rng(seed: number) {
  return () => {
    seed |= 0
    seed = (seed + 0x6d2b79f5) | 0
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const item = (id: string, over: Partial<WorkItem> = {}): WorkItem => ({
  id, repo_id: 1, title: id, status: 'todo', acceptance: '', branch: '', merge_state: 'not_ready', needs_merge: true,
  created_at: '', updated_at: '', ready: true, waiting: [], agents: [], ...over,
})
const dep = (u: string, d: string): Dep => ({ upstream: u, downstream: d, cond: 'accepted', satisfied: false })

const REPOS = 10
const ITEMS = 500
const DEPS = 600
const SESSIONS = 300

function buildSnapshot(): Snapshot {
  const r = rng(42)
  const statuses: ItemStatus[] = ['todo', 'in_progress', 'blocked', 'review', 'done', 'abandoned']
  const providers = ['claude', 'codex', 'other']
  const repos: Repo[] = Array.from({ length: REPOS }, (_, i) => ({ id: i + 1, name: `repo${i}`, common_dir: `/r${i}/.git`, is_git: true, target_ref: 'main' }))
  const work_items = Array.from({ length: ITEMS }, (_, i) =>
    item(`W-${i}`, {
      repo_id: (i % REPOS) + 1,
      title: `任务 ${i} ${i % 7 === 0 ? '行情页断网' : '普通'}`,
      status: statuses[Math.floor(r() * statuses.length)],
      branch: `feat/W-${i}`,
      agents: i % 3 === 0 ? [providers[i % 2]] : [],
    }),
  )
  const seen = new Set<string>()
  const deps: Dep[] = []
  while (deps.length < DEPS) {
    let a = Math.floor(r() * ITEMS)
    let b = Math.floor(r() * ITEMS)
    if (a === b) continue
    if (a > b) [a, b] = [b, a] // 只从小编号指向大编号，无环
    const k = `${a}>${b}`
    if (seen.has(k)) continue
    seen.add(k)
    deps.push(dep(`W-${a}`, `W-${b}`))
  }
  const sessions: Session[] = Array.from({ length: SESSIONS }, (_, i) => ({
    id: i + 1, host_id: 'h', provider: providers[i % 3], provider_session_id: `s${i}`, client: 'cli', version: '',
    cwd: `/r${i % REPOS}/wt${i}`, worktree: `/r${i % REPOS}/wt${i}`, branch: 'main', repo_id: (i % REPOS) + 1,
    state: i % 5 === 0 ? 'ended' : 'running', state_reason: '', data_source: 'live', freshness: 'live', suggested_work_item: '',
    first_seen_at: '', last_activity_at: '', last_progress_at: '', work_item_id: i % 2 === 0 ? `W-${(i * 13) % ITEMS}` : '',
    binding: i % 2 === 0 ? 'tag' : '', worktree_conflict: false, resume_command: '',
  }))
  return { cursor: 1, now: '2026-10-18T00:00:00Z', repos, work_items, deps, sessions, runs: [], approvals: [] }
}

function timeIt(fn: () => unknown, runs = 15, warmup = 3) {
  for (let i = 0; i < warmup; i++) fn()
  const ts: number[] = []
  for (let i = 0; i < runs; i++) {
    const t0 = performance.now()
    fn()
    ts.push(performance.now() - t0)
  }
  ts.sort((a, b) => a - b)
  return { median: ts[Math.floor(ts.length / 2)], max: ts[ts.length - 1] }
}

const fmt = (name: string, r: { median: number; max: number }) => `${name}: 中位数 ${r.median.toFixed(2)}ms, 最大 ${r.max.toFixed(2)}ms`

// 参考实现：基于 BFS 的上下游闭包，用于校验 relatedIds
function bfsClosure(deps: Dep[], seeds: Set<string>) {
  const out = new Set(seeds)
  for (const dir of ['up', 'down'] as const) {
    const q = [...seeds]
    while (q.length) {
      const id = q.shift()!
      for (const d of deps) {
        const [from, to] = dir === 'down' ? [d.upstream, d.downstream] : [d.downstream, d.upstream]
        if (from === id && !out.has(to)) {
          out.add(to)
          q.push(to)
        }
      }
    }
  }
  return out
}

describe('规模：500 工作项 / 600 依赖 / 300 会话', () => {
  const snap = buildSnapshot()
  const all = { query: '', showDone: true, repoId: 'all' as const, provider: 'all' }

  it('groupByRepo 无查询 < 50ms', () => {
    const g = groupByRepo(snap, all)
    expect(g.length).toBe(REPOS)
    expect(g.reduce((n, x) => n + x.items.length, 0)).toBe(ITEMS)
    // 未归属、未结束、实时的会话进入分组
    const loose = snap.sessions!.filter((s) => !s.work_item_id && s.state !== 'ended').length
    expect(g.reduce((n, x) => n + x.sessions.length, 0)).toBe(loose)
    const r = timeIt(() => groupByRepo(snap, all))
    console.log(fmt('groupByRepo(无查询)', r))
    expect(r.median).toBeLessThan(50)
  })

  it('groupByRepo 带查询 < 50ms', () => {
    const f = { ...all, query: '断网' }
    const g = groupByRepo(snap, f)
    const ids = new Set(g.flatMap((x) => x.items.map((w) => w.id)))
    const seeds = new Set(snap.work_items!.filter((w) => w.title.includes('断网')).map((w) => w.id))
    expect(ids).toEqual(bfsClosure(snap.deps!, seeds))
    const r = timeIt(() => groupByRepo(snap, f))
    console.log(fmt('groupByRepo(查询"断网")', r) + `，命中并展开 ${ids.size} 项`)
    expect(r.median).toBeLessThan(50)
  })

  it('layers < 50ms 且满足分层不变式', () => {
    const l = layers(snap.work_items!, snap.deps!)
    expect(l.size).toBe(ITEMS)
    for (const d of snap.deps!) expect(l.get(d.downstream)!).toBeGreaterThan(l.get(d.upstream)!)
    const r = timeIt(() => layers(snap.work_items!, snap.deps!))
    console.log(fmt('layers', r) + `，最大层 ${Math.max(...l.values())}`)
    expect(r.median).toBeLessThan(50)
  })

  it('relatedIds < 50ms 且与 BFS 结果一致', () => {
    const seeds = new Set(['W-0', 'W-250', 'W-499'])
    expect(relatedIds(snap.deps!, seeds)).toEqual(bfsClosure(snap.deps!, seeds))
    const r = timeIt(() => relatedIds(snap.deps!, seeds))
    console.log(fmt('relatedIds', r))
    expect(r.median).toBeLessThan(50)
  })
})

describe('边界形态', () => {
  it('relatedIds 对 200 层链不栈溢出、结果正确', () => {
    const n = 200
    const deps = Array.from({ length: n - 1 }, (_, i) => dep(`C-${i}`, `C-${i + 1}`))
    const mid = relatedIds(deps, new Set(['C-100']))
    expect(mid.size).toBe(n)
    const head = relatedIds(deps, new Set(['C-0']))
    expect(head.size).toBe(n)
    // 加一条不相连的边，不应被带入
    expect(relatedIds([...deps, dep('X-1', 'X-2')], new Set(['C-5'])).has('X-1')).toBe(false)
  })

  it('relatedIds 对 20000 层链也不栈溢出（迭代实现）', () => {
    const n = 20000
    const deps = Array.from({ length: n - 1 }, (_, i) => dep(`C-${i}`, `C-${i + 1}`))
    expect(relatedIds(deps, new Set([`C-${n - 1}`])).size).toBe(n)
  })

  it('layers 对 200 层链正确', () => {
    const n = 200
    const items = Array.from({ length: n }, (_, i) => item(`C-${i}`))
    const deps = Array.from({ length: n - 1 }, (_, i) => dep(`C-${i}`, `C-${i + 1}`))
    const l = layers(items, deps)
    for (let i = 0; i < n; i++) expect(l.get(`C-${i}`)).toBe(i)
  })

  it('layers 对菱形依赖正确', () => {
    // A → B, A → C, B → D, C → D, 以及长短不一的菱形：A → D 直连、C → E → D
    const items = ['A', 'B', 'C', 'D', 'E'].map((x) => item(x))
    const l = layers(items, [dep('A', 'B'), dep('A', 'C'), dep('B', 'D'), dep('C', 'D')])
    expect([l.get('A'), l.get('B'), l.get('C'), l.get('D'), l.get('E')]).toEqual([0, 1, 1, 2, 0])
    const l2 = layers(items, [dep('A', 'B'), dep('A', 'C'), dep('B', 'D'), dep('C', 'E'), dep('E', 'D'), dep('A', 'D')])
    expect([l2.get('A'), l2.get('B'), l2.get('C'), l2.get('E'), l2.get('D')]).toEqual([0, 1, 1, 2, 3])
  })

  it('layers 对多层堆叠菱形（2^20 条路径）不发生指数爆炸', () => {
    // 20 个菱形串联：路径数 2^20，记忆化后应线性
    const ids: string[] = ['N0']
    const deps: Dep[] = []
    for (let i = 0; i < 20; i++) {
      const a = `N${i}`, l = `L${i}`, r = `R${i}`, b = `N${i + 1}`
      ids.push(l, r, b)
      deps.push(dep(a, l), dep(a, r), dep(l, b), dep(r, b))
    }
    const t0 = performance.now()
    const res = layers(ids.map((x) => item(x)), deps)
    expect(performance.now() - t0).toBeLessThan(50)
    expect(res.get('N20')).toBe(40)
  })
})
