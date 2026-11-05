import { CELL_D, CELL_W, DISTRICT_FOOTPRINT, type Cell, type WorldLayout } from './world'
import { GARDEN_SPOTS, gardenRoute, homePoint, pointDistance, RESIDENT_IDS, type GardenPoint, type GardenSpot, type ResidentId } from './residents'

export interface ResidentDestination { id: string; key: string; name: string; cell: Cell; door: GardenPoint }
export interface ResidentWorld { home: Cell; destinations: ResidentDestination[] }
export interface ResidentTrip extends GardenPoint {
  projectId: string; projectName: string; phase: 'outbound' | 'inside' | 'returning'
  origin: GardenPoint; path: GardenPoint[]; trail: GardenPoint[]
  insideMs: number; insideLeft: number; restOnReturn: boolean; returnTarget?: GardenSpot
}
export const cellOrigin = (cell: Cell): GardenPoint => ({ x: cell.cx * CELL_W, y: cell.cy * CELL_D })
export const pointCell = (point: GardenPoint): Cell => ({ cx: Math.floor(point.x / CELL_W), cy: Math.floor(point.y / CELL_D) })
export const cellKey = (cell: Cell) => `${cell.cx},${cell.cy}`
export const addPoint = (a: GardenPoint, b: GardenPoint): GardenPoint => ({ x: a.x + b.x, y: a.y + b.y })
export const localTripPoint = (trip: ResidentTrip): GardenPoint => ({ x: trip.x - trip.origin.x, y: trip.y - trip.origin.y })
const gate = (origin: GardenPoint) => addPoint(origin, GARDEN_SPOTS.square)
const junction = (cell: Cell): GardenPoint => addPoint(cellOrigin(cell), { x: 9.7, y: 8.9 })
const unique = (points: GardenPoint[]) => points.filter((p, i) => !i || pointDistance(p, points[i - 1]) > 0.01)

export function residentWorld(world: WorldLayout): ResidentWorld | undefined {
  if (!world.residential) return undefined
  return { home: world.residential, destinations: world.districts.map((d) => ({
    id: d.id, key: d.key, name: d.b.name, cell: d.cell,
    door: { x: d.ox + 0.8 + DISTRICT_FOOTPRINT[d.tier].w / 2, y: d.oy + 0.5 + DISTRICT_FOOTPRINT[d.tier].d + 0.4 },
  })) }
}

/** 只沿格子边缘的道路走，先到房前小路，再到门口，不穿过项目建筑。 */
export function projectRoute(home: Cell, destination: ResidentDestination): GardenPoint[] {
  const origin = cellOrigin(home), path: GardenPoint[] = [gate(origin), { x: gate(origin).x, y: junction(home).y }, junction(home)]
  const cell = { ...home }
  while (cell.cx !== destination.cell.cx) { cell.cx += Math.sign(destination.cell.cx - cell.cx); path.push(junction(cell)) }
  while (cell.cy !== destination.cell.cy) { cell.cy += Math.sign(destination.cell.cy - cell.cy); path.push(junction(cell)) }
  path.push({ x: destination.door.x, y: junction(destination.cell).y }, destination.door)
  return unique(path)
}

export function startResidentTrip(id: ResidentId, from: GardenPoint, world: ResidentWorld, destination: ResidentDestination): ResidentTrip {
  const origin = cellOrigin(world.home), position = addPoint(origin, from)
  const path = unique([...gardenRoute(from, 'square').map((p) => addPoint(origin, p)), ...projectRoute(world.home, destination)])
  return { ...position, projectId: destination.id, projectName: destination.name, phase: 'outbound', origin, path,
    trail: [position], insideMs: 0, insideLeft: 26_000 + RESIDENT_IDS.indexOf(id) * 2000, restOnReturn: false }
}

export function returnResidentTrip(trip: ResidentTrip, id: ResidentId, rest: boolean): ResidentTrip {
  if (trip.phase === 'returning') return { ...trip, restOnReturn: rest, ...(rest ? { returnTarget: undefined } : {}) }
  const gatePoint = gate(trip.origin), index = trip.trail.findIndex((p) => pointDistance(p, gatePoint) < 0.02)
  const last = index >= 0 ? GARDEN_SPOTS.square : localTripPoint(trip)
  const reverse = index >= 0 ? [...trip.trail.slice(index)].reverse() : []
  const path = unique([...reverse, ...gardenRoute(last, 'home', homePoint(id)).map((p) => addPoint(trip.origin, p))])
  return { ...trip, phase: 'returning', path, restOnReturn: rest }
}

export function tickResidentTrip(before: ResidentTrip, id: ResidentId, dt: number): { trip?: ResidentTrip; entered: boolean } {
  let trip: ResidentTrip = { ...before, path: [...before.path], trail: [...before.trail] }
  if (trip.phase === 'inside') {
    trip.insideMs += dt * 1000; trip.insideLeft -= dt * 1000
    if (trip.insideLeft <= 0) trip = returnResidentTrip(trip, id, false)
    return { trip, entered: false }
  }
  let left = dt * 2.1
  while (left > 0 && trip.path.length) {
    const point = trip.path[0], distance = pointDistance(trip, point)
    if (distance <= left) {
      trip.x = point.x; trip.y = point.y; trip.path.shift(); left -= distance
      if (trip.phase === 'outbound') trip.trail.push({ x: point.x, y: point.y })
    } else { trip.x += (point.x - trip.x) * left / distance; trip.y += (point.y - trip.y) * left / distance; left = 0 }
  }
  if (!trip.path.length) {
    if (trip.phase === 'returning') return { entered: false }
    trip.phase = 'inside'; return { trip, entered: true }
  }
  return { trip, entered: false }
}

/** 兼容已有生活记录；拒绝损坏或过大的路线，不把它带入整个地图。 */
export function readResidentTrip(raw: unknown): ResidentTrip | undefined {
  if (!raw || typeof raw !== 'object') return undefined
  const r = raw as ResidentTrip
  const point = (p: unknown): p is GardenPoint => !!p && typeof p === 'object' && Number.isFinite((p as GardenPoint).x) && Number.isFinite((p as GardenPoint).y) && Math.abs((p as GardenPoint).x) < 100_000 && Math.abs((p as GardenPoint).y) < 100_000
  const points = (p: unknown): p is GardenPoint[] => Array.isArray(p) && p.length <= 1200 && p.every(point)
  if (!point(r) || !point(r.origin) || !points(r.path) || !points(r.trail) || !['outbound', 'inside', 'returning'].includes(r.phase)
    || typeof r.projectId !== 'string' || r.projectId.length > 300 || typeof r.projectName !== 'string' || r.projectName.length > 300
    || !Number.isFinite(r.insideMs) || !Number.isFinite(r.insideLeft)) return undefined
  return { x: r.x, y: r.y, origin: { ...r.origin }, path: r.path.map((p) => ({ ...p })), trail: r.trail.map((p) => ({ ...p })),
    projectId: r.projectId, projectName: r.projectName, phase: r.phase, insideMs: Math.max(0, Math.min(600_000, r.insideMs)),
    insideLeft: Math.max(0, Math.min(600_000, r.insideLeft)), restOnReturn: r.restOnReturn === true,
    ...(r.returnTarget === 'tea' ? { returnTarget: 'tea' as const } : {}) }
}

/** 来访只在工作台前留出的过道活动，工作台、会话与功能数据保持原样。 */
export function interiorVisitorPoint(trip: ResidentTrip, id: ResidentId): GardenPoint {
  const points = [{ x: 1.2, y: 10.8 }, { x: 6.5, y: 10.8 }, { x: 12.8, y: 10.8 }, { x: 14.9, y: 9.9 }, { x: 6.5, y: 10.8 }]
  const time = trip.insideMs / 6500 + RESIDENT_IDS.indexOf(id) * 0.35, step = Math.floor(time) % points.length
  const a = points[step], b = points[(step + 1) % points.length], t = Math.min(1, (time % 1) * 1.5)
  return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t }
}
