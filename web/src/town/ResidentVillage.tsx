import { useRef, useState, type PointerEvent as RPointerEvent } from 'react'
import { HipRoof, IsoBox, IsoTile, iso } from './iso'
import { Flowers, Pond } from './scenery'
import { Path, Tag, Tree, activate } from './TownScene'
import { CELL_D, CELL_W, type Cell } from './world'
import { GARDEN_PATHS, GARDEN_SPOTS, RESIDENTS, RESIDENT_IDS, residentImage, residentSpec, type GardenPoint, type ResidentId } from './residents'
import { residentStatus, type ResidentActor, type ResidentLife, type ResidentStore } from './residentLife'
import { useResidentLife as useLife } from './residentPresence'
import { cellKey, localTripPoint, pointCell, type ResidentDestination } from './residentTrips'
import './residents.css'

/** 岛内的物件按脚下深度排序；立绘能被小屋、树和桌子自然遮挡。 */
export function ResidentsVillage({ cell, store, far, selected, onSelect }: {
  cell: Cell; store: ResidentStore; far: boolean; active: boolean; selected: ResidentId | null; onSelect: (id: ResidentId) => void
}) {
  const life = useLife(store)
  const root = useRef<SVGGElement>(null)
  const [dragged, setDragged] = useState<{ id: ResidentId; at: GardenPoint } | null>(null)
  const origin = iso(cell.cx * CELL_W, cell.cy * CELL_D)
  const localPoint = (e: RPointerEvent<SVGGElement>): GardenPoint | null => {
    const matrix = root.current?.getScreenCTM()
    if (!matrix) return null
    const point = new DOMPoint(e.clientX, e.clientY).matrixTransform(matrix.inverse())
    return { x: point.x / 60 + point.y / 30, y: point.y / 30 - point.x / 60 }
  }
  const objects = [
    { key: 'house', depth: 6.5, content: <g className="town-resident-house" aria-label="七只的小屋，查看七位居民" {...activate(() => onSelect('deepseek'))} onPointerDown={(e) => e.stopPropagation()}>
      <IsoBox gx={0.7} gy={0.35} w={3.45} d={2.4} h={57} top="#f1e7d1" left="#f4e7cc" right="#dfcdb0" stroke="#9b7b55" />
      <HipRoof gx={0.7} gy={0.35} w={3.45} d={2.4} z={57} rise={30} front="#c77d68" side="#a95f50" stroke="#825242" />
      <IsoBox gx={1.35} gy={2.76} w={0.65} d={0.06} h={30} top="#8b6549" left="#b89162" right="#a07751" stroke="#805b40" />
      <IsoBox gx={2.55} gy={2.78} w={0.78} d={0.04} h={18} z={20} top="#fff3b8" left="#ffe4a0" right="#ffe4a0" stroke="#a98760" />
      <Tag at={iso(2.5, 0.6, 100)} text="七只的小屋" bg="#fffaf0" fg="#694d3a" />
      <title>七位常住居民的家；生活记录只保存在本机。</title>
    </g> },
    { key: 'tea-table', depth: 7.9, content: <g aria-hidden>
      <IsoBox gx={0.35} gy={6.9} w={1.35} d={0.5} h={19} top="#caa779" left="#a58057" right="#92704a" stroke="#856545" />
      <IsoBox gx={0.5} gy={6.9} w={0.3} d={0.23} h={5} z={19} top="#fff8e6" left="#e8ddc6" right="#dfd0b4" />
      <IsoBox gx={1} gy={6.9} w={0.36} d={0.26} h={3} z={19} top="#daaa76" left="#be8f61" right="#aa7d51" />
    </g> },
    { key: 'workbench', depth: 9.6, content: <g aria-hidden>
      <IsoBox gx={5.5} gy={3.3} w={1.3} d={0.6} h={21} top="#b58d65" left="#96714d" right="#805d3d" stroke="#795a3e" />
      <IsoBox gx={5.7} gy={3.45} w={0.32} d={0.26} h={5} z={21} top="#b7c3c4" left="#8c9c9d" right="#75898b" />
    </g> },
    { key: 'snacks', depth: 14.2, content: <g aria-hidden>
      <IsoBox gx={5.5} gy={8} w={1.35} d={0.5} h={18} top="#f4d8ad" left="#cb9a67" right="#b58858" stroke="#9b764e" />
      <IsoBox gx={5.7} gy={8.04} w={0.3} d={0.2} h={6} z={18} top="#fffaf0" left="#d8b5c2" right="#c496a5" />
      <IsoBox gx={6.2} gy={8.04} w={0.3} d={0.2} h={6} z={18} top="#fffaf0" left="#c6d4b2" right="#a9bd92" />
    </g> },
    { key: 'tree-back', depth: 1.1, content: <Tree at={iso(0.15, 1)} k={0.7} /> },
    { key: 'tree-front', depth: 17, content: <Tree at={iso(8.6, 8.4)} k={0.85} /> },
    ...(life.enabled ? RESIDENT_IDS.filter((id) => { const trip = life.actors[id].trip; return !trip || trip.phase !== 'inside' && cellKey(pointCell(trip)) === cellKey(cell) }).map((id) => {
      const actor = life.actors[id], at = dragged?.id === id ? dragged.at : actor.trip ? localTripPoint(actor.trip) : actor
      return { key: id, depth: at.x + at.y, content: <ResidentFigure actor={actor} at={at} now={life.now} quiet={life.quiet} far={far}
        selected={selected === id} draggable={!actor.trip} moving={!life.paused && (actor.trip ? actor.trip.path.length > 0 : actor.route.length > 0) && actor.holdUntil <= life.now && dragged?.id !== id}
        onSelect={() => onSelect(id)} onDrag={(e) => { const p = localPoint(e); if (p) setDragged({ id, at: p }) }}
        onDrop={(e) => { const p = localPoint(e); if (p) store.drop(id, p); setDragged(null) }} onCancel={() => setDragged(null)} /> }
    }) : []),
  ].sort((a, b) => a.depth - b.depth)
  return (
    <g ref={root} transform={`translate(${origin[0]},${origin[1]})`} className={`town-residents${far ? ' is-distant' : ''}`} aria-label="七位居民的生活花园">
      <IsoTile gx={-1} gy={-1} w={11.1} d={10.1} fill="#e6d9bd" />
      <IsoTile gx={0} gy={0} w={9} d={8.2} fill="#dbe8c0" />
      <Pond gx={6.2} gy={0.55} w={2.7} d={2.2} />
      {GARDEN_PATHS.map(([a, b]) => <Path key={`${a}-${b}`} from={[GARDEN_SPOTS[a].x, GARDEN_SPOTS[a].y]} to={[GARDEN_SPOTS[b].x, GARDEN_SPOTS[b].y]} />)}
      <Flowers gx={8.2} gy={6.8} seed={34} /><Flowers gx={7.9} gy={7.5} seed={18} />
      <Flowers gx={0.4} gy={4.7} seed={9} /><Flowers gx={8.4} gy={4} seed={51} />
      {RESIDENTS.map((r, i) => <g key={r.id} aria-hidden>
        <IsoBox gx={0.8 + i * 0.48} gy={2.95} w={0.28} d={0.22} h={12} top={r.color} left={r.color} right={r.color} stroke="#856545" />
      </g>)}
      {objects.map((o) => <g key={o.key}>{o.content}</g>)}
      {far && <Tag at={iso(4.5, 7.7, 20)} text={life.enabled ? '七只的家 · 7 位居民' : '七只的家 · 休息中'} bg="#fffaf0" fg="#694d3a" />}
    </g>
  )
}

export function ResidentFigure({ actor, at, now, quiet, far, selected, moving, onSelect, onDrag, onDrop, onCancel, draggable = true }: {
  actor: ResidentActor; at: GardenPoint; now: number; quiet: boolean; far: boolean; selected: boolean; moving: boolean
  onSelect: () => void; onDrag?: (e: RPointerEvent<SVGGElement>) => void; onDrop?: (e: RPointerEvent<SVGGElement>) => void; onCancel?: () => void; draggable?: boolean
}) {
  const pointer = useRef<{ x: number; y: number; moved: boolean } | null>(null)
  const spec = residentSpec(actor.id), p = iso(at.x, at.y)
  const bubble = !quiet && !far && actor.bubble && actor.bubble.from <= now && actor.bubble.until > now ? actor.bubble.text : null
  return <g transform={`translate(${p[0]},${p[1]})`} className={`town-resident-figure${moving ? ' is-walking' : ''}${selected ? ' is-selected' : ''}${draggable ? '' : ' is-travelling'}`}
    data-resident-id={actor.id} data-resident-status={residentStatus(actor)} role="button" tabIndex={0} aria-label={`${spec.name}，${residentStatus(actor)}，查看居民`}
    onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); e.stopPropagation(); onSelect() } }}
    onPointerDown={(e) => { if (e.button !== 0) return; e.stopPropagation(); pointer.current = { x: e.clientX, y: e.clientY, moved: false }; e.currentTarget.setPointerCapture(e.pointerId) }}
    onPointerMove={(e) => { const d = pointer.current; if (!d) return; e.stopPropagation(); if (Math.hypot(e.clientX - d.x, e.clientY - d.y) > 5) d.moved = true; if (d.moved && draggable) onDrag?.(e) }}
    onPointerUp={(e) => { const d = pointer.current; if (!d) return; e.stopPropagation(); pointer.current = null; if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId); if (d.moved && draggable) onDrop?.(e); else if (!d.moved) onSelect() }}
    onPointerCancel={(e) => { e.stopPropagation(); pointer.current = null; onCancel?.() }}>
    <ellipse rx={far ? 9 : 18} ry={far ? 3.5 : 5.5} fill="rgba(70,55,35,.18)" />
    {selected && <ellipse rx={far ? 12 : 23} ry={far ? 5 : 8} fill="none" stroke={spec.color} strokeWidth="2" />}
    <g className="town-resident-body">
      <image href={residentImage(actor.id, far ? 'avatar' : actor.pose)} x={far ? -15 : -38} y={far ? -30 : -84} width={far ? 30 : 76} height={far ? 30 : 86} preserveAspectRatio="xMidYMax meet" pointerEvents="none" />
    </g>
    {!far && <text className="town-resident-name" y="17" textAnchor="middle">{spec.name}</text>}
    <rect x={far ? -18 : -33} y={far ? -34 : -83} width={far ? 36 : 66} height={far ? 40 : 107} fill="transparent" />
    {bubble && <foreignObject x="-100" y="-150" width="200" height="68" pointerEvents="none"><div className="town-resident-bubble">{bubble}</div></foreignObject>}
    <title>{spec.name} · {residentStatus(actor)}。{draggable ? '可以拖到花园小路上。' : '点开查看串门情况。'}</title>
  </g>
}

const journalTime = (at: number) => new Date(at).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false })

export function ResidentsPanel({ store, selected, onSelect, onClose, onVisit, destinations = [], onLocate }: {
  store: ResidentStore; selected: ResidentId; onSelect: (id: ResidentId) => void; onClose: () => void; onVisit: () => void
  destinations?: ResidentDestination[]; onLocate?: (id: ResidentId) => void
}) {
  const life = useLife(store), actor = life.actors[selected], spec = residentSpec(selected)
  const [chosenProject, setChosenProject] = useState('')
  const visitId = destinations.some((d) => d.id === chosenProject) ? chosenProject : destinations[0]?.id ?? ''
  const friendship = Object.entries(life.friendship).filter(([key]) => key.split('+').includes(selected))
    .map(([key, f]) => ({ id: key.split('+').find((id) => id !== selected) as ResidentId, points: f.points }))
    .sort((a, b) => b.points - a.points).slice(0, 2)
  return <section className="town-residents-panel town-world-ui" aria-label="小镇居民" data-town-popover="residents" onPointerDown={(e) => e.stopPropagation()}>
    <div className="town-residents-heading"><div><span>小镇日常</span><h2>七只的小屋</h2></div><button type="button" className="town-residents-close" onClick={onClose} aria-label="关闭居民面板">×</button></div>
    <p className="town-residents-intro">各自散步，也会偶尔聊上几句。</p>
    <div className="town-residents-visit"><button type="button" onClick={onVisit}>去她们家</button><button type="button" disabled={!life.enabled} onClick={() => { store.gather(); onVisit() }}>叫大家来喝茶</button></div>
    <div className="town-residents-roster" role="group" aria-label="七位常住居民">
      {RESIDENTS.map((r) => <button key={r.id} type="button" aria-pressed={selected === r.id} onClick={() => onSelect(r.id)}>
        <img src={residentImage(r.id, 'avatar')} alt="" width="34" height="34" />
        <span><strong>{r.name}</strong><small>{residentStatus(life.actors[r.id])}</small></span>
      </button>)}
    </div>
    <div className="town-resident-detail">
      <img src={residentImage(selected, actor.pose)} alt="" width="76" height="90" />
      <div><h3>{spec.name}</h3><p>{spec.description}</p>{actor.pats > 0 && <small>你已经摸过她 {actor.pats} 次头啦</small>}</div>
    </div>
    <div className="town-resident-actions" role="group" aria-label={`${spec.name}的互动`}>
      <button type="button" disabled={!life.enabled} onClick={() => store.pat(selected)}>摸摸头</button>
      <button type="button" disabled={!life.enabled} onClick={() => store.go(selected, false)}>去散步</button>
      <button type="button" disabled={!life.enabled} onClick={() => store.go(selected, true)}>回家休息</button>
    </div>
    <div className="town-resident-trip-controls">
      <label htmlFor="resident-visit-project">去其他项目串门</label>
      <div><select id="resident-visit-project" value={visitId} disabled={!destinations.length || !!actor.trip} onChange={(e) => setChosenProject(e.target.value)}>
        {!destinations.length && <option value="">当前地图还没有项目</option>}
        {destinations.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
      </select><button type="button" disabled={!life.enabled || !visitId || !!actor.trip} onClick={() => store.visit(selected, visitId)}>去串门</button></div>
      {actor.trip && <p>{residentStatus(actor)} {onLocate && <button type="button" onClick={() => onLocate(selected)}>{actor.trip.phase === 'inside' ? '进屋看看' : '看看她在哪'}</button>}</p>}
    </div>
    {friendship.length > 0 && <p className="town-resident-friends">熟悉的邻居：{friendship.map((f) => `${residentSpec(f.id).name} · 碰面 ${f.points} 次`).join('，')}</p>}
    <ResidentJournal life={life} />
    <div className="town-residents-settings">
      <label><input type="checkbox" checked={life.enabled} onChange={(e) => store.configure('enabled', e.target.checked)} />显示居民</label>
      <label><input type="checkbox" checked={life.quiet} onChange={(e) => store.configure('quiet', e.target.checked)} />安静一点</label>
      <label><input type="checkbox" checked={life.paused} onChange={(e) => store.configure('paused', e.target.checked)} />暂停散步</label>
      <label><input type="checkbox" checked={life.autoVisit} onChange={(e) => store.configure('autoVisit', e.target.checked)} />自己去串门</label>
    </div>
    <a className="town-residents-credits" href="/residents/ATTRIBUTION.md" target="_blank" rel="noreferrer">角色立绘致谢</a>
  </section>
}

function ResidentJournal({ life }: { life: ResidentLife }) {
  return <div className="town-resident-journal"><h3>刚刚的小事</h3><ol>{life.journal.slice(0, 3).map((entry, i) => <li key={`${entry.at}-${i}`}><time dateTime={new Date(entry.at).toISOString()}>{journalTime(entry.at)}</time><span>{entry.text}</span></li>)}</ol></div>
}
