// 小镇世界：每个项目一个街区，中间是广场。远景只画街区名牌和计数，近景画小人、包裹和任务。只读。
import { useEffect, useMemo, useRef, useState, type PointerEvent as RPointerEvent } from 'react'
import { IsoBox, IsoTile, iso, type Pt } from './iso'
import { MAX_SEATS, characterStatusLabel, type BuildingView, type Highlight, type ParcelView, type TownModel } from './townModel'
import {
  Building, HOUSE_SHAPE, Character, DecisionBoard, Desk, FailRack, Parcel, Path, ReviewDesk, StatusPill, Tag, Tree,
  activate, buildingColors, charLook, charMatches, onReviewDesk, parcelMatches, parcelTitle, slot, yard,
  type BuildingShape, type Plot, type Selection,
} from './TownScene'
import {
  CELL_D, CELL_W, FAR_W, INNER_D, INNER_W, cellBox, clampCamera, fitCamera, lerpCamera, tourStops, viewBoxOf, worldLayout, zoomAt,
  type Box, type Camera, type Cell, type District, type Tier, type WorldLayout,
} from './world'
import type { WorldPlan } from './clusters'
import { InteriorScene } from './InteriorScene'
import { Campfire, Fence, Flowers, Pine, Pond, Rock, Windmill, YARD_TINT, terrainOf, type Terrain } from './scenery'
import { statusChips, statusOf, sumStatus, type StatusCounts } from './status'
import { Field } from './field'
import { harvestResult, ripeQueue } from './harvest'
import { AGENTS, agentChips, agentCounts, agentLegend, agentOf, mainAgent, sumAgents, type Agent } from './agents'

/** 每个街区的退件筐最多摆几个箱子，其余只计数。 */
const BIN_MAX = 2
/** 告示栏最多钉几张卡片。 */
const BOARD_MAX = 4
/** 视野宽于此时只画村庄名牌（村里的项目合并成一块），中央和野外项目仍各一块。 */
const MAP_W = 3600

const hash = (s: string) => { let h = 0; for (const ch of s) h = (h * 31 + ch.charCodeAt(0)) | 0; return Math.abs(h) }

interface SceneProps {
  model: TownModel
  world: WorldLayout
  view: Box
  far: boolean
  selected: Selection | null
  highlight: Highlight | null
  onSelect: (s: Selection) => void
  changed?: ReadonlySet<string>
  offline?: boolean
  needsYou: (b: BuildingView) => boolean
  /** “按 Agent 看”打开时：按 Agent 着色；focus 非空时只突出这个 Agent 的会话和项目。 */
  agents?: { focus: Agent | null } | null
}

/** 四档建筑：占地、墙色、高度、窗户层数。占满院子后排，远看也认得出大小差别。 */
const TIERS: Record<Tier, { shape: BuildingShape; w: number; d: number }> = {
  0: { w: 3.8, d: 3.0, shape: { kind: 'cabin', name: '小木屋', h: 48, rise: 38, floors: 1, walls: { top: '#b48a5c', front: '#c99c6a', side: '#ad8152', edge: '#7a5636' } } },
  1: { w: 5.0, d: 3.6, shape: { ...HOUSE_SHAPE, h: 72, rise: 44, floors: 2 } },
  2: { w: 5.6, d: 3.9, shape: { kind: 'workshop', name: '工坊', h: 86, rise: 34, floors: 2, walls: { top: '#e9dcc4', front: '#efe1c8', side: '#dccaa8', edge: '#8f7350' } } },
  3: { w: 5.0, d: 4.0, shape: { kind: 'tower', name: '大楼', h: 196, rise: 30, floors: 5, walls: { top: '#e7e2d6', front: '#f1ece0', side: '#dcd4c3', edge: '#8d8270' } } },
}

function districtPlot(d: District): Plot {
  const t = TIERS[d.tier]
  return { gx: d.ox + 0.8, gy: d.oy + 0.5, w: t.w, d: t.d, facing: 'x', ...buildingColors(d.b.repo?.id) }
}

export function WorldScene({ model, world, view, far, selected, highlight, onSelect, changed = new Set(), offline = false, needsYou, agents = null }: SceneProps) {
  const isSel = (kind: Selection['kind'], key: string) => selected?.kind === kind && selected.key === key
  const dim = (match: boolean) => (highlight && !match ? ' is-dim' : '')
  const flash = (key: string) => (changed.has(key) ? ' is-changed' : '')
  const { gx0, gy0, gx1, gy1 } = world.tiles

  // 道路：每个街区右侧和前方各一条，贯穿整个世界。
  const cxs = new Set<number>(), cys = new Set<number>()
  for (let gx = gx0; gx < gx1; gx += CELL_W) cxs.add(Math.floor(gx / CELL_W))
  for (let gy = gy0; gy < gy1; gy += CELL_D) cys.add(Math.floor(gy / CELL_D))
  const used = new Set(['0,0', ...world.districts.map((d) => `${d.cell.cx},${d.cell.cy}`), ...world.villages.map((v) => `${v.square.cx},${v.square.cy}`)])
  const streetCells: Cell[] = [{ cx: 0, cy: 0 }, ...world.districts.filter((d) => d.kind !== 'wild').map((d) => d.cell), ...world.villages.map((v) => v.square)]
  // 地形：中央是草地；村庄和野外小屋按名字固定一种。
  const terrainAt = new Map<string, Terrain>([['0,0', 'meadow']])
  for (const v of world.villages) for (const c of v.cells) terrainAt.set(`${c.cx},${c.cy}`, terrainOf(v.key))
  for (const d of world.districts) if (!terrainAt.has(`${d.cell.cx},${d.cell.cy}`)) terrainAt.set(`${d.cell.cx},${d.cell.cy}`, d.kind === 'wild' ? terrainOf(d.key) : 'meadow')
  const tintOf = (c: Cell) => YARD_TINT[terrainAt.get(`${c.cx},${c.cy}`) ?? 'meadow']
  const empty: { ox: number; oy: number }[] = []
  for (const cx of cxs) for (const cy of cys) if (!used.has(`${cx},${cy}`)) empty.push({ ox: cx * CELL_W, oy: cy * CELL_D })

  // 角色、包裹的位置，按街区分组：每个街区整体按前后顺序画，后面的不会盖住前面的。
  type Seat = { key: string; c: BuildingView['characters'][number]; plot: Plot; gx: number; gy: number }
  type Slot = { p: ParcelView; at: Pt; stale: boolean; moving: boolean }
  const seatsOf = new Map<string, Seat[]>()
  const slotsOf = new Map<string, Slot[]>()
  const seats: Seat[] = []
  const charPos = new Map<string, Pt>()
  const itemOwner = new Map<string, string>()
  for (const d of world.districts) {
    const plot = districtPlot(d)
    const mine: Seat[] = [], parcels: Slot[] = []
    d.b.characters.slice(0, MAX_SEATS).forEach((c, j) => {
      const [gx, gy] = yard(plot, slot(j), 2.2)
      mine.push({ key: c.key, c, plot, gx, gy })
      charPos.set(c.key, iso(gx, gy))
      if (c.item) itemOwner.set(c.item.id, c.key)
      const stale = c.status === 'stale'
      for (const r of c.runs.filter((x) => x.phase === 'moving')) parcels.push({ p: r, at: iso(gx - 0.05, gy - 0.43, 12), stale, moving: !stale })
    })
    d.b.parcels.filter((p) => p.phase === 'failed').slice(0, BIN_MAX).forEach((p, i) => {
      parcels.push({ p, at: iso(d.ox + 4.45 + i * 0.5, d.oy + 7.65, 9), stale: false, moving: false })
    })
    seatsOf.set(d.key, mine)
    slotsOf.set(d.key, parcels.sort((a, b) => a.p.run.id - b.p.run.id))
    seats.push(...mine)
  }
  const depthOrder = [{ key: '__plaza', depth: 0, cx: 0 }, ...world.districts.map((d) => ({ key: d.key, depth: d.cell.cx + d.cell.cy, cx: d.cell.cx }))]
    .sort((a, b) => a.depth - b.depth || a.cx - b.cx)
  const byKey = new Map(world.districts.map((d) => [d.key, d]))
  const statusAt = new Map(world.districts.map((d) => [d.key, statusOf(d.b, model.pendingApprovals)]))
  const agentAt = new Map(world.districts.map((d) => [d.key, agentCounts(d.b)]))
  const focus = agents?.focus ?? null
  const fadeDistrict = (key: string) => (focus && agentAt.get(key)![focus] === 0 ? ' is-dim' : '')
  const fadeChar = (c: BuildingView['characters'][number]) => (focus && agentOf(c.session) !== focus ? ' is-dim' : '')

  const allParcels = model.buildings.flatMap((b) => b.parcels)
  const reviewTotal = allParcels.filter(onReviewDesk).length
  const failedTotal = allParcels.filter((p) => p.phase === 'failed').length
  const boardModel = { ...model, pendingApprovals: model.pendingApprovals.slice(0, BOARD_MAX) }
  const boardAt = iso(6.0, 8.0)
  const P = world.plaza
  // 远景名牌跟着视野放大，拉得再远也认得出项目名。
  const nowMs = Date.parse(model.now) || Date.now()
  const plateK = Math.min(2.4, Math.max(0.8, view.w / 2900))
  const mapMode = view.w > MAP_W

  return (
    <svg className={`town-svg is-world${far ? ' is-far' : ''}${far && mapMode ? ' is-map' : ''}${offline ? ' is-offline' : ''}`} viewBox={`${view.x} ${view.y} ${view.w} ${view.h}`}
      role="group" aria-label="工作小镇世界">
      <defs>
        <pattern id="world-grass" width="60" height="30" patternUnits="userSpaceOnUse">
          <path d="M0 15 L30 0 L60 15 L30 30 Z" fill="none" stroke="#b9cba0" strokeWidth="0.8" />
        </pattern>
      </defs>

      {/* 大地与道路 */}
      <IsoBox gx={gx0} gy={gy0} w={gx1 - gx0} d={gy1 - gy0} h={26} z={-26} top="#d7e2bf" left="#b48a5e" right="#946c48" />
      <IsoTile gx={gx0} gy={gy0} w={gx1 - gx0} d={gy1 - gy0} fill="url(#world-grass)" />
      {/* 街道：只铺在中央和各村庄的格子上；野外是草地和树林 */}
      {streetCells.map((c) => <IsoTile key={`st${c.cx},${c.cy}`} gx={c.cx * CELL_W - 1} gy={c.cy * CELL_D - 1} w={CELL_W + 0.1} d={CELL_D + 0.1} fill="#e6d9bd" />)}
      {streetCells.map((c) => <IsoTile key={`yd${c.cx},${c.cy}`} gx={c.cx * CELL_W} gy={c.cy * CELL_D} w={INNER_W} d={INNER_D} fill={tintOf(c)} />)}
      {/* 村庄之间的土路：从村口小广场通到中央广场 */}
      {world.villages.map((v) => {
        const a = [v.square.cx * CELL_W + INNER_W / 2, v.square.cy * CELL_D + INNER_D / 2] as [number, number]
        const b = [INNER_W / 2, INNER_D / 2] as [number, number]
        return <Path key={`road-${v.key}`} from={a} to={b} />
      })}
      {/* 野外小屋脚下的空地 */}
      {world.districts.filter((d) => d.kind === 'wild').map((d) => <IsoTile key={`cl${d.key}`} gx={d.ox + 0.2} gy={d.oy + 0.1} w={INNER_W - 0.4} d={INNER_D - 0.6} fill={tintOf(d.cell)} />)}
      {/* 村口小广场：井和村名牌 */}
      {world.villages.map((v) => <VillageSquare key={v.key} cell={v.square} name={v.name} terrain={terrainOf(v.key)} />)}

      {/* 空地：池塘、草甸（石头和花）、松林或树林，按格子固定 */}
      {empty.map(({ ox, oy }) => {
        const h = hash(`${ox},${oy}`)
        const kind = h % 10
        const spot = (i: number): [number, number] => [ox + 0.8 + ((h >> (i * 3)) % 9), oy + 0.8 + ((h >> (i * 4 + 1)) % 8)]
        if (kind === 0) return (
          <g key={`e${ox},${oy}`}>
            <Pond gx={ox + 1.5} gy={oy + 1.5} w={6} d={5} />
            <Tree at={iso(ox + 0.6, oy + 7.6)} k={0.9} />
          </g>
        )
        if (kind <= 2) return (
          <g key={`e${ox},${oy}`}>
            <Rock gx={spot(0)[0]} gy={spot(0)[1]} k={1.3} />
            <Rock gx={spot(1)[0]} gy={spot(1)[1]} />
            <Flowers gx={spot(2)[0]} gy={spot(2)[1]} seed={h} />
            <Flowers gx={spot(3)[0]} gy={spot(3)[1]} seed={h >> 5} />
            <Tree at={iso(...spot(4))} k={0.9} />
          </g>
        )
        const pines = kind >= 7
        return (
          <g key={`e${ox},${oy}`}>
            {[0, 1, 2, 3, 4, 5].map((i) => {
              const [gx, gy] = spot(i)
              const k = 0.8 + ((h >> i) % 4) * 0.12
              return pines ? <Pine key={i} at={iso(gx, gy)} k={k} /> : <Tree key={i} at={iso(gx, gy)} k={k} />
            })}
          </g>
        )
      })}

      {depthOrder.map(({ key }) => {
        if (key === '__plaza') return (
          <g key="__plaza">
            <IsoTile gx={P.ox + 0.4} gy={P.oy + 0.4} w={INNER_W - 0.4} d={INNER_D - 0.4} fill="#e9dcc2" stroke="#cdbb98" />
            <FailRack at={{ gx: P.ox + 5.8, gy: P.oy + 1.3 }} count={failedTotal} />
            <ReviewDesk at={{ gx: P.ox + 1.2, gy: P.oy + 2.4 }} count={reviewTotal} selected={isSel('review-desk', 'review-desk')} dimDesk={dim(highlight === 'review')} onSelect={onSelect} />
            {/* 验收台上的箱子只是示意，数量看招牌 */}
            {Array.from({ length: Math.min(5, reviewTotal) }, (_, i) => (
              <g key={`rd${i}`} className="town-near" aria-hidden><TownCrate at={iso(P.ox + 2.0 + (i % 3) * 0.9, P.oy + 2.95, 16 + Math.floor(i / 3) * 11)} fill="#d6b27a" tape="#5b6cd8" /></g>
            ))}
            <DecisionBoard place={{ x: boardAt[0], y: boardAt[1], anchor: 'bottom', scale: 1 }} model={boardModel} isSel={(k) => isSel('approval', k)} dimClass={dim(highlight === 'waiting')} onSelect={onSelect} />
            {model.pendingApprovals.length > BOARD_MAX && <Tag at={[boardAt[0], boardAt[1] + 16]} text={`另有 ${model.pendingApprovals.length - BOARD_MAX} 条在关注队列`} bg="#fffaf0" fg="#6b5a44" small />}
          </g>
        )
        const d = byKey.get(key)!
        const plot = districtPlot(d)
        const failed = d.b.parcels.filter((p) => p.phase === 'failed').length
        const h = hash(d.key)
        const lead = agents ? mainAgent(agentAt.get(d.key)!) : null
        return (
          <g key={d.key} className={fadeDistrict(d.key) || undefined}>
            {lead && <AgentYard d={d} color={AGENTS.find((a) => a.key === lead)!.color} />}
            <Path from={[plot.gx + plot.w / 2, plot.gy + plot.d]} to={[plot.gx + plot.w / 2, d.oy + INNER_D + 0.6]} />
            {terrainAt.get(`${d.cell.cx},${d.cell.cy}`) === 'forest' || terrainAt.get(`${d.cell.cx},${d.cell.cy}`) === 'hill'
              ? <Pine at={iso(d.ox + 8.6, d.oy + 0.4)} k={0.9 + (h % 3) * 0.1} />
              : <Tree at={iso(d.ox + 8.6, d.oy + 0.4)} k={0.8 + (h % 3) * 0.1} />}
            {terrainAt.get(`${d.cell.cx},${d.cell.cy}`) === 'hill' && <Rock gx={d.ox + 8.2} gy={d.oy + 4.4} k={1.2} />}
            <Flowers gx={d.ox + 0.4} gy={d.oy + 5.4} seed={h} />
            <Flowers gx={d.ox + 5.0} gy={d.oy + 8.0} seed={h >> 4} />
            {d.kind === 'wild' && <Campfire gx={d.ox + 7.2} gy={d.oy + 2.4} />}
            {d.kind === 'wild' && <Fence gx={d.ox + 0.3} gy={d.oy + INNER_D - 0.5} len={1.9} />}
            {d.kind === 'wild' && <Fence gx={d.ox + 4.6} gy={d.oy + INNER_D - 0.5} len={4.0} />}
            <Building plot={plot} shape={TIERS[d.tier].shape} b={d.b} selected={isSel('building', d.b.key)} dimClass={dim(false)} onSelect={() => onSelect({ kind: 'building', key: d.b.key })} />
            {/* 门口的菜地：一棵菜一个工作项，熟了 = 待你验收 */}
            <Field gx={d.ox + 5.5} gy={d.oy + 4.9} b={d.b} pending={model.pendingApprovals} now={nowMs}
              selectedKey={selected?.kind === 'item' ? selected.key : null} dimClass={dim(highlight === 'review')} onSelect={onSelect} />
            {failed > 0 && (
              <g className={dim(highlight === 'failed')}>
                <IsoBox gx={d.ox + 4.0} gy={d.oy + 7.2} w={1.3} d={0.9} h={9} top="#7a3a32" left="#a5483e" right="#8a3c33" />
                <Tag at={iso(d.ox + 4.65, d.oy + 7.65, 40)} text={`失败 ${failed}`} bg="#d2483d" fg="#fff" small />
              </g>
            )}
            {statusAt.get(d.key)!.blocked > 0 && (
              <g className={`town-obj${dim(false)}`} {...activate(() => onSelect({ kind: 'building', key: d.b.key }))} aria-label={`${d.b.name}：受阻 ${statusAt.get(d.key)!.blocked} 项`}>
                <Roadblock gx={plot.gx + plot.w / 2 + 0.9} gy={plot.gy + plot.d + 1.0} />
                <Tag at={iso(plot.gx + plot.w / 2 + 1.5, plot.gy + plot.d + 1.0, 46)} text={`受阻 ${statusAt.get(d.key)!.blocked}`} bg="#d2483d" fg="#fff" small />
              </g>
            )}
            {seatsOf.get(d.key)!.map((seat) => <Desk key={`${seat.key}-desk`} gx={seat.gx - 0.35} gy={seat.gy - 1.05} facing={seat.plot.facing} />)}
            {slotsOf.get(d.key)!.map(({ p, at, stale, moving }) => (
              <Parcel key={p.key} at={at} p={p} stale={stale} moving={moving} selected={isSel('parcel', p.key)}
                dimClass={dim(highlight ? parcelMatches(p, highlight, stale) : true) + flash(p.key)} onSelect={() => onSelect({ kind: 'parcel', key: p.key })}
                label={<title>{parcelTitle(p, 40)}</title>} />
            ))}
            {seatsOf.get(d.key)!.map(({ key: k, c, gx, gy }) => (
              <Character key={k} at={iso(gx, gy)} c={c} selected={isSel('character', c.key)}
                dimClass={(fadeChar(c) || dim(highlight ? charMatches(c, highlight) : true)) + flash(c.key)} onSelect={() => onSelect({ kind: 'character', key: c.key })} />
            ))}
            <Tree at={iso(d.ox + 0.4, d.oy + 7.4)} k={0.7 + ((h >> 3) % 3) * 0.1} />
            {agents && <AgentFlags gx={plot.gx - 0.3} gy={plot.gy + plot.d + 0.2} counts={agentAt.get(d.key)!} />}
          </g>
        )
      })}

      {model.deps.map((dep) => {
        const a = charPos.get(itemOwner.get(dep.upstream) ?? ''), z = charPos.get(itemOwner.get(dep.downstream) ?? '')
        if (!a || !z) return null
        const mid: Pt = [(a[0] + z[0]) / 2, Math.max(a[1], z[1]) + 30]
        return (
          <g key={`${dep.upstream}-${dep.downstream}`} className={`town-dep town-near${dim(false)}`}>
            <path d={`M${a[0]},${a[1] + 2} Q${mid[0]},${mid[1] + 20} ${z[0]},${z[1] + 2}`} fill="none" stroke={dep.satisfied ? '#4f9d5d' : '#8a7a63'} strokeWidth="1.6" strokeDasharray="4 4" />
            <Tag at={[mid[0], mid[1] + 12]} text={`${dep.downstream} 等 ${dep.upstream}${dep.cond === 'accepted' ? '验收' : '合并'}`} bg="#fffaf0" fg="#6b5a44" small />
          </g>
        )
      })}

      {/* 近景标签层 */}
      <g className="town-near">
        {seats.map(({ c }) => {
          const at = charPos.get(c.key)!
          const { style, st } = charLook(c)
          const label = characterStatusLabel[c.status]
          return (
            <g key={`${c.key}-pill`} style={{ transform: `translate(${at[0]}px,${at[1]}px) scale(1.22)` }}
              className={`town-obj town-move${fadeChar(c) || dim(highlight ? charMatches(c, highlight) : true)}`} aria-hidden onClick={() => onSelect({ kind: 'character', key: c.key })}>
              <StatusPill at={[0, 17]} name={c.name} status={offline && c.status === 'working' ? `断线前·${label}` : label} bg={st.bg} fg={st.fg} edge={style.body} />
            </g>
          )
        })}
      </g>

      {/* 远景名牌：拉远时代替招牌、小人和包裹。四种状态始终用同样的色点和顺序。 */}
      <g className="town-far">
        {world.villages.map((v) => {
          const members = world.districts.filter((d) => d.village === v.key)
          const st = sumStatus(members.map((d) => statusAt.get(d.key)!))
          const ag = sumAgents(members.map((d) => agentAt.get(d.key)!))
          return (
            <g key={`fv-${v.key}`} className={`town-map-only${focus && ag[focus] === 0 ? ' is-dim' : ''}`}>
              <FarPlate k={plateK * 1.2} at={iso(v.square.cx * CELL_W + INNER_W / 2, v.square.cy * CELL_D + INNER_D / 2, villageLift(v.square, plateK))} title={v.name} sub={`${members.length} 个项目`}
                tone={toneOf(st, 'plaza')} chips={agents ? withWaiting(agentChips(ag), st) : plateChips(st, 0)} note={agents ? '村里没有会话' : '村里很安静'} />
            </g>
          )
        })}
        {world.districts.map((d) => {
          const st = statusAt.get(d.key)!
          const failed = d.b.parcels.filter((p) => p.phase === 'failed').length
          const open = d.b.items.filter((w) => w.status !== 'done' && w.status !== 'abandoned').length
          const chips = agents ? withWaiting(agentChips(agentAt.get(d.key)!), st) : plateChips(st, failed)
          const note = agents ? '没有会话' : open ? `${open} 项未完成 · 没人在干活` : '安静'
          return (
            <g key={`far-${d.key}`} className={`town-obj${d.village ? ' town-hide-on-map' : ''}${fadeDistrict(d.key)}`} {...activate(() => onSelect({ kind: 'building', key: d.b.key }))}
              aria-label={`${d.b.name}：${chips.length ? chips.map((c) => c.text).join('，') : note}`}>
              <FarPlate k={plateK * (d.kind === 'wild' ? 0.85 : 1)} at={plateAt(d)} title={d.b.name}
                tone={toneOf(st, 'calm')} chips={chips} note={note} accent={buildingColors(d.b.repo?.id).accent} />
            </g>
          )
        })}
        {/* 广场名牌最后画：全镇合计，不被村庄名牌盖住 */}
        <FarPlate k={plateK * 1.1} at={iso(P.ox + INNER_W / 2, P.oy + INNER_D / 2, 110)} title="中央广场" tone="plaza"
          chips={agents ? agentChips(sumAgents([...agentAt.values()])) : plateChips({ ...sumStatus([...statusAt.values()]), waiting: model.pendingApprovals.length }, failedTotal)}
          note={agents ? '没有会话' : '今天很安静'} />
      </g>
    </svg>
  )
}

function VillageSquare({ cell, name, terrain }: { cell: Cell; name: string; terrain: Terrain }) {
  const ox = cell.cx * CELL_W, oy = cell.cy * CELL_D
  const sign = iso(ox + 4.5, oy + 3.2, 70)
  return (
    <g aria-label={`村口：${name}`}>
      <IsoTile gx={ox + 1.5} gy={oy + 1.2} w={6} d={5.6} fill="#eadfc6" stroke="#cdbb98" />
      {terrain === 'lake' && <Pond gx={ox + 0.3} gy={oy + 5.2} w={3.4} d={2.6} />}
      {terrain === 'hill' && <><Rock gx={ox + 0.6} gy={oy + 6.2} k={1.5} /><Rock gx={ox + 1.6} gy={oy + 7.0} /></>}
      {terrain === 'forest' && <><Pine at={iso(ox + 0.7, oy + 6.4)} k={1.1} /><Pine at={iso(ox + 1.6, oy + 7.4)} k={0.9} /></>}
      <Windmill gx={ox + 6.6} gy={oy + 0.6} />
      <Flowers gx={ox + 2.0} gy={oy + 1.6} seed={ox * 7 + oy} />
      {/* 井 */}
      <IsoBox gx={ox + 3.8} gy={oy + 3.4} w={1.4} d={1.4} h={14} top="#7d8a96" left="#a7b1bb" right="#8d98a3" />
      <IsoBox gx={ox + 4.2} gy={oy + 3.8} w={0.6} d={0.6} h={1} z={14} top="#4b7bb0" left="#4b7bb0" right="#3f6a98" />
      <line x1={iso(ox + 3.85, oy + 4.1)[0]} y1={iso(ox + 3.85, oy + 4.1)[1] - 14} x2={iso(ox + 3.85, oy + 4.1)[0]} y2={iso(ox + 3.85, oy + 4.1)[1] - 40} stroke="#6b4a2a" strokeWidth="2.5" />
      <line x1={iso(ox + 5.15, oy + 4.1)[0]} y1={iso(ox + 5.15, oy + 4.1)[1] - 14} x2={iso(ox + 5.15, oy + 4.1)[0]} y2={iso(ox + 5.15, oy + 4.1)[1] - 40} stroke="#6b4a2a" strokeWidth="2.5" />
      <polygon points={`${iso(ox + 3.6, oy + 4.1)[0]},${iso(ox + 3.6, oy + 4.1)[1] - 38} ${iso(ox + 4.5, oy + 4.1)[0]},${iso(ox + 4.5, oy + 4.1)[1] - 54} ${iso(ox + 5.4, oy + 4.1)[0]},${iso(ox + 5.4, oy + 4.1)[1] - 38}`} fill="#a6503a" stroke="#5a3a2a" />
      <g className="town-sign" transform={`translate(${sign[0]},${sign[1]})`}>
        <rect x={-(name.length * 15 + 28) / 2} y={-16} width={name.length * 15 + 28} height={30} rx="8" fill="#fffaf0" stroke="#8a6a3a" strokeWidth="2" />
        <text y="5" textAnchor="middle" fontSize="15" fontWeight="800" fill="#5a3a1c">{name}</text>
      </g>
    </g>
  )
}

function TownCrate({ at, fill, tape }: { at: Pt; fill: string; tape: string }) {
  const [x, y] = at
  const hw = 10, hh = 5, h = 11
  return (
    <g>
      <polygon points={`${x - hw},${y - hh} ${x},${y} ${x},${y - h} ${x - hw},${y - hh - h}`} fill={fill} stroke="rgba(60,30,10,.45)" />
      <polygon points={`${x + hw},${y - hh} ${x},${y} ${x},${y - h} ${x + hw},${y - hh - h}`} fill={fill} stroke="rgba(60,30,10,.45)" opacity="0.85" />
      <polygon points={`${x},${y - 2 * hh - h} ${x + hw},${y - hh - h} ${x},${y - h} ${x - hw},${y - hh - h}`} fill={fill} stroke="rgba(60,30,10,.45)" opacity="0.92" />
      <line x1={x - 5} y1={y - 18.5} x2={x + 5} y2={y - 13.5} stroke={tape} strokeWidth="2.2" />
    </g>
  )
}

/** 后面的村庄名牌抬高一些，免得和广场名牌叠在一起。 */
function villageLift(square: Cell, k: number) {
  const depth = square.cx + square.cy
  return depth < 0 ? 60 + 70 * k : 60
}

type Chip = { text: string; short?: string; dot: string }
type Tone = 'urgent' | 'blocked' | 'busy' | 'calm' | 'plaza'

function plateChips(st: StatusCounts, failed: number): Chip[] {
  return [...statusChips(st), ...(failed ? [{ text: `失败 ${failed}`, short: `失败 ${failed}`, dot: '#7a3a32' }] : [])]
}

/** 按 Agent 看时名牌列各 Agent 的会话数，等你决定仍然保留。 */
function withWaiting(chips: Chip[], st: StatusCounts): Chip[] {
  return st.waiting ? [...chips, ...statusChips({ ...st, working: 0, review: 0, blocked: 0 })] : chips
}

/** 院子描上主 Agent 的颜色。 */
function AgentYard({ d, color }: { d: District; color: string }) {
  return <IsoTile gx={d.ox + 0.15} gy={d.oy + 0.15} w={INNER_W - 0.3} d={INNER_D - 0.3} fill={color} opacity={0.14} className="town-agent-yard" />
}

/** 门口插小旗：每个在场的 Agent 一面，旗上写会话数。 */
function AgentFlags({ gx, gy, counts }: { gx: number; gy: number; counts: ReturnType<typeof agentCounts> }) {
  const present = AGENTS.filter((a) => counts[a.key] > 0)
  return (
    <g aria-hidden>
      {present.map((a, i) => {
        const [x, y] = iso(gx + i * 0.7, gy)
        return (
          <g key={a.key} transform={`translate(${x},${y})`}>
            <line x1="0" y1="0" x2="0" y2="-34" stroke="#6b4a2a" strokeWidth="2" />
            <path d="M0,-34 L22,-29 L0,-22 Z" fill={a.color} stroke="rgba(0,0,0,.25)" />
            <text x="8" y="-25.5" textAnchor="middle" fontSize="8" fontWeight="800" fill="#fff">{counts[a.key]}</text>
          </g>
        )
      })}
    </g>
  )
}

/** 名牌边框：等你决定 > 受阻 > 工作中 > 平常。 */
function toneOf(st: StatusCounts, rest: 'calm' | 'plaza'): Tone {
  return st.waiting ? 'urgent' : st.blocked ? 'blocked' : st.working ? 'busy' : rest
}

const PLATE_FILL: Record<Tone, string> = { urgent: '#fff4c2', blocked: '#fde8e4', busy: '#fffaf0', calm: '#fffaf0', plaza: '#eef0ff' }
const PLATE_EDGE: Record<Tone, string> = { urgent: '#e0a400', blocked: '#d2483d', busy: '#e3a23d', calm: '', plaza: '#5b6cd8' }

/** 远景名牌：游戏里那种头顶名牌，一行写完：项目名 + 状态色点和数字，下面一个小尖角指着建筑。 */
function FarPlate({ at, title, sub, chips, note, tone, accent = '#8a7a63', k = 1 }: { at: Pt; title: string; sub?: string; chips: Chip[]; note: string; tone: Tone; accent?: string; k?: number }) {
  const name = title.length > 22 ? `${title.slice(0, 21)}…` : title
  const words = chips.length ? chips.map((c) => c.short ?? c.text) : [note]
  const widths = words.map((t) => measureText(t, 17) + (chips.length ? 26 : 8))
  const nameW = measureText(name, 22) + (sub ? measureText(sub, 15) + 10 : 0)
  const w = 28 + nameW + 12 + widths.reduce((n, x) => n + x + 6, 0)
  let x = -w / 2 + 28 + nameW + 12
  return (
    <g transform={`translate(${at[0]},${at[1]}) scale(${k})`}>
      <title>{`${title}${sub ? ` · ${sub}` : ''}：${chips.length ? chips.map((c) => c.text).join('，') : note}`}</title>
      <path d="M-7,-2 L0,8 L7,-2 Z" fill={PLATE_EDGE[tone] || accent} />
      <rect x={-w / 2 + 2} y={-36} width={w} height={36} rx="10" fill="rgba(40,25,10,.22)" />
      <rect x={-w / 2} y={-38} width={w} height={36} rx="10" fill={PLATE_FILL[tone]} stroke={PLATE_EDGE[tone] || accent} strokeWidth={tone === 'calm' ? 2 : 3.5} />
      <rect x={-w / 2 + 9} y={-30} width={6} height={20} rx="3" fill={accent} />
      <text x={-w / 2 + 22} y="-13" fontSize="22" fontWeight="800" fill="#3a2a1c">{name}{sub && <tspan dx="8" fontSize="15" fontWeight="600" fill="#7a6a55">{sub}</tspan>}</text>
      {words.map((t, i) => {
        const cw = widths[i], x0 = x
        x += cw + 6
        return chips.length ? (
          <g key={t} transform={`translate(${x0},-32)`}>
            <rect width={cw} height={24} rx="12" fill="#fff" stroke={chips[i].dot} strokeWidth="1.5" />
            <circle cx="12" cy="12" r="5.5" fill={chips[i].dot} />
            <text x={cw / 2 + 8} y="18" textAnchor="middle" fontSize="17" fontWeight="700" fill="#3a2a1c">{t}</text>
          </g>
        ) : <text key={t} x={x0 + 4} y="-14" fontSize="17" fill="#8a7a63">{t}</text>
      })}
    </g>
  )
}

/** 粗略量字宽：中文一个字一格，英文数字半格多一点。 */
function measureText(t: string, size: number) {
  let n = 0
  for (const ch of t) n += /[\u0000-\u00ff]/.test(ch) ? 0.58 : 1
  return n * size
}

/** 项目名牌钉在屋顶正上方。 */
function plateAt(d: District): Pt {
  const t = TIERS[d.tier], p = districtPlot(d)
  return iso(p.gx + t.w / 2, p.gy + t.d / 2, t.shape.h + t.shape.rise + 26)
}

/** 路障：一项工作受阻时立在项目门口，红白条纹，远远就能看见。 */
function Roadblock({ gx, gy }: { gx: number; gy: number }) {
  const [x, y] = iso(gx, gy)
  return (
    <g aria-hidden transform={`translate(${x},${y})`}>
      <ellipse rx="20" ry="6" fill="rgba(40,25,10,.2)" />
      <rect x="-15" y="-20" width="3" height="20" fill="#6b4a2a" />
      <rect x="12" y="-20" width="3" height="20" fill="#6b4a2a" />
      <g transform="skewY(-26)">
        <rect x="-19" y="-24" width="38" height="9" rx="1.5" fill="#fff" stroke="#8a2a22" strokeWidth="1.2" />
        {[0, 1, 2, 3].map((i) => <path key={i} d={`M${-17 + i * 10},-15 l6,-9 h4 l-6,9 z`} fill="#d2483d" />)}
      </g>
      <circle className="town-blink" cx="-13.5" cy="-24" r="3" fill="#ff6a3d" />
    </g>
  )
}

// ---- 舞台：相机、拖动、缩放、小地图、巡游 ----

function attentionOf(d: District, needsYou: (b: BuildingView) => boolean) {
  return needsYou(d.b) || d.b.characters.some((c) => c.status === 'working') || d.b.parcels.some(onReviewDesk) || d.b.items.some((w) => w.status === 'blocked')
}

export function WorldStage(props: Omit<SceneProps, 'world' | 'view' | 'far'> & { kiosk?: boolean; rotateMs?: number; paused?: boolean; focusKey?: string; plan?: WorldPlan }) {
  const { model, needsYou, kiosk = false, rotateMs = 20_000, paused = false, focusKey, plan } = props
  // 走进某栋建筑：显示它的室内；拖动、缩放、巡游都暂停。
  const [inside, setInside] = useState<string | null>(null)
  const [byAgent, setByAgent] = useState(false)
  const [agentFocus, setAgentFocus] = useState<Agent | null>(null)
  const legend = useMemo(() => agentLegend(model.buildings), [model])
  // 收菜：开始时记下这一批熟了的菜，一棵一棵飞过去打开验收卡片；收下或退回后自动去下一棵。
  const [harvest, setHarvest] = useState<{ ids: string[]; index: number } | null>(null)
  const insideB = inside ? model.buildings.find((b) => b.key === inside) ?? null : null
  useEffect(() => {
    if (!inside) return
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setInside(null) }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [inside])
  const sceneSelect = (s: Selection) => { if (s.kind === 'building') { stop(); lastTouch.current = Date.now(); setInside(s.key) } else props.onSelect(s) }
  const world = useMemo(() => worldLayout(model.buildings, needsYou, plan), [model, needsYou, plan])
  const box = useRef<HTMLDivElement>(null)
  const [aspect, setAspect] = useState(1.6)
  const [cam, setCam] = useState<Camera | null>(null)
  const anim = useRef<number | null>(null)
  const lastTouch = useRef(0)
  const drag = useRef<{ x: number; y: number; cam: Camera; moved: boolean; id: number } | null>(null)
  const swallowClick = useRef(false)

  useEffect(() => {
    const el = box.current
    if (!el || typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(() => { const r = el.getBoundingClientRect(); if (r.width > 0 && r.height > 0) setAspect(r.width / r.height) })
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  const fitAll = () => fitCamera(world.bounds, aspect, 1.02)
  const camera = cam ?? fitAll()
  const stop = () => { if (anim.current != null) cancelAnimationFrame(anim.current); anim.current = null }
  const flyTo = (to: Camera, ms = 900) => {
    stop()
    const from = camera, t0 = performance.now()
    const step = (t: number) => {
      const k = Math.min(1, (t - t0) / ms)
      setCam(clampCamera(lerpCamera(from, to, k), world.bounds))
      anim.current = k < 1 ? requestAnimationFrame(step) : null
    }
    anim.current = requestAnimationFrame(step)
  }
  useEffect(() => stop, [])

  // 选中某个会话时飞到它的街区。
  useEffect(() => {
    if (!focusKey) return
    const d = world.districts.find((x) => x.b.characters.some((c) => c.key === focusKey))
    if (d) flyTo(fitCamera(cellBox(d.ox, d.oy), aspect, 1.15))
  }, [focusKey])

  // 桌面模式巡游：全景 → 各个需要注意的街区 → 全景；有人刚操作过、抽屉打开时暂停。
  const stops = useMemo(() => tourStops(world, (d) => attentionOf(d, needsYou), aspect), [world, aspect, needsYou])
  const ripe = useMemo(() => ripeQueue(world.districts.map((d) => d.b)), [world])
  const results = harvest ? harvest.ids.map((id) => harvestResult(id, model.buildings)) : []
  const goHarvest = (ids: string[], index: number) => {
    setHarvest({ ids, index })
    const id = ids[index]
    const d = world.districts.find((x) => x.b.items.some((w) => w.id === id))
    if (!d) return
    lastTouch.current = Date.now()
    // 验收卡片从右边滑出、盖住大半个画面：镜头对准这块菜地，让它落在左边露出来的那一条里。
    const [fx, fy] = iso(d.ox + 7, d.oy + 6.4)
    flyTo(clampCamera({ cx: fx + 1000 * 0.33, cy: fy - 20, w: 1000 }, world.bounds), 900)
    props.onSelect({ kind: 'item', key: id })
  }
  const startHarvest = () => { if (!ripe.length) return; setInside(null); goHarvest(ripe.map((r) => r.item.id), 0) }
  const nextPending = (from: number, step: 1 | -1) => {
    if (!harvest) return -1
    for (let i = from + step; i >= 0 && i < harvest.ids.length; i += step) if (results[i] === 'pending') return i
    return -1
  }
  // 当前这棵收下或退回了：稍等一下，自动去下一棵还没收的。
  const current = harvest ? results[harvest.index] : undefined
  useEffect(() => {
    if (!harvest || current === 'pending') return
    const t = window.setTimeout(() => {
      const n = nextPending(harvest.index, 1)
      if (n >= 0) goHarvest(harvest.ids, n)
    }, 900)
    return () => window.clearTimeout(t)
  }, [harvest?.index, current])
  useEffect(() => {
    if (!harvest) return
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape' && !inside) setHarvest(null) }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [harvest, inside])
  const [stopIndex, setStopIndex] = useState(0)
  const [tick, setTick] = useState(0)
  useEffect(() => {
    if (!kiosk || paused || inside || harvest || stops.length < 2) return
    const t = window.setTimeout(() => {
      // 刚拖过或缩放过：这一轮先不动，过一会儿再试。
      if (Date.now() - lastTouch.current < 30_000) { setTick((n) => n + 1); return }
      const next = (stopIndex + 1) % stops.length
      setStopIndex(next)
      flyTo(stops[next], 1400)
    }, rotateMs)
    return () => window.clearTimeout(t)
  }, [kiosk, paused, inside, harvest, stops, stopIndex, rotateMs, tick])

  // 滚轮缩放：以光标为中心。
  useEffect(() => {
    const el = box.current
    if (!el) return
    const onWheel = (e: WheelEvent) => {
      if (inside) return
      e.preventDefault()
      stop(); lastTouch.current = Date.now()
      const r = el.getBoundingClientRect()
      setCam((c) => clampCamera(zoomAt(c ?? camera, Math.exp(e.deltaY * 0.0015), (e.clientX - r.left) / r.width, (e.clientY - r.top) / r.height, aspect), world.bounds))
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  })

  const onPointerDown = (e: RPointerEvent<HTMLDivElement>) => {
    if (e.button !== 0 || inside) return
    drag.current = { x: e.clientX, y: e.clientY, cam: camera, moved: false, id: e.pointerId }
  }
  const onPointerMove = (e: RPointerEvent<HTMLDivElement>) => {
    const d = drag.current
    if (!d || d.id !== e.pointerId) return
    const dx = e.clientX - d.x, dy = e.clientY - d.y
    if (!d.moved && Math.hypot(dx, dy) < 5) return
    if (!d.moved) { d.moved = true; stop(); box.current?.setPointerCapture(e.pointerId) }
    lastTouch.current = Date.now()
    const r = box.current!.getBoundingClientRect()
    const k = d.cam.w / r.width
    setCam(clampCamera({ cx: d.cam.cx - dx * k, cy: d.cam.cy - dy * k, w: d.cam.w }, world.bounds))
  }
  const onPointerUp = (e: RPointerEvent<HTMLDivElement>) => {
    const d = drag.current
    drag.current = null
    if (d?.moved) { swallowClick.current = true; box.current?.releasePointerCapture(e.pointerId) }
  }
  const zoomBy = (f: number) => { lastTouch.current = Date.now(); flyTo(clampCamera(zoomAt(camera, f, 0.5, 0.5, aspect), world.bounds), 350) }

  const view = viewBoxOf(camera, aspect)
  const far = camera.w > FAR_W
  return (
    <div className="town-world" ref={box} onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={onPointerUp} onPointerCancel={onPointerUp}
      onClickCapture={(e) => { if (swallowClick.current) { swallowClick.current = false; e.stopPropagation(); e.preventDefault() } }}>
      {insideB ? (
        <>
          <InteriorScene b={insideB} model={model} selected={props.selected} highlight={props.highlight} onSelect={props.onSelect} changed={props.changed} offline={props.offline} />
          <div className="town-world-tools is-inside" onPointerDown={(e) => e.stopPropagation()}>
            <button type="button" onClick={() => setInside(null)} title="回到世界（Esc）">← 回到世界</button>
          </div>
          <p className="town-world-hint">{insideB.name} · 室内：工作台是工作项，点任何东西看详情</p>
        </>
      ) : (
        <>
      <WorldScene {...props} onSelect={sceneSelect} world={world} view={view} far={far} agents={byAgent ? { focus: agentFocus } : null} />
      <div className="town-world-tools" onPointerDown={(e) => e.stopPropagation()}>
        <button type="button" onClick={() => zoomBy(0.7)} aria-label="放大" title="放大（也可以滚动滚轮）">＋</button>
        <button type="button" onClick={() => zoomBy(1.4)} aria-label="缩小" title="缩小">－</button>
        <button type="button" onClick={() => { lastTouch.current = Date.now(); flyTo(fitAll()) }} title="看全部街区">全景</button>
        <button type="button" onClick={() => { lastTouch.current = Date.now(); flyTo(fitCamera(cellBox(world.plaza.ox, world.plaza.oy), aspect, 1.1)) }} title="回到中央广场">广场</button>
        <button type="button" className={`town-basket${ripe.length ? ' has-ripe' : ''}`} onClick={startHarvest} disabled={!ripe.length && !harvest}
          title={ripe.length ? `熟了 ${ripe.length} 棵：一棵一棵打开验收卡片，收下或退回` : '现在没有熟了的菜（没有待验收的工作项）'}>收菜 {ripe.length}</button>
        <button type="button" aria-pressed={byAgent} className={byAgent ? 'is-on' : undefined} onClick={() => { setByAgent(!byAgent); setAgentFocus(null) }} title="按会话来自哪个 Agent 着色">按 Agent 看</button>
      </div>
      {byAgent && (
        <div className="town-agent-legend" role="group" aria-label="按 Agent 筛选" onPointerDown={(e) => e.stopPropagation()}>
          <button type="button" aria-pressed={agentFocus == null} onClick={() => setAgentFocus(null)}>全部</button>
          {legend.map((a) => (
            <button key={a.key} type="button" aria-pressed={agentFocus === a.key} disabled={a.sessions === 0}
              onClick={() => setAgentFocus(agentFocus === a.key ? null : a.key)}>
              <i style={{ background: a.color }} />{a.label}<small>{a.sessions} 个会话 · {a.projects} 个项目</small>
            </button>
          ))}
        </div>
      )}
      <MiniMap world={world} view={view} needsYou={needsYou} pending={model.pendingApprovals} onJump={(p) => { lastTouch.current = Date.now(); flyTo(clampCamera({ cx: p[0], cy: p[1], w: Math.min(camera.w, 1500) }, world.bounds), 600) }} />
      <p className="town-world-hint">拖动地图移动 · 滚轮缩放 · 拉远看全部项目</p>
      {harvest && <HarvestBar ids={harvest.ids} index={harvest.index} results={results} model={model}
        onPrev={() => { const n = nextPending(harvest.index, -1); if (n >= 0) goHarvest(harvest.ids, n) }}
        onNext={() => { const n = nextPending(harvest.index, 1); if (n >= 0) goHarvest(harvest.ids, n) }}
        onReopen={() => goHarvest(harvest.ids, harvest.index)} onEnd={() => setHarvest(null)} />}
        </>
      )}
    </div>
  )
}

/** 收菜进度条：第几棵、这棵是什么、已收几棵、退回几棵。收下 / 退回的按钮在验收卡片里。 */
function HarvestBar({ ids, index, results, model, onPrev, onNext, onReopen, onEnd }: {
  ids: string[]; index: number; results: ReturnType<typeof harvestResult>[]; model: TownModel; onPrev: () => void; onNext: () => void; onReopen: () => void; onEnd: () => void
}) {
  const item = model.buildings.flatMap((b) => b.items).find((w) => w.id === ids[index])
  const harvested = results.filter((r) => r === 'harvested').length
  const returned = results.filter((r) => r === 'returned').length
  const left = results.filter((r) => r === 'pending').length
  const now = results[index]
  return (
    <div className="town-harvest-bar" role="region" aria-label="收菜" onPointerDown={(e) => e.stopPropagation()}>
      <p className="town-harvest-title">
        <strong>收菜 {index + 1}/{ids.length}</strong>
        <span>已收 {harvested} · 退回 {returned} · 还剩 {left}</span>
      </p>
      {left === 0 ? <p className="town-harvest-now">这一批都看完了。收下的进了粮仓，退回的重新种下，Agent 会接着改。</p>
        : <p className="town-harvest-now">{now === 'harvested' ? '收下了 ✓ ' : now === 'returned' ? '退回重种 ↺ ' : ''}<code>{ids[index]}</code> {item?.title ?? '这项已不在地里'}</p>}
      <p className="town-harvest-hint">右边的验收卡片里看交付说明，点“验收通过”收下，“退回修改”重新种。</p>
      <div className="town-harvest-actions">
        <button type="button" onClick={onPrev}>上一棵</button>
        <button type="button" onClick={onReopen}>重新打开卡片</button>
        <button type="button" onClick={onNext}>跳过，下一棵</button>
        <button type="button" onClick={onEnd}>结束收菜</button>
      </div>
    </div>
  )
}

function MiniMap({ world, view, needsYou, pending, onJump }: { world: WorldLayout; view: Box; needsYou: (b: BuildingView) => boolean; pending: TownModel['pendingApprovals']; onJump: (p: Pt) => void }) {
  const b = world.bounds, t = world.tiles
  const diamond = (ox: number, oy: number) => [iso(ox, oy), iso(ox + INNER_W, oy), iso(ox + INNER_W, oy + INNER_D), iso(ox, oy + INNER_D)].map((p) => p.join(',')).join(' ')
  return (
    <svg className="town-minimap" viewBox={`${b.x} ${b.y} ${b.w} ${b.h}`} aria-label="小地图：点一下跳过去"
      onPointerDown={(e) => e.stopPropagation()}
      onClick={(e) => {
        const r = (e.currentTarget as SVGSVGElement).getBoundingClientRect()
        const s = Math.min(r.width / b.w, r.height / b.h)
        const ox = (r.width - b.w * s) / 2, oy = (r.height - b.h * s) / 2
        onJump([b.x + (e.clientX - r.left - ox) / s, b.y + (e.clientY - r.top - oy) / s])
      }}>
      <polygon points={[iso(t.gx0, t.gy0), iso(t.gx1, t.gy0), iso(t.gx1, t.gy1), iso(t.gx0, t.gy1)].map((p) => p.join(',')).join(' ')} fill="#d7e2bf" />
      <polygon points={diamond(world.plaza.ox, world.plaza.oy)} fill="#5b6cd8" opacity="0.8" />
      {world.districts.map((d) => (
        <polygon key={d.key} points={diamond(d.ox, d.oy)} fill={needsYou(d.b) ? '#e0a400' : buildingColors(d.b.repo?.id).roof} opacity="0.9"
          stroke={statusOf(d.b, pending).blocked ? '#d2483d' : 'none'} strokeWidth={b.w / 70} />
      ))}
      <rect x={view.x} y={view.y} width={view.w} height={view.h} fill="none" stroke="#2d6cdf" strokeWidth={b.w / 90} />
    </svg>
  )
}
