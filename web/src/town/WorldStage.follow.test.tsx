import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ReactElement } from 'react'
import type { Snapshot } from '../types'

// 现有依赖没有 DOM 模拟器。这个小型 hook 宿主运行真实 WorldStage 与 effect/timer，
// 检查它输出的组件/回调；真实 DOM、绘图与点击另外用合成 HTTP 页面点验。
const host = vi.hoisted(() => {
  interface Context { index: number; dirty: boolean; slots: any[]; pending: (() => void)[]; cleanups: Map<number, (() => void) | void> }
  const contexts = new Map<string, Context>()
  let active: Context
  const equal = (a: any[] | undefined, b: any[] | undefined) => !!a && !!b && a.length === b.length && a.every((v, i) => Object.is(v, b[i]))
  return {
    begin(scope = 'stage') {
      if (!contexts.has(scope)) contexts.set(scope, { index: 0, dirty: false, slots: [], pending: [], cleanups: new Map() })
      active = contexts.get(scope)!; active.index = 0; active.dirty = false; active.pending = []
    },
    commit() { const c = active; c.pending.forEach((f) => f()); return c.dirty },
    reset() { contexts.forEach((c) => c.cleanups.forEach((f) => f?.())); contexts.clear() },
    state(init: any) { const c = active, i = c.index++; if (!(i in c.slots)) c.slots[i] = typeof init === 'function' ? init() : init
      return [c.slots[i], (value: any) => { const next = typeof value === 'function' ? value(c.slots[i]) : value; if (!Object.is(next, c.slots[i])) { c.slots[i] = next; c.dirty = true } }] },
    ref(value: any) { const c = active, i = c.index++; if (!(i in c.slots)) c.slots[i] = { current: value }; return c.slots[i] },
    memo(fn: () => any, deps: any[]) { const c = active, i = c.index++; if (!c.slots[i] || !equal(c.slots[i].deps, deps)) c.slots[i] = { value: fn(), deps }; return c.slots[i].value },
    effect(fn: () => void | (() => void), deps?: any[]) { const c = active, i = c.index++; if (!c.slots[i] || !equal(c.slots[i].deps, deps)) {
      c.slots[i] = { deps }; c.pending.push(() => { c.cleanups.get(i)?.(); c.cleanups.set(i, fn()) })
    } },
  }
})
vi.mock('react', async (original) => ({ ...await original<typeof import('react')>(), useState: host.state, useRef: host.ref, useMemo: host.memo, useEffect: host.effect,
  useCallback: (fn: (...args: any[]) => any, deps: any[]) => host.memo(() => fn, deps) }))
import { WorldScene, WorldStage } from './WorldScene'
import { MomentCard } from './MomentCard'
import { TownGuide } from './TownGuide'
import { TownView } from './TownView'
import { api } from '../api'
import { buildTown } from './townModel'
import { fakeApproval, fakeItem } from './fixtures'
import { FOLLOW_KEY, LAST_SEEN_KEY, SEEN_KEY } from './moments'

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
let snap: Snapshot, tree: Node, townTree: Node
let viewProps: Partial<Parameters<typeof TownView>[0]> | null
const noop = () => {}
let props: Partial<Parameters<typeof WorldStage>[0]>
let hidden = false, reduced = false
let storage: Map<string, string>, listeners: Map<string, Set<() => void>>
const emitVisibility = () => listeners.get('visibilitychange')?.forEach((fn) => fn())
const render = () => {
  let stageProps = { snapshot: snap, model: buildTown(snap), needsYou, selected: null, highlight: null, onSelect: selected, ...props }
  if (viewProps) {
    for (let n = 0; n < 12; n++) {
      host.begin('view')
      townTree = TownView({ snap, conn: 'live', repoId: 'all', provider: 'all', sel: null, layout: 'wide', world: true,
        onSelectItem: selected, onSelectSession: noop, onSelectRepo: noop, onQueue: noop, ...viewProps })
      const stage = nodes(townTree).find((n) => n.type === WorldStage)!
      stageProps = { ...stage.props, ...props }
      if (!host.commit()) break
    }
  }
  for (let n = 0; n < 12; n++) {
    host.begin()
    tree = WorldStage(stageProps)
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
  storage = new Map(); listeners = new Map(); props = {}; viewProps = null; hidden = false; reduced = false; selected.mockReset()
  vi.stubGlobal('localStorage', { getItem: (key: string) => storage.get(key) ?? null, setItem: (key: string, value: string) => storage.set(key, value) })
  vi.stubGlobal('window', { innerWidth: 1280, setTimeout, clearTimeout, setInterval, clearInterval, addEventListener: vi.fn(), removeEventListener: vi.fn(),
    matchMedia: () => ({ matches: reduced, addEventListener: vi.fn(), removeEventListener: vi.fn() }) })
  vi.stubGlobal('matchMedia', () => ({ matches: reduced }))
  vi.stubGlobal('document', { get hidden() { return hidden }, addEventListener: (name: string, cb: () => void) => { const group = listeners.get(name) ?? new Set(); group.add(cb); listeners.set(name, group) }, removeEventListener: (name: string, cb: () => void) => listeners.get(name)?.delete(cb) })
  vi.stubGlobal('requestAnimationFrame', vi.fn(() => 1)); vi.stubGlobal('cancelAnimationFrame', vi.fn())
  snap = { cursor: 1, now: new Date().toISOString(), repos: [{ id: 1, name: '合成花园', common_dir: '', is_git: true, target_ref: 'main' }],
    work_items: [fakeItem({ id: 'DEMO-1', repo_id: 1, title: '第一棵', status: 'review' }), fakeItem({ id: 'DEMO-2', repo_id: 1, title: '第二棵', status: 'in_progress' })], sessions: [], approvals: [], runs: [], deps: [] }
})
afterEach(() => { host.reset(); vi.unstubAllGlobals(); vi.useRealTimers(); vi.restoreAllMocks() })

describe('WorldStage 跟随动态', () => {
  it('首次不飞；完整等完 3 秒才出现新熟菜卡片，且没有验收写入', () => {
    render(); expect(notice(tree)).toBeUndefined(); expect(requestAnimationFrame).not.toHaveBeenCalled()
    deliver(); advance(2999); expect(notice(tree)).toBeUndefined()
    advance(1); expect(notice(tree)?.props.moment.itemId).toBe('DEMO-2')
    expect(requestAnimationFrame).toHaveBeenCalledOnce(); expect(selected).not.toHaveBeenCalled()
    expect(words(tree)).not.toContain('已处理')
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
    // 重新打开：已经在“你离开期间”里看过的同一条交付不再出现
    host.reset(); storage.set(LAST_SEEN_KEY, String(Date.parse('2026-10-29T07:00:00Z'))); render(); advance(3000)
    expect(words(tree)).not.toContain('你离开期间'); expect(requestAnimationFrame).not.toHaveBeenCalled()
    // 浏览器存储被清掉（真的没看过）时照常补上
    host.reset(); storage.delete(SEEN_KEY); storage.set(LAST_SEEN_KEY, String(Date.parse('2026-10-29T07:00:00Z'))); render(); advance(3000)
    expect(words(tree)).toContain('你离开期间：1 棵菜熟了'); expect(requestAnimationFrame).not.toHaveBeenCalled()
  })
  it('本地存储被拒绝时仍能检测新动态和更新设置', () => {
    vi.stubGlobal('localStorage', { getItem: () => { throw Error('blocked') }, setItem: () => { throw Error('blocked') } })
    render(); button(tree, '怎么看').props.onClick(); render()
    nodes(tree).find((n) => n.type === TownGuide)!.props.onFollowChange({ enabled: false, includeMerged: true }); render()
    button(tree, '怎么看').props.onClick(); render(); deliver(); advance(3000)
    expect(notice(tree)).toBeUndefined(); expect(words(tree)).toContain('1 处有新动态')
  })
  it('读屏 status 区域从首屏就存在，卡片出现才更新文字，卡片本身不另建 live 区域', () => {
    const status = () => nodes(tree).find((n) => n.props.className === 'town-moment-status')!
    render(); expect(status().props.role).toBe('status'); expect(status().props['aria-live']).toBe('polite'); expect(words(status())).toBe('')
    deliver(); advance(3000)
    expect(words(status())).toBe('合成花园：DEMO-2 熟了，可以收')
    const card = MomentCard(notice(tree)!.props)
    expect(nodes(card).some((n) => n.props['aria-live'])).toBe(false)
    click('稍后'); expect(words(status())).toBe(''); expect(status().props.role).toBe('status')
  })
  it('连续访问两个时刻后，返回第一次飞行之前的相机，返回后按钮清空', () => {
    reduced = true
    snap = { ...snap, repos: [...snap.repos!, { id: 2, name: '另一块合成菜地', common_dir: '', is_git: true, target_ref: 'main' }],
      work_items: [...snap.work_items!, fakeItem({ id: 'DEMO-3', repo_id: 2, title: '第三棵', status: 'in_progress' })] }
    const view = () => nodes(tree).find((n) => n.type === WorldScene)!.props.view
    render(); const initial = view()
    deliver(); advance(3000); const first = view(); expect(first).not.toEqual(initial)
    snap = { ...snap, cursor: 3, work_items: snap.work_items!.map((w) => w.id === 'DEMO-3' ? { ...w, status: 'review', updated_at: new Date().toISOString() } : w) }
    render(); advance(3000); click('1 处有新动态'); click('另一块合成菜地：DEMO-3 熟了，可以收')
    expect(view()).not.toEqual(first)
    click('回到刚才的位置'); expect(view()).toEqual(initial); expect(button(tree, '回到刚才的位置')).toBeUndefined()
  })
  it.each(['拖动', '滚轮缩放', '按钮缩放'])('手动%s地图后清除旧返回位置', (action) => {
    render(); deliver(); advance(3000); expect(button(tree, '回到刚才的位置')).toBeDefined()
    if (action === '按钮缩放') click('＋')
    else {
      const events = new Map<string, (event: any) => void>()
      tree.props.ref.current = { getBoundingClientRect: () => ({ width: 800, height: 500, left: 0, top: 0 }),
        setPointerCapture: vi.fn(), releasePointerCapture: vi.fn(), addEventListener: (name: string, fn: (event: any) => void) => events.set(name, fn), removeEventListener: vi.fn() }
      render()
      if (action === '拖动') {
        tree.props.onPointerDown({ button: 0, clientX: 10, clientY: 10, pointerId: 1 })
        tree.props.onPointerMove({ clientX: 50, clientY: 30, pointerId: 1 })
      } else events.get('wheel')!({ target: null, preventDefault: vi.fn(), clientX: 100, clientY: 100, deltaY: 100 })
      render()
    }
    expect(button(tree, '回到刚才的位置')).toBeUndefined()
  })
  it('离开提示只给本机计数，远端另列；带我去看优先本机，超过远端权限的优先级', () => {
    storage.set(LAST_SEEN_KEY, String(Date.parse('2026-10-29T07:00:00Z')))
    snap = { ...snap, repos: [...snap.repos!, { id: 1_000_000_001, name: '远方合成菜地', device: '远方演示机', common_dir: '', is_git: true, target_ref: 'main' }],
      devices: [{ id: 'self', name: '本机演示', self: true, online: true, received_at: snap.now }, { id: 'remote', name: '远方演示机', self: false, online: true, received_at: snap.now }],
      work_items: [{ ...snap.work_items![0], updated_at: snap.now }, snap.work_items![1], fakeItem({ id: 'remote:DEMO-3', repo_id: 1_000_000_001, title: '远端第三棵', status: 'review', updated_at: snap.now })],
      approvals: [fakeApproval({ id: 'remote:DEMO-A', kind: 'permission', status: 'pending', repo_id: 1_000_000_001, created_at: snap.now })] }
    render()
    expect(words(tree)).toContain('你离开期间：1 棵菜熟了，0 件要你决定')
    expect(words(tree)).toContain('另一台电脑：1 棵菜熟了，1 件要你决定')
    click('带我去看'); expect(notice(tree)?.props.moment.itemId).toBe('DEMO-1'); expect(notice(tree)?.props.moment.local).toBe(true)
    expect(selected).not.toHaveBeenCalled()
  })
  it('只有远端离开动态时本机计数为零，查看卡片不会出现本机收菜入口', () => {
    storage.set(LAST_SEEN_KEY, String(Date.parse('2026-10-29T07:00:00Z')))
    snap = { ...snap, repos: [{ ...snap.repos![0], device: '远方演示机' }], work_items: [{ ...snap.work_items![0], updated_at: snap.now }] }
    render()
    expect(words(tree)).toContain('你离开期间：0 棵菜熟了，0 件要你决定')
    expect(words(tree)).toContain('另一台电脑：1 棵菜熟了，0 件要你决定')
    click('带我去看'); expect(notice(tree)?.props.moment.local).toBe(false); expect(button(tree, '收这一棵')).toBeUndefined()
  })
})

describe('TownView 与 WorldStage 的真实组件连接', () => {
  it('全部设备视图仍可收菜，但完整收菜队列只含本机工作', () => {
    viewProps = { noReplay: true }
    snap = { ...snap, repos: [{ ...snap.repos![0], device: '本机演示' }, { id: 1_000_000_001, name: '远方合成菜地', device: '远方演示机', common_dir: '', is_git: true, target_ref: 'main' }],
      devices: [{ id: 'self', name: '本机演示', self: true, online: true, received_at: snap.now }, { id: 'remote', name: '远方演示机', self: false, online: true, received_at: snap.now }],
      work_items: [...snap.work_items!.map((w) => ({ ...w, status: 'review' as const })), fakeItem({ id: 'remote:DEMO-3', repo_id: 1_000_000_001, title: '远端第三棵', status: 'review' })] }
    render(); expect(button(tree, '收菜 2')).toBeDefined(); expect(button(tree, '收菜 3')).toBeUndefined()
    click('收菜 2')
    const harvest = nodes(tree).find((n) => typeof n.type === 'function' && n.type.name === 'HarvestBar')!
    expect(new Set(harvest.props.ids)).toEqual(new Set(['DEMO-1', 'DEMO-2']))
    expect(selected).toHaveBeenLastCalledWith('DEMO-1')
    harvest.props.onNext(); render(); expect(selected).toHaveBeenLastCalledWith('DEMO-2')
    expect(snap.work_items!.every((w) => w.status === 'review')).toBe(true)
  })
  it('TownView 详情选中状态真正传入相机保护，新熟菜只入队', () => {
    viewProps = { sel: { kind: 'item', id: 'DEMO-1' } }; render(); deliver(); advance(3000)
    expect(notice(tree)).toBeUndefined(); expect(words(tree)).toContain('1 处有新动态'); expect(requestAnimationFrame).not.toHaveBeenCalled()
    viewProps = { sel: null }; render(); advance(31_000)
    expect(notice(tree)).toBeUndefined(); expect(requestAnimationFrame).not.toHaveBeenCalled()
  })
  it('从 TownView 点击回放后，新交付进入队列但不移动镜头', () => {
    vi.spyOn(api, 'snapshotAt').mockResolvedValue(snap)
    viewProps = {}; render(); button(townTree, '回放').props.onClick(); render(); deliver(); advance(3000)
    expect(notice(tree)).toBeUndefined(); expect(words(tree)).toContain('1 处有新动态'); expect(requestAnimationFrame).not.toHaveBeenCalled()
    expect(button(townTree, '回放')).toBeUndefined()
  })
})
