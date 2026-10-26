// 小镇世界：每个项目一个街区，中间是广场。远景只画街区名牌和计数，近景画小人、包裹和任务。只读。
import { useEffect, useMemo, useRef, useState, type PointerEvent as RPointerEvent } from 'react'
import { IsoBox, IsoTile, iso, type Pt } from './iso'
import { MAX_SEATS, characterStatusLabel, type BuildingView, type Highlight, type ParcelView, type TownModel } from './townModel'
import {
  Building, Character, DecisionBoard, Desk, FailRack, Parcel, Path, ReviewDesk, StatusPill, Tag, Tree,
  activate, buildingColors, charLook, charMatches, onReviewDesk, parcelMatches, parcelTitle, slot, yard,
  type Plot, type Selection,
} from './TownScene'
import {
  CELL_D, CELL_W, FAR_W, INNER_D, INNER_W, cellBox, clampCamera, fitCamera, lerpCamera, tourStops, viewBoxOf, worldLayout, zoomAt,
  type Box, type Camera, type District, type WorldLayout,
} from './world'

/** 每个街区的待验收架、退件筐最多摆几个箱子，其余只计数。 */
const SHELF_MAX = 3
const BIN_MAX = 2
/** 告示栏最多钉几张卡片。 */
const BOARD_MAX = 4

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
}

function districtPlot(d: District): Plot {
  return { gx: d.ox + 1, gy: d.oy + 0.6, w: 4.3, d: 2.8, facing: 'x', ...buildingColors(d.b.repo?.id) }
}

export function WorldScene({ model, world, view, far, selected, highlight, onSelect, changed = new Set(), offline = false, needsYou }: SceneProps) {
  const isSel = (kind: Selection['kind'], key: string) => selected?.kind === kind && selected.key === key
  const dim = (match: boolean) => (highlight && !match ? ' is-dim' : '')
  const flash = (key: string) => (changed.has(key) ? ' is-changed' : '')
  const { gx0, gy0, gx1, gy1 } = world.tiles

  // 道路：每个街区右侧和前方各一条，贯穿整个世界。
  const cxs = new Set<number>(), cys = new Set<number>()
  for (let gx = gx0; gx < gx1; gx += CELL_W) cxs.add(Math.floor(gx / CELL_W))
  for (let gy = gy0; gy < gy1; gy += CELL_D) cys.add(Math.floor(gy / CELL_D))
  const used = new Set(['0,0', ...world.districts.map((d) => `${d.cell.cx},${d.cell.cy}`)])
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
    d.b.parcels.filter(onReviewDesk).slice(0, SHELF_MAX).forEach((p, i) => {
      parcels.push({ p, at: iso(d.ox + 6.6 + i * 0.6, d.oy + 4.75, 12), stale: false, moving: false })
    })
    d.b.parcels.filter((p) => p.phase === 'failed').slice(0, BIN_MAX).forEach((p, i) => {
      parcels.push({ p, at: iso(d.ox + 6.95 + i * 0.5, d.oy + 6.6, 9), stale: false, moving: false })
    })
    seatsOf.set(d.key, mine)
    slotsOf.set(d.key, parcels.sort((a, b) => a.p.run.id - b.p.run.id))
    seats.push(...mine)
  }
  const depthOrder = [{ key: '__plaza', depth: 0, cx: 0 }, ...world.districts.map((d) => ({ key: d.key, depth: d.cell.cx + d.cell.cy, cx: d.cell.cx }))]
    .sort((a, b) => a.depth - b.depth || a.cx - b.cx)
  const byKey = new Map(world.districts.map((d) => [d.key, d]))

  const allParcels = model.buildings.flatMap((b) => b.parcels)
  const reviewTotal = allParcels.filter(onReviewDesk).length
  const failedTotal = allParcels.filter((p) => p.phase === 'failed').length
  const boardModel = { ...model, pendingApprovals: model.pendingApprovals.slice(0, BOARD_MAX) }
  const boardAt = iso(6.0, 8.0)
  const P = world.plaza

  return (
    <svg className={`town-svg is-world${far ? ' is-far' : ''}${offline ? ' is-offline' : ''}`} viewBox={`${view.x} ${view.y} ${view.w} ${view.h}`}
      role="group" aria-label="工作小镇世界">
      <defs>
        <pattern id="world-grass" width="60" height="30" patternUnits="userSpaceOnUse">
          <path d="M0 15 L30 0 L60 15 L30 30 Z" fill="none" stroke="#b9cba0" strokeWidth="0.8" />
        </pattern>
      </defs>

      {/* 大地与道路 */}
      <IsoBox gx={gx0} gy={gy0} w={gx1 - gx0} d={gy1 - gy0} h={26} z={-26} top="#d7e2bf" left="#b48a5e" right="#946c48" />
      <IsoTile gx={gx0} gy={gy0} w={gx1 - gx0} d={gy1 - gy0} fill="url(#world-grass)" />
      {[...cxs].map((cx) => <IsoTile key={`rx${cx}`} gx={cx * CELL_W + INNER_W + 0.3} gy={gy0} w={CELL_W - INNER_W - 0.6} d={gy1 - gy0} fill="#e6d9bd" />)}
      {[...cys].map((cy) => <IsoTile key={`ry${cy}`} gx={gx0} gy={cy * CELL_D + INNER_D + 0.3} w={gx1 - gx0} d={CELL_D - INNER_D - 0.6} fill="#e6d9bd" />)}

      {/* 空地：树林 */}
      {empty.map(({ ox, oy }) => {
        const h = hash(`${ox},${oy}`)
        return [0, 1, 2, 3].map((i) => {
          const gx = ox + 1.2 + ((h >> (i * 3)) % 7), gy = oy + 1.2 + ((h >> (i * 4 + 1)) % 6)
          return <Tree key={`t${ox},${oy},${i}`} at={iso(gx, gy)} k={0.8 + ((h >> i) % 4) * 0.12} />
        })
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
        const review = d.b.parcels.filter(onReviewDesk).length
        const failed = d.b.parcels.filter((p) => p.phase === 'failed').length
        const h = hash(d.key)
        return (
          <g key={d.key}>
            <Path from={[d.ox + 3.15, d.oy + 3.4]} to={[d.ox + 3.15, d.oy + INNER_D + 0.6]} />
            <Tree at={iso(d.ox + 7.9, d.oy + 1.1)} k={0.8 + (h % 3) * 0.1} />
            <Building plot={plot} b={d.b} selected={isSel('building', d.b.key)} dimClass={dim(false)} onSelect={() => onSelect({ kind: 'building', key: d.b.key })} />
            {review > 0 && (
              <g className={`town-shelf${dim(highlight === 'review')}`}>
                <IsoBox gx={d.ox + 6.2} gy={d.oy + 4.3} w={2.1} d={0.95} h={12} top="#e8d2a8" left="#b98a52" right="#9c7140" />
                <Tag at={iso(d.ox + 7.25, d.oy + 4.8, 52)} text={`待验收 ${review}${review > SHELF_MAX ? ` · 摆了 ${SHELF_MAX}` : ''}`} bg="#eef0ff" fg="#2f3a8f" small border="#5b6cd8" />
              </g>
            )}
            {failed > 0 && (
              <g className={dim(highlight === 'failed')}>
                <IsoBox gx={d.ox + 6.5} gy={d.oy + 6.2} w={1.3} d={0.9} h={9} top="#7a3a32" left="#a5483e" right="#8a3c33" />
                <Tag at={iso(d.ox + 7.15, d.oy + 6.65, 40)} text={`失败 ${failed}`} bg="#d2483d" fg="#fff" small />
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
                dimClass={dim(highlight ? charMatches(c, highlight) : true) + flash(c.key)} onSelect={() => onSelect({ kind: 'character', key: c.key })} />
            ))}
            <Tree at={iso(d.ox + 0.4, d.oy + 7.4)} k={0.7 + ((h >> 3) % 3) * 0.1} />
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
              className={`town-obj town-move${dim(highlight ? charMatches(c, highlight) : true)}`} aria-hidden onClick={() => onSelect({ kind: 'character', key: c.key })}>
              <StatusPill at={[0, 17]} name={c.name} status={offline && c.status === 'working' ? `断线前·${label}` : label} bg={st.bg} fg={st.fg} edge={style.body} />
            </g>
          )
        })}
      </g>

      {/* 远景名牌：拉远时代替招牌、小人和包裹 */}
      <g className="town-far">
        <FarPlate at={iso(P.ox + INNER_W / 2, P.oy + INNER_D / 2, 120)} title="中央广场" tone="plaza"
          parts={[`等你决定 ${model.pendingApprovals.length}`, `待验收 ${reviewTotal}`, `失败 ${failedTotal}`]} />
        {world.districts.map((d) => {
          const working = d.b.characters.filter((c) => c.status === 'working').length
          const review = d.b.parcels.filter(onReviewDesk).length
          const failed = d.b.parcels.filter((p) => p.phase === 'failed').length
          const open = d.b.items.filter((w) => w.status !== 'done' && w.status !== 'abandoned').length
          const parts = [working ? `工作中 ${working}` : `${d.b.characters.length} 个会话`, review ? `待验收 ${review}` : `${open} 项未完成`, ...(failed ? [`失败 ${failed}`] : [])]
          return (
            <g key={`far-${d.key}`} className="town-obj" {...activate(() => onSelect({ kind: 'building', key: d.b.key }))} aria-label={`${d.b.name}：${parts.join('，')}`}>
              <FarPlate at={iso(d.ox + 3.15, d.oy + 2.0, 150)} title={d.b.name} tone={needsYou(d.b) ? 'urgent' : working ? 'busy' : 'calm'} parts={parts} accent={buildingColors(d.b.repo?.id).accent} />
            </g>
          )
        })}
      </g>
    </svg>
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

function FarPlate({ at, title, parts, tone, accent = '#8a7a63' }: { at: Pt; title: string; parts: string[]; tone: 'urgent' | 'busy' | 'calm' | 'plaza'; accent?: string }) {
  const name = title.length > 16 ? `${title.slice(0, 15)}…` : title
  const line = parts.join(' · ')
  const w = Math.max(name.length * 26 * 0.7 + 60, line.length * 15 + 40)
  const fill = tone === 'urgent' ? '#fff4c2' : tone === 'plaza' ? '#eef0ff' : '#fffaf0'
  const border = tone === 'urgent' ? '#e0a400' : tone === 'plaza' ? '#5b6cd8' : tone === 'busy' ? '#e3a23d' : accent
  return (
    <g transform={`translate(${at[0]},${at[1]})`}>
      <rect x={-w / 2} y={-44} width={w} height={84} rx="16" fill={fill} stroke={border} strokeWidth={tone === 'calm' ? 3 : 6} />
      <text y="-4" textAnchor="middle" fontSize="34" fontWeight="800" fill="#3a2a1c">{name}</text>
      <text y="28" textAnchor="middle" fontSize="22" fill="#6b5a44">{line}</text>
    </g>
  )
}

// ---- 舞台：相机、拖动、缩放、小地图、巡游 ----

function attentionOf(d: District, needsYou: (b: BuildingView) => boolean) {
  return needsYou(d.b) || d.b.characters.some((c) => c.status === 'working') || d.b.parcels.some(onReviewDesk)
}

export function WorldStage(props: Omit<SceneProps, 'world' | 'view' | 'far'> & { kiosk?: boolean; rotateMs?: number; paused?: boolean; focusKey?: string }) {
  const { model, needsYou, kiosk = false, rotateMs = 20_000, paused = false, focusKey } = props
  const world = useMemo(() => worldLayout(model.buildings, needsYou), [model, needsYou])
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
  const [stopIndex, setStopIndex] = useState(0)
  const [tick, setTick] = useState(0)
  useEffect(() => {
    if (!kiosk || paused || stops.length < 2) return
    const t = window.setTimeout(() => {
      // 刚拖过或缩放过：这一轮先不动，过一会儿再试。
      if (Date.now() - lastTouch.current < 30_000) { setTick((n) => n + 1); return }
      const next = (stopIndex + 1) % stops.length
      setStopIndex(next)
      flyTo(stops[next], 1400)
    }, rotateMs)
    return () => window.clearTimeout(t)
  }, [kiosk, paused, stops, stopIndex, rotateMs, tick])

  // 滚轮缩放：以光标为中心。
  useEffect(() => {
    const el = box.current
    if (!el) return
    const onWheel = (e: WheelEvent) => {
      e.preventDefault()
      stop(); lastTouch.current = Date.now()
      const r = el.getBoundingClientRect()
      setCam((c) => clampCamera(zoomAt(c ?? camera, Math.exp(e.deltaY * 0.0015), (e.clientX - r.left) / r.width, (e.clientY - r.top) / r.height, aspect), world.bounds))
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  })

  const onPointerDown = (e: RPointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return
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
      <WorldScene {...props} world={world} view={view} far={far} />
      <div className="town-world-tools" onPointerDown={(e) => e.stopPropagation()}>
        <button type="button" onClick={() => zoomBy(0.7)} aria-label="放大" title="放大（也可以滚动滚轮）">＋</button>
        <button type="button" onClick={() => zoomBy(1.4)} aria-label="缩小" title="缩小">－</button>
        <button type="button" onClick={() => { lastTouch.current = Date.now(); flyTo(fitAll()) }} title="看全部街区">全景</button>
        <button type="button" onClick={() => { lastTouch.current = Date.now(); flyTo(fitCamera(cellBox(world.plaza.ox, world.plaza.oy), aspect, 1.1)) }} title="回到中央广场">广场</button>
      </div>
      <MiniMap world={world} view={view} needsYou={needsYou} onJump={(p) => { lastTouch.current = Date.now(); flyTo(clampCamera({ cx: p[0], cy: p[1], w: Math.min(camera.w, 1500) }, world.bounds), 600) }} />
      <p className="town-world-hint">拖动地图移动 · 滚轮缩放 · 拉远看全部项目</p>
    </div>
  )
}

function MiniMap({ world, view, needsYou, onJump }: { world: WorldLayout; view: Box; needsYou: (b: BuildingView) => boolean; onJump: (p: Pt) => void }) {
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
        <polygon key={d.key} points={diamond(d.ox, d.oy)} fill={needsYou(d.b) ? '#e0a400' : buildingColors(d.b.repo?.id).roof} opacity="0.9" />
      ))}
      <rect x={view.x} y={view.y} width={view.w} height={view.h} fill="none" stroke="#2d6cdf" strokeWidth={b.w / 90} />
    </svg>
  )
}
