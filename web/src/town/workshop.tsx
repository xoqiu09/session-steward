// 项目院子里每个 Agent 一间小作坊（屋顶是 Agent 的颜色），它的会话小人站在自己作坊门口。
// 两间作坊之间有条小路：最近一天里工作在两边交接或接力时，一辆小推车推着写了工作项编号的箱子跑过去。
import type { CSSProperties } from 'react'
import { IsoBox, iso, pts, type Pt } from './iso'
import { activate, type Selection } from './TownScene'
import { AGENTS, type Agent } from './agents'
import type { Relay } from './relays'

export const SHED_D = 1.35
const SHED_H = 40

export interface ShedSpot { agent: Agent; gx: number; gy: number; w: number }

/** 作坊的位置：从左往右排在主屋前、菜地左边；中间留出主屋门口那条路。 */
export function shedSpots(agents: readonly Agent[], ox: number, oy: number): ShedSpot[] {
  const gy = oy + 5.15
  const xs = agents.length >= 3 ? [[0.15, 1.5], [1.8, 1.4], [3.7, 1.7]] : agents.length === 2 ? [[0.2, 2.3], [3.65, 1.8]] : [[0.5, 2.4]]
  return agents.slice(0, 3).map((agent, i) => ({ agent, gx: ox + xs[i][0], gy, w: xs[i][1] }))
}

/** 作坊门口的站位：每间最多站两个小人。 */
export function shedSeat(s: ShedSpot, k: number): [number, number] {
  return [s.gx + 0.35 + k * 1.15, s.gy + SHED_D + 1.25]
}

export const SHED_MAX = 2

const colorOf = (a: Agent) => AGENTS.find((x) => x.key === a)!.color
const labelOf = (a: Agent) => AGENTS.find((x) => x.key === a)!.label

export function Workshop({ s, more }: { s: ShedSpot; more: number }) {
  const color = colorOf(s.agent)
  const { gx, gy, w } = s
  const d = SHED_D
  const roofL = iso(gx - 0.1, gy + d + 0.1, SHED_H), roofR = iso(gx + w + 0.1, gy + d + 0.1, SHED_H)
  const ridgeL = iso(gx - 0.1, gy + d / 2, SHED_H + 16), ridgeR = iso(gx + w + 0.1, gy + d / 2, SHED_H + 16)
  const backL = iso(gx - 0.1, gy - 0.1, SHED_H), backR = iso(gx + w + 0.1, gy - 0.1, SHED_H)
  const sign = iso(gx + w / 2, gy + d / 2, SHED_H + 34)
  const door = (u: number, h: number): Pt => iso(gx + u, gy + d, h)
  return (
    <g aria-label={`${labelOf(s.agent)} 作坊`}>
      <IsoBox gx={gx} gy={gy} w={w} d={d} h={SHED_H} top="#e9dcc4" left="#efe1c8" right="#dccaa8" stroke="#8f7350" />
      {/* 门 */}
      <polygon points={pts([door(w / 2 - 0.28, 0), door(w / 2 + 0.28, 0), door(w / 2 + 0.28, 24), door(w / 2 - 0.28, 24)])} fill={color} opacity={0.85} />
      <polygon points={pts([door(0.3, 14), door(0.75, 14), door(0.75, 28), door(0.3, 28)])} fill="#ffe2a0" stroke="#7a5a3a" strokeWidth={0.8} />
      {/* 坡屋顶：前坡和后坡 */}
      <polygon points={pts([backL, backR, ridgeR, ridgeL])} fill={color} opacity={0.75} stroke="rgba(40,25,10,.35)" />
      <polygon points={pts([ridgeL, ridgeR, roofR, roofL])} fill={color} stroke="rgba(40,25,10,.35)" />
      <g transform={`translate(${sign[0]},${sign[1] - 10})`}>
        <rect x={-32} y={-11} width={64} height={18} rx={5} fill="#fffaf0" stroke={color} strokeWidth={1.6} />
        <text y={3} textAnchor="middle" fontSize={12} fontWeight={800} fill="#3a2a1c">{labelOf(s.agent)}</text>
      </g>
      {more > 0 && <text x={iso(gx + w, gy + d)[0] + 4} y={iso(gx + w, gy + d)[1] - 4} fontSize={10} fill="#6b5a44">+{more}</text>}
    </g>
  )
}

/** 两间作坊门前的小路（交接的通道）。 */
export function trackEnds(a: ShedSpot, b: ShedSpot): [Pt, Pt] {
  const y = a.gy + SHED_D + 0.35
  return [iso(a.gx + a.w / 2, y), iso(b.gx + b.w / 2, y)]
}

export function Track({ a, b }: { a: ShedSpot; b: ShedSpot }) {
  const [p, q] = trackEnds(a, b)
  return (
    <g aria-hidden>
      <line x1={p[0]} y1={p[1]} x2={q[0]} y2={q[1]} stroke="#d9c39a" strokeWidth={9} strokeLinecap="round" />
      <line x1={p[0]} y1={p[1] - 2.5} x2={q[0]} y2={q[1] - 2.5} stroke="#a88a5c" strokeWidth={1} strokeDasharray="5 6" />
      <line x1={p[0]} y1={p[1] + 2.5} x2={q[0]} y2={q[1] + 2.5} stroke="#a88a5c" strokeWidth={1} strokeDasharray="5 6" />
    </g>
  )
}

/** 小推车：从交出方的作坊推到接手方的作坊，到了停一下再从头来。点它打开那个工作项。 */
export function Cart({ relay, from, to, count, onSelect }: { relay: Relay; from: ShedSpot; to: ShedSpot; count: number; onSelect: (s: Selection) => void }) {
  const [p, q] = trackEnds(from, to)
  const style = { '--dx': `${q[0] - p[0]}px`, '--dy': `${q[1] - p[1]}px` } as CSSProperties
  const what = relay.kind === 'handoff' ? '交接' : '接力'
  return (
    <g className="town-obj town-cart-wrap" transform={`translate(${p[0]},${p[1]})`} {...activate(() => onSelect({ kind: 'item', key: relay.itemId }))}
      aria-label={`${labelOf(relay.from)} → ${labelOf(relay.to)} ${what}：${relay.itemId} ${relay.title}${count > 1 ? `（最近一天共 ${count} 次）` : ''}`}>
      <title>{`${labelOf(relay.from)} → ${labelOf(relay.to)} ${what}\n${relay.itemId} ${relay.title}${count > 1 ? `\n最近一天共 ${count} 次` : ''}`}</title>
      <g className="town-cart" style={style}><g transform="scale(1.3)">
        <rect x={-16} y={-34} width={32} height={40} fill="transparent" />
        <ellipse cy={2} rx={15} ry={5} fill="rgba(40,25,10,.2)" />
        {/* 车斗 */}
        <polygon points="-13,-6 13,-6 10,-16 -10,-16" fill="#a5733f" stroke="#6b4a2a" />
        {/* 箱子 */}
        <rect x={-8} y={-27} width={16} height={12} rx={1.5} fill="#e0b97a" stroke="#8a6a3a" />
        <line x1={-8} y1={-21} x2={8} y2={-21} stroke={colorOf(relay.to)} strokeWidth={2} />
        {/* 轮子和把手 */}
        <circle cx={-7} cy={-3} r={4} fill="#5a3a22" stroke="#3a2412" />
        <circle cx={7} cy={-3} r={4} fill="#5a3a22" stroke="#3a2412" />
        <line x1={-13} y1={-12} x2={-21} y2={-18} stroke="#6b4a2a" strokeWidth={2} strokeLinecap="round" />
        <g transform="translate(0,-40)">
          <rect x={-34} y={-9} width={68} height={14} rx={7} fill="#fffaf0" stroke={colorOf(relay.to)} strokeWidth={1.2} />
          <text y={2} textAnchor="middle" fontSize={8.5} fontWeight={700} fill="#3a2a1c">{relay.itemId}{count > 1 ? ` · ${count} 次` : ''}</text>
        </g>
      </g></g>
    </g>
  )
}
