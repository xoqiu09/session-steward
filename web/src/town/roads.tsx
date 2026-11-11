import { useMemo } from 'react'
import { iso } from './iso'
import { worldRoads } from './roadNetwork'
import { CELL_D, CELL_W, type WorldLayout } from './world'
import './roads.css'

export { worldRoads, type RoadSegment } from './roadNetwork'

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
    {paths.map(p => <path key={`grain-${p.kind}`} className={`town-road-grain is-${p.kind}`} d={p.d} />)}
  </g>
}
