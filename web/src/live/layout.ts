// 直播展示的紧凑排布：不沿用正常小镇里记住的位置，而是把要展示的项目按稳定顺序排成整齐的几行几列，
// 镜头只框这些房子和它们的名牌。纯计算，便于测试；位置只记在页面内存里，不读写浏览器存储。
//
// 格子坐标在等距视角里是斜的：u = cx - cy 决定左右，v = cx + cy 决定上下。同一行相邻两栋相差
// u = 2（屏幕上约 630 宽），相邻两行相差 v = 4（约 630 高）。行距按“前排名牌不碰后排的房子和小人标签”留够。
import { iso, type Pt } from '../town/iso'
import { liveCharacterName, liveCharacterStatus, measure, buildingArt, SIGN_MAX } from '../town/TownScene'
import { clip } from '../town/townModel'
import { districtPlot, TIERS, type LiveDress } from '../town/WorldScene'
import { CELL_D, CELL_W, INNER_D, INNER_W, buildingTier, finish, type Box, type Cell, type District, type Tier, type WorldLayout } from '../town/world'
import { AGENTS, agentOf } from '../town/agents'
import { shedSeat, shedSpots } from '../town/workshop'
import type { BuildingView } from '../town/townModel'
import type { WorldPlan } from '../town/clusters'
import type { TownThemeId } from '../town/appearance'

/** 最多画几栋房子（与服务端 LiveMaxProjects 一致）。 */
export const LIVE_MAX = 12
/** 招牌放大倍数（世界坐标）。镜头框住的范围由排布决定，所以招牌在画面上的大小也基本固定。 */
export const LIVE_SIGN_K = 4.4
/** 小人标签放大倍数（再乘小人本身的 1.22）。 */
export const LIVE_PILL_K = 2.1
/** 展示里最高只画到工坊：大楼太高，会顶到后排，名牌就只能压在别人家上。 */
const LIVE_TIER_MAX: Tier = 2
/** 第一行离中央广场的距离：广场不进画面。 */
const V0 = 4
/** 行距（v 方向的格子数）。 */
const ROW_V = 4
/** 最多几列。 */
const COLS_MAX = 6

/**
 * 稳定顺序：已经在画面上的项目保持原来的名次；离开的空位由新来的项目按编号补上，多出来的接在后面，
 * 空位没人补时后面的往前挪。第一次按编号升序（与通用名 项目 A、B、C 的顺序一致）。
 */
export function liveOrder(prev: readonly string[], keys: readonly string[], rank: (key: string) => number): string[] {
  const now = new Set(keys)
  const before = new Set(prev)
  const fresh = keys.filter((k) => !before.has(k)).sort((a, b) => rank(a) - rank(b) || a.localeCompare(b))
  const out: string[] = []
  for (const k of prev) {
    if (now.has(k)) out.push(k)
    else if (fresh.length) out.push(fresh.shift()!)
  }
  return [...out, ...fresh]
}

/** 第 i 栋（共 n 栋、cols 列）的格子。最后一行不满时尽量居中。 */
export function liveSlot(i: number, n: number, cols: number): Cell {
  const r = Math.floor(i / cols)
  const inRow = Math.min(cols, n - r * cols)
  const c = (i % cols) + Math.floor((cols - inRow) / 2)
  const v = V0 + ROW_V * r
  const u = 2 * c - 2 * Math.floor(cols / 2)
  return { cx: (u + v) / 2, cy: (v - u) / 2 }
}

const boxOf = (pts: readonly Pt[]): Box => {
  const xs = pts.map((p) => p[0]), ys = pts.map((p) => p[1])
  const x = Math.min(...xs), y = Math.min(...ys)
  return { x, y, w: Math.max(...xs) - x, h: Math.max(...ys) - y }
}
export const unionBox = (boxes: readonly Box[]): Box =>
  boxOf(boxes.flatMap((b) => [[b.x, b.y], [b.x + b.w, b.y + b.h]] as Pt[]))
export const overlaps = (a: Box, b: Box) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h

export type LiveArt = TownThemeId

/** 原画风的建筑主体：墙、披屋、屋顶（含出檐）、烟囱，干活时的烟和完成的小旗。 */
function plainBody(d: District): Box {
  const p = districtPlot(d)
  const { shape } = TIERS[d.tier]
  const H = shape.h, o = 0.25
  const right = p.gx + p.w + (shape.kind === 'workshop' ? 1.5 : 0) + o
  const foot = [iso(p.gx - o, p.gy - o), iso(right, p.gy - o), iso(right, p.gy + p.d + o), iso(p.gx - o, p.gy + p.d + o)]
  const tops = [iso(p.gx - o, p.gy - o, H), iso(p.gx + p.w / 2, p.gy + p.d / 2, H + shape.rise), iso(p.gx + p.w * 0.72, p.gy + 0.5, H + 42)]
  if (d.b.characters.some((c) => c.status === 'working')) tops.push(iso(p.gx + p.w * 0.72, p.gy + 0.7, H + 66))
  if (d.b.items.some((w) => w.status === 'done')) tops.push(iso(p.gx + p.w * 0.28, p.gy + p.d / 2, H + 62))
  const box = boxOf(foot)
  const top = Math.min(...tops.map((q) => q[1]))
  return { ...box, y: top, h: box.y + box.h - top }
}

/** 建筑主体在屏幕上的框。art 为某种画风时只算那一种；不给时取三种画风的并集。 */
export function liveBodyBox(d: District, art?: LiveArt): Box {
  const p = districtPlot(d)
  const { shape } = TIERS[d.tier]
  const story = (mini: boolean) => { const a = buildingArt(p, shape, mini).artBox; return { x: a.x, y: a.y, w: a.width, h: a.height } }
  if (art === 'original') return plainBody(d)
  if (art === 'storybook') return story(false)
  if (art === 'miniature') return story(true)
  return unionBox([plainBody(d), story(false), story(true)])
}

/** 招牌牌面的下边（未放大）。 */
const SIGN_RECT_BOTTOM = 12

/** 招牌的局部范围（未放大）：名字一行在 y -14..12，“N 位在工作”在上面一行，木桩到 y 26。 */
function signLocal(d: District) {
  const name = clip(d.b.name, SIGN_MAX)
  const working = d.b.characters.filter((c) => c.status === 'working').length
  const half = Math.max(measure(name, 14) + 26, working > 0 ? measure(`${working} 位在工作`, 12) : 0) / 2
  return { half, top: -34, bottom: 26 }
}

/** 招牌位置：建筑正上方，牌子底边落在建筑最高处（木桩插在自家屋顶上）。 */
export function liveSignAt(d: District, art?: LiveArt, k = LIVE_SIGN_K): Pt {
  const p = districtPlot(d)
  return [iso(p.gx + p.w / 2, p.gy + p.d / 2)[0], liveBodyBox(d, art).y - SIGN_RECT_BOTTOM * k]
}

export function liveSignBox(d: District, at: Pt, k = LIVE_SIGN_K): Box {
  const l = signLocal(d)
  return { x: at[0] - l.half * k, y: at[1] + l.top * k, w: 2 * l.half * k, h: (l.bottom - l.top) * k }
}

/** 站在作坊门口、会被画出来的小人（与 WorldScene 的选法一致：每间作坊一个，最需要你的那个）。 */
function seatedCharacters(d: District): { c: BuildingView['characters'][number]; at: Pt }[] {
  const present = AGENTS.map((a) => a.key).filter((a) => d.b.characters.some((c) => agentOf(c.session) === a))
  const rank: Record<string, number> = { waiting: 0, error: 1, working: 2, stale: 3 }
  return shedSpots(present, d.ox, d.oy).flatMap((spot) => {
    const c = d.b.characters.filter((x) => agentOf(x.session) === spot.agent).sort((a, b) => (rank[a.status] ?? 4) - (rank[b.status] ?? 4))[0]
    if (!c) return []
    const [gx, gy] = shedSeat(spot, 0)
    return [{ c, at: iso(gx, gy) }]
  })
}

/** 小人标签：每个标签挂在自己的小人下方；同一个院子里的几个标签往下错开，不互相压。 */
export function livePills(d: District, k = LIVE_PILL_K): { key: string; at: Pt; box: Box }[] {
  const s = 1.22 * k
  const out: { key: string; at: Pt; box: Box }[] = []
  let floor = -Infinity
  for (const { c, at } of seatedCharacters(d)) {
    const w = measure(liveCharacterStatus(c), 9.5) + 10 + measure(liveCharacterName(c), 9.5) + 10
    // 标签中心在 at + 17s；上一个标签底边以下再留 3s。
    const y = Math.max(at[1], floor + 3 * s - 9 * s)
    const box = { x: at[0] - (w / 2) * s, y: y + 9 * s, w: w * s, h: 16 * s }
    floor = box.y + box.h
    out.push({ key: c.key, at: [at[0], y], box })
  }
  return out
}

/** 一个街区的院子（等距菱形）在屏幕上的框。 */
function yardBox(d: District): Box {
  return boxOf([iso(d.ox, d.oy), iso(d.ox + INNER_W, d.oy), iso(d.ox + INNER_W, d.oy + INNER_D), iso(d.ox, d.oy + INNER_D)])
}

export interface LiveWorld { world: WorldLayout; dress: LiveDress; frame: Box; cols: number }

function build(buildings: readonly BuildingView[], plan: WorldPlan | undefined, cols: number, art: LiveArt | undefined): LiveWorld {
  const districts: District[] = buildings.map((b, i) => {
    const cell = liveSlot(i, buildings.length, cols)
    const tier = Math.min(LIVE_TIER_MAX, buildingTier(b, b.repo ? plan?.activity.get(b.repo.id) ?? 0 : 0)) as Tier
    return { key: b.key, id: b.key, b, cell, ox: cell.cx * CELL_W, oy: cell.cy * CELL_D, ring: Math.max(Math.abs(cell.cx), Math.abs(cell.cy)), kind: 'central', tier }
  })
  const signs = new Map<string, Pt>()
  const pills = new Map<string, Pt>()
  const boxes: Box[] = []
  for (const d of districts) {
    const at = liveSignAt(d, art)
    signs.set(d.key, at)
    boxes.push(yardBox(d), liveBodyBox(d, art), liveSignBox(d, at))
    for (const p of livePills(d)) { pills.set(p.key, p.at); boxes.push(p.box) }
  }
  const frame = boxes.length ? unionBox(boxes) : { x: -400, y: -300, w: 800, h: 600 }
  return { world: finish(districts, [], []), dress: { signK: LIVE_SIGN_K, signs, pillK: LIVE_PILL_K, pills }, frame, cols }
}

/**
 * 展示用的世界：buildings 已按 liveOrder 排好、最多 LIVE_MAX 栋。列数按画面比例选，
 * 让房子在画面里尽量大（取景后视野最窄的那种）。aspect 是镜头可用区域的宽高比；art 是当前画风（招牌贴着该画风的屋顶）。
 */
export function liveWorld(buildings: readonly BuildingView[], plan: WorldPlan | undefined, aspect: number, art?: LiveArt): LiveWorld {
  const list = buildings.slice(0, LIVE_MAX)
  let best: LiveWorld | null = null
  let bestW = Infinity
  for (let cols = 1; cols <= Math.max(1, Math.min(COLS_MAX, list.length)); cols++) {
    const lw = build(list, plan, cols, art)
    const w = Math.max(lw.frame.w, lw.frame.h * aspect)
    if (w < bestW - 1) { best = lw; bestW = w }
  }
  return best ?? build(list, plan, 1, art)
}
