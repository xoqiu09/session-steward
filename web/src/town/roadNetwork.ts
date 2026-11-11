import { CELL_D, CELL_W, DISTRICT_FOOTPRINT, type Cell, type WorldLayout } from './world'
import { GARDEN_SPOTS, pointDistance, type GardenPoint } from './residents'

export interface RoadDestination { cell: Cell; door: GardenPoint; id?: string; key?: string; name?: string }
const originOf = (cell: Cell) => ({ x: cell.cx * CELL_W, y: cell.cy * CELL_D })
export const homeGate = (cell: Cell) => ({ x: originOf(cell).x + GARDEN_SPOTS.square.x, y: originOf(cell).y + GARDEN_SPOTS.square.y })
export const homeGardenPoint = (point:GardenPoint,home:Cell):GardenPoint|undefined => {
  const local={x:point.x-home.cx*CELL_W,y:point.y-home.cy*CELL_D}
  return local.x>=0&&local.x<=9&&local.y>=3&&local.y<=8.81?local:undefined
}
const cellOrigin = originOf
const gate = (origin: GardenPoint) => ({ x: origin.x + GARDEN_SPOTS.square.x, y: origin.y + GARDEN_SPOTS.square.y })
const junction = (cell: Cell) => ({ x: cell.cx * CELL_W + 9.7, y: cell.cy * CELL_D + 8.9 })
const unique = (points: GardenPoint[]) => points.filter((p, i) => !i || pointDistance(p, points[i - 1]) > .001)

/** 只沿格子边缘的道路走，先到房前小路，再到门口，不穿过项目建筑。 */
export function projectRoute(home: Cell, destination: RoadDestination): GardenPoint[] {
  const origin = cellOrigin(home), path: GardenPoint[] = [gate(origin), { x: gate(origin).x, y: junction(home).y }, junction(home)]
  const cell = { ...home }
  while (cell.cx !== destination.cell.cx) { cell.cx += Math.sign(destination.cell.cx - cell.cx); path.push(junction(cell)) }
  while (cell.cy !== destination.cell.cy) { cell.cy += Math.sign(destination.cell.cy - cell.cy); path.push(junction(cell)) }
  path.push({ x: destination.door.x, y: junction(destination.cell).y }, destination.door)
  return unique(path)
}

export interface RoadSegment { from: GardenPoint; to: GardenPoint; kind: 'street' | 'path' }
const EPSILON = .001
const onGrid = (value: number, offset: number, size: number) => Math.abs((value - offset) / size - Math.round((value - offset) / size)) < EPSILON

/** Paint the existing resident routes, including the empty cells between towns.
 * Routing, district placement and saved world data remain owned by their stores. */
export function worldRoads(world: WorldLayout): RoadSegment[] {
  const residents = { home: world.residential ?? { cx: 0, cy: 0 }, destinations: world.districts.map(d => ({ key: d.key, id: d.id, name: '', cell: d.cell, door: { x: d.ox + .8 + DISTRICT_FOOTPRINT[d.tier].w / 2, y: d.oy + .9 + DISTRICT_FOOTPRINT[d.tier].d } })) }
  const projects = new Set(residents.destinations.map(d => d.key))
  const squares = [{ cell: { cx: 0, cy: 0 }, name: 'plaza' }, ...world.villages.map(v => ({ cell: v.square, name: v.key }))]
  const destinations = [...residents.destinations, ...squares.map(({ cell, name }) => ({
    id: `road-${name}`, key: `road-${name}`, name, cell,
    door: { x: cell.cx * CELL_W + 4.5, y: cell.cy * CELL_D + 4.1 },
  }))]
  const lines = new Map<string, { vertical: boolean; fixed: number; kind: RoadSegment['kind']; spans: [number, number][] }>()
  const routes = destinations.map(destination => {
    const route = projectRoute(residents.home, destination)
    // Extend the visible entrance under the front step. The resident's actual
    // arrival point stays .4 cells in front of the footprint, on this same path.
    if (projects.has(destination.key)) route.push({ x: destination.door.x, y: destination.door.y - .4 })
    return route
  })
  // 每块有人居住的街区有一圈步行路，路口可转弯，不再只有一去一回的支路。
  const cells = new Map([...world.districts.map(d => d.cell), ...squares.map(s => s.cell), ...(world.residential ? [world.residential] : [])].map(c => [`${c.cx},${c.cy}`, c]))
  for (const c of cells.values()) {
    const x = c.cx * CELL_W - 1.3, y = c.cy * CELL_D - 1.1
    routes.push([{x,y},{x:x+CELL_W,y},{x:x+CELL_W,y:y+CELL_D},{x,y:y+CELL_D},{x,y}])
  }
  for (const route of routes) {
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

export interface RoadGraph {
  nodes: GardenPoint[]
  neighbors: Map<number, number[]>
  edges: [number, number][]
}
const contains = (s: RoadSegment, p: GardenPoint) =>
  p.x >= Math.min(s.from.x,s.to.x)-EPSILON && p.x <= Math.max(s.from.x,s.to.x)+EPSILON &&
  p.y >= Math.min(s.from.y,s.to.y)-EPSILON && p.y <= Math.max(s.from.y,s.to.y)+EPSILON

/** 在每个真实交叉口拆边；画出来的 T 路口和十字路口都可以转弯。 */
export function buildRoadGraph(segments: RoadSegment[]): RoadGraph {
  const points = segments.map(s => [s.from,s.to])
  for (let i=0;i<segments.length;i++) for (let j=i+1;j<segments.length;j++) {
    const a=segments[i], b=segments[j], av=Math.abs(a.from.x-a.to.x)<EPSILON, bv=Math.abs(b.from.x-b.to.x)<EPSILON
    if (av===bv) continue
    const p={x:av?a.from.x:b.from.x,y:av?b.from.y:a.from.y}
    if (contains(a,p)&&contains(b,p)) { points[i].push(p); points[j].push(p) }
  }
  const nodes: GardenPoint[]=[], ids=new Map<string,number>(), neighbors=new Map<number,number[]>(), edges:[number,number][]=[]
  const index=(p:GardenPoint) => {
    const key=`${p.x.toFixed(4)},${p.y.toFixed(4)}`
    if (!ids.has(key)) { ids.set(key,nodes.length); nodes.push({...p}); neighbors.set(nodes.length-1,[]) }
    return ids.get(key)!
  }
  const seen=new Set<string>()
  points.forEach((list,i)=> {
    const vertical=Math.abs(segments[i].from.x-segments[i].to.x)<EPSILON
    const sorted=list.sort((a,b)=>vertical?a.y-b.y:a.x-b.x)
    for (let j=1;j<sorted.length;j++) {
      const a=index(sorted[j-1]), b=index(sorted[j]), key=[a,b].sort((x,y)=>x-y).join(':')
      if (a===b||seen.has(key)) continue
      seen.add(key); edges.push([a,b]); neighbors.get(a)!.push(b); neighbors.get(b)!.push(a)
    }
  })
  return {nodes,neighbors,edges}
}

function roadAttachment(graph:RoadGraph, point:GardenPoint) {
  let best:{at:GardenPoint;ends:[number,number];distance:number}|undefined
  for (const [i,j] of graph.edges) {
    const a=graph.nodes[i], b=graph.nodes[j], dx=b.x-a.x, dy=b.y-a.y
    const t=Math.max(0,Math.min(1,((point.x-a.x)*dx+(point.y-a.y)*dy)/(dx*dx+dy*dy)))
    const at={x:a.x+dx*t,y:a.y+dy*t}, distance=pointDistance(point,at)
    if (!best||distance<best.distance) best={at,ends:[i,j],distance}
  }
  return best
}

/** 从道路中途出发也先接回该路段，不能斜穿一栋房子去最近路口。 */
export function roadRoute(graph:RoadGraph, from:GardenPoint, to:GardenPoint):GardenPoint[] {
  const start=roadAttachment(graph,from), end=roadAttachment(graph,to)
  if (!start||!end) return []
  if (start.ends.every(n=>end.ends.includes(n))) return unique([from,start.at,end.at,to])
  const costs=new Map<number,number>(), previous=new Map<number,number>(), pending=new Set<number>()
  for (const n of start.ends) { costs.set(n,pointDistance(start.at,graph.nodes[n])); pending.add(n) }
  const visited=new Set<number>()
  while (pending.size) {
    let at=-1, cost=Infinity
    for (const n of pending) if (costs.get(n)!<cost) { at=n; cost=costs.get(n)! }
    pending.delete(at); visited.add(at)
    for (const next of graph.neighbors.get(at)??[]) {
      const value=cost+pointDistance(graph.nodes[at],graph.nodes[next])
      if (!visited.has(next)&&value<(costs.get(next)??Infinity)) { costs.set(next,value); previous.set(next,at); pending.add(next) }
    }
  }
  const target=end.ends.filter(n=>costs.has(n)).sort((a,b)=>costs.get(a)!+pointDistance(graph.nodes[a],end.at)-costs.get(b)!-pointDistance(graph.nodes[b],end.at))[0]
  if (target===undefined) return []
  const path=[target]
  while (previous.has(path[0])) path.unshift(previous.get(path[0])!)
  return unique([from,start.at,...path.map(n=>graph.nodes[n]),end.at,to])
}
