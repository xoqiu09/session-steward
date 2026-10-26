// 小镇世界：每个项目一个街区，围绕中央广场一圈圈排开；相机可拖动、缩放、巡游。纯函数，便于测试。
import { iso, type Pt } from './iso'
import type { BuildingView } from './townModel'

/** 一个街区占的格子（含右侧和前方的道路）。 */
export const CELL_W = 11
export const CELL_D = 10
/** 街区内可用范围，其余是道路。 */
export const INNER_W = 9
export const INNER_D = 8.2

export interface Cell { cx: number; cy: number }

export interface District {
  key: string
  b: BuildingView
  cell: Cell
  /** 街区左上角的格子坐标。 */
  ox: number
  oy: number
  /** 第几圈：1 紧挨广场。 */
  ring: number
}

export interface WorldLayout {
  districts: District[]
  plaza: { ox: number; oy: number }
  /** 世界的格子范围（含边缘空地）。 */
  tiles: { gx0: number; gy0: number; gx1: number; gy1: number }
  /** 屏幕坐标下的世界范围。 */
  bounds: Box
}

export interface Box { x: number; y: number; w: number; h: number }

/** 围绕 (0,0) 的格子，按圈由内向外；同一圈从画面上方顺时针排，第一圈先排正前方，离广场最近的位置留给最要紧的项目。 */
export function spiralCells(n: number): Cell[] {
  const out: Cell[] = []
  for (let r = 1; out.length < n; r++) {
    const ring: Cell[] = []
    for (let cx = -r; cx <= r; cx++) for (let cy = -r; cy <= r; cy++) if (Math.max(Math.abs(cx), Math.abs(cy)) === r) ring.push({ cx, cy })
    // 等距视角里 cx+cy 越小越靠上（越远）；先放离镜头近、离广场近的格子。
    ring.sort((a, b) => Math.abs(a.cx) + Math.abs(a.cy) - (Math.abs(b.cx) + Math.abs(b.cy)) || (b.cx + b.cy) - (a.cx + a.cy) || a.cx - b.cx)
    out.push(...ring)
  }
  return out.slice(0, n)
}

/** 排序：等你处理的 > 有人在干活的 > 有待验收的 > 其余，组内保持原顺序。 */
export function districtOrder(buildings: readonly BuildingView[], needsYou: (b: BuildingView) => boolean): BuildingView[] {
  const score = (b: BuildingView) =>
    needsYou(b) ? 0 : b.characters.some((c) => c.status === 'working') ? 1 : b.items.some((w) => w.status === 'review') ? 2 : b.characters.length ? 3 : 4
  return buildings.map((b, i) => ({ b, i, s: score(b) })).sort((x, y) => x.s - y.s || x.i - y.i).map((x) => x.b)
}

function boxOfTiles(gx0: number, gy0: number, gx1: number, gy1: number, top = 140, bottom = 40): Box {
  const corners = [iso(gx0, gy0), iso(gx1, gy0), iso(gx1, gy1), iso(gx0, gy1)]
  const xs = corners.map((c) => c[0]), ys = corners.map((c) => c[1])
  const x = Math.min(...xs), y = Math.min(...ys) - top
  return { x, y, w: Math.max(...xs) - x, h: Math.max(...ys) + bottom - y }
}

export function worldLayout(buildings: readonly BuildingView[], needsYou: (b: BuildingView) => boolean): WorldLayout {
  const ordered = districtOrder(buildings, needsYou)
  const cells = spiralCells(ordered.length)
  const districts = ordered.map((b, i) => {
    const cell = cells[i]
    return { key: b.key, b, cell, ox: cell.cx * CELL_W, oy: cell.cy * CELL_D, ring: Math.max(Math.abs(cell.cx), Math.abs(cell.cy)) }
  })
  const all = [{ cx: 0, cy: 0 }, ...cells]
  // 外面再留一圈空地（树林），世界不是刚好卡在最后一栋房子边上。
  const gx0 = (Math.min(...all.map((c) => c.cx)) - 0.5) * CELL_W, gy0 = (Math.min(...all.map((c) => c.cy)) - 0.5) * CELL_D
  const gx1 = (Math.max(...all.map((c) => c.cx)) + 1.5) * CELL_W, gy1 = (Math.max(...all.map((c) => c.cy)) + 1.5) * CELL_D
  return { districts, plaza: { ox: 0, oy: 0 }, tiles: { gx0, gy0, gx1, gy1 }, bounds: boxOfTiles(gx0, gy0, gx1, gy1) }
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
