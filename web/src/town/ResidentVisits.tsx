import { useLayoutEffect, useMemo, useState, type RefObject } from 'react'
import { createPortal } from 'react-dom'
import { iso } from './iso'
import { type ResidentStore } from './residentLife'
import { ResidentFigure } from './ResidentVillage'
import { useResidentLife } from './residentPresence'
import { cellKey, interiorVisitorPoint, pointCell, residentWorld } from './residentTrips'
import { RESIDENT_IDS, residentImage, residentSpec, type ResidentId } from './residents'
import type { WorldLayout } from './world'

interface Anchors { ground: Map<string, SVGGElement>; doors: Map<string, SVGGElement> }
const equalMap = (a: Map<string, SVGGElement>, b: Map<string, SVGGElement>) => a.size === b.size && [...a].every(([k, v]) => b.get(k) === v)

/** 动态立绘放进地图已有的深度层。只有七只的组件订阅生活时钟，整座工作地图不跟着每拍重画。 */
export function ResidentWorldVisitors({ store, world, svgRef, far, selected, onSelect, onEnter }: {
  store: ResidentStore; world: WorldLayout; svgRef?: RefObject<SVGSVGElement | null>; far: boolean
  selected: ResidentId | null; onSelect: (id: ResidentId) => void; onEnter: (projectId: string) => void
}) {
  const life = useResidentLife(store), context = useMemo(() => residentWorld(world), [world])
  const [anchors, setAnchors] = useState<Anchors>(() => ({ ground: new Map(), doors: new Map() }))
  useLayoutEffect(() => {
    const svg = svgRef?.current
    if (!svg) return
    const ground = new Map([...svg.querySelectorAll<SVGGElement>('[data-resident-ground]')].map((el) => [el.getAttribute('data-resident-ground')!, el]))
    const doors = new Map([...svg.querySelectorAll<SVGGElement>('[data-resident-door]')].map((el) => [el.getAttribute('data-resident-door')!, el]))
    if (!equalMap(ground, anchors.ground) || !equalMap(doors, anchors.doors)) setAnchors({ ground, doors })
  })
  if (!life.enabled || !context) return null
  return <>{RESIDENT_IDS.map((id) => {
    const actor = life.actors[id], trip = actor.trip
    if (!trip) return null
    if (trip.phase === 'inside') {
      const door = anchors.doors.get(trip.projectId), destination = context.destinations.find((d) => d.id === trip.projectId)
      if (!door || !destination) return null
      const guests = RESIDENT_IDS.filter((other) => life.actors[other].trip?.phase === 'inside' && life.actors[other].trip?.projectId === trip.projectId)
      const index = guests.indexOf(id), p = iso(destination.door.x, destination.door.y + 0.25)
      return createPortal(<g transform={`translate(${p[0] + index * 28},${p[1]})`} role="button" tabIndex={0} data-resident-id={id}
        aria-label={`${residentSpec(id).name} 在 ${trip.projectName} 屋里串门，进去看看`} className="town-resident-guest"
        onPointerDown={(e) => e.stopPropagation()} onClick={() => onEnter(trip.projectId)} onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onEnter(trip.projectId) } }}>
        <rect x="-15" y="-32" width="28" height="31" rx="8" fill="#fffaf0" stroke="#b88e78" />
        <image href={residentImage(id, 'avatar')} x="-13" y="-30" width="24" height="28" />
        {!far && index === 0 && <text y="12" className="town-resident-name" textAnchor="middle">居民来访 {guests.length}</text>}
      </g>, door, `guest-${id}`)
    }
    const cell = pointCell(trip)
    if (cellKey(cell) === cellKey(context.home)) return null
    const anchor = anchors.ground.get(cellKey(cell))
    return anchor ? createPortal(<ResidentFigure actor={actor} at={trip} now={life.now} quiet={life.quiet} far={far} selected={selected === id}
      moving={!life.paused && actor.holdUntil <= life.now} draggable={false} onSelect={() => onSelect(id)} />, anchor, id) : null
  })}</>
}

export function ResidentRoomVisitors({ store, projectId }: { store: ResidentStore; projectId: string }) {
  const life = useResidentLife(store)
  if (!life.enabled) return null
  return <g aria-label="在屋内串门的居民" pointerEvents="none">{RESIDENT_IDS.filter((id) => life.actors[id].trip?.phase === 'inside' && life.actors[id].trip?.projectId === projectId).map((id) => {
    const actor = life.actors[id], p = interiorVisitorPoint(actor.trip!, id), at = iso(p.x, p.y)
    return <g key={id} data-resident-id={id} transform={`translate(${at[0]},${at[1]}) scale(.8)`} className={`town-resident-figure${life.paused ? '' : ' is-walking'}`} role="img" aria-label={`来访居民 ${residentSpec(id).name} 在屋内参观`}>
      <ellipse rx="17" ry="5" fill="rgba(70,55,35,.16)" />
      <image href={residentImage(id, actor.pose)} x="-38" y="-84" width="76" height="86" preserveAspectRatio="xMidYMax meet" />
      <text className="town-resident-name" y="17" textAnchor="middle">来访 · {residentSpec(id).name}</text>
    </g>
  })}</g>
}
