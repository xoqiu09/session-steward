// 展示用的小镇舞台：复用世界地图的画法（WorldScene），但房子按展示布局紧凑重排（见 layout.ts），
// 镜头固定框住这些房子和名牌；不巡游、不跟随、不响应指针；排布顺序只放在内存里，不读写浏览器存储。
import { memo, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { Snapshot } from '../types'
import type { BuildingView, TownModel } from '../town/townModel'
import { WorldScene } from '../town/WorldScene'
import { useTownArt } from '../town/appearance'
import { planWorld } from '../town/clusters'
import { iso } from '../town/iso'
import { INNER_D, INNER_W, fitCamera, type Box, type WorldLayout } from '../town/world'
import { LIVE_MAX, LIVE_SIGN_K, liveOrder, liveWorld } from './layout'
import type { LiveEvent } from './events'
import { createResidentStore } from '../town/residentLife'
import { residentWorld } from '../town/residentTrips'
import { createReadingTour, type ReadingLink } from './readingTour'
import { topicHouseKey } from './topics'
import { ReadingStatus } from './ReadingStatus'
import './readingTour.css'

const noop = () => {}
const nobody = () => false

/** 把气泡钉在对应项目建筑上方；找不到建筑时为 null（由外层放到地图上方）。 */
export function bubbleAnchor(world: WorldLayout, view: { x: number; y: number; w: number; h: number }, repoId: number | null): { left: number; top: number } | null {
  if (repoId == null) return null
  const d = world.districts.find((x) => x.b.repo?.id === repoId)
  if (!d) return null
  const [x, y] = iso(d.ox + INNER_W / 2, d.oy + INNER_D / 2, 150)
  const clamp = (v: number) => Math.min(88, Math.max(12, v))
  return { left: clamp(((x - view.x) / view.w) * 100), top: clamp(((y - view.y) / view.h) * 100) }
}

/** 画面上被说明卡、图例盖住的上下比例（横屏时卡片浮在地图上）。房子只排在中间那一段。 */
export interface LiveReserve { top: number; bottom: number }
const NO_RESERVE: LiveReserve = { top: 0, bottom: 0 }

/** 镜头：把取景框完整放进可用区域（扣掉上下被盖住的部分），返回整个画面的视野。 */
export function liveView(frame: Box, aspect: number, reserve: LiveReserve = NO_RESERVE): Box {
  const free = Math.max(0.3, 1 - reserve.top - reserve.bottom)
  const usable = aspect / free
  const cam = fitCamera(frame, usable, 1.06)
  const h = cam.w / aspect
  return { x: cam.cx - cam.w / 2, y: cam.cy - (h * free) / 2 - reserve.top * h, w: cam.w, h }
}

/** 要画的房子：只画有项目的；超过上限时按快照里的项目顺序（服务端已按最近活跃排好）取前面的。 */
export function liveBuildings(model: TownModel, snap: Snapshot, limit = LIVE_MAX): BuildingView[] {
  const pos = new Map((snap.repos ?? []).map((r, i) => [r.id, i]))
  const list = model.buildings.filter((b) => b.repo)
  return list.length <= limit ? list
    : list.slice().sort((a, b) => (pos.get(a.repo!.id) ?? 1e9) - (pos.get(b.repo!.id) ?? 1e9) || a.repo!.id - b.repo!.id).slice(0, limit)
}

const memoryOnly = { getItem: () => null, setItem: () => {} }
export const LiveStage = memo(function LiveStage({ model, snap, bubble, initialAspect = 1.2, reserve = NO_RESERVE, residents = false, maxBuildings, signScale = LIVE_SIGN_K, reading = null }: { model: TownModel; snap: Snapshot; bubble: LiveEvent | null; initialAspect?: number; reserve?: LiveReserve; residents?: boolean; maxBuildings?: number; signScale?: number; reading?: ReadingLink | null }) {
  const limit = maxBuildings ?? (residents ? 8 : LIVE_MAX)
  // 排布顺序只记在这一页的内存里：同一批项目刷新后位置不变，有项目进出时其他房子尽量不动。
  const order = useRef<string[]>([])
  const instance = useId()
  const box = useRef<HTMLDivElement>(null)
  const scene = useRef<SVGSVGElement>(null)
  const [tour] = useState(createReadingTour)
  const [residentStore] = useState(() => createResidentStore(memoryOnly, Date.now(), tour.advance))
  const bubbleBox = useRef<HTMLDivElement>(null)
  const [bubblePosition, setBubblePosition] = useState<{ left: number; top: number } | null>(null)
  const [aspect, setAspect] = useState(initialAspect)
  useEffect(() => {
    const el = box.current
    if (!el || typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(() => {
      const r = el.getBoundingClientRect()
      if (r.width > 0 && r.height > 0) setAspect(r.width / r.height)
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, [])
  const buildings = useMemo(() => {
    const list = liveBuildings(model, snap, limit)
    const byKey = new Map(list.map((b) => [b.key, b]))
    order.current = liveOrder(order.current, list.map((b) => b.key), (k) => byKey.get(k)!.repo!.id)
    return order.current.map((k) => byKey.get(k)!)
  }, [model, snap, limit])
  const plan = useMemo(() => planWorld(buildings.map((b) => b.repo!), snap, Date.parse(snap.now) || Date.now()), [buildings, snap])
  const { theme } = useTownArt()
  const free = Math.max(0.3, 1 - reserve.top - reserve.bottom)
  const live = useMemo(() => liveWorld(buildings, plan, aspect / free, theme, residents, { limit, signScale }), [buildings, plan, aspect, free, theme, residents, limit, signScale])
  const residentMap = useMemo(() => residents ? residentWorld(live.world) : undefined, [residents, live.world])
  useEffect(() => { residentStore.setWorld(residentMap) }, [residentStore, residentMap])
  useEffect(() => { tour.setReading(residents ? reading : null) }, [tour, residents, reading])
  useEffect(() => {
    if (!residents) return
    // OBS can mark a browser source hidden. Keep this memory-only visual clock running there too.
    residentStore.resetClock(Date.now())
    const timer = window.setInterval(() => residentStore.tick(Date.now()), 500)
    return () => window.clearInterval(timer)
  }, [residentStore, residents])
  const view = liveView(live.frame, aspect, reserve)
  const readingKey = reading ? topicHouseKey(reading.topic) : undefined
  const destination = residentMap?.destinations.find(d => d.id === readingKey)
  const door = destination ? iso(destination.door.x, destination.door.y + 0.25) : null
  const anchor = bubble ? bubbleAnchor(live.world, view, bubble.repoId) : null
  useLayoutEffect(() => {
    const el = box.current, message = bubbleBox.current
    if (!el || !message || !bubble) { setBubblePosition(null); return }
    const measure = () => {
      const w = el.clientWidth, h = el.clientHeight
      const margin = Math.max(12, w * 0.025)
      const half = message.offsetWidth / 2
      const left = Math.max(margin + half, Math.min(w - margin - half, w * (anchor?.left ?? 50) / 100))
      const top = Math.max(message.offsetHeight + margin, Math.min(h - margin, h * (anchor?.top ?? 18) / 100))
      setBubblePosition({ left, top })
    }
    measure()
    if (typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(measure); ro.observe(el); ro.observe(message)
    return () => ro.disconnect()
  }, [bubble?.key, anchor?.left, anchor?.top])
  return (
    <div className="live-stage live-topic-stage" ref={box} data-stage-instance={instance} data-reading-topic={reading?.topic} data-reading-resident={reading?.resident}>
      <div className="live-stage-scene" inert aria-hidden="true">
        <WorldScene model={model} world={live.world} view={view} far={false} selected={null} highlight={null} onSelect={noop} needsYou={nobody} live liveDress={{ ...live.dress, readingKey }} sceneRef={scene} residents={residents ? { store: residentStore, active: true, selected: null, onSelect: noop, readOnly: true } : undefined} />
      </div>
      <div className="live-lights" aria-hidden="true">{live.world.districts.filter(d => d.key === readingKey || d.b.characters.some(c => c.status === 'working')).map(d => {
        const [x, y] = iso(d.ox + INNER_W / 2, d.oy + INNER_D / 2)
        return <i key={d.key} style={{ left: `${(x - view.x) / view.w * 100}%`, top: `${(y - view.y) / view.h * 100}%` }} />
      })}</div>
      {reading && <ReadingStatus store={residentStore} reading={reading} door={door ? { left: `${(door[0] - view.x) / view.w * 100}%`, top: `${(door[1] - view.y) / view.h * 100}%`, width: `${140 / view.w * 100}%` } : undefined} />}
      {bubble && (
        <div ref={bubbleBox} key={bubble.key} className="live-bubble" role="status" style={bubblePosition ? { left: bubblePosition.left, top: bubblePosition.top } : { left: `${anchor?.left ?? 50}%`, top: `${anchor?.top ?? 18}%` }}>
          {bubble.text}
        </div>
      )}
    </div>
  )
})
