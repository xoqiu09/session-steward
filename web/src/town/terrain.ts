// 小镇世界的地形：一张平滑变化的“湿度 / 高度 / 疏密”图决定每块空地是草甸、森林、湖还是山坡，
// 相邻的空地自然连成一片；每块地上的湖、林子、石头再按自己的位置长出不同的样子。
// 全是纯函数：同一个位置每次都长一样，刷新、拖动都不会变。
import type { Box, Cell } from './world'
import { CELL_D, CELL_W } from './world'
import { HH, HW } from './iso'
import type { Terrain } from './scenery'

/** 32 位整数哈希：同样的 (x, y, seed) 永远得到同一个数。 */
export function hash2(x: number, y: number, seed = 0): number {
  let h = (Math.imul(x | 0, 0x27d4eb2d) ^ Math.imul(y | 0, 0x165667b1) ^ Math.imul(seed | 0, 0x9e3779b9)) >>> 0
  h = Math.imul(h ^ (h >>> 15), 0x85ebca6b) >>> 0
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35) >>> 0
  return (h ^ (h >>> 16)) >>> 0
}

/** 可复现的伪随机数序列（mulberry32），返回 [0, 1)。 */
export function rng(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const smooth = (t: number) => t * t * (3 - 2 * t)

/** 二维值噪声：整数格点上取随机值，中间平滑插值，结果在 [0, 1)。 */
export function noise(x: number, y: number, seed: number): number {
  const x0 = Math.floor(x), y0 = Math.floor(y)
  const tx = smooth(x - x0), ty = smooth(y - y0)
  const v = (i: number, j: number) => hash2(x0 + i, y0 + j, seed) / 4294967296
  const a = v(0, 0) + (v(1, 0) - v(0, 0)) * tx
  const b = v(0, 1) + (v(1, 1) - v(0, 1)) * tx
  return a + (b - a) * ty
}

/** 两层叠加：大片的走向 + 一点细节。 */
function fbm(x: number, y: number, seed: number): number {
  return noise(x, y, seed) * 0.82 + noise(x * 2.3 + 17, y * 2.3 - 5, seed + 101) * 0.18
}

/** 每个格子的地形倾向，单位是“格子”，相邻格子的值很接近。 */
export function fieldAt(cx: number, cy: number): { wet: number; high: number; dense: number } {
  return {
    wet: fbm(cx * 0.3 + 0.3, cy * 0.3 - 0.6, 11),
    high: fbm(cx * 0.3 - 4.1, cy * 0.3 + 2.2, 29),
    dense: fbm(cx * 0.8 + 9.7, cy * 0.8 + 3.3, 53),
  }
}

/** 空地的地形：湿的地方是湖、其次是森林；干而高的地方是山坡；其余是草甸。 */
export function terrainAtCell(cx: number, cy: number): Terrain {
  const { wet, high } = fieldAt(cx, cy)
  if (wet > 0.7) return 'lake'
  if (wet > 0.52) return 'forest'
  if (high > 0.57) return 'hill'
  return 'meadow'
}

/** 屏幕坐标 → 格子坐标（z = 0 的地面）。 */
export function gridAt(x: number, y: number): [number, number] {
  const a = x / HW, b = y / HH
  return [(a + b) / 2, (b - a) / 2]
}

/** 盖住整个视野的格子范围：用它铺地面，拖到哪里都是草地。margin 是额外多铺的格子数。 */
export function gridOfView(v: Box, margin = 2): { gx0: number; gy0: number; gx1: number; gy1: number } {
  const corners = [gridAt(v.x, v.y), gridAt(v.x + v.w, v.y), gridAt(v.x, v.y + v.h), gridAt(v.x + v.w, v.y + v.h)]
  const gxs = corners.map((c) => c[0]), gys = corners.map((c) => c[1])
  return { gx0: Math.min(...gxs) - margin, gy0: Math.min(...gys) - margin, gx1: Math.max(...gxs) + margin, gy1: Math.max(...gys) + margin }
}

/** 视野里能看到的街区格子（含一圈边缘：高的树会从视野外伸进来）。 */
export function cellsInView(v: Box): Cell[] {
  const g = gridOfView(v, 0)
  // 视野是屏幕上的矩形，在格子坐标里是菱形；只留真正和矩形相交的格子。
  const out: Cell[] = []
  for (let cx = Math.floor(g.gx0 / CELL_W) - 1; cx <= Math.floor(g.gx1 / CELL_W) + 1; cx++) {
    for (let cy = Math.floor(g.gy0 / CELL_D) - 1; cy <= Math.floor(g.gy1 / CELL_D) + 1; cy++) {
      const xs = [cx * CELL_W, (cx + 1) * CELL_W], ys = [cy * CELL_D, (cy + 1) * CELL_D]
      const pts = xs.flatMap((gx) => ys.map((gy) => [(gx - gy) * HW, (gx + gy) * HH]))
      const minX = Math.min(...pts.map((p) => p[0])), maxX = Math.max(...pts.map((p) => p[0]))
      const minY = Math.min(...pts.map((p) => p[1])) - 160, maxY = Math.max(...pts.map((p) => p[1]))
      if (maxX >= v.x && minX <= v.x + v.w && maxY >= v.y && minY <= v.y + v.h) out.push({ cx, cy })
    }
  }
  return out
}

export type PropKind = 'pine' | 'tree' | 'bush' | 'rock' | 'flowers' | 'reeds'

export interface Prop { kind: PropKind; gx: number; gy: number; k: number; seed: number }

/** 湖：按格子坐标给出的一圈不规则轮廓，可能带一个小岛。 */
export interface PondShape { ring: [number, number][]; cx: number; cy: number; island: { gx: number; gy: number; r: number } | null }

/** 山坡上隆起的小土丘。 */
export interface Mound { ring: [number, number][]; lift: number }

export interface CellScenery { terrain: Terrain; pond: PondShape | null; mounds: Mound[]; props: Prop[] }

/** 一圈不规则轮廓：半径按位置起伏，顶点数也各不相同。 */
function blobRing(cx: number, cy: number, rx: number, ry: number, r: () => number, n = 10 + Math.floor(r() * 7), rough = 0.22): [number, number][] {
  const phase = r() * Math.PI * 2
  const bumps = Array.from({ length: n }, () => 1 - rough + r() * rough * 2)
  return bumps.map((k, i) => {
    // 相邻顶点取平均，轮廓圆润一些，不会尖。
    const kk = (k + bumps[(i + 1) % n] + bumps[(i + n - 1) % n]) / 3
    const a = phase + (i / n) * Math.PI * 2
    return [cx + Math.cos(a) * rx * kk, cy + Math.sin(a) * ry * kk] as [number, number]
  })
}

function insideEllipse(gx: number, gy: number, cx: number, cy: number, rx: number, ry: number, pad = 1): boolean {
  const dx = (gx - cx) / (rx * pad), dy = (gy - cy) / (ry * pad)
  return dx * dx + dy * dy < 1
}

/** 在格子里撒点：彼此至少隔 minGap，不落在 avoid 里，也不出这个格子。 */
function scatter(ox: number, oy: number, count: number, minGap: number, r: () => number, avoid: (gx: number, gy: number) => boolean): [number, number][] {
  const pts: [number, number][] = []
  for (let tries = 0; pts.length < count && tries < count * 12; tries++) {
    const gx = ox + 0.6 + r() * (CELL_W - 1.2), gy = oy + 0.6 + r() * (CELL_D - 1.2)
    if (avoid(gx, gy)) continue
    if (pts.some(([x, y]) => Math.hypot(x - gx, y - gy) < minGap)) continue
    pts.push([gx, gy])
  }
  return pts
}

const cache = new Map<string, CellScenery>()

/**
 * 一块空地上长什么。near = 紧挨着项目：只放矮的花草石头，项目周围保持干净。
 * lakeNeighbors：四邻里也是湖的方向，湖会朝那边伸过去，和邻格的湖连成一片。
 */
export function sceneryOf(cell: Cell, near: boolean, lakeNeighbors: { e: boolean; s: boolean; w: boolean; n: boolean } = lakeSides(cell)): CellScenery {
  const key = `${cell.cx},${cell.cy},${near ? 1 : 0},${+lakeNeighbors.e}${+lakeNeighbors.s}${+lakeNeighbors.w}${+lakeNeighbors.n}`
  const hit = cache.get(key)
  if (hit) return hit
  const out = build(cell, near, lakeNeighbors)
  if (cache.size > 5000) cache.clear()
  cache.set(key, out)
  return out
}

/** 四邻里哪些方向也是湖（不考虑那里有没有项目，调用方可以覆盖）。 */
export function lakeSides(cell: Cell) {
  const lake = (dx: number, dy: number) => terrainAtCell(cell.cx + dx, cell.cy + dy) === 'lake'
  return { e: lake(1, 0), s: lake(0, 1), w: lake(-1, 0), n: lake(0, -1) }
}

function build(cell: Cell, near: boolean, sides: { e: boolean; s: boolean; w: boolean; n: boolean }): CellScenery {
  const terrain = terrainAtCell(cell.cx, cell.cy)
  const { high, dense } = fieldAt(cell.cx, cell.cy)
  const r = rng(hash2(cell.cx, cell.cy, 7))
  const ox = cell.cx * CELL_W, oy = cell.cy * CELL_D
  const props: Prop[] = []
  const add = (kind: PropKind, gx: number, gy: number, k: number) => props.push({ kind, gx, gy, k, seed: Math.floor(r() * 1e9) })

  // 紧挨项目：一两丛花、一块石头或一丛灌木，别的都不放。
  if (near) {
    const n = Math.floor(r() * 3) + (terrain === 'meadow' ? 1 : 0)
    const kinds: PropKind[] = terrain === 'hill' ? ['rock', 'flowers', 'rock'] : terrain === 'forest' ? ['bush', 'flowers', 'bush'] : ['flowers', 'bush', 'rock']
    scatter(ox, oy, Math.min(3, n), 2.4, r, () => false).forEach(([gx, gy], i) => add(kinds[i % kinds.length], gx, gy, 0.7 + r() * 0.3))
    return { terrain, pond: null, mounds: [], props }
  }

  let pond: PondShape | null = null
  const mounds: Mound[] = []
  if (terrain === 'lake') {
    // 湖心和大小各不相同；朝同是湖的邻格伸到格子边上，两边的湖叠在一起就连成一片。
    let x0 = ox + 1.2 + r() * 1.6, x1 = ox + CELL_W - 1.2 - r() * 1.6
    let y0 = oy + 1.0 + r() * 1.6, y1 = oy + CELL_D - 1.0 - r() * 1.6
    if (sides.e) x1 = ox + CELL_W + 0.8
    if (sides.w) x0 = ox - 0.8
    if (sides.s) y1 = oy + CELL_D + 0.8
    if (sides.n) y0 = oy - 0.8
    // 独立的湖大小随机；和邻格相连的湖不缩，保证两边叠得上。
    const joined = sides.e || sides.s || sides.w || sides.n
    const shrink = joined ? 1 : 0.72 + r() * 0.28
    const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2, rx = ((x1 - x0) / 2) * shrink, ry = ((y1 - y0) / 2) * shrink
    const island = r() < 0.35 ? { gx: cx + (r() - 0.5) * rx * 0.6, gy: cy + (r() - 0.5) * ry * 0.6, r: 0.5 + r() * 0.5 } : null
    pond = { ring: blobRing(cx, cy, rx, ry, r, undefined, 0.2), cx, cy, island }
    const wet = (gx: number, gy: number) => insideEllipse(gx, gy, cx, cy, rx, ry, 1.12)
    // 岸边：芦苇贴着水，树离开一点。
    for (let i = 0, n = 2 + Math.floor(r() * 4); i < n; i++) {
      const a = r() * Math.PI * 2
      add('reeds', cx + Math.cos(a) * rx * 1.02, cy + Math.sin(a) * ry * 1.02, 0.8 + r() * 0.4)
    }
    scatter(ox, oy, 1 + Math.floor(dense * 5), 1.6, r, wet).forEach(([gx, gy]) => add(r() < 0.5 ? 'tree' : 'bush', gx, gy, 0.75 + r() * 0.35))
  } else if (terrain === 'forest') {
    // 林子的疏密跟着“疏密”图走；越高的地方松树越多。
    const n = 4 + Math.floor(dense * 11)
    const pineShare = Math.min(0.95, Math.max(0.1, high * 1.4 - 0.2))
    const clearing = r() < 0.4 ? { gx: ox + 2 + r() * (CELL_W - 4), gy: oy + 2 + r() * (CELL_D - 4), rad: 1.2 + r() * 1.3 } : null
    const avoid = (gx: number, gy: number) => !!clearing && Math.hypot(gx - clearing.gx, gy - clearing.gy) < clearing.rad
    scatter(ox, oy, n, 1.05, r, avoid).forEach(([gx, gy]) => add(r() < pineShare ? 'pine' : 'tree', gx, gy, 0.7 + r() * 0.55))
    if (clearing) add('flowers', clearing.gx, clearing.gy, 1)
    scatter(ox, oy, Math.floor(r() * 3), 1.2, r, avoid).forEach(([gx, gy]) => add('bush', gx, gy, 0.6 + r() * 0.3))
  } else if (terrain === 'hill') {
    // 一两个土丘，石头散在坡上，零星几棵松树。
    for (let i = 0, n = 1 + Math.floor(r() * 2); i < n; i++) {
      const cx = ox + 2.5 + r() * (CELL_W - 5), cy = oy + 2.2 + r() * (CELL_D - 4.4)
      mounds.push({ ring: blobRing(cx, cy, 1.6 + r() * 1.6, 1.3 + r() * 1.3, r, 9 + Math.floor(r() * 5), 0.18), lift: 10 + Math.floor(r() * 14) })
    }
    scatter(ox, oy, 2 + Math.floor(r() * 5), 1.3, r, () => false).forEach(([gx, gy]) => add('rock', gx, gy, 0.6 + r() * 1.0))
    scatter(ox, oy, Math.floor(dense * 4), 1.5, r, () => false).forEach(([gx, gy]) => add('pine', gx, gy, 0.6 + r() * 0.35))
  } else {
    // 草甸：多数是花和矮灌木，偶尔一棵孤树或一块石头。
    scatter(ox, oy, 1 + Math.floor(dense * 4), 2.0, r, () => false).forEach(([gx, gy]) => add('flowers', gx, gy, 0.8 + r() * 0.4))
    if (r() < 0.55) scatter(ox, oy, 1 + Math.floor(r() * 2), 2.4, r, () => false).forEach(([gx, gy]) => add('bush', gx, gy, 0.6 + r() * 0.4))
    if (r() < 0.45) scatter(ox, oy, 1, 2, r, () => false).forEach(([gx, gy]) => add('tree', gx, gy, 0.8 + r() * 0.4))
    if (r() < 0.35) scatter(ox, oy, 1, 2, r, () => false).forEach(([gx, gy]) => add('rock', gx, gy, 0.6 + r() * 0.6))
  }
  // 由远到近画，前面的东西盖住后面的。
  props.sort((a, b) => a.gx + a.gy - (b.gx + b.gy))
  return { terrain, pond, mounds, props }
}

/** 地形底色：一块比格子稍大的不规则色斑，相邻同类格子的色斑叠成一整片。 */
export function tintBlob(cell: Cell): [number, number][] {
  const r = rng(hash2(cell.cx, cell.cy, 91))
  const cx = (cell.cx + 0.5) * CELL_W, cy = (cell.cy + 0.5) * CELL_D
  return blobRing(cx, cy, CELL_W * 0.68, CELL_D * 0.68, r, 12, 0.16)
}
