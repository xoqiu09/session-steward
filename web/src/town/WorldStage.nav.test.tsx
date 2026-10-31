import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
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
import { WorldScene, WorldStage, type NavTarget } from './WorldScene'
import { InteriorScene } from './InteriorScene'
import { TownView } from './TownView'
import { api } from '../api'
import { buildTown } from './townModel'
import { fakeItem, fakeSession } from './fixtures'
import { FAR_W, type Box } from './world'
import { iso } from './iso'
import type { WorldPlan } from './clusters'

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
const needsYou = () => false
const selected = vi.fn()
const noop = () => {}
let snap: Snapshot, tree: Node, townTree: Node
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
    if (!host.commit()) return tree
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
const press = (label: string) => { touch(); button(tree, label)!.props.onClick(); render() }
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
