import { useMemo } from 'react'
import { iso } from './iso'
import { projectRoute, residentWorld } from './residentTrips'
import type { GardenPoint } from './residents'
import { CELL_D, CELL_W, type WorldLayout } from './world'
import './roads.css'

export interface RoadSegment { from: GardenPoint; to: GardenPoint; kind: 'street' | 'path' }
const EPSILON = .001
const onGrid = (value: number, offset: number, size: number) => Math.abs((value - offset) / size - Math.round((value - offset) / size)) < EPSILON

/** Paint the existing resident routes, including the empty cells between towns.
 * Routing, district placement and saved world data remain owned by their stores. */
export function worldRoads(world: WorldLayout): RoadSegment[] {
  const residents = residentWorld({ ...world, residential: world.residential ?? { cx: 0, cy: 0 } })!
  const projects = new Set(residents.destinations.map(d => d.key))
  const squares = [{ cell: { cx: 0, cy: 0 }, name: 'plaza' }, ...world.villages.map(v => ({ cell: v.square, name: v.key }))]
  const destinations = [...residents.destinations, ...squares.map(({ cell, name }) => ({
    id: `road-${name}`, key: `road-${name}`, name, cell,
    door: { x: cell.cx * CELL_W + 4.5, y: cell.cy * CELL_D + 4.1 },
  }))]
  const lines = new Map<string, { vertical: boolean; fixed: number; kind: RoadSegment['kind']; spans: [number, number][] }>()
  for (const destination of destinations) {
    const route = projectRoute(residents.home, destination)
    // Extend the visible entrance under the front step. The resident's actual
    // arrival point stays .4 cells in front of the footprint, on this same path.
    if (projects.has(destination.key)) route.push({ x: destination.door.x, y: destination.door.y - .4 })
    for (let i = 1; i < route.length; i++) {
      const from = route[i - 1], to = route[i]
      const vertical = Math.abs(from.x - to.x) < EPSILON
      const fixed = vertical ? from.x : from.y
      const start = vertical ? from.y : from.x, end = vertical ? to.y : to.x
      if (Math.abs(start - end) < EPSILON) continue
      const kind = (vertical ? onGrid(fixed, 9.7, CELL_W) : onGrid(fixed, 8.9, CELL_D)) ? 'street' : 'path'
      const key = `${kind}:${vertical ? 'x' : 'y'}:${fixed.toFixed(4)}`
      let line = lines.get(key)
      if (!line) { line = { vertical, fixed, kind, spans: [] }; lines.set(key, line) }
      line.spans.push([Math.min(start, end), Math.max(start, end)])
    }
  }
  const segments: RoadSegment[] = []
  for (const [, line] of [...lines].sort(([a], [b]) => a.localeCompare(b))) {
    const merged: [number, number][] = []
    for (const span of line.spans.sort((a, b) => a[0] - b[0])) {
      const last = merged.at(-1)
      if (last && span[0] <= last[1] + EPSILON) last[1] = Math.max(last[1], span[1])
      else merged.push([...span])
    }
    for (const [start, end] of merged) segments.push({
      kind: line.kind,
      from: line.vertical ? { x: line.fixed, y: start } : { x: start, y: line.fixed },
      to: line.vertical ? { x: line.fixed, y: end } : { x: end, y: line.fixed },
    })
  }
  return segments
}

/** 道路经过的格子（含相邻湖面会伸过来的 .8 格）。这些格子不放湖，路就不会铺在水上。 */
export function roadCells(world: WorldLayout): Set<string> {
  const cells = new Set<string>(), pad = .8
  for (const { from, to } of worldRoads(world)) {
    const x0 = Math.floor((Math.min(from.x, to.x) - pad) / CELL_W), x1 = Math.floor((Math.max(from.x, to.x) + pad) / CELL_W)
    const y0 = Math.floor((Math.min(from.y, to.y) - pad) / CELL_D), y1 = Math.floor((Math.max(from.y, to.y) + pad) / CELL_D)
    for (let cx = x0; cx <= x1; cx++) for (let cy = y0; cy <= y1; cy++) cells.add(`${cx},${cy}`)
  }
  return cells
}

export function WorldRoads({ world }: { world: WorldLayout }) {
  const paths = useMemo(() => {
    const segments = worldRoads(world)
    return (['street', 'path'] as const).map(kind => ({ kind, d: segments.filter(s => s.kind === kind).map(s => `M${iso(s.from.x,s.from.y).join(',')}L${iso(s.to.x,s.to.y).join(',')}`).join(' ') }))
  }, [world])
  // All borders are painted before all surfaces, so a joining branch cannot
  // leave a dark seam or grass gap across the shared street.
  return <g className="town-world-roads" aria-hidden="true" pointerEvents="none">
    {paths.map(p => <path key={`edge-${p.kind}`} className={`town-road-edge is-${p.kind}`} d={p.d} />)}
    {paths.map(p => <path key={p.kind} className={`town-road-surface is-${p.kind}`} data-town-road={p.kind} d={p.d} />)}
  </g>
}
