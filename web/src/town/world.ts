// 小镇世界：每个项目一个街区，围绕中央广场一圈圈排开；相机可拖动、缩放、巡游。纯函数，便于测试。
import { iso, type Pt } from './iso'
import type { BuildingView } from './townModel'
import type { Village, WorldPlan } from './clusters'
import { attentionManaged } from '../workManagement'

/** 一个街区占的格子（含右侧和前方的道路）。 */
export const CELL_W = 11
export const CELL_D = 10
/** 街区内可用范围，其余是道路。 */
export const INNER_W = 9
export const INNER_D = 8.2

export interface Cell { cx: number; cy: number }

export type DistrictKind = 'central' | 'village' | 'wild'

export interface District {
  key: string
  /** 稳定项目键（来源设备 + 原始项目编号），定位和记住位置都用它。 */
  id: string
  b: BuildingView
  cell: Cell
  /** 街区左上角的格子坐标。 */
  ox: number
  oy: number
  /** 第几圈（离中央广场的格子距离）。 */
  ring: number
  kind: DistrictKind
  /** 所属村庄；中央和野外为空。 */
  village?: string
  /** 建筑档次：0 小木屋、1 房子、2 工坊、3 大楼。 */
  tier: Tier
}

export type Tier = 0 | 1 | 2 | 3

/** 建筑档次看项目体量：未完成的工作项、近 7 天活动量、正在这里干活的会话。 */
export function buildingTier(b: BuildingView, activity = 0): Tier {
  const open = b.items.filter((w) => w.status !== 'done' && w.status !== 'abandoned').length
  const score = open + Math.min(activity, 45) / 3 + b.characters.length * 2
  return score >= 16 ? 3 : score >= 8 ? 2 : score >= 3 ? 1 : 0
}

export interface VillageArea {
  key: string
  name: string
  /** 村口小广场所在的格子。 */
  square: Cell
  cells: Cell[]
}

export interface WorldLayout {
  districts: District[]
  plaza: { ox: number; oy: number }
  villages: VillageArea[]
  /** 世界的格子范围（含边缘空地）。 */
  tiles: { gx0: number; gy0: number; gx1: number; gy1: number }
  /** 屏幕坐标下的世界范围。 */
  bounds: Box
  /** 记得的片区里，当前显示范围一个项目都没有的（已归档、被筛选或来源设备不在）。 */
  emptyVillages: { key: string; name: string }[]
}

export interface Box { x: number; y: number; w: number; h: number }

const cheb = (c: Cell) => Math.max(Math.abs(c.cx), Math.abs(c.cy))
const keyOf = (c: Cell) => `${c.cx},${c.cy}`

/** 围绕 (0,0) 的格子，按圈由内向外；同一圈先放离镜头近、离中心近的格子。 */
export function spiralCells(n: number, around: Cell = { cx: 0, cy: 0 }, skip: ReadonlySet<string> = new Set()): Cell[] {
  const out: Cell[] = []
  for (let r = 1; out.length < n && r < 64; r++) {
    const ring: Cell[] = []
    for (let cx = -r; cx <= r; cx++) for (let cy = -r; cy <= r; cy++) if (Math.max(Math.abs(cx), Math.abs(cy)) === r) ring.push({ cx, cy })
    // 等距视角里 cx+cy 越小越靠上（越远）；先放离镜头近、离中心近的格子。
    ring.sort((a, b) => Math.abs(a.cx) + Math.abs(a.cy) - (Math.abs(b.cx) + Math.abs(b.cy)) || (b.cx + b.cy) - (a.cx + a.cy) || a.cx - b.cx)
    for (const c of ring) {
      const cell = { cx: c.cx + around.cx, cy: c.cy + around.cy }
      if (!skip.has(keyOf(cell))) out.push(cell)
      if (out.length >= n) break
    }
  }
  return out
}

/** 排序：等你处理的 > 有人在干活的 > 有待验收的 > 其余，组内保持原顺序。 */
export function districtOrder(buildings: readonly BuildingView[], needsYou: (b: BuildingView) => boolean): BuildingView[] {
  const score = (b: BuildingView) =>
    needsYou(b) ? 0 : b.characters.some((c) => c.status === 'working') ? 1 : b.items.some((w) => !attentionManaged(w) && w.status === 'review') ? 2 : b.characters.length ? 3 : 4
  return buildings.map((b, i) => ({ b, i, s: score(b) })).sort((x, y) => x.s - y.s || x.i - y.i).map((x) => x.b)
}

function boxOfTiles(gx0: number, gy0: number, gx1: number, gy1: number, top = 140, bottom = 40): Box {
  const corners = [iso(gx0, gy0), iso(gx1, gy0), iso(gx1, gy1), iso(gx0, gy1)]
  const xs = corners.map((c) => c[0]), ys = corners.map((c) => c[1])
  const x = Math.min(...xs), y = Math.min(...ys) - top
  return { x, y, w: Math.max(...xs) - x, h: Math.max(...ys) + bottom - y }
}

const DIRS: Cell[] = [{ cx: 1, cy: 0 }, { cx: 0, cy: 1 }, { cx: -1, cy: 0 }, { cx: 0, cy: -1 }, { cx: 1, cy: 1 }, { cx: -1, cy: 1 }, { cx: 1, cy: -1 }, { cx: -1, cy: -1 }]

/** 分组排布。没有 plan 时（测试、旧数据）全部围着中央广场。 */
export function worldLayout(buildings: readonly BuildingView[], needsYou: (b: BuildingView) => boolean, plan?: WorldPlan, idOf: (b: BuildingView) => string = (b) => b.key): WorldLayout {
  const taken = new Set<string>([keyOf({ cx: 0, cy: 0 })])
  const districts: District[] = []
  const place = (b: BuildingView, cell: Cell, kind: DistrictKind, village?: string) => {
    taken.add(keyOf(cell))
    const tier = buildingTier(b, b.repo ? plan?.activity.get(b.repo.id) ?? 0 : 0)
    districts.push({ key: b.key, id: idOf(b), b, cell, ox: cell.cx * CELL_W, oy: cell.cy * CELL_D, ring: cheb(cell), kind, village, tier })
  }
  const byRepo = new Map(buildings.filter((b) => b.repo).map((b) => [b.repo!.id, b]))
  const inPlan = new Set<number>(plan ? [...plan.central, ...plan.villages.flatMap((v) => v.repoIds), ...plan.wild] : [])
  // 不在 plan 里的（未归属、plan 之后新出现的）也放到中央。
  const centralList = districtOrder(buildings.filter((b) => !b.repo || !plan || !inPlan.has(b.repo.id) || plan.central.includes(b.repo.id)), needsYou)
  spiralCells(centralList.length, { cx: 0, cy: 0 }, taken).forEach((cell, i) => place(centralList[i], cell, 'central'))

  const villages: VillageArea[] = []
  if (plan) {
    let radius = Math.max(1, ...districts.map((d) => d.ring)) + 2
    plan.villages.forEach((v, i) => {
      const members = districtOrder(v.repoIds.map((id) => byRepo.get(id)).filter((b): b is BuildingView => !!b), needsYou)
      if (!members.length) return
      const size = members.length <= 8 ? 1 : 2
      const dir = DIRS[i % DIRS.length]
      const dist = radius + size - 1 + Math.floor(i / DIRS.length) * 3
      let square = { cx: dir.cx * dist, cy: dir.cy * dist }
      while (taken.has(keyOf(square))) square = { cx: square.cx + dir.cx, cy: square.cy + dir.cy }
      taken.add(keyOf(square))
      const cells = spiralCells(members.length, square, taken)
      cells.forEach((cell, j) => place(members[j], cell, 'village', v.key))
      villages.push({ key: v.key, name: v.name, square, cells: [square, ...cells] })
    })
    // 野外：紧挨着最外圈，和别的房子至少隔一格，绕着世界均匀散开。
    const wild = plan.wild.map((id) => byRepo.get(id)).filter((b): b is BuildingView => !!b)
    if (wild.length) {
      radius = Math.max(1, ...districts.map((d) => d.ring), ...villages.map((v) => cheb(v.square) + 1))
      let left = wild
      for (let r = radius; left.length && r < radius + 20; r += 1) {
        const ring: Cell[] = []
        for (let cx = -r; cx <= r; cx++) for (let cy = -r; cy <= r; cy++) {
          if (Math.max(Math.abs(cx), Math.abs(cy)) !== r || (cx + cy) % 2 !== 0) continue
          const c = { cx, cy }
          const near = [...taken].some((k) => { const [x, y] = k.split(',').map(Number); return Math.max(Math.abs(x - cx), Math.abs(y - cy)) < 2 })
          if (!near) ring.push(c)
        }
        ring.sort((a, b) => Math.atan2(a.cy, a.cx) - Math.atan2(b.cy, b.cx))
        const n = Math.min(left.length, ring.length)
        for (let i = 0; i < n; i++) place(left[i], ring[Math.floor((i * ring.length) / n)], 'wild')
        left = left.slice(n)
      }
    }
  }

  return finish(districts, villages, [])
}

function finish(districts: District[], villages: VillageArea[], emptyVillages: WorldLayout['emptyVillages']): WorldLayout {
  const all = [{ cx: 0, cy: 0 }, ...districts.map((d) => d.cell), ...villages.map((v) => v.square)]
  // 外面再留一圈空地（树林），世界不是刚好卡在最后一栋房子边上。
  const gx0 = (Math.min(...all.map((c) => c.cx)) - 0.35) * CELL_W, gy0 = (Math.min(...all.map((c) => c.cy)) - 0.35) * CELL_D
  const gx1 = (Math.max(...all.map((c) => c.cx)) + 1.25) * CELL_W, gy1 = (Math.max(...all.map((c) => c.cy)) + 1.25) * CELL_D
  return { districts, plaza: { ox: 0, oy: 0 }, villages, tiles: { gx0, gy0, gx1, gy1 }, bounds: boxOfTiles(gx0, gy0, gx1, gy1), emptyVillages }
}

// ---- 稳定位置：第一次按分组排好后记住每个项目的格子；之后状态、排名、设备顺序变了也不搬家，新项目往外追加 ----

export interface Placement { cell: Cell; kind: DistrictKind; village?: string }

/** 记住的位置，按稳定项目键。不在当前显示范围的项目也保留格子，回来时还在原处。 */
export interface WorldMemo {
  places: Map<string, Placement>
  villages: Map<string, { name: string; square: Cell }>
}

export const newWorldMemo = (): WorldMemo => ({ places: new Map(), villages: new Map() })

/** 记住的位置存在浏览器里：刷新、重开 App 后房子还在原处。只存格子坐标和片区名，不存项目内容。 */
export const LAYOUT_KEY = 'ss.town.layout.v1'
const LAYOUT_MAX = 600

const isCell = (c: unknown): c is Cell => !!c && Number.isInteger((c as Cell).cx) && Number.isInteger((c as Cell).cy)

export function loadWorldMemo(storage: Pick<Storage, 'getItem'> | undefined = globalThis.localStorage): WorldMemo {
  const memo = newWorldMemo()
  try {
    const raw = JSON.parse(storage?.getItem(LAYOUT_KEY) || 'null')
    for (const [k, p] of Array.isArray(raw?.places) ? raw.places : []) {
      if (typeof k === 'string' && isCell(p?.cell) && ['central', 'village', 'wild'].includes(p.kind)) {
        memo.places.set(k, { cell: { cx: p.cell.cx, cy: p.cell.cy }, kind: p.kind, ...(typeof p.village === 'string' ? { village: p.village } : {}) })
      }
    }
    for (const [k, v] of Array.isArray(raw?.villages) ? raw.villages : []) {
      if (typeof k === 'string' && typeof v?.name === 'string' && isCell(v?.square)) memo.villages.set(k, { name: v.name, square: { cx: v.square.cx, cy: v.square.cy } })
    }
  } catch { /* 读不到或格式不对：当作第一次排布。 */ }
  // 片区引用了不存在的村子时整份作废，免得排出半个村子。
  for (const p of memo.places.values()) if (p.village && !memo.villages.has(p.village)) return newWorldMemo()
  return memo
}

export function saveWorldMemo(memo: WorldMemo, storage: Pick<Storage, 'setItem'> | undefined = globalThis.localStorage): void {
  // 只留最近的一部分，项目很多时也不会无限增长（Map 按插入顺序，新项目在后面）。
  const places = [...memo.places].slice(-LAYOUT_MAX)
  const used = new Set(places.map(([, p]) => p.village).filter(Boolean))
  const villages = [...memo.villages].filter(([k]) => used.has(k))
  try { storage?.setItem(LAYOUT_KEY, JSON.stringify({ places, villages })) } catch { /* 存不下时本次会话照常可用。 */ }
}

/** 野外空地：离所有占用格子至少隔一格，从内圈往外找。 */
function wildCell(taken: ReadonlySet<string>): Cell {
  const cells = [...taken].map((k) => k.split(',').map(Number))
  const start = Math.max(1, ...cells.map(([x, y]) => Math.max(Math.abs(x), Math.abs(y))))
  for (let r = start; r < start + 40; r++) {
    const ring: Cell[] = []
    for (let cx = -r; cx <= r; cx++) for (let cy = -r; cy <= r; cy++) {
      if (Math.max(Math.abs(cx), Math.abs(cy)) !== r || (cx + cy) % 2 !== 0) continue
      if (!cells.some(([x, y]) => Math.max(Math.abs(x - cx), Math.abs(y - cy)) < 2)) ring.push({ cx, cy })
    }
    ring.sort((a, b) => Math.atan2(a.cy, a.cx) - Math.atan2(b.cy, b.cx))
    if (ring.length) return ring[0]
  }
  return spiralCells(1, { cx: 0, cy: 0 }, taken)[0]
}

/** 按记住的位置排布；memo 为空时用 worldLayout 的分组排第一次并记下来。memo 会被更新。 */
export function stableLayout(buildings: readonly BuildingView[], needsYou: (b: BuildingView) => boolean, plan: WorldPlan | undefined, memo: WorldMemo, idOf: (b: BuildingView) => string): WorldLayout {
  if (!memo.places.size) {
    const first = worldLayout(buildings, needsYou, plan, idOf)
    for (const d of first.districts) memo.places.set(d.id, { cell: d.cell, kind: d.kind, village: d.village })
    for (const v of first.villages) memo.villages.set(v.key, { name: v.name, square: v.square })
    return first
  }
  const taken = new Set<string>([keyOf({ cx: 0, cy: 0 })])
  for (const p of memo.places.values()) taken.add(keyOf(p.cell))
  for (const v of memo.villages.values()) taken.add(keyOf(v.square))
  const byRepo = new Map(buildings.filter((b) => b.repo).map((b) => [b.repo!.id, b]))
  const villageOf = new Map<number, Village>()
  for (const v of plan?.villages ?? []) for (const id of v.repoIds) villageOf.set(id, v)
  const wild = new Set(plan?.wild ?? [])
  // 新项目按现在的分组找去处：同村已有老住户就挨着它，至少两个新成员才在外圈开一个新村，不常动的去野外，其余围着中央。
  const fresh = districtOrder(buildings.filter((b) => !memo.places.has(idOf(b))), needsYou)
  const freshIn = new Map<string, number>()
  for (const b of fresh) { const v = b.repo && villageOf.get(b.repo.id); if (v) freshIn.set(v.key, (freshIn.get(v.key) ?? 0) + 1) }
  for (const b of fresh) {
    const pv = b.repo ? villageOf.get(b.repo.id) : undefined
    const mate = pv?.repoIds.map((id) => byRepo.get(id)).map((m) => (m ? memo.places.get(idOf(m)) : undefined)).find((p) => p?.kind === 'village')
    let place: Placement
    if (pv && (mate || (freshIn.get(pv.key) ?? 0) >= 2)) {
      let key = mate?.village
      if (!key) {
        key = pv.key
        for (let n = 2; memo.villages.has(key); n++) key = `${pv.key}~${n}`
        const radius = Math.max(1, ...[...taken].map((k) => { const [x, y] = k.split(',').map(Number); return Math.max(Math.abs(x), Math.abs(y)) })) + 2
        const dir = DIRS[memo.villages.size % DIRS.length]
        let square = { cx: dir.cx * radius, cy: dir.cy * radius }
        while (taken.has(keyOf(square))) square = { cx: square.cx + dir.cx, cy: square.cy + dir.cy }
        taken.add(keyOf(square))
        memo.villages.set(key, { name: pv.name, square })
      }
      place = { cell: spiralCells(1, memo.villages.get(key)!.square, taken)[0], kind: 'village', village: key }
    } else if (b.repo && wild.has(b.repo.id)) {
      place = { cell: wildCell(taken), kind: 'wild' }
    } else {
      place = { cell: spiralCells(1, { cx: 0, cy: 0 }, taken)[0], kind: 'central' }
    }
    taken.add(keyOf(place.cell))
    memo.places.set(idOf(b), place)
  }
  const districts: District[] = buildings.map((b) => {
    const id = idOf(b), p = memo.places.get(id)!
    return { key: b.key, id, b, cell: p.cell, ox: p.cell.cx * CELL_W, oy: p.cell.cy * CELL_D, ring: cheb(p.cell), kind: p.kind, village: p.village,
      tier: buildingTier(b, b.repo ? plan?.activity.get(b.repo.id) ?? 0 : 0) }
  })
  const villages: VillageArea[] = []
  const emptyVillages: WorldLayout['emptyVillages'] = []
  for (const [key, v] of memo.villages) {
    const cells = districts.filter((d) => d.village === key).map((d) => d.cell)
    if (cells.length) villages.push({ key, name: v.name, square: v.square, cells: [v.square, ...cells] })
    else emptyVillages.push({ key, name: v.name })
  }
  return finish(districts, villages, emptyVillages)
}

/** 一个片区全部成员（含村口广场）的屏幕框。 */
export function areaBox(cells: readonly Cell[]): Box {
  const xs = cells.map((c) => c.cx), ys = cells.map((c) => c.cy)
  return boxOfTiles(Math.min(...xs) * CELL_W - 0.5, Math.min(...ys) * CELL_D - 0.5, Math.max(...xs) * CELL_W + INNER_W + 0.5, Math.max(...ys) * CELL_D + INNER_D + 0.5, 150, 30)
}

/** 一个街区（或广场）在屏幕上的框，用来让相机对准它。 */
export function cellBox(ox: number, oy: number): Box {
  return boxOfTiles(ox - 0.5, oy - 0.5, ox + INNER_W + 0.5, oy + INNER_D + 0.5, 150, 30)
}

export function cellCenter(ox: number, oy: number): Pt {
  return iso(ox + INNER_W / 2, oy + INNER_D / 2)
}

// ---- 相机：viewBox = 以 (cx, cy) 为中心、宽 w 的矩形，高度按容器比例 ----

export interface Camera { cx: number; cy: number; w: number }

export const MIN_W = 520
export const MAX_W = 9000
/** 视野宽于此时只画街区名牌和计数（远景）。 */
export const FAR_W = 1900

export function clampCamera(c: Camera, bounds: Box): Camera {
  const w = Math.min(MAX_W, Math.max(MIN_W, c.w))
  const pad = w * 0.35
  const cx = Math.min(bounds.x + bounds.w + pad, Math.max(bounds.x - pad, c.cx))
  const cy = Math.min(bounds.y + bounds.h + pad, Math.max(bounds.y - pad, c.cy))
  return { cx, cy, w }
}

/** 让一个框完整落在视野里。 */
export function fitCamera(box: Box, aspect: number, margin = 1.08): Camera {
  const w = Math.max(box.w, box.h * aspect) * margin
  return { cx: box.x + box.w / 2, cy: box.y + box.h / 2, w: Math.max(MIN_W, w) }
}

export function viewBoxOf(c: Camera, aspect: number): Box {
  const h = c.w / aspect
  return { x: c.cx - c.w / 2, y: c.cy - h / 2, w: c.w, h }
}

/** 以屏幕上某点为中心缩放：该点在缩放前后指向同一个世界位置。fx、fy 是该点在视野里的比例位置（0..1）。 */
export function zoomAt(c: Camera, factor: number, fx: number, fy: number, aspect: number): Camera {
  const v = viewBoxOf(c, aspect)
  const px = v.x + fx * v.w, py = v.y + fy * v.h
  const w = Math.min(MAX_W, Math.max(MIN_W, c.w * factor))
  const h = w / aspect
  return { cx: px - (fx - 0.5) * w, cy: py - (fy - 0.5) * h, w }
}

export function lerpCamera(a: Camera, b: Camera, t: number): Camera {
  const e = t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2
  // 宽度按对数插值，拉远拉近更顺。
  return { cx: a.cx + (b.cx - a.cx) * e, cy: a.cy + (b.cy - a.cy) * e, w: Math.exp(Math.log(a.w) + (Math.log(b.w) - Math.log(a.w)) * e) }
}

/** 桌面模式巡游：先看全景，再依次飞到需要注意的街区（最多 limit 个），然后回到全景。 */
export function tourStops(layout: WorldLayout, attention: (d: District) => boolean, aspect: number, limit = 8): Camera[] {
  const overview = fitCamera(layout.bounds, aspect, 1.02)
  const stops = layout.districts.filter(attention).slice(0, limit).map((d) => fitCamera(cellBox(d.ox, d.oy), aspect, 1.15))
  return [overview, ...stops]
}
