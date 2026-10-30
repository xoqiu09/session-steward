import { recentSignal } from '../signals'
// 微缩工作室：一张桌面上的等距小镇。建筑=项目，角色=会话，包裹=单次运行。只读，不提供批准/验收入口。
import type { KeyboardEvent, ReactNode } from 'react'
import { HipRoof, IsoBox, IsoTile, iso, pts, type Pt } from './iso'
import { MAX_SEATS, characterStatusLabel, clip, itemStatusLabel, parcelPhaseLabel, type BuildingView, type CharacterView, type Highlight, type ParcelView, type TownModel } from './townModel'
import type { WorkItem } from '../types'
import { attentionManaged } from '../workManagement'
import { shownNo } from '../hub/ids'

export type Selection =
  | { kind: 'building'; key: string }
  | { kind: 'character'; key: string }
  | { kind: 'parcel'; key: string }
  | { kind: 'approval'; key: string }
  | { kind: 'review-desk'; key: 'review-desk' }
  | { kind: 'item'; key: string }

interface SceneProps {
  model: TownModel
  selected: Selection | null
  highlight: Highlight | null
  onSelect: (s: Selection) => void
  /** 本次快照里状态刚变化的对象 key，用来闪一下。 */
  changed?: ReadonlySet<string>
  /** 断线中：画面是最后一版快照，状态前加“断线前”。 */
  offline?: boolean
  /** 本页要画的建筑（分页后）；不传时画前几栋，其余提示去列表视图。 */
  buildings?: BuildingView[]
  /** wide：桌面横向一屏三栋；portrait：手机竖屏一栋，标签放大。 */
  layout?: LayoutName
}

/** 招牌最多显示的字符数，全名在 aria-label 里。 */
export const SIGN_MAX = 18

export interface Plot {
  gx: number; gy: number; w: number; d: number
  /** 'x'：门朝左下，院子在 +y；'y'：门朝右下，院子在 +x。 */
  facing: 'x' | 'y'
  roof: string; roofSide: string; accent: string
}

export type LayoutName = 'wide' | 'portrait'

export interface Layout {
  plots: Plot[]
  ground: { gx: number; gy: number; w: number; d: number }
  shadow: { cx: number; cy: number; rx: number; ry: number }
  paths: [[number, number], [number, number]][]
  plaza: { gx: number; gy: number; w: number; d: number }
  plazaLabel: [number, number] | null
  trees: [number, number, number][]
  failRack: { gx: number; gy: number }
  reviewDesk: { gx: number; gy: number }
  /** 告示栏：bottom 以底边中点定位，top 以顶边中点定位（高度随卡片数变）。 */
  board: { x: number; y: number; anchor: 'bottom' | 'top'; scale: number }
  /** 角色下方状态牌与建筑招牌的放大倍数。 */
  pillScale: number
  signScale: number
  overflowAt: Pt
  viewBox: (boardH: number) => string
}

const PALETTE = [
  { roof: '#c8674a', roofSide: '#a6503a', accent: '#c8674a' },
  { roof: '#3f8f8a', roofSide: '#2f6f6b', accent: '#3f8f8a' },
  { roof: '#6b6fb8', roofSide: '#53579a', accent: '#6b6fb8' },
  { roof: '#c99a3a', roofSide: '#a57c2a', accent: '#c99a3a' },
  { roof: '#5f8f4e', roofSide: '#4a7240', accent: '#5f8f4e' },
  { roof: '#a65a7e', roofSide: '#864665', accent: '#a65a7e' },
]
const UNASSIGNED = { roof: '#9a8f80', roofSide: '#7c7366', accent: '#9a8f80' }

/** 建筑颜色按项目固定（repo.id 取模），翻页、换位置、切换桌面模式都不变；相邻编号的项目颜色不同。 */
export function buildingColors(repoId: number | null | undefined): { roof: string; roofSide: string; accent: string } {
  if (repoId == null) return UNASSIGNED
  return PALETTE[((repoId % PALETTE.length) + PALETTE.length) % PALETTE.length]
}

const PLOTS: Plot[] = [
  { gx: 0.8, gy: 0.6, w: 4.3, d: 2.8, facing: 'x', ...PALETTE[0] },
  { gx: 6.9, gy: 0.6, w: 4.3, d: 2.8, facing: 'x', ...PALETTE[1] },
  { gx: 13.0, gy: 0.6, w: 4.3, d: 2.8, facing: 'x', ...PALETTE[2] },
]

export const BUILDING_H = 58

const LAYOUTS: Record<LayoutName, Layout> = {
  wide: {
    plots: PLOTS,
    ground: { gx: 0, gy: 0, w: 18.6, d: 13 },
    shadow: { cx: 105, cy: 300, rx: 560, ry: 250 },
    paths: PLOTS.map((p) => [[p.gx + p.w / 2, p.gy + p.d], [p.gx + p.w / 2, 8.4]]),
    plaza: { gx: 1, gy: 8, w: 15.6, d: 4.4 },
    plazaLabel: [12.5, 12.9],
    trees: [[0.5, 7.0, 1], [0.7, 9.6, 0.8], [18.0, 4.8, 1.1], [17.6, 8.2, 0.9], [0.9, 12.2, 0.9], [12.0, 0.4, 0.75], [5.9, 0.3, 0.7]],
    failRack: { gx: 8.6, gy: 10.4 },
    reviewDesk: { gx: 3.6, gy: 10.4 },
    board: { x: iso(17, 12.9)[0], y: iso(17, 12.9)[1], anchor: 'bottom', scale: 1 },
    pillScale: 1.22,
    signScale: 1,
    overflowAt: iso(18, 12.6),
    viewBox: () => '-415 -150 990 665',
  },
  // 竖屏一栋：院子在上，验收台和退件架在下方广场，告示栏放在最下面。视野只框住这一栋，标签就能放大。
  portrait: {
    plots: [{ gx: 1, gy: 1, w: 4.3, d: 2.8, facing: 'x', ...PALETTE[0] }],
    ground: { gx: -4, gy: -4, w: 26, d: 26 },
    shadow: { cx: -25, cy: 260, rx: 260, ry: 360 },
    paths: [[[3.15, 3.8], [7.6, 9.6]]],
    plaza: { gx: 5.8, gy: 8.8, w: 8, d: 4.6 },
    plazaLabel: null,
    trees: [[6.2, 1.4, 0.8], [7.6, 4.6, 1], [10.4, 6.8, 0.9]],
    failRack: { gx: 11.4, gy: 9.6 },
    reviewDesk: { gx: 7, gy: 10.8 },
    board: { x: -25, y: 374, anchor: 'top', scale: 1.15 },
    pillScale: 1.45,
    signScale: 1.15,
    overflowAt: [-25, 360],
    viewBox: (boardH) => `-222 -100 392 ${Math.ceil(374 + (boardH + 20) * 1.15 + 16 + 100)}`,
  },
}

export const slot = (j: number) => 0.6 + j * 1.6

/** 院子局部坐标：u 沿建筑长边，v 从门向外。 */
export function yard(p: Plot, u: number, v: number): [number, number] {
  return p.facing === 'x' ? [p.gx + u, p.gy + p.d + v] : [p.gx + p.w + v, p.gy + u]
}

export function activate(fn: () => void) {
  return {
    onClick: fn,
    onKeyDown: (e: KeyboardEvent) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); fn() } },
    tabIndex: 0,
    role: 'button',
  }
}

export function charMatches(c: CharacterView, h: Highlight): boolean {
  if (h === 'working') return c.status === 'working'
  if (h === 'waiting') return c.pendingApprovals.length > 0
  if (h === 'stale') return c.status === 'stale'
  if (h === 'review') return !!c.item && !attentionManaged(c.item) && c.item.status === 'review'
  return c.runs.some((r) => r.phase === 'failed')
}

// SS 里 Agent 交付表现为工作项进入 review（run.outcome 的 delivered 只在你标记完成时写入），
// 所以待验收工作项上已结束、未失败的运行放到验收台。
export function onReviewDesk(p: ParcelView): boolean {
  return !!p.item && !attentionManaged(p.item) && p.item.status === 'review' && p.phase !== 'moving' && p.phase !== 'failed'
}

export function parcelMatches(p: ParcelView, h: Highlight, staleSession: boolean): boolean {
  if (h === 'failed') return p.phase === 'failed'
  if (h === 'review') return onReviewDesk(p)
  if (h === 'working') return p.phase === 'moving' && !staleSession
  if (h === 'stale') return staleSession
  return false
}

export default function TownScene({ model, selected, highlight, onSelect, changed = new Set(), offline = false, buildings, layout = 'wide' }: SceneProps) {
  const L = LAYOUTS[layout]
  const isSel = (kind: Selection['kind'], key: string) => selected?.kind === kind && selected.key === key
  const dim = (match: boolean) => (highlight && !match ? ' is-dim' : '')
  const flash = (key: string) => (changed.has(key) ? ' is-changed' : '')

  const placed = (buildings ?? model.buildings).slice(0, L.plots.length)
  // 地块只定位置，颜色跟着项目走。
  const plotOf = (i: number, b: BuildingView): Plot => ({ ...L.plots[i], ...buildingColors(b.repo?.id) })
  const overflow = buildings ? 0 : model.buildings.length - placed.length

  // 角色位置：画工位、依赖线和标签都用它。每栋只画前 MAX_SEATS 个，顺序由调用方决定。
  const charPos = new Map<string, Pt>()
  const itemOwner = new Map<string, string>()
  const seats: { key: string; c: CharacterView; plot: Plot; gx: number; gy: number }[] = []
  placed.forEach((b, i) => {
    const p = plotOf(i, b)
    b.characters.slice(0, MAX_SEATS).forEach((c, j) => {
      const [gx, gy] = yard(p, slot(j), 2.2)
      charPos.set(c.key, iso(gx, gy))
      if (c.item) itemOwner.set(c.item.id, c.key)
      seats.push({ key: c.key, c, plot: p, gx, gy })
    })
  })

  // 退件架与验收台汇总全部项目，不随分页变化。
  const allParcels = model.buildings.flatMap((b) => b.parcels)
  const failedParcels = allParcels.filter((p) => p.phase === 'failed')
  const reviewParcels = allParcels.filter(onReviewDesk)

  // 每个包裹算出它此刻该在哪里；同一个 key 换位置时由 CSS 过渡移过去。
  const slots: { p: ParcelView; at: Pt; stale: boolean; moving: boolean; label?: ReactNode }[] = []
  for (const seat of seats) {
    const stale = seat.c.status === 'stale'
    for (const r of seat.c.runs.filter((x) => x.phase === 'moving')) {
      const [dx, dy] = seat.plot.facing === 'x' ? [0, -0.38] : [-0.38, 0]
      slots.push({ p: r, at: iso(seat.gx + dx - 0.05, seat.gy + dy - 0.05, 12), stale, moving: !stale })
    }
  }
  const rackBase = iso(L.failRack.gx + 0.7, L.failRack.gy + 0.55)
  failedParcels.forEach((p, i) => {
    const at: Pt = [rackBase[0] + (i - (failedParcels.length - 1) / 2) * 18, rackBase[1] - 10 - i * 3]
    slots.push({
      p, at, stale: false, moving: false,
      label: <Tag at={[0, -34 - (i % 2) * 18]} text={`${parcelTitle(p, 8)} · 第 ${p.run.attempt} 次`} bg="#fff0ee" fg="#8f2a22" small border="#d2483d" />,
    })
  })
  reviewParcels.forEach((p, i) => {
    slots.push({
      p, at: iso(L.reviewDesk.gx + 1.9 + i * 1.1, L.reviewDesk.gy + 0.55, 16), stale: false, moving: false,
      label: <Tag at={[0, -34 - i * 26]} text={parcelTitle(p, 12)} bg="#eef0ff" fg="#2f3a8f" small border="#5b6cd8" />,
    })
  })

  return (
    <svg className={`town-svg${offline ? ' is-offline' : ''} is-${layout}`} viewBox={L.viewBox(boardHeight(model.pendingApprovals.length))} role="group" aria-label="工作小镇场景">
      <defs>
        <pattern id="town-grass" width="60" height="30" patternUnits="userSpaceOnUse">
          <path d="M0 15 L30 0 L60 15 L30 30 Z" fill="none" stroke="#b9cba0" strokeWidth="0.8" />
        </pattern>
        <filter id="town-soft" x="-20%" y="-20%" width="140%" height="140%">
          <feGaussianBlur stdDeviation="10" />
        </filter>
      </defs>

      {/* 桌面投影与底座 */}
      <ellipse cx={L.shadow.cx} cy={L.shadow.cy} rx={L.shadow.rx} ry={L.shadow.ry} fill="#5b4632" opacity="0.18" filter="url(#town-soft)" />
      <IsoBox {...L.ground} h={22} z={-22} top="#d7e2bf" left="#b48a5e" right="#946c48" />
      <IsoTile {...L.ground} fill="url(#town-grass)" />

      {/* 石板路：各院子通向中央广场 */}
      {L.paths.map(([from, to]) => <Path key={from.join()} from={from} to={to} />)}
      <IsoTile {...L.plaza} fill="#e9dcc2" stroke="#cdbb98" />
      {L.plazaLabel && <text className="town-ground-label" {...xy(iso(...L.plazaLabel))}>中央广场</text>}

      {L.trees.map(([gx, gy, k]) => <Tree key={`${gx}-${gy}`} at={iso(gx, gy)} k={k} />)}

      {placed.map((b, i) => (
        <Building key={b.key} plot={plotOf(i, b)} signScale={L.signScale} b={b} selected={isSel('building', b.key)} dimClass={dim(false)} onSelect={() => onSelect({ kind: 'building', key: b.key })} />
      ))}

      {seats.map((seat) => <Desk key={`${seat.key}-desk`} gx={seat.gx - 0.35} gy={seat.gy - 1.05} facing={seat.plot.facing} />)}

      <FailRack at={L.failRack} count={failedParcels.length} />

      <ReviewDesk at={L.reviewDesk} count={reviewParcels.length} selected={isSel('review-desk', 'review-desk')} dimDesk={dim(highlight === 'review')} onSelect={onSelect} />

      <DecisionBoard place={L.board} model={model} isSel={(k) => isSel('approval', k)} dimClass={dim(highlight === 'waiting')} onSelect={onSelect} />

      {/* 包裹层：同一个 run 只有一个节点，换位置时平移过去。
          按 run id 固定顺序渲染：节点在 DOM 里被挪动会打断过渡动画。 */}
      {[...slots].sort((a, b) => a.p.run.id - b.p.run.id).map(({ p, at, stale, moving, label }) => (
        <Parcel key={p.key} at={at} p={p} stale={stale} moving={moving} selected={isSel('parcel', p.key)}
          dimClass={dim(highlight ? parcelMatches(p, highlight, stale) : true) + flash(p.key)} onSelect={() => onSelect({ kind: 'parcel', key: p.key })} label={label} />
      ))}

      {seats.map(({ key, c, gx, gy }) => (
        <Character key={key} at={iso(gx, gy)} c={c} selected={isSel('character', c.key)}
          dimClass={dim(highlight ? charMatches(c, highlight) : true) + flash(c.key)} onSelect={() => onSelect({ kind: 'character', key: c.key })} />
      ))}

      {/* 依赖线：下游等上游满足条件 */}
      {model.deps.map((d) => {
        const a = charPos.get(itemOwner.get(d.upstream) ?? '')
        const z = charPos.get(itemOwner.get(d.downstream) ?? '')
        if (!a || !z) return null
        const mid: Pt = [(a[0] + z[0]) / 2, Math.max(a[1], z[1]) + 30]
        return (
          <g key={`${d.upstream}-${d.downstream}`} className={`town-dep${dim(false)}`}>
            <path d={`M${a[0]},${a[1] + 2} Q${mid[0]},${mid[1] + 20} ${z[0]},${z[1] + 2}`} fill="none" stroke={d.satisfied ? '#4f9d5d' : '#8a7a63'} strokeWidth="1.6" strokeDasharray="4 4" />
            <Tag at={[mid[0], mid[1] + 12]} text={`${d.downstream} 等 ${d.upstream}${d.cond === 'accepted' ? '验收' : '合并'}`} bg="#fffaf0" fg="#6b5a44" small />
          </g>
        )
      })}

      {/* 标签层：放在最上面，避免被相邻角色遮住 */}
      {seats.map(({ c }) => {
        const at = charPos.get(c.key)!
        const { style, st } = charLook(c)
        const label = characterStatusLabel[c.status]
        return (
          <g key={`${c.key}-pill`} style={{ transform: `translate(${at[0]}px,${at[1]}px) scale(${L.pillScale})` }}
            className={`town-obj town-move${dim(highlight ? charMatches(c, highlight) : true)}`} aria-hidden onClick={() => onSelect({ kind: 'character', key: c.key })}>
            <StatusPill at={[0, 17]} name={c.name} status={offline && c.status === 'working' ? `断线前·${label}` : label} bg={st.bg} fg={st.fg} edge={style.body} />
          </g>
        )
      })}
      {overflow > 0 && <Tag at={L.overflowAt} text={`另有 ${overflow} 个项目在列表视图`} bg="#fffaf0" fg="#6b5a44" />}
    </svg>
  )
}

export function xy([x, y]: Pt) {
  return { x, y }
}

export function Path({ from, to }: { from: [number, number]; to: [number, number] }) {
  const a = iso(...from), b = iso(...to)
  return <line x1={a[0]} y1={a[1]} x2={b[0]} y2={b[1]} stroke="#e4d6b8" strokeWidth="16" strokeLinecap="round" opacity="0.9" />
}

export function Tag({ at, text, bg, fg, small, border }: { at: Pt; text: string; bg: string; fg: string; small?: boolean; border?: string }) {
  const fs = small ? 10 : 12
  const w = measure(text, fs) + (small ? 10 : 14)
  const h = small ? 16 : 20
  return (
    <g transform={`translate(${at[0]},${at[1]})`} className="town-tag">
      <rect x={-w / 2} y={-h / 2} width={w} height={h} rx={h / 2} fill={bg} stroke={border ?? 'rgba(60,40,20,.18)'} />
      <text y={fs * 0.36} textAnchor="middle" fontSize={fs} fill={fg}>{text}</text>
    </g>
  )
}

/** 粗略估算中英混排宽度。 */
export function measure(text: string, fs: number): number {
  let w = 0
  for (const ch of text) w += ch.charCodeAt(0) > 0x2e80 ? fs : fs * 0.58
  return w
}

const TASK_MAX = 14
const TASK_ORDER: Record<WorkItem['status'], number> = { review: 0, blocked: 1, in_progress: 2, todo: 3, done: 4, abandoned: 5 }

/** 招牌上方最多列两项当前任务：待验收、受阻优先，其余数量汇总。 */
export function buildingTasks(items: readonly WorkItem[], max = 2) {
  const open = items.filter((w) => w.status !== 'done' && w.status !== 'abandoned')
    .slice().sort((a, b) => TASK_ORDER[a.status] - TASK_ORDER[b.status] || b.updated_at.localeCompare(a.updated_at))
  return { lines: open.slice(0, max), more: Math.max(0, open.length - max) }
}

/** 包裹标签：编号 + 截短的任务标题，没有工作项时只写编号。 */
export function parcelTitle(p: ParcelView, max: number) {
  const id = p.item?.id ?? p.run.work_item_id ?? '?'
  return p.item?.title ? `${id} ${clip(p.item.title, max)}` : id
}

/** 建筑外形：小镇默认是“房子”；大地图按项目体量换成小木屋、工坊或大楼。 */
export interface BuildingShape {
  kind: 'cabin' | 'house' | 'workshop' | 'tower'
  name: string
  h: number
  rise: number
  walls: { top: string; front: string; side: string; edge: string }
  /** 每面墙上的窗户行数。 */
  floors: number
}

export const HOUSE_SHAPE: BuildingShape = {
  kind: 'house', name: '房子', h: BUILDING_H, rise: 34, floors: 1,
  walls: { top: '#efe3cc', front: '#f6ecda', side: '#e4d4b8', edge: '#9b7b55' },
}

export function Building({ plot: p, b, selected, dimClass, onSelect, signScale = 1, shape = HOUSE_SHAPE }: { plot: Plot; b: BuildingView; selected: boolean; dimClass: string; onSelect: () => void; signScale?: number; shape?: BuildingShape }) {
  const H = shape.h
  const active = b.items.filter((w) => w.status !== 'done' && w.status !== 'abandoned').length
  const done = b.items.filter((w) => w.status === 'done').length
  const hidden = Math.max(0, b.characters.length - MAX_SEATS)
  const sign = clip(b.name, SIGN_MAX)
  const tasks = buildingTasks(b.items)
  const signW = measure(sign, 14) + 26
  const label = iso(p.gx + p.w / 2, p.gy + p.d / 2, H + 66)
  const corner = iso(p.gx + p.w, p.gy + p.d)
  // 窗户与门画在朝向镜头的长面上。
  const win = (u: number, v: number, ww: number, wh: number, color: string) => {
    const base = (uu: number, vv: number): Pt => (p.facing === 'x' ? iso(p.gx + uu, p.gy + p.d, vv) : iso(p.gx + p.w, p.gy + uu, vv))
    return <polygon points={pts([base(u, v), base(u + ww, v), base(u + ww, v + wh), base(u, v + wh)])} fill={color} stroke="#7a5a3a" strokeWidth="1" />
  }
  const long = p.facing === 'x' ? p.w : p.d
  return (
    <g className={`town-obj town-building${selected ? ' is-selected' : ''}${dimClass}`}
      aria-label={`项目建筑 ${b.name}：${b.characters.length} 个会话，${active} 个未完成任务${hidden ? `，另有 ${hidden} 个会话不在画面中` : ''}`} {...activate(onSelect)}>
      <IsoTile gx={p.gx - 0.4} gy={p.gy - 0.4} w={p.w + 0.8} d={p.d + 0.8} fill="#c9b48e" opacity={0.5} />
      <IsoBox gx={p.gx} gy={p.gy} w={p.w} d={p.d} h={H} top={shape.walls.top} left={p.facing === 'x' ? shape.walls.front : shape.walls.side} right={p.facing === 'x' ? shape.walls.side : shape.walls.front} stroke={shape.walls.edge} />
      {shape.kind === 'workshop' && (
        // 工坊侧面的披屋
        <IsoBox gx={p.gx + p.w} gy={p.gy + 0.3} w={1.5} d={p.d - 0.6} h={H * 0.55} top="#a07a52" left={shape.walls.front} right={shape.walls.side} stroke={shape.walls.edge} />
      )}
      {/* 门、窗 */}
      {win(long / 2 - 0.4, 0, 0.8, 30, p.accent)}
      {Array.from({ length: shape.floors }, (_, f) => (
        <g key={f}>
          {win(0.45, 22 + f * 30, 0.9, 18, '#ffe2a0')}
          {win(long - 1.35, 22 + f * 30, 0.9, 18, '#ffe2a0')}
          {shape.kind !== 'cabin' && long > 4.6 && win(long / 2 + 0.7, 22 + f * 30, 0.8, 18, '#ffe2a0')}
        </g>
      ))}
      <HipRoof gx={p.gx} gy={p.gy} w={p.w} d={p.d} z={H} rise={shape.rise} front={p.roof} side={p.roofSide} stroke="#5a3a2a" />
      {/* 烟囱 */}
      <IsoBox gx={p.gx + (p.facing === 'x' ? p.w * 0.72 : 0.6)} gy={p.gy + (p.facing === 'x' ? 0.5 : p.d * 0.72)} w={0.45} d={0.45} h={28} z={H + 14} top="#8d5b45" left="#b07258" right="#94604a" />
      {shape.kind === 'tower' && (
        <g transform={`translate(${iso(p.gx + p.w / 2, p.gy + p.d / 2, H + shape.rise).join(',')})`} aria-hidden>
          <line x1="0" y1="0" x2="0" y2="-34" stroke="#5a3a2a" strokeWidth="2" />
          <path d="M0,-34 l20,6 l-20,7 z" fill={p.accent} />
        </g>
      )}
      {done > 0 && (
        <g transform={`translate(${iso(p.gx + p.w * 0.28, p.gy + p.d / 2, H + 34).join(',')})`} aria-hidden>
          <line x1="0" y1="0" x2="0" y2="-26" stroke="#6b4a2a" strokeWidth="1.8" />
          <path d="M0,-26 l16,4.5 l-16,5.5 z" fill="#4f9d5d" />
        </g>
      )}
      {b.characters.some((c) => c.status === 'working') && (
        <g transform={`translate(${iso(p.gx + (p.facing === 'x' ? p.w * 0.72 : 0.8), p.gy + (p.facing === 'x' ? 0.7 : p.d * 0.72), H + 50).join(',')})`}>
          <g className="town-smoke">
            <circle r="5" fill="#fff" opacity="0.7" />
            <circle cx="6" cy="-9" r="6" fill="#fff" opacity="0.5" />
          </g>
        </g>
      )}
      {/* 招牌：长名截断，全名在 aria-label */}
      <g className="town-sign" transform={`translate(${label[0]},${label[1]}) scale(${signScale})`}>
        <line x1="0" y1="10" x2="0" y2="26" stroke="#7a5a3a" strokeWidth="1.5" />
        <rect x={-signW / 2} y={-14} width={signW} height={26} rx="6" fill="#fffaf0" stroke={selected ? '#2d6cdf' : p.accent} strokeWidth={selected ? 3 : 2} />
        <text y="4" textAnchor="middle" fontSize="14" fontWeight="700" fill="#3a2a1c">{sign}</text>
        <text y="-22" textAnchor="middle" fontSize="10.5" fill="#6b5a44" className="town-sub">
          {shape.kind === 'house' ? '' : `${shape.name} · `}{b.characters.length} 个会话 · {active} 个未完成{done ? ` · 已完成 ${done}` : ''}
        </text>
        {tasks.lines.map((t, i) => (
          <text key={t.id} y={-38 - (tasks.lines.length - 1 - i) * 14} textAnchor="middle" fontSize="10.5" fill="#3a2a1c" className="town-task">
            <tspan fontWeight="700" fill={t.status === 'review' ? '#2f3a8f' : t.status === 'blocked' ? '#8f2a22' : '#6b5a44'}>{itemStatusLabel[t.status]}</tspan> {clip(t.title, TASK_MAX)}
          </text>
        ))}
        {tasks.more > 0 && <text y={-38 - tasks.lines.length * 14} textAnchor="middle" fontSize="10" fill="#7a6a55">等 {tasks.more} 项</text>}
      </g>
      {hidden > 0 && <Tag at={[corner[0], corner[1] - 22]} text={`另有 ${hidden} 位`} bg="#fffaf0" fg="#6b5a44" small border={p.accent} />}
    </g>
  )
}

export function Tree({ at, k }: { at: Pt; k: number }) {
  const [x, y] = at
  return (
    <g aria-hidden transform={`translate(${x},${y}) scale(${k})`}>
      <ellipse rx="16" ry="6" fill="rgba(40,25,10,.18)" />
      <rect x="-3" y="-16" width="6" height="16" rx="2" fill="#8a5d3b" />
      <circle cy="-30" r="17" fill="#7fae6a" />
      <circle cx="-8" cy="-38" r="11" fill="#93c27b" />
      <circle cx="7" cy="-42" r="9" fill="#a6d18a" />
    </g>
  )
}

export function Desk({ gx, gy, facing }: { gx: number; gy: number; facing: 'x' | 'y' }) {
  const [w, d] = facing === 'x' ? [0.9, 0.55] : [0.55, 0.9]
  return <IsoBox gx={gx} gy={gy} w={w} d={d} h={12} top="#c99a63" left="#a87a48" right="#8f6638" />
}

const PROVIDER_STYLE: Record<string, { body: string; trim: string }> = {
  claude: { body: '#d9774b', trim: '#f3c6a6' },
  codex: { body: '#334055', trim: '#9fb3cf' },
  cat: { body: '#7c9b5a', trim: '#e7f0c8' },
  other: { body: '#8a7a9e', trim: '#e2d8f0' },
}

const STATUS_COLOR: Record<CharacterView['status'], { bg: string; fg: string }> = {
  working: { bg: '#f4b740', fg: '#3b2a05' },
  waiting: { bg: '#ffe066', fg: '#3b2a05' },
  error: { bg: '#d2483d', fg: '#fff' },
  idle: { bg: '#e8e0d0', fg: '#4a4033' },
  interrupted: { bg: '#e0b0a0', fg: '#3b2a1c' },
  ended: { bg: '#d8d2c8', fg: '#4a4033' },
  stale: { bg: '#bdbdbd', fg: '#2e2e2e' },
  unknown: { bg: '#d8d2c8', fg: '#4a4033' },
}

export function charLook(c: CharacterView) {
  const s = c.session
  const isCat = s.provider !== 'claude' && s.provider !== 'codex' && (s.client ?? '').includes('猫')
  const style = PROVIDER_STYLE[isCat ? 'cat' : s.provider] ?? PROVIDER_STYLE.other
  return { isCat, style, st: STATUS_COLOR[c.status] }
}

export function Character({ at, c, selected, dimClass, onSelect, now }: { at: Pt; c: CharacterView; selected: boolean; dimClass: string; onSelect: () => void; now?: string }) {
  const s = c.session
  const { isCat, style } = charLook(c)
  const skin = isCat ? '#f2b36b' : '#f6d7b8'
  const stale = c.status === 'stale'
  return (
    <g style={{ transform: `translate(${at[0]}px,${at[1]}px) scale(1.22)` }}
      className={`town-obj town-move town-char is-${c.status}${selected ? ' is-selected' : ''}${dimClass}`}
      aria-label={`${c.name}，${characterStatusLabel[c.status]}${c.item ? `，任务 ${c.item.title}` : ''}`} {...activate(onSelect)}>
      <title>{`${c.name} · ${recentSignal(s.signal, now ?? new Date().toISOString())}`}</title>
      {/* 闲着的会话在院子里来回溜达；干活的手边冒火花 */}
      <g className={c.status === 'idle' ? 'town-stroll' : undefined} style={c.status === 'idle' ? { animationDelay: `${-(s.id % 7) * 1.3}s` } : undefined}>
      <rect x="-17" y="-58" width="34" height="64" fill="transparent" />
      <ellipse className="town-pulse" rx="16" ry="7" fill="none" stroke="#ff9f1a" strokeWidth="2.5" />
      <ellipse rx="13" ry="5" fill="rgba(40,25,10,.22)" />
      {selected && <ellipse rx="19" ry="8" fill="none" stroke="#2d6cdf" strokeWidth="2.5" />}
      {stale && <ellipse rx="19" ry="8" fill="none" stroke="#777" strokeWidth="1.5" strokeDasharray="3 3" />}
      <g className={c.status === 'working' ? 'town-bob' : undefined}>
        <rect x="-6" y="-11" width="4.5" height="11" rx="2" fill="#3d3a4a" />
        <rect x="1.5" y="-11" width="4.5" height="11" rx="2" fill="#3d3a4a" />
        <rect x="-10" y="-30" width="20" height="21" rx="7" fill={style.body} />
        <rect x="-6.5" y="-26" width="13" height="10" rx="2" fill="#fffaf0" />
        <text y="-18.3" textAnchor="middle" fontSize="7.5" fontWeight="700" fill="#3a2a1c">{s.id}</text>
        <circle cy="-41" r="11" fill={skin} stroke="rgba(80,50,30,.25)" />
        {isCat ? (
          <g>
            <path d="M-10,-46 L-8,-57 L-2,-50 Z" fill={skin} stroke="rgba(80,50,30,.35)" />
            <path d="M10,-46 L8,-57 L2,-50 Z" fill={skin} stroke="rgba(80,50,30,.35)" />
            <path d="M-13,-38 L-6,-39 M-13,-35 L-6,-37 M13,-38 L6,-39 M13,-35 L6,-37" stroke="#7a4a2a" strokeWidth="0.8" />
          </g>
        ) : s.provider === 'codex' ? (
          <g fill="none" stroke={style.body} strokeWidth="2.5">
            <path d="M-11,-41 A11,11 0 0 1 11,-41" />
            <rect x="-13.5" y="-44" width="5" height="8" rx="2" fill={style.body} />
            <rect x="8.5" y="-44" width="5" height="8" rx="2" fill={style.body} />
          </g>
        ) : (
          <path d="M-11,-45 Q0,-58 11,-45 Q0,-49 -11,-45 Z" fill={style.body} />
        )}
        <circle cx="-3.8" cy="-40" r="1.4" fill="#2b2017" />
        <circle cx="3.8" cy="-40" r="1.4" fill="#2b2017" />
      </g>

      {c.status === 'waiting' && (
        <g className="town-wave">
          <line x1="12" y1="-24" x2="22" y2="-62" stroke="#7a5a3a" strokeWidth="2" />
          <rect x="10" y="-86" width="44" height="26" rx="4" fill="#ffe066" stroke="#8a6a10" strokeWidth="1.5" />
          <text x="32" y="-68.5" textAnchor="middle" fontSize="11" fontWeight="700" fill="#3b2a05">等你决定</text>
          <circle className="town-blink" cx="54" cy="-86" r="4" fill="#ff9f1a" />
        </g>
      )}
      {c.status === 'error' && (
        <g>
          <circle cx="16" cy="-60" r="9" fill="#d2483d" />
          <text x="16" y="-56" textAnchor="middle" fontSize="13" fontWeight="700" fill="#fff">!</text>
        </g>
      )}
      {c.status === 'idle' && <text className="town-zzz" x="13" y="-56" fontSize="11" fill="#6b5a44">z z</text>}
      {c.status === 'working' && (
        <g className="town-spark" aria-hidden>
          <path d="M13,-26 l5,-4 M14,-21 l7,0 M13,-16 l5,4" stroke="#ffb02e" strokeWidth="1.8" strokeLinecap="round" />
        </g>
      )}
      {stale && (
        <g>
          <path d="M6,-62 a7,7 0 0 1 12,-6 a8,8 0 0 1 15,3 a6,6 0 0 1 -2,11 h-23 a6,6 0 0 1 -2,-8 z" fill="#e9e9e9" stroke="#8a8a8a" />
          <text x="20" y="-56" textAnchor="middle" fontSize="9" fill="#555">?</text>
        </g>
      )}
      </g>
    </g>
  )
}

export function Crate({ at, fill, tape, size = 1 }: { at: Pt; fill: string; tape: string; size?: number }) {
  const hw = 10 * size, hh = 5 * size, h = 11 * size
  const [x, y] = at
  const T: Pt = [x, y - hh * 2 - h], L: Pt = [x - hw, y - hh - h], R: Pt = [x + hw, y - hh - h], F: Pt = [x, y - h]
  const edge = 'rgba(60,30,10,.45)'
  return (
    <g>
      <polygon points={pts([[x - hw, y - hh], [x, y], F, L])} fill={fill} stroke={edge} />
      <polygon points={pts([[x + hw, y - hh], [x, y], F, R])} fill={shade(fill)} stroke={edge} />
      <polygon points={pts([T, R, F, L])} fill={lighten(fill)} stroke={edge} />
      <line x1={(T[0] + L[0]) / 2} y1={(T[1] + L[1]) / 2} x2={(R[0] + F[0]) / 2} y2={(R[1] + F[1]) / 2} stroke={tape} strokeWidth={2.2 * size} />
    </g>
  )
}

const shade = (hex: string) => mix(hex, '#000000', 0.18)
const lighten = (hex: string) => mix(hex, '#ffffff', 0.22)
function mix(a: string, b: string, t: number) {
  const pa = parseInt(a.slice(1), 16), pb = parseInt(b.slice(1), 16)
  const ch = (s: number) => Math.round(((pa >> s) & 255) * (1 - t) + ((pb >> s) & 255) * t).toString(16).padStart(2, '0')
  return `#${ch(16)}${ch(8)}${ch(0)}`
}

export function Parcel({ at, p, stale, moving, selected, dimClass, onSelect, label }: { at: Pt; p: ParcelView; stale?: boolean; moving?: boolean; selected: boolean; dimClass: string; onSelect: () => void; label?: ReactNode }) {
  const review = onReviewDesk(p)
  const fill = stale ? '#c8c8c8' : p.phase === 'failed' ? '#d9776b' : review ? '#d6b27a' : '#d4a565'
  const tape = review ? '#5b6cd8' : p.phase === 'failed' ? '#8f2a22' : '#f1dfb8'
  const state = stale ? '状态待更新' : parcelPhaseLabel[p.phase]
  return (
    <g style={{ transform: `translate(${at[0]}px,${at[1]}px)` }}
      className={`town-obj town-move town-parcel${moving ? ' is-moving' : ''}${selected ? ' is-selected' : ''}${dimClass}`}
      aria-label={`包裹：运行 #${shownNo(p.run.id)} 第 ${p.run.attempt} 次，${state}`} {...activate(onSelect)}>
      <g className="town-pop">
        <g className={moving ? 'town-slide' : undefined}>
          <ellipse className="town-pulse" rx="15" ry="7" fill="none" stroke="#ff9f1a" strokeWidth="2.5" />
          {selected && <ellipse rx="16" ry="7" fill="none" stroke="#2d6cdf" strokeWidth="2.5" />}
          <Crate at={[0, 0]} fill={fill} tape={tape} />
          {p.phase === 'failed' && <path d="M-4,-20 l3,4 l-2,3 l4,4" stroke="#5a1510" strokeWidth="1.3" fill="none" />}
        </g>
        {label}
      </g>
    </g>
  )
}

export function FailRack({ at, count }: { at: { gx: number; gy: number }; count: number }) {
  const { gx, gy } = at
  const base = iso(gx + 0.7, gy + 0.55)
  return (
    <g aria-label={`退件架：${count} 个失败运行`}>
      <IsoBox gx={gx} gy={gy} w={1.4} d={1.1} h={10} top="#7a3a32" left="#a5483e" right="#8a3c33" />
      <Tag at={[base[0], base[1] + 18]} text={`退件架 · 失败 ${count}`} bg="#d2483d" fg="#fff" small />
    </g>
  )
}

export function StatusPill({ at, name, status, bg, fg, edge }: { at: Pt; name: string; status: string; bg: string; fg: string; edge: string }) {
  const fs = 9.5
  const a = measure(status, fs) + 10, b = measure(name, fs) + 10
  const x0 = -(a + b) / 2
  return (
    <g transform={`translate(${at[0]},${at[1]})`}>
      <rect x={x0} y={-8} width={a + b} height={16} rx={8} fill="#fffaf0" stroke={edge} />
      <path d={`M${x0 + 8},-8 h${a - 8} v16 h-${a - 8} a8,8 0 0 1 0,-16 z`} fill={bg} />
      <text x={x0 + a / 2} y={3.4} textAnchor="middle" fontSize={fs} fontWeight="700" fill={fg}>{status}</text>
      <text x={x0 + a + b / 2} y={3.4} textAnchor="middle" fontSize={fs} fill="#3a2a1c">{name}</text>
    </g>
  )
}

export function ReviewDesk({ at, count, selected, dimDesk, onSelect }: { at: { gx: number; gy: number }; count: number; selected: boolean; dimDesk: string; onSelect: (s: Selection) => void }) {
  const { gx, gy } = at
  const label = iso(gx - 0.2, gy + 0.55, 50)
  return (
    <g>
      <g className={`town-obj town-desk${selected ? ' is-selected' : ''}${dimDesk}`} aria-label={`你的验收台：${count} 个待验收`} {...activate(() => onSelect({ kind: 'review-desk', key: 'review-desk' }))}>
        <IsoBox gx={gx} gy={gy} w={3.4} d={1.1} h={16} top="#e8d2a8" left="#b98a52" right="#9c7140" stroke={selected ? '#2d6cdf' : undefined} />
        {/* 台灯与空椅子：这里等你来坐 */}
        <IsoBox gx={gx + 2.2} gy={gy + 1.5} w={0.7} d={0.7} h={9} top="#8a6a8a" left="#6e526e" right="#5e445e" />
        <IsoBox gx={gx + 2.2} gy={gy + 2.05} w={0.7} d={0.15} h={24} z={0} top="#8a6a8a" left="#6e526e" right="#5e445e" />
        <g transform={`translate(${iso(gx + 0.5, gy + 0.3, 16).join(',')})`}>
          <line x1="0" y1="0" x2="0" y2="-20" stroke="#4a3a2a" strokeWidth="2" />
          <path d="M-7,-18 L7,-18 L4,-27 L-4,-27 Z" fill="#ffd36b" stroke="#8a6a10" />
          <circle cy="-14" r="10" fill="#ffe9a8" opacity="0.35" className="town-blink-soft" />
        </g>
        <g transform={`translate(${label[0]},${label[1]})`}>
          <rect x="-62" y="-16" width="124" height="30" rx="7" fill="#5b6cd8" />
          <text y="-2" textAnchor="middle" fontSize="13" fontWeight="700" fill="#fff">你的验收台</text>
          <text y="10" textAnchor="middle" fontSize="9.5" fill="#dfe4ff">只有你能验收 · {count} 件待验收</text>
        </g>
      </g>
    </g>
  )
}

const KIND_SHORT: Record<string, string> = { permission: '权限', merge: '合并', decision: '决定', attention: '提醒' }

/** 告示栏高度（不含立柱），随待决定卡片数变化。 */
export function boardHeight(cards: number): number {
  return 46 + Math.max(1, cards) * 34
}

export function DecisionBoard({ place, model, isSel, dimClass, onSelect }: { place: Layout['board']; model: TownModel; isSel: (k: string) => boolean; dimClass: string; onSelect: (s: Selection) => void }) {
  const cards = model.pendingApprovals
  const h = boardHeight(cards.length)
  // 以底边中点为原点画，外层按版式平移、缩放。
  const x = 0, y = 0
  const top = y - h - 20
  const oy = place.anchor === 'bottom' ? place.y : place.y + (h + 20) * place.scale
  return (
    <g className={dimClass} transform={`translate(${place.x},${oy}) scale(${place.scale})`}>
      <line x1={x - 62} y1={y} x2={x - 62} y2={top + 8} stroke="#6b4a2a" strokeWidth="4" />
      <line x1={x + 62} y1={y} x2={x + 62} y2={top + 8} stroke="#6b4a2a" strokeWidth="4" />
      <rect x={x - 74} y={top} width="148" height={h} rx="6" fill="#a87a48" stroke="#6b4a2a" strokeWidth="2" />
      <rect x={x - 68} y={top + 6} width="136" height={h - 12} rx="4" fill="#d9b98a" />
      <text x={x} y={top + 25} textAnchor="middle" fontSize="13" fontWeight="700" fill="#3a2a1c">等你决定 · {cards.length}</text>
      {cards.length === 0 && <text x={x} y={top + 56} textAnchor="middle" fontSize="11" fill="#6b5a44">暂时没有待决定</text>}
      {cards.map((a, i) => {
        const cy = top + 36 + i * 34
        const sel = isSel(a.id)
        const sess = a.session_id != null ? `#${shownNo(a.session_id)}` : ''
        return (
          <g key={a.id} className={`town-obj town-card${sel ? ' is-selected' : ''}`} aria-label={`待决定 ${a.id}：${a.preview}`} {...activate(() => onSelect({ kind: 'approval', key: a.id }))}>
            <rect x={x - 62} y={cy} width="124" height="28" rx="3" fill="#fffbe6" stroke={sel ? '#2d6cdf' : '#c9a227'} strokeWidth={sel ? 2.5 : 1} transform={`rotate(${i % 2 ? 1.5 : -1.5} ${x} ${cy + 14})`} />
            <circle cx={x} cy={cy + 2} r="3" fill="#d2483d" />
            <text x={x - 56} y={cy + 13} fontSize="9" fill="#8a6a10" fontWeight="700">{KIND_SHORT[a.kind] ?? '提醒'} {sess}</text>
            <text x={x - 56} y={cy + 24} fontSize="9.5" fill="#3a2a1c">{clip(a.preview ?? '', 12)}</text>
          </g>
        )
      })}
    </g>
  )
}

/** 场景图例；放在 .town-diorama 里。 */
export function TownLegend() {
  return (
    <ul className="town-legend" aria-label="图例">
      <li><i className="town-lg-building" />建筑 = 项目</li>
      <li><i className="town-lg-char" />角色 = 一个会话</li>
      <li><i className="town-lg-parcel" />包裹 = 一次运行</li>
      <li><i className="town-lg-board" />告示栏 = 等你决定</li>
    </ul>
  )
}

export const TOWN_CHIPS: { key: Highlight; label: string }[] = [
  { key: 'working', label: '工作中' }, { key: 'waiting', label: '等你决定' }, { key: 'failed', label: '失败' }, { key: 'review', label: '待验收' }, { key: 'stale', label: '状态待更新' },
]

/** 按状态高亮的计数按钮；再点一次取消高亮。 */
export function TownChips({ counts, highlight, onHighlight, offline = false }: { counts: TownModel['counts']; highlight: Highlight | null; onHighlight: (h: Highlight | null) => void; offline?: boolean }) {
  return (
    <nav className="town-chips" aria-label="按状态高亮">
      {TOWN_CHIPS.map((c) => (
        <button key={c.key} type="button" className={`town-chip is-${c.key}${highlight === c.key ? ' is-on' : ''}`} aria-pressed={highlight === c.key} onClick={() => onHighlight(highlight === c.key ? null : c.key)}>
          <i aria-hidden />{offline && c.key === 'working' ? '断线前工作中' : c.label}<b>{counts[c.key]}</b>
        </button>
      ))}
    </nav>
  )
}
