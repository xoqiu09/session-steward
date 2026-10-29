import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ReactElement } from 'react'
import type { Snapshot } from '../types'

// 现有依赖没有 DOM 模拟器。这个小型 hook 宿主运行真实 WorldStage 与 effect/timer，
// 检查它输出的组件/回调；真实 DOM、绘图与点击另外用合成 HTTP 页面点验。
const host = vi.hoisted(() => {
  let index = 0, dirty = false
  let slots: any[] = [], pending: (() => void)[] = []
  const cleanups = new Map<number, (() => void) | void>()
  const equal = (a: any[] | undefined, b: any[] | undefined) => !!a && !!b && a.length === b.length && a.every((v, i) => Object.is(v, b[i]))
  return {
    begin() { index = 0; dirty = false; pending = [] },
    commit() { pending.forEach((f) => f()); return dirty },
    reset() { cleanups.forEach((f) => f?.()); cleanups.clear(); slots = []; index = 0; pending = [] },
    state(init: any) { const i = index++; if (!(i in slots)) slots[i] = typeof init === 'function' ? init() : init
      return [slots[i], (value: any) => { const next = typeof value === 'function' ? value(slots[i]) : value; if (!Object.is(next, slots[i])) { slots[i] = next; dirty = true } }] },
    ref(value: any) { const i = index++; if (!(i in slots)) slots[i] = { current: value }; return slots[i] },
    memo(fn: () => any, deps: any[]) { const i = index++; if (!slots[i] || !equal(slots[i].deps, deps)) slots[i] = { value: fn(), deps }; return slots[i].value },
    effect(fn: () => void | (() => void), deps?: any[]) { const i = index++; if (!slots[i] || !equal(slots[i].deps, deps)) {
      slots[i] = { deps }; pending.push(() => { cleanups.get(i)?.(); cleanups.set(i, fn()) })
    } },
  }
})
vi.mock('react', async (original) => ({ ...await original<typeof import('react')>(), useState: host.state, useRef: host.ref, useMemo: host.memo, useEffect: host.effect }))
import { WorldScene, WorldStage } from './WorldScene'
import { MomentCard } from './MomentCard'
import { TownGuide } from './TownGuide'
import { buildTown } from './townModel'
import { fakeApproval, fakeItem } from './fixtures'
import { FOLLOW_KEY, LAST_SEEN_KEY } from './moments'

type Node = ReactElement<any>
const nodes = (node: any): Node[] => {
  if (Array.isArray(node)) return node.flatMap(nodes)
  if (!node || typeof node !== 'object' || !node.props) return []
  return [node, ...(node.type === MomentCard ? nodes(MomentCard(node.props)) : nodes(node.props.children))]
}
const words = (node: any): string => Array.isArray(node) ? node.map(words).join('') : typeof node === 'string' || typeof node === 'number' ? String(node) : node?.props ? words(node.props.children) : ''
const button = (tree: Node, text: string) => nodes(tree).find((n) => n.type === 'button' && words(n) === text)!
const notice = (tree: Node) => nodes(tree).find((n) => n.type === MomentCard)
const needsYou = () => false
const selected = vi.fn()
let snap: Snapshot, tree: Node
let props: Partial<Parameters<typeof WorldStage>[0]>
let hidden = false, reduced = false
let storage: Map<string, string>, listeners: Map<string, Set<() => void>>
const emitVisibility = () => listeners.get('visibilitychange')?.forEach((fn) => fn())
const render = () => {
  for (let n = 0; n < 12; n++) {
    host.begin()
    tree = WorldStage({ snapshot: snap, model: buildTown(snap), needsYou, selected: null, highlight: null, onSelect: selected, ...props })
    if (!host.commit()) return tree
  }
  throw new Error('组件没有稳定下来')
}
const advance = (ms: number) => { vi.advanceTimersByTime(ms); render() }
const deliver = () => {
  snap = { ...snap, cursor: snap.cursor + 1, now: new Date().toISOString(), work_items: snap.work_items!.map((w) => w.id === 'DEMO-2' ? { ...w, status: 'review', updated_at: new Date().toISOString() } : w) }
  render()
}
const click = (label: string) => { tree.props.onPointerDownCapture(); button(tree, label).props.onClick(); render() }

beforeEach(() => {
  vi.useFakeTimers(); vi.setSystemTime(new Date('2026-10-29T08:00:00Z'))
  storage = new Map(); listeners = new Map(); props = {}; hidden = false; reduced = false; selected.mockReset()
  vi.stubGlobal('localStorage', { getItem: (key: string) => storage.get(key) ?? null, setItem: (key: string, value: string) => storage.set(key, value) })
  vi.stubGlobal('window', { innerWidth: 1280, setTimeout, clearTimeout, addEventListener: vi.fn(), removeEventListener: vi.fn(),
    matchMedia: () => ({ matches: reduced, addEventListener: vi.fn(), removeEventListener: vi.fn() }) })
  vi.stubGlobal('matchMedia', () => ({ matches: reduced }))
  vi.stubGlobal('document', { get hidden() { return hidden }, addEventListener: (name: string, cb: () => void) => { const group = listeners.get(name) ?? new Set(); group.add(cb); listeners.set(name, group) }, removeEventListener: (name: string, cb: () => void) => listeners.get(name)?.delete(cb) })
  vi.stubGlobal('requestAnimationFrame', vi.fn(() => 1)); vi.stubGlobal('cancelAnimationFrame', vi.fn())
  snap = { cursor: 1, now: new Date().toISOString(), repos: [{ id: 1, name: '合成花园', common_dir: '', is_git: true, target_ref: 'main' }],
    work_items: [fakeItem({ id: 'DEMO-1', repo_id: 1, title: '第一棵', status: 'review' }), fakeItem({ id: 'DEMO-2', repo_id: 1, title: '第二棵', status: 'in_progress' })], sessions: [], approvals: [], runs: [], deps: [] }
})
afterEach(() => { host.reset(); vi.unstubAllGlobals(); vi.useRealTimers() })

describe('WorldStage 跟随动态', () => {
  it('首次不飞；完整等完 3 秒才出现新熟菜卡片，且没有验收写入', () => {
    render(); expect(notice(tree)).toBeUndefined(); expect(requestAnimationFrame).not.toHaveBeenCalled()
    deliver(); advance(2999); expect(notice(tree)).toBeUndefined()
    advance(1); expect(notice(tree)?.props.moment.itemId).toBe('DEMO-2')
    expect(requestAnimationFrame).toHaveBeenCalledOnce(); expect(selected).not.toHaveBeenCalled()
    expect(words(tree)).not.toContain('验收通过')
  })
  it('30 秒内点过地图时只入队；不会保护结束后突然补飞', () => {
    render(); tree.props.onPointerDownCapture(); deliver(); advance(3000)
    expect(notice(tree)).toBeUndefined(); expect(words(tree)).toContain('1 处有新动态')
    advance(31_000); expect(notice(tree)).toBeUndefined(); expect(requestAnimationFrame).not.toHaveBeenCalled()
  })
  it.each([{ paused: true }, { replaying: true }, { offline: true }])('%o 时不抢镜头', (guard) => {
    props = guard; render(); deliver(); advance(3000)
    expect(notice(tree)).toBeUndefined(); expect(words(tree)).toContain('1 处有新动态'); expect(requestAnimationFrame).not.toHaveBeenCalled()
  })
  it('室内、说明打开或收菜中都不会自动飞行', () => {
    for (const mode of ['inside', 'guide', 'harvest']) {
      render()
      if (mode === 'inside') nodes(tree).find((n) => n.type === WorldScene)!.props.onSelect({ kind: 'building', key: 'repo-1' })
      if (mode === 'guide') button(tree, '怎么看').props.onClick()
      if (mode === 'harvest') button(tree, '收菜 1').props.onClick()
      render(); advance(31_000); vi.mocked(requestAnimationFrame).mockClear()
      deliver(); advance(3000)
      expect(notice(tree)).toBeUndefined(); expect(requestAnimationFrame).not.toHaveBeenCalled()
      host.reset(); snap = { ...snap, cursor: snap.cursor + 1, work_items: snap.work_items!.map((w) => w.id === 'DEMO-2' ? { ...w, status: 'in_progress' } : w) }
    }
  })
  it('合并窗口内后来的权限请求排在熟菜前，稍后后两条都在队列里', () => {
    render(); deliver(); advance(1500)
    snap = { ...snap, cursor: 3, approvals: [fakeApproval({ id: 'DEMO-A', kind: 'permission', status: 'pending', repo_id: 1, work_item_id: 'DEMO-2', created_at: new Date().toISOString() })] }
    render(); advance(1500)
    expect(notice(tree)?.props.moment.kind).toBe('decision'); expect(words(tree)).toContain('1 处有新动态')
    click('稍后'); expect(words(tree)).toContain('2 处有新动态')
    advance(35_000); expect(notice(tree)).toBeUndefined(); expect(requestAnimationFrame).toHaveBeenCalledOnce()
  })
  it('普通模式停在目标；桌面模式无人操作 20 秒后恢复巡游', () => {
    render(); deliver(); advance(3000); advance(20_000)
    expect(notice(tree)).toBeDefined(); expect(requestAnimationFrame).toHaveBeenCalledOnce()
    host.reset(); vi.mocked(requestAnimationFrame).mockClear(); props = { kiosk: true }
    snap = { ...snap, cursor: snap.cursor + 1, work_items: snap.work_items!.map((w) => w.id === 'DEMO-2' ? { ...w, status: 'in_progress' } : w) }
    render(); deliver(); advance(3000); advance(19_999)
    expect(notice(tree)).toBeDefined(); expect(requestAnimationFrame).toHaveBeenCalledOnce()
    advance(1); expect(notice(tree)).toBeUndefined(); expect(requestAnimationFrame).toHaveBeenCalledTimes(2)
  })
  it('低优先级新进展只冒火花，不飞、不排队、不出现操作卡片', () => {
    render()
    snap = { ...snap, cursor: 2, work_items: snap.work_items!.map((w) => w.id === 'DEMO-2' ? { ...w, brief: { fields: { progress: {
      entry_id: 1, text: '合成进展', source: 'report', kind: 'agent', session_id: 2, at: new Date().toISOString(),
    } }, tool_events_since: 0, last_event_at: new Date().toISOString(), stale: false } } : w) }
    render()
    expect(nodes(tree).find((n) => n.type === WorldScene)!.props.progressSparks.has('repo-1')).toBe(true)
    advance(3000); expect(notice(tree)).toBeUndefined(); expect(words(tree)).not.toContain('处有新动态'); expect(requestAnimationFrame).not.toHaveBeenCalled()
  })
  it('桌面模式飞到后再次操作仍保留 30 秒保护，隐藏期间也不巡游', () => {
    props = { kiosk: true }; render(); deliver(); advance(3000)
    tree.props.onPointerDownCapture(); advance(20_000)
    expect(notice(tree)).toBeDefined(); expect(requestAnimationFrame).toHaveBeenCalledOnce()
    advance(10_000); expect(notice(tree)).toBeUndefined(); expect(requestAnimationFrame).toHaveBeenCalledTimes(2)
    hidden = true; emitVisibility(); advance(40_000)
    expect(requestAnimationFrame).toHaveBeenCalledTimes(2)
  })
  it('远端工作只入队，关闭跟随也只入队', () => {
    storage.set(FOLLOW_KEY, JSON.stringify({ enabled: false, includeMerged: true })); render(); deliver(); advance(3000)
    expect(notice(tree)).toBeUndefined(); expect(words(tree)).toContain('1 处有新动态')
    host.reset(); storage.clear(); snap = { ...snap, work_items: snap.work_items!.map((w) => ({ ...w, status: 'in_progress' })), repos: [{ ...snap.repos![0], device: '远方演示机' }] }
    render(); deliver(); advance(3000)
    expect(notice(tree)).toBeUndefined(); expect(words(tree)).toContain('1 处有新动态'); expect(requestAnimationFrame).not.toHaveBeenCalled()
  })
  it('减少动态效果时直接定位，不请求动画帧、光圈或火花', () => {
    reduced = true; render(); const view = nodes(tree).find((n) => n.type === WorldScene)!.props.view
    deliver(); advance(3000)
    const scene = nodes(tree).find((n) => n.type === WorldScene)!
    expect(scene.props.view).not.toEqual(view); expect(scene.props.momentGlow).toBeUndefined(); expect(scene.props.progressSparks).toBeUndefined()
    expect(requestAnimationFrame).not.toHaveBeenCalled(); expect(notice(tree)).toBeDefined()
  })
  it('收这一棵打开该工作项；开始收菜从该棵开始，仍需用户验收', () => {
    render(); deliver(); advance(3000); click('收这一棵')
    expect(selected).toHaveBeenLastCalledWith({ kind: 'item', key: 'DEMO-2' })
    expect(snap.work_items![1].status).toBe('review')
    host.reset(); selected.mockClear(); snap = { ...snap, work_items: snap.work_items!.map((w) => w.id === 'DEMO-2' ? { ...w, status: 'in_progress' } : w) }
    render(); deliver(); advance(3000); click('开始收菜（2 棵）')
    expect(selected).toHaveBeenLastCalledWith({ kind: 'item', key: 'DEMO-2' })
    const harvest = nodes(tree).find((n) => typeof n.type === 'function' && n.type.name === 'HarvestBar')!
    expect(harvest.props.ids).toEqual(['DEMO-2', 'DEMO-1']); expect(harvest.props.index).toBe(0)
  })
  it('已在别处验收就收起卡片；回到刚才的位置复用相机飞行', () => {
    render(); deliver(); advance(3000); click('回到刚才的位置')
    expect(notice(tree)).toBeUndefined(); expect(requestAnimationFrame).toHaveBeenCalledTimes(2)
    snap = { ...snap, cursor: 3, work_items: snap.work_items!.map((w) => ({ ...w, status: 'done' })) }; render()
    expect(words(tree)).not.toContain('处有新动态')
  })
  it('后台期间和重新打开只显示离开提示，前台后不自动飞', () => {
    render(); hidden = true; emitVisibility(); advance(10_000); deliver(); advance(3000)
    hidden = false; emitVisibility(); render()
    expect(words(tree)).toContain('你离开期间：1 棵菜熟了，0 件要你决定'); expect(notice(tree)).toBeUndefined(); expect(requestAnimationFrame).not.toHaveBeenCalled()
    host.reset(); storage.set(LAST_SEEN_KEY, String(Date.parse('2026-10-29T07:00:00Z'))); render(); advance(3000)
    expect(words(tree)).toContain('你离开期间：1 棵菜熟了'); expect(requestAnimationFrame).not.toHaveBeenCalled()
  })
  it('本地存储被拒绝时仍能检测新动态和更新设置', () => {
    vi.stubGlobal('localStorage', { getItem: () => { throw Error('blocked') }, setItem: () => { throw Error('blocked') } })
    render(); button(tree, '怎么看').props.onClick(); render()
    nodes(tree).find((n) => n.type === TownGuide)!.props.onFollowChange({ enabled: false, includeMerged: true }); render()
    button(tree, '怎么看').props.onClick(); render(); deliver(); advance(3000)
    expect(notice(tree)).toBeUndefined(); expect(words(tree)).toContain('1 处有新动态')
  })
})
