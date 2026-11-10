import { describe, expect, it } from 'vitest'
import { buildTown } from '../town/townModel'
import { planWorld } from '../town/clusters'
import { fakeItem, fakeSession } from '../town/fixtures'
import type { Repo, Session, Snapshot, WorkItem } from '../types'
import { LIVE_MAX, type LiveArt, liveBodyBox, liveOrder, livePills, liveSignBox, liveSlot, liveWorld, overlaps, unionBox } from './layout'
import { liveBuildings, liveView, type LiveReserve } from './LiveStage'

const NOW = '2026-11-10T08:00:00Z'

/**
 * n 个项目的合成快照。默认最挤：名字用最长的通用名，每个项目三种助手都在干活、未关闭的工作项很多（建筑档次拉满）。
 * mixed 时名字长短、助手数和建筑档次各不相同。
 */
function crowd(n: number, idOf = (i: number) => 900 + i * 3, mixed = false): Snapshot {
  const repos: Repo[] = [], sessions: Session[] = [], items: WorkItem[] = []
  for (let i = 0; i < n; i++) {
    const id = idOf(i)
    repos.push({ id, name: mixed && i % 2 ? `项目 ${String.fromCharCode(65 + i)}` : `项目 ${100 + i}`, common_dir: '', is_git: true, target_ref: '', activity: 'active', last_activity_at: NOW })
    ;(['claude', 'codex', 'opencode'] as const).slice(0, mixed ? i % 4 : 3).forEach((p, k) => {
      sessions.push(fakeSession({ id: id * 10 + k, provider: p, state: mixed && k === 1 ? 'idle' : 'running', repo_id: id, last_activity_at: NOW }))
    })
    for (let k = 0; k < (mixed ? (i * 5) % 17 : 20); k++) items.push(fakeItem({ id: `item-${id}-${k}`, repo_id: id, title: '工作项', status: 'in_progress', updated_at: NOW }))
  }
  return { cursor: 1, now: NOW, repos, sessions, work_items: items, deps: [], runs: [], approvals: [] }
}

const PORTRAIT = { aspect: 1080 / 860, reserve: { top: 0, bottom: 0 } }
const PORTRAIT_TALL_CARD = { aspect: 1080 / 700, reserve: { top: 0, bottom: 0 } }
const LANDSCAPE = { aspect: 1920 / 1080, reserve: { top: 0.2, bottom: 0.1 } }

function scene(snap: Snapshot, aspect: number, reserve: LiveReserve, art?: LiveArt) {
  const model = buildTown(snap, snap.now)
  const buildings = liveBuildings(model, snap)
  const plan = planWorld(buildings.map((b) => b.repo!), snap, Date.parse(snap.now))
  const free = 1 - reserve.top - reserve.bottom
  const live = liveWorld(buildings, plan, aspect / free, art)
  return { live, view: liveView(live.frame, aspect, reserve), buildings }
}

describe('直播展示排布', () => {
  for (const [label, size] of Object.entries({ PORTRAIT, PORTRAIT_TALL_CARD, LANDSCAPE })) {
    const cases = (['original', 'storybook', 'miniature'] as const).flatMap((art) => [[`${art} 最挤`, art, false], [`${art} 混合`, art, true]] as const)
    it.each(cases)(`${label}（%s）：12 栋时名牌两两不相交，也不压别人家的房子和小人标签`, (_, art, mixed) => {
      const { live } = scene(crowd(12, undefined, mixed), size.aspect, size.reserve, art)
      const ds = live.world.districts
      expect(ds).toHaveLength(12)
      if (mixed) expect(new Set(ds.map((d) => d.tier)).size).toBeGreaterThan(1)
      const signs = ds.map((d) => liveSignBox(d, live.dress.signs.get(d.key)!))
      // 别人家的房子按三种画风的并集算，最保守。
      const bodies = ds.map((d) => liveBodyBox(d))
      const pills = ds.map((d) => livePills(d).map((p) => p.box))
      if (!mixed) expect(pills.every((p) => p.length === 3)).toBe(true)
      for (let i = 0; i < ds.length; i++) {
        for (let j = 0; j < ds.length; j++) {
          if (i === j) continue
          expect(overlaps(signs[i], signs[j]), `名牌 ${i} 与 ${j} 相交`).toBe(false)
          expect(overlaps(signs[i], bodies[j]), `名牌 ${i} 压到房子 ${j}`).toBe(false)
          expect(overlaps(bodies[i], bodies[j]), `房子 ${i} 与 ${j} 相交`).toBe(false)
          for (const p of pills[j]) expect(overlaps(signs[i], p), `名牌 ${i} 压到 ${j} 的小人标签`).toBe(false)
          for (const p of pills[i]) expect(overlaps(p, bodies[j]), `${i} 的小人标签压到房子 ${j}`).toBe(false)
        }
        // 同一个院子里的几个小人标签也不互相压。
        const own = pills[i]
        for (let a = 0; a < own.length; a++) for (let b = a + 1; b < own.length; b++) expect(overlaps(own[a], own[b])).toBe(false)
      }
    })

    it.each(['original', 'storybook', 'miniature'] as const)(`${label}（%s）：建筑群占满画面的大部分`, (art) => {
      const { live, view } = scene(crowd(12), size.aspect, size.reserve, art)
      const ds = live.world.districts
      const group = unionBox([...ds.map((d) => liveBodyBox(d, art)), ...ds.map((d) => liveSignBox(d, live.dress.signs.get(d.key)!))])
      const usableH = view.h * (1 - size.reserve.top - size.reserve.bottom)
      const fillW = group.w / view.w, fillH = group.h / usableH
      // 一个方向几乎顶满，另一个方向也占一大半；整体面积超过可用区域的一半。
      expect(Math.max(fillW, fillH)).toBeGreaterThan(0.85)
      expect(Math.min(fillW, fillH)).toBeGreaterThan(0.6)
      expect((group.w * group.h) / (view.w * usableH)).toBeGreaterThan(0.55)
      // 建筑群完整落在可用区域里。
      expect(group.x).toBeGreaterThanOrEqual(view.x)
      expect(group.x + group.w).toBeLessThanOrEqual(view.x + view.w)
      expect(group.y).toBeGreaterThanOrEqual(view.y + view.h * size.reserve.top - 1)
      expect(group.y + group.h).toBeLessThanOrEqual(view.y + view.h * (1 - size.reserve.bottom) + 1)
    })
  }

  it('竖屏排成 3–4 列、横屏排得更宽', () => {
    expect(scene(crowd(12), PORTRAIT.aspect, PORTRAIT.reserve).live.cols).toBeGreaterThanOrEqual(3)
    expect(scene(crowd(12), PORTRAIT.aspect, PORTRAIT.reserve).live.cols).toBeLessThanOrEqual(4)
    expect(scene(crowd(12), LANDSCAPE.aspect, LANDSCAPE.reserve).live.cols).toBeGreaterThan(scene(crowd(12), PORTRAIT.aspect, PORTRAIT.reserve).live.cols)
  })

  it('不管项目编号多分散，排布只取决于数量和顺序：没有离群的房子把镜头拉远', () => {
    const near = scene(crowd(12), PORTRAIT.aspect, PORTRAIT.reserve)
    const far = scene(crowd(12, (i) => (i === 11 ? 99_999 : 2 + i)), PORTRAIT.aspect, PORTRAIT.reserve)
    expect(far.view.w).toBeCloseTo(near.view.w, 0)
  })

  it('最多画 12 栋：快照里项目更多时按快照顺序取前 12 个', () => {
    const snap = crowd(15)
    const model = buildTown(snap, snap.now)
    const picked = liveBuildings(model, snap)
    expect(picked).toHaveLength(LIVE_MAX)
    expect(picked.map((b) => b.repo!.id).sort((a, b) => a - b)).toEqual(snap.repos!.slice(0, LIVE_MAX).map((r) => r.id).sort((a, b) => a - b))
  })

  it('格子都是整数，不占中央广场，彼此不重复', () => {
    for (let n = 1; n <= LIVE_MAX; n++) for (let cols = 1; cols <= 6; cols++) {
      const cells = Array.from({ length: n }, (_, i) => liveSlot(i, n, cols))
      const keys = cells.map((c) => `${c.cx},${c.cy}`)
      expect(new Set(keys).size).toBe(n)
      expect(keys).not.toContain('0,0')
      for (const c of cells) expect(Number.isInteger(c.cx) && Number.isInteger(c.cy)).toBe(true)
    }
  })
})

describe('排布顺序稳定', () => {
  const rank = (k: string) => Number(k.split('-')[1])

  it('第一次按编号升序；同一批项目刷新后不变', () => {
    const first = liveOrder([], ['repo-9', 'repo-3', 'repo-5'], rank)
    expect(first).toEqual(['repo-3', 'repo-5', 'repo-9'])
    expect(liveOrder(first, ['repo-5', 'repo-9', 'repo-3'], rank)).toEqual(first)
  })

  it('一个项目离开、另一个进来：新来的补在空位上，其他房子不动', () => {
    const prev = ['repo-3', 'repo-5', 'repo-9', 'repo-12']
    expect(liveOrder(prev, ['repo-3', 'repo-9', 'repo-12', 'repo-40'], rank)).toEqual(['repo-3', 'repo-40', 'repo-9', 'repo-12'])
  })

  it('只有新来的：接在后面；只有离开的：后面的往前挪', () => {
    expect(liveOrder(['repo-3', 'repo-5'], ['repo-3', 'repo-5', 'repo-1'], rank)).toEqual(['repo-3', 'repo-5', 'repo-1'])
    expect(liveOrder(['repo-3', 'repo-5', 'repo-9'], ['repo-3', 'repo-9'], rank)).toEqual(['repo-3', 'repo-9'])
  })

  it('换掉一个项目时，其余房子的格子不变', () => {
    const a = crowd(12)
    const model = buildTown(a, a.now)
    const keys = liveBuildings(model, a).map((b) => b.key)
    const order = liveOrder([], keys, rank)
    const swapped = [...keys.slice(1), 'repo-5000']
    const next = liveOrder(order, swapped, rank)
    const cells = (ks: string[]) => new Map(ks.map((k, i) => [k, liveSlot(i, ks.length, 3)]))
    const before = cells(order), after = cells(next)
    for (const k of keys.slice(1)) expect(after.get(k)).toEqual(before.get(k))
  })
})
