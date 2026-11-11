import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { EXTRAS_KEY } from './extras'
import type { ReactElement } from 'react'
import type { Snapshot } from '../types'

// 与 WorldStage.follow.test.tsx 相同的小型 hook 宿主：没有 DOM 模拟器，真实运行 WorldStage / TownView 的 state、effect 与 timer，
// 再直接调用输出元素上的 onClick / onKeyDown。真实 DOM 的点击与截图另外用合成数据页面点验。
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
    changed(scope = 'stage') { return contexts.get(scope)?.dirty ?? false },
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
  useId: () => host.ref('synthetic-map-tools').current,
  useCallback: (fn: (...args: any[]) => any, deps: any[]) => host.memo(() => fn, deps), useSyncExternalStore: (_subscribe: any, getSnapshot: () => any) => getSnapshot() }))
// This hook host calls scene components directly. Keep its original-art fixture;
// actual context switching is covered by appearance tests and the browser flow.
vi.mock('./appearance', async original => ({ ...await original<typeof import('./appearance')>(), useTownArt: () => ({ theme: 'original', illustrated: false, miniature: false }) }))
import { WorldScene, WorldStage, type NavTarget } from './WorldScene'
import { InteriorScene } from './InteriorScene'
import { TownStructure } from './TownStructure'
import { TownView } from './TownView'
import { api } from '../api'
import { buildTown } from './townModel'
import { fakeItem, fakeSession } from './fixtures'
import { FAR_W, type Box } from './world'
import { iso } from './iso'
import type { WorldPlan } from './clusters'
import { ResidentFollow } from './ResidentFollow'
import { ResidentsPanel } from './ResidentVillage'
import type { ResidentStore } from './residentLife'
import type { ResidentId } from './residents'

type Node = ReactElement<any>
/** 项目列表、验收台列表是函数组件（无 hook），展开它们的输出一起找按钮和文字。 */
const kids = (node: Node): any => typeof node.type === 'function' && ['ProjectList', 'DeskList'].includes(node.type.name) ? (node.type as any)(node.props) : node.props.children
const nodes = (node: any): Node[] => {
  if (Array.isArray(node)) return node.flatMap(nodes)
  if (!node || typeof node !== 'object' || !node.props) return []
  return [node, ...nodes(kids(node))]
}
/** 带祖先链的遍历：检查一个可点的东西外面有没有别的点击处理（会被冒泡触发）。 */
const withParents = (node: any, parents: Node[] = []): { n: Node; parents: Node[] }[] => {
  if (Array.isArray(node)) return node.flatMap((x) => withParents(x, parents))
  if (!node || typeof node !== 'object' || !node.props) return []
  return [{ n: node, parents }, ...withParents(node.props.children, [...parents, node])]
}
const words = (node: any): string => Array.isArray(node) ? node.map(words).join('') : typeof node === 'string' || typeof node === 'number' ? String(node) : node?.props ? words(kids(node)) : ''
const button = (tree: Node, text: string) => nodes(tree).find((n) => n.type === 'button' && (words(n) === text || n.props['aria-label'] === text))
// Hook-only rendering does not attach DOM refs. Give actual button refs stable
// focus targets, so closing a secondary dialog can return to the visible “更多”.
const mountButtonRefs = (tree: Node) => {
  for (const node of nodes(tree)) {
    const ref = node.type === 'button' ? node.props.ref : null
    if (ref && typeof ref === 'object' && !ref.current) ref.current = { focus: vi.fn(), isConnected: true }
  }
}
const needsYou = () => false
const selected = vi.fn()
const noop = () => {}
let snap: Snapshot, tree: Node, townTree: Node, residentTree: Node | null
let props: Partial<Parameters<typeof WorldStage>[0]>
let viewProps: Partial<Parameters<typeof TownView>[0]> | null
let reduced = true
let storage: Map<string, string>
let modelFor: Snapshot | null = null, model: ReturnType<typeof buildTown>
const setItem = vi.fn()

const render = () => {
  // 和 TownView 一样按快照缓存 model：每次重画都新建会让巡游计时器不停重置。
  if (modelFor !== snap) { modelFor = snap; model = buildTown(snap) }
  let stageProps: any = { snapshot: snap, model, needsYou, selected: null, highlight: null, onSelect: selected, ...props }
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
    mountButtonRefs(tree)
    host.commit()
    const resident = nodes(tree).find((n) => n.type === ResidentFollow)!
    host.begin('resident-follow')
    residentTree = ResidentFollow(resident.props)
    host.commit()
    if (!host.changed()) return tree
  }
  throw new Error('组件没有稳定下来')
}
const advance = (ms: number) => { vi.advanceTimersByTime(ms); render() }
/** 一秒一秒地走，每秒重画一次：和真实页面一样，timer 触发后的状态变化马上生效。 */
const walk = (ms: number) => { for (let t = 0; t < ms; t += 1000) advance(Math.min(1000, ms - t)) }
const scene = () => nodes(tree).find((n) => n.type === WorldScene)!
const drawn = () => WorldScene(scene().props)
const view = (): Box => scene().props.view
const district = (id: string) => scene().props.world.districts.find((d: any) => d.id === id)
const plate = (label: string) => nodes(drawn()).find((n) => typeof n.props['aria-label'] === 'string' && n.props['aria-label'].startsWith(label))
const inside = () => nodes(tree).some((n) => n.type === InteriorScene)
const touch = () => tree.props.onPointerDownCapture()
const targetButton = (label: string) => {
  let target = button(tree, label)
  if (!target) { button(tree, '更多')?.props.onClick(); render(); target = button(tree, label) }
  if (!target) throw new Error(`地图入口不存在：${label}`)
  return target
}
const press = (label: string) => { touch(); const target = targetButton(label); target.props.onClick({ currentTarget: target.props.ref?.current }); render() }
const hit = (n: Node | undefined) => { touch(); n!.props.onClick(); render() }
const within = (p: [number, number], v: Box) => p[0] >= v.x && p[0] <= v.x + v.w && p[1] >= v.y && p[1] <= v.y + v.h
/** 近景（看得清小人和菜），门前花园（菜地中心）和房子都在镜头里，镜头对着这个街区。 */
const gardenInView = (id: string) => {
  const d = district(id), v = view(), c = iso(d.ox + 4.5, d.oy + 4.1)
  return v.w < FAR_W && within(iso(d.ox + 6.5, d.oy + 5.6), v) && within(iso(d.ox + 3, d.oy + 2), v) && Math.hypot(v.x + v.w / 2 - c[0], v.y + v.h / 2 - c[1]) < v.w * 0.2
}

// 合成世界：中央一个项目（带受阻和一个会话），一个 7 个项目的片区。名字、编号都是虚构的。
const repos = [{ id: 1, name: '合成花园', common_dir: '', is_git: true, target_ref: 'main' },
  ...Array.from({ length: 7 }, (_, i) => ({ id: i + 2, name: `合成片区项目${i + 1}`, common_dir: '', is_git: true, target_ref: 'main' }))]
const plan: WorldPlan = { central: [1], villages: [{ key: 'v-2', name: '合成一带', repoIds: [2, 3, 4, 5, 6, 7, 8], activity: 7 }], wild: [], activity: new Map() }

beforeEach(() => {
  vi.useFakeTimers(); vi.setSystemTime(new Date('2026-10-30T08:00:00Z'))
  storage = new Map(); props = { plan }; viewProps = null; reduced = true; selected.mockReset(); setItem.mockReset()
  vi.stubGlobal('localStorage', { getItem: (key: string) => storage.get(key) ?? null, setItem: (key: string, value: string) => { setItem(key, value); storage.set(key, value) } })
  vi.stubGlobal('window', { innerWidth: 1280, setTimeout, clearTimeout, setInterval, clearInterval, addEventListener: vi.fn(), removeEventListener: vi.fn(),
    matchMedia: () => ({ matches: reduced, addEventListener: vi.fn(), removeEventListener: vi.fn() }) })
  vi.stubGlobal('matchMedia', () => ({ matches: reduced }))
  vi.stubGlobal('document', { hidden: false, addEventListener: vi.fn(), removeEventListener: vi.fn() })
  vi.stubGlobal('requestAnimationFrame', vi.fn(() => 1)); vi.stubGlobal('cancelAnimationFrame', vi.fn())
  vi.stubGlobal('fetch', vi.fn(() => Promise.reject(new Error('导航不该发请求'))))
  const now = new Date().toISOString()
  snap = { cursor: 1, now, repos, approvals: [], runs: [], deps: [],
    sessions: [fakeSession({ id: 41, provider: 'claude', state: 'running', repo_id: 1, work_item_id: 'SYN-1', last_activity_at: now })],
    work_items: [fakeItem({ id: 'SYN-1', repo_id: 1, title: '合成进行中', status: 'in_progress', updated_at: now }), fakeItem({ id: 'SYN-B', repo_id: 1, title: '合成受阻', status: 'blocked', updated_at: now })] }
})
afterEach(() => { host.reset(); vi.unstubAllGlobals(); vi.useRealTimers(); vi.restoreAllMocks() })

describe('名牌去花园', () => {
  it.each([390, 1280])('%ipx 都先从“更多”找到二级地图操作，关闭后重新保持简洁', width => {
    window.innerWidth = width; render()
    expect(button(tree, '结构说明')).toBeUndefined()
    expect(button(tree, '项目 8')).toBeUndefined()
    expect(button(tree, '按 Agent 看')).toBeUndefined()
    expect(button(tree, '更多')!.props['aria-expanded']).toBe(false)
    press('更多')
    const group = nodes(tree).find(node => node.props['aria-label'] === '更多地图操作')!
    expect(group.props.role).toBe('group')
    expect(group.props.id).toBe(button(tree, '更多')!.props['aria-controls'])
    expect(button(tree, '结构说明')).toBeDefined()
    expect(button(tree, '项目 8')).toBeDefined()
    press('更多')
    expect(button(tree, '更多')!.props['aria-expanded']).toBe(false)
    expect(button(tree, '项目 8')).toBeUndefined()
  })
  it('点项目名牌立即定位到房子和门前花园，仍在世界里，不开详情', () => {
    render(); const before = view()
    expect(gardenInView('self#1')).toBe(false)
    hit(plate('去门前花园：合成花园'))
    expect(view()).not.toEqual(before); expect(gardenInView('self#1')).toBe(true)
    expect(inside()).toBe(false); expect(selected).not.toHaveBeenCalled()
    expect(words(tree)).toContain('已到「合成花园」的房子和门前花园'); expect(button(tree, '回到刚才的位置')).toBeDefined()
  })
  it('不等 3 秒归并：同一次渲染里镜头就到位；动效开启时也只发起一次既有飞行', () => {
    reduced = false; render()
    hit(plate('去门前花园：合成花园')); expect(requestAnimationFrame).toHaveBeenCalledOnce()
    reduced = true; host.reset(); render(); const before = view()
    plate('去门前花园：合成花园')!.props.onClick(); render()
    expect(view()).not.toEqual(before)
  })
  it.each(['Enter', ' '])('键盘 %j 触发同一个导航', (key) => {
    render(); const preventDefault = vi.fn()
    plate('去门前花园：合成花园')!.props.onKeyDown({ key, preventDefault }); render()
    expect(preventDefault).toHaveBeenCalled(); expect(gardenInView('self#1')).toBe(true); expect(inside()).toBe(false)
    const p = plate('去门前花园：合成花园')!
    expect(p.props.role).toBe('button'); expect(p.props.tabIndex).toBe(0)
  })
  it('项目列表里的项目名和“去花园”走同一个导航；“工作室”才进室内', () => {
    render(); press('项目 8')
    expect(words(tree)).toContain('合成一带 · 7 个项目')
    press('去花园：合成片区项目3'); expect(gardenInView('self#4')).toBe(true); expect(inside()).toBe(false)
    expect(button(tree, '去花园：合成片区项目3')).toBeUndefined()
    press('项目 8'); press('合成花园'); expect(gardenInView('self#1')).toBe(true); expect(inside()).toBe(false)
    press('项目 8'); press('进入工作室：合成片区项目1'); expect(inside()).toBe(true); expect(selected).not.toHaveBeenCalled()
  })
  it('找不到目标时说明原因，不移动、不换成别的项目', () => {
    render(); const before = view()
    scene().props.onNavigate({ kind: 'project', id: 'self#999' } satisfies NavTarget); render()
    expect(view()).toEqual(before); expect(words(tree)).toContain('这个项目不在当前显示范围'); expect(button(tree, '回到刚才的位置')).toBeUndefined()
  })
})

describe('片区取景', () => {
  it('点片区名牌框住全部 7 个成员，成员名牌在远景下实际显示且可点，不是只飞到第一个', () => {
    render()
    hit(plate('看片区「合成一带」的 7 个项目'))
    const v = view()
    expect(v.w).toBeGreaterThan(FAR_W)
    for (let id = 2; id <= 8; id++) { const d = district(`self#${id}`); expect(within(iso(d.ox + 4.5, d.oy + 4), v)).toBe(true) }
    expect(scene().props.far).toBe(true); expect(scene().props.focusArea).toBe('v-2')
    const members = nodes(drawn()).filter((n) => typeof n.props['aria-label'] === 'string' && n.props['aria-label'].startsWith('去门前花园：合成片区项目'))
    expect(members).toHaveLength(7)
    for (const m of members) { expect(m.props.className).not.toContain('town-hide-on-map'); expect(m.props.onClick).toBeTypeOf('function') }
    expect(plate('看片区「合成一带」')).toBeUndefined()
    expect(words(tree)).toContain('「合成一带」· 7 个项目：点名牌去它的门前花园')
    hit(plate('去门前花园：合成片区项目5')); expect(gardenInView('self#6')).toBe(true); expect(inside()).toBe(false)
  })
  it('片区成员都不在显示范围时说明原因', () => {
    render()
    snap = { ...snap, cursor: 2, repos: repos.slice(0, 1) }; props = { plan: { ...plan, villages: [] } }; render()
    press('项目 1'); expect(words(tree)).toContain('「合成一带」：当前显示范围里没有项目')
    const before = view()
    scene().props.onNavigate({ kind: 'area', key: 'v-2' }); render()
    expect(view()).toEqual(before); expect(words(tree)).toContain('「合成一带」现在没有可看的项目')
  })
})

describe('一次点击只有一个动作', () => {
  it('房子本体进室内；名牌、片区名牌、徽章外面都没有别的点击处理', () => {
    render()
    const all = withParents(drawn())
    for (const { n, parents } of all.filter(({ n }) => typeof n.props['aria-label'] === 'string' && /^(去门前花园|看片区|合成花园：受阻)/.test(n.props['aria-label']))) {
      expect(n.props.onClick).toBeTypeOf('function'); expect(parents.some((p) => p.props.onClick)).toBe(false)
    }
    scene().props.onSelect({ kind: 'building', key: 'repo-1' }); render()
    expect(inside()).toBe(true); expect(button(tree, '回到刚才的位置')).toBeUndefined(); expect(selected).not.toHaveBeenCalled()
  })
  it('受阻徽章保持原来的动作（走进项目），不触发导航；小人照旧开会话详情', () => {
    render()
    hit(plate('合成花园：受阻 1 项')); expect(inside()).toBe(true)
    expect(button(tree, '回到刚才的位置')).toBeUndefined(); expect(selected).not.toHaveBeenCalled()
    host.reset(); render()
    scene().props.onSelect({ kind: 'character', key: 'session-41' }); render()
    expect(selected).toHaveBeenCalledOnce(); expect(selected).toHaveBeenCalledWith({ kind: 'character', key: 'session-41' }); expect(inside()).toBe(false)
    expect(button(tree, '回到刚才的位置')).toBeUndefined()
  })
  it('到达后的“进入工作室”入口才进室内', () => {
    render(); hit(plate('去门前花园：合成花园')); expect(inside()).toBe(false)
    press('进入工作室'); expect(inside()).toBe(true)
  })
})

describe('回到刚才的位置', () => {
  it('连续导航不覆盖返回点，返回第一次导航前的镜头和 Agent 筛选，然后清空', () => {
    render(); const initial = view()
    hit(plate('看片区「合成一带」')); hit(plate('去门前花园：合成片区项目2')); press('项目 8'); press('合成花园')
    press('按 Agent 看'); expect(scene().props.agents).not.toBeNull()
    press('回到刚才的位置')
    expect(view()).toEqual(initial); expect(scene().props.agents).toBeNull(); expect(scene().props.focusArea).toBeNull()
    expect(button(tree, '回到刚才的位置')).toBeUndefined()
  })
  it('拖动后返回点作废并明确说明', () => {
    render(); hit(plate('去门前花园：合成花园'))
    tree.props.ref.current = { getBoundingClientRect: () => ({ width: 800, height: 500, left: 0, top: 0 }), setPointerCapture: vi.fn(), releasePointerCapture: vi.fn(), addEventListener: vi.fn(), removeEventListener: vi.fn() }
    tree.props.onPointerDown({ button: 0, clientX: 10, clientY: 10, pointerId: 1 }); tree.props.onPointerMove({ clientX: 60, clientY: 30, pointerId: 1 }); render()
    expect(button(tree, '回到刚才的位置')).toBeUndefined(); expect(words(tree)).toContain('“回到刚才的位置”已作废')
  })
  it('经 TownView：恢复设备范围、只看的项目和状态高亮；恢复不了的说明原因', () => {
    const onScope = vi.fn(), onAllRepos = vi.fn(), onSelectRepo = vi.fn()
    storage.set(EXTRAS_KEY, JSON.stringify({ chips: true, replay: true, parcels: true }))
    viewProps = { scope: 'all', onScope, onAllRepos, onSelectRepo, repoId: 'all' }; render()
    nodes(townTree).find((n) => n.type === 'button' && words(n).startsWith('工作中'))!.props.onClick(); render()
    const initial = view()
    hit(plate('去门前花园：合成花园'))
    // 导航之后用户又切到这台、只看一个项目、换了高亮。
    viewProps = { ...viewProps, scope: 'here', repoId: 1, provider: 'claude' }; render()
    nodes(townTree).find((n) => n.type === 'button' && words(n).startsWith('等你决定'))!.props.onClick(); render()
    press('回到刚才的位置')
    expect(onScope).toHaveBeenCalledWith('all'); expect(onAllRepos).toHaveBeenCalledOnce(); expect(onSelectRepo).not.toHaveBeenCalled()
    expect(nodes(townTree).find((n) => n.type === 'button' && words(n).startsWith('工作中'))!.props['aria-pressed']).toBe(true)
    expect(view()).toEqual(initial)
    expect(words(tree)).toContain('Agent 来源筛选在小镇外改过')
  })
  it('切换本机 / 全部设备不重建：镜头停在原处，本机项目还在原来的地块', () => {
    viewProps = {}; render()
    hit(plate('去门前花园：合成花园')); const at = view(); const cell = district('self#1').cell
    snap = { ...snap, repos: [...repos.map((r) => ({ ...r, device: '本机演示' })), { id: 1_000_000_001, name: '合成花园', device: '远方演示机', common_dir: '', is_git: true, target_ref: 'main' }],
      work_items: [...snap.work_items!, fakeItem({ id: '远方演示机:SYN-1', repo_id: 1_000_000_001, title: '远端合成工作', status: 'in_progress', updated_at: snap.now })],
      devices: [{ id: 'self', name: '本机演示', self: true, online: true, received_at: snap.now }, { id: 'r1', name: '远方演示机', self: false, online: true, received_at: snap.now }] }
    render()
    expect(view()).toEqual(at); expect(district('self#1').cell).toEqual(cell); expect(district('远方演示机#1')).toBeDefined()
    expect(button(tree, '回到刚才的位置')).toBeDefined()
  })
})

describe('30 秒内不被自动巡游抢镜', () => {
  it('桌面模式：导航后 30 秒内不巡游，之后照常恢复', () => {
    reduced = false; props = { plan, kiosk: true, rotateMs: 20_000 }; render(); walk(1000)
    hit(plate('去门前花园：合成花园')); expect(requestAnimationFrame).toHaveBeenCalledTimes(1)
    walk(29_000); expect(requestAnimationFrame).toHaveBeenCalledTimes(1)
    walk(11_000); expect(requestAnimationFrame).toHaveBeenCalledTimes(2)
  })
  it('返回后同样保护 30 秒', () => {
    reduced = false; props = { plan, kiosk: true, rotateMs: 20_000 }; render(); walk(1000)
    hit(plate('去门前花园：合成花园')); walk(5000); press('回到刚才的位置'); expect(requestAnimationFrame).toHaveBeenCalledTimes(2)
    walk(29_000); expect(requestAnimationFrame).toHaveBeenCalledTimes(2)
    walk(20_000); expect(requestAnimationFrame).toHaveBeenCalledTimes(3)
  })
  it('导航后新熟菜只入队，不自动飞走', () => {
    render(); hit(plate('去门前花园：合成花园')); const at = view()
    snap = { ...snap, cursor: 2, work_items: snap.work_items!.map((w) => w.id === 'SYN-1' ? { ...w, status: 'review', updated_at: new Date().toISOString() } : w) }
    render(); advance(3000)
    expect(view()).toEqual(at); expect(words(tree)).toContain('1 处有新动态')
  })
})

describe('看居民时留在花园', () => {
  it('居民面板开着超过巡游周期也不飞走，关闭后恢复巡游', () => {
    reduced = false; props = { plan, kiosk: true, rotateMs: 5000 }; render()
    press('居民 7')
    const flights = vi.mocked(requestAnimationFrame).mock.calls.length
    walk(65_000)
    expect(requestAnimationFrame).toHaveBeenCalledTimes(flights)
    press('居民 7')
    walk(40_000)
    expect(vi.mocked(requestAnimationFrame).mock.calls.length).toBeGreaterThan(flights)
  })
  it('看居民超过手动操作保护期后，新交付仍只入队，不抢走镜头', () => {
    render(); press('居民 7'); const at = view(); walk(35_000)
    snap = { ...snap, cursor: 2, work_items: snap.work_items!.map((w) => w.id === 'SYN-1' ? { ...w, status: 'review', updated_at: new Date().toISOString() } : w) }
    render(); advance(3000)
    expect(view()).toEqual(at)
    expect(words(tree)).toContain('1 处有新动态')
  })
})

describe('两台设备同名项目不串位', () => {
  it('同名项目按来源设备各自定位；设备顺序变了也去同一块地', () => {
    const devices = [{ id: 'self', name: '本机演示', self: true, online: true, received_at: snap.now }, { id: 'r1', name: '远方演示机', self: false, online: true, received_at: snap.now }]
    snap = { ...snap, devices, repos: [{ ...repos[0], device: '本机演示' }, { id: 1_000_000_001, name: '合成花园', device: '远方演示机', common_dir: '', is_git: true, target_ref: 'main' }] }
    props = { plan: { central: [1, 1_000_000_001], villages: [], wild: [], activity: new Map() } }
    render()
    const remote = district('远方演示机#1'), local = district('self#1')
    expect(remote.cell).not.toEqual(local.cell)
    const plates = nodes(drawn()).filter((n) => n.props['aria-label']?.startsWith('去门前花园：合成花园'))
    expect(plates).toHaveLength(2)
    scene().props.onNavigate({ kind: 'project', id: '远方演示机#1' }); render()
    expect(gardenInView('远方演示机#1')).toBe(true); expect(gardenInView('self#1')).toBe(false)
    expect(words(tree)).toContain('另一台电脑，仅查看')
    // 又接入一台设备排在前面：远方演示机的合并编号变了，身份和位置不变。
    snap = { ...snap, cursor: 2, devices: [devices[0], { ...devices[1], id: 'r0', name: '第三台演示机' }, devices[1]],
      repos: [snap.repos![0], { id: 1_000_000_001, name: '新来的合成项目', device: '第三台演示机', common_dir: '', is_git: true, target_ref: 'main' }, { ...snap.repos![1], id: 2_000_000_001 }] }
    props = { plan: { central: [1, 1_000_000_001, 2_000_000_001], villages: [], wild: [], activity: new Map() } }
    render()
    expect(district('远方演示机#1').cell).toEqual(remote.cell); expect(district('远方演示机#1').key).toBe('repo-2000000001')
  })
})

describe('导航零业务写入', () => {
  it('名牌、片区、列表、返回、键盘：不调接口、不发请求、不写存储、不开详情', () => {
    const calls = Object.keys(api).filter((k) => typeof (api as any)[k] === 'function').map((k) => vi.spyOn(api as any, k))
    render(); setItem.mockClear()
    hit(plate('看片区「合成一带」')); hit(plate('去门前花园：合成片区项目4'))
    press('项目 8'); press('去花园：合成花园')
    plate('去门前花园：合成片区项目6')!.props.onKeyDown({ key: 'Enter', preventDefault: noop }); render()
    press('回到刚才的位置'); advance(10_000)
    for (const c of calls) expect(c).not.toHaveBeenCalled()
    expect(fetch).not.toHaveBeenCalled(); expect(setItem).not.toHaveBeenCalled(); expect(selected).not.toHaveBeenCalled()
    expect(snap.work_items!.map((w) => w.status)).toEqual(['in_progress', 'blocked'])
  })
})

describe('结构说明保留阅读现场', () => {
  const explanation = () => nodes(tree).find(n => n.type === TownStructure)
  const open = (focus = vi.fn()) => {
    touch(); const target = targetButton('结构说明')
    const restoredFocus = inside() ? focus : button(tree, '更多')!.props.ref.current.focus
    target.props.onClick({ currentTarget: { focus } }); render()
    return restoredFocus
  }
  const close = () => { explanation()!.props.onClose(); render() }
  it('地图保留 SS 样本并返回更多，房间读取自己的结构并返回室内入口', () => {
    render(); const before = view(); const hiddenTriggerFocus = vi.fn(), focus = open(hiddenTriggerFocus)
    expect(explanation()).toBeDefined(); expect(explanation()!.props.project).toBeUndefined()
    expect(nodes(tree).find(n => n.props.className === 'town-world-surface')!.props.inert).toBe(true)
    close(); expect(view()).toEqual(before); expect(focus).toHaveBeenCalledWith({ preventScroll: true })
    expect(hiddenTriggerFocus).not.toHaveBeenCalled()
    expect(button(tree, '更多')!.props['aria-expanded']).toBe(false)
    scene().props.onSelect({ kind: 'building', key: 'repo-1' }); render()
    const roomFocus = open(); expect(inside()).toBe(true)
    expect(explanation()!.props.project.b.repo.id).toBe(1)
    expect(explanation()!.props.project.b.name).toBe('合成花园')
    close(); expect(inside()).toBe(true); expect(roomFocus).toHaveBeenCalledOnce()
    expect(selected).not.toHaveBeenCalled()
  })
  it('桌面巡游和选中会话的镜头跳转在阅读期间暂停，关闭后仍在原处', () => {
    reduced = false; props = { plan, kiosk: true, rotateMs: 5000 }; render()
    const before = view(); open(); walk(65_000)
    props = { ...props, focusKey: 'session-41' }; render()
    expect(requestAnimationFrame).not.toHaveBeenCalled(); expect(view()).toEqual(before)
    close(); expect(view()).toEqual(before)
    walk(29_000); expect(requestAnimationFrame).not.toHaveBeenCalled()
    walk(11_000); expect(requestAnimationFrame).toHaveBeenCalled()
  })
  it('打开时停止尚未结束的飞行；阅读时新交付只入队，不自动飞走或开详情', () => {
    reduced = false; render(); hit(plate('去门前花园：合成花园'))
    expect(requestAnimationFrame).toHaveBeenCalledOnce()
    open(); expect(cancelAnimationFrame).toHaveBeenCalledWith(1)
    const before = view()
    snap = { ...snap, cursor: 2, work_items: snap.work_items!.map(w => w.id === 'SYN-1' ? { ...w, status: 'review', updated_at: new Date().toISOString() } : w) }
    render(); walk(35_000)
    expect(view()).toEqual(before); expect(requestAnimationFrame).toHaveBeenCalledOnce()
    expect(selected).not.toHaveBeenCalled()
  })
  it('浮层内滚轮不阻止正常滚动、不缩放；地图拖动也被保护', () => {
    render()
    const handlers = new Map<string, any>()
    tree.props.ref.current = { getBoundingClientRect: () => ({ width: 800, height: 500, left: 0, top: 0 }), addEventListener: (name: string, fn: any) => handlers.set(name, fn), removeEventListener: (name: string) => handlers.delete(name) }
    render(); open(); const before = view(); const preventDefault = vi.fn()
    handlers.get('wheel')({ target: { closest: () => true }, preventDefault, deltaY: 300, clientX: 200, clientY: 200 })
    tree.props.onPointerDown({ button: 0, clientX: 10, clientY: 10, pointerId: 1 }); tree.props.onPointerMove({ clientX: 60, clientY: 30, pointerId: 1 }); render()
    expect(preventDefault).not.toHaveBeenCalled(); expect(view()).toEqual(before)
  })
  it('打开、阅读、关闭不产生接口请求或状态改写', () => {
    const calls = Object.keys(api).filter(k => typeof (api as any)[k] === 'function').map(k => vi.spyOn(api as any, k))
    render(); const before = JSON.stringify(snap); setItem.mockClear()
    open(); walk(10_000); close()
    for (const call of calls) expect(call).not.toHaveBeenCalled()
    expect(fetch).not.toHaveBeenCalled(); expect(setItem).not.toHaveBeenCalled(); expect(selected).not.toHaveBeenCalled()
    expect(JSON.stringify(snap)).toBe(before)
  })
  it('窄屏分页布局也能阅读同一样本，暂停自动翻页并恢复入口焦点', () => {
    snap = { ...snap, work_items: [...snap.work_items!, ...repos.slice(1).map(r => fakeItem({ id: `SYN-PAGE-${r.id}`, title: '合成分页工作', repo_id: r.id, status: 'in_progress', updated_at: snap.now }))] }
    const narrowRender = () => {
      for (let i = 0; i < 12; i++) {
        host.begin('narrow')
        townTree = TownView({ snap, conn: 'live', repoId: 'all', provider: 'all', sel: null, layout: 'portrait', world: true, kiosk: true, rotateMs: 5000,
          onSelectItem: selected, onSelectSession: noop, onSelectRepo: noop, onQueue: noop })
        if (!host.commit()) return
      }
    }
    narrowRender()
    const page = () => nodes(townTree).find(n => n.props.role === 'group' && String(n.props['aria-label']).startsWith('项目分页'))!.props['aria-label']
    const before = page(), focus = vi.fn()
    button(townTree, '结构说明')!.props.onClick({ currentTarget: { focus } }); narrowRender()
    expect(nodes(townTree).some(n => n.type === TownStructure)).toBe(true)
    for (let i = 0; i < 60; i++) { vi.advanceTimersByTime(1000); narrowRender() }
    expect(page()).toBe(before)
    nodes(townTree).find(n => n.type === TownStructure)!.props.onClose(); narrowRender()
    expect(page()).toBe(before); expect(focus).toHaveBeenCalledWith({ preventScroll: true })
    expect(selected).not.toHaveBeenCalled(); expect(fetch).not.toHaveBeenCalled()
  })
})

describe('验收台去项目门口', () => {
  const desk = () => { touch(); scene().props.onSelect({ kind: 'review-desk', key: 'review-desk' }); render() }
  const ripe = (id: string, repo: number) => fakeItem({ id, repo_id: repo, title: `合成交付${id}`, status: 'review', updated_at: snap.now })
  it('只有一个项目在等：点验收台直接飞到它门口，不开队列', () => {
    snap = { ...snap, work_items: [...snap.work_items!, ripe('SYN-R1', 4)] }
    render(); desk()
    expect(gardenInView('self#4')).toBe(true); expect(inside()).toBe(false); expect(selected).not.toHaveBeenCalled()
  })
  it('几个项目在等：列出来，点“去门口”飞过去，列表收起', () => {
    snap = { ...snap, work_items: [...snap.work_items!, ripe('SYN-R1', 4), ripe('SYN-R2', 4), ripe('SYN-R3', 6)] }
    render(); desk()
    expect(words(tree)).toContain('这台电脑 · 3 件')
    press('去门口：合成片区项目5'); expect(gardenInView('self#6')).toBe(true); expect(inside()).toBe(false)
    expect(button(tree, '去门口：合成片区项目5')).toBeUndefined(); expect(selected).not.toHaveBeenCalled()
  })
  it('没有待验收时照旧打开关注队列', () => {
    render(); desk()
    expect(selected).toHaveBeenCalledWith({ kind: 'review-desk', key: 'review-desk' })
  })
})

// 使用真实居民 store、面板回调和跟随组件 effect；每拍显式重画，模拟浏览器的外部 store 订阅。
const followNode = () => nodes(tree).find((n) => n.type === ResidentFollow)!
const residentStore = (): ResidentStore => followNode().props.store
const residentPanel = () => {
  const panel = nodes(tree).find((n) => n.type === ResidentsPanel)!
  host.begin('resident-panel'); const result = ResidentsPanel(panel.props); host.commit(); return result
}
const startResidentVisit = (id: ResidentId = 'gpt', destination?: string) => {
  if (!tree) render()
  if (!nodes(tree).some((n) => n.type === ResidentsPanel)) press('居民 7')
  nodes(tree).find((n) => n.type === ResidentsPanel)!.props.onSelect(id); render()
  let panel = residentPanel()
  if (destination) { nodes(panel).find((n) => n.type === 'select')!.props.onChange({ target: { value: destination } }); panel = residentPanel() }
  button(panel, '去串门')!.props.onClick(); render()
  return residentStore()
}
const residentTick = (ms = 500) => { vi.advanceTimersByTime(ms); residentStore().tick(Date.now()); render() }
const followedInView = (id: ResidentId) => {
  const trip = residentStore().getSnapshot().actors[id].trip!
  return within(iso(trip.x, trip.y), view())
}
const followButton = (label: string) => { button(residentTree!, label)!.props.onClick(); render() }

describe('跟着串门居民走', () => {
  it('点去串门自动跟随，位置推进时镜头也推进', () => {
    render(); const before = view(), store = startResidentVisit()
    expect(followNode().props).toMatchObject({ id: 'gpt', following: true })
    expect(view()).not.toEqual(before); expect(followedInView('gpt')).toBe(true)
    const first = view(); residentTick(); residentTick()
    expect(view()).not.toEqual(first); expect(followedInView('gpt')).toBe(true)
    expect(store.getSnapshot().actors.gpt.trip).toBeDefined()
  })
  it('工作详情打开只暂停巡游，显式居民跟随仍然推进', () => {
    viewProps = { sel: { kind: 'item', id: 'SYN-1' } }; render(); startResidentVisit()
    expect(nodes(townTree).find((n) => n.type === WorldStage)!.props.paused).toBe(true)
    const before = view(); residentTick(); residentTick()
    expect(view()).not.toEqual(before); expect(followedInView('gpt')).toBe(true)
  })
  it('拖动交还镜头但居民继续走，可继续跟随，也能停止跟随', () => {
    render(); const store = startResidentVisit()
    tree.props.ref.current = { getBoundingClientRect: () => ({ width: 800, height: 500, left: 0, top: 0 }), querySelector: () => null, setPointerCapture: vi.fn(), releasePointerCapture: vi.fn(), addEventListener: vi.fn(), removeEventListener: vi.fn() }
    tree.props.onPointerDown({ button: 0, clientX: 10, clientY: 10, pointerId: 1 }); tree.props.onPointerMove({ clientX: 100, clientY: 30, pointerId: 1 }); render()
    expect(followNode().props.following).toBe(false)
    const manual = view(), before = { ...store.getSnapshot().actors.gpt.trip! }; residentTick(); residentTick()
    expect(view()).toEqual(manual); expect(store.getSnapshot().actors.gpt.trip).not.toEqual(before)
    followButton('继续跟随'); expect(followNode().props.following).toBe(true); expect(followedInView('gpt')).toBe(true)
    followButton('停止跟随'); expect(followNode().props.following).toBe(false)
  })
  it('缩放和手动项目导航都退出跟随，镜头不会被下一拍抢回', () => {
    render(); startResidentVisit(); press('放大')
    expect(followNode().props.following).toBe(false)
    const zoom = view(); residentTick(); expect(view()).toEqual(zoom)
    followButton('继续跟随'); scene().props.onNavigate({ kind: 'project', id: 'self#1' }); render()
    expect(followNode().props.following).toBe(false)
    const project = view(); residentTick(); expect(view()).toEqual(project)
  })
  it('一只进屋时自动跟进，返程回世界，回到家后结束跟随', () => {
    render(); const original = JSON.stringify(snap), destination = scene().props.world.districts[0]
    const store = startResidentVisit('gpt', destination.id)
    for (let i = 0; i < 360 && store.getSnapshot().actors.gpt.trip?.phase !== 'inside'; i++) residentTick()
    expect(store.getSnapshot().actors.gpt.trip?.phase).toBe('inside')
    expect(nodes(tree).find((n) => n.type === InteriorScene)!.props.b.key).toBe(destination.key)
    expect(followNode().props.following).toBe(true)
    for (let i = 0; i < 500 && store.getSnapshot().actors.gpt.trip; i++) residentTick()
    expect(store.getSnapshot().actors.gpt.trip).toBeUndefined(); expect(inside()).toBe(false)
    expect(followNode().props.id).toBeNull(); expect(residentTree).toBeNull()
    expect(JSON.stringify(snap)).toBe(original)
  })
  it('两只分别串门时只跟最近指定的一只，手动离开房间后不强行跟回去', () => {
    render(); const destination = scene().props.world.districts[0], store = startResidentVisit('gpt', destination.id)
    startResidentVisit('deepseek', destination.id)
    expect(followNode().props.id).toBe('deepseek'); expect(store.getSnapshot().actors.gpt.trip).toBeDefined()
    for (let i = 0; i < 360 && store.getSnapshot().actors.deepseek.trip?.phase !== 'inside'; i++) residentTick()
    expect(inside()).toBe(true); press('← 回到世界')
    expect(followNode().props.following).toBe(false); residentTick(); expect(inside()).toBe(false)
  })
  it('居民自己的暂停冻结路线，恢复后继续跟随；进入回放清掉跟随', () => {
    render(); const store = startResidentVisit(); store.configure('paused', true); render()
    const before = { ...store.getSnapshot().actors.gpt.trip! }, camera = view(); residentTick(); residentTick()
    expect(store.getSnapshot().actors.gpt.trip).toEqual(before); expect(view()).toEqual(camera)
    store.configure('paused', false); residentTick(); expect(view()).not.toEqual(camera)
    props = { ...props, replaying: true }; render(); expect(followNode().props.id).toBeNull(); expect(residentTree).toBeNull()
  })
})


describe('全局对话框保持地图阅读现场', () => {
  let modal: boolean, listeners: Set<(event: any) => void>
  beforeEach(() => {
    modal = false; listeners = new Set()
    vi.stubGlobal('document', { hidden: false, querySelector: () => modal ? {} : null, addEventListener: vi.fn(), removeEventListener: vi.fn() })
    vi.mocked(window.addEventListener).mockImplementation(((type: string, listener: (event: any) => void) => { if (type === 'keydown') listeners.add(listener) }) as any)
    vi.mocked(window.removeEventListener).mockImplementation(((type: string, listener: (event: any) => void) => { if (type === 'keydown') listeners.delete(listener) }) as any)
  })
  const escape = () => {
    let stopped = false
    const event = { key: 'Escape', stopImmediatePropagation: () => { stopped = true }, preventDefault: vi.fn() }
    for (const listener of [...listeners]) { listener(event); if (stopped) break }
    render()
  }
  it('Esc只关闭更多操作并把焦点还给可见入口', () => {
    render(); press('更多')
    const focus = button(tree, '更多')!.props.ref.current.focus
    escape()
    expect(button(tree, '更多')!.props['aria-expanded']).toBe(false)
    expect(button(tree, '结构说明')).toBeUndefined()
    expect(focus).toHaveBeenCalledExactlyOnceWith({ preventScroll: true })
  })
  it('设置或直播说明在上层时 Esc 不退出正在阅读的项目房间，关上后才退出', () => {
    render(); press('项目 8'); press('进入工作室：合成片区项目1')
    expect(inside()).toBe(true)
    modal = true; escape(); expect(inside()).toBe(true)
    modal = false; escape(); expect(inside()).toBe(false)
  })
  it('上层画风对话框关闭时不同时收起背景项目列表', () => {
    render(); press('项目 8')
    expect(button(tree, '去花园：合成花园')).toBeDefined()
    modal = true; escape(); expect(button(tree, '去花园：合成花园')).toBeDefined()
    modal = false; escape(); expect(button(tree, '去花园：合成花园')).toBeUndefined()
  })
})
