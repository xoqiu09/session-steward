// 展示用的小镇舞台：复用世界地图的画法（WorldScene），但镜头固定为整村全景，
// 不巡游、不跟随、不响应指针；布局记忆只放在内存里，不读写浏览器存储。
import { useEffect, useMemo, useRef, useState } from 'react'
import type { Snapshot } from '../types'
import type { TownModel } from '../town/townModel'
import { WorldScene } from '../town/WorldScene'
import { planWorld } from '../town/clusters'
import { iso } from '../town/iso'
import { INNER_D, INNER_W, areaBox, fitCamera, newWorldMemo, stableLayout, viewBoxOf, type Box, type WorldLayout, type WorldMemo } from '../town/world'
import type { LiveEvent } from './events'

const noop = () => {}
const nobody = () => false

/** 把气泡钉在对应项目建筑上方；找不到建筑时为 null（由外层放到地图上方）。 */
export function bubbleAnchor(world: ReturnType<typeof stableLayout>, view: { x: number; y: number; w: number; h: number }, repoId: number | null): { left: number; top: number } | null {
  if (repoId == null) return null
  const d = world.districts.find((x) => x.b.repo?.id === repoId)
  if (!d) return null
  const [x, y] = iso(d.ox + INNER_W / 2, d.oy + INNER_D / 2, 150)
  const clamp = (v: number) => Math.min(88, Math.max(12, v))
  return { left: clamp(((x - view.x) / view.w) * 100), top: clamp(((y - view.y) / view.h) * 100) }
}

/** 取景框：所有项目建筑加中央广场，上方再留出放大后的招牌位置；不框空草地和湖。项目多时整体缩小，不裁建筑。 */
export function liveFrame(world: WorldLayout): Box {
  const box = areaBox([{ cx: 0, cy: 0 }, ...world.districts.map((d) => d.cell)])
  const head = 90 + box.h * 0.06
  return { x: box.x, y: box.y - head, w: box.w, h: box.h + head }
}

export function LiveStage({ model, snap, bubble, initialAspect = 1.2 }: { model: TownModel; snap: Snapshot; bubble: LiveEvent | null; initialAspect?: number }) {
  const memo = useRef<WorldMemo | null>(null)
  memo.current ??= newWorldMemo()
  const box = useRef<HTMLDivElement>(null)
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
  const plan = useMemo(() => planWorld(model.buildings.filter((b) => b.repo).map((b) => b.repo!), snap, Date.parse(snap.now) || Date.now()), [model, snap])
  // 稳定键用建筑键（repo-编号）：展示快照的项目编号与正常面板一致，但位置只记在这一页的内存里。
  const world = useMemo(() => stableLayout(model.buildings, nobody, plan, memo.current!, (b) => b.key, false), [model, plan])
  const camera = fitCamera(liveFrame(world), aspect, 1.06)
  const view = viewBoxOf(camera, aspect)
  const anchor = bubble ? bubbleAnchor(world, view, bubble.repoId) : null
  return (
    <div className="live-stage" ref={box}>
      <div className="live-stage-scene" inert aria-hidden="true">
        <WorldScene model={model} world={world} view={view} far={false} selected={null} highlight={null} onSelect={noop} needsYou={nobody} live />
      </div>
      {bubble && (
        <div key={bubble.key} className={`live-bubble${anchor ? '' : ' is-top'}`} role="status" style={anchor ? { left: `${anchor.left}%`, top: `${anchor.top}%` } : undefined}>
          {bubble.text}
        </div>
      )}
    </div>
  )
}
