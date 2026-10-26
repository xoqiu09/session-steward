// 小镇世界的景物：松树、花丛、石头、池塘、风车、营火、栅栏。全部自己画的 SVG，按格子坐标摆放。
import { IsoBox, iso, pts, type Pt } from './iso'

export type Terrain = 'meadow' | 'forest' | 'lake' | 'hill'

/** 地形主题按名字固定，不随刷新变化。 */
export function terrainOf(key: string): Terrain {
  let h = 0
  for (const ch of key) h = (h * 31 + ch.charCodeAt(0)) | 0
  return (['meadow', 'forest', 'lake', 'hill'] as const)[Math.abs(h) % 4]
}

/** 各地形院子的底色。 */
export const YARD_TINT: Record<Terrain, string> = {
  meadow: '#dbe8c0',
  forest: '#cddcb2',
  lake: '#d6e7c9',
  hill: '#e2ddc0',
}

export const TERRAIN_NAME: Record<Terrain, string> = { meadow: '草地', forest: '森林', lake: '湖边', hill: '山坡' }

export function Pine({ at, k = 1 }: { at: Pt; k?: number }) {
  const [x, y] = at
  return (
    <g aria-hidden transform={`translate(${x},${y}) scale(${k})`}>
      <ellipse rx="13" ry="5" fill="rgba(40,25,10,.18)" />
      <rect x="-2.5" y="-12" width="5" height="12" rx="1.5" fill="#7a5233" />
      <polygon points="0,-58 -13,-30 13,-30" fill="#4f8a5b" />
      <polygon points="0,-46 -16,-18 16,-18" fill="#5e9a68" />
      <polygon points="0,-34 -18,-8 18,-8" fill="#6aa673" />
    </g>
  )
}

const PETALS = ['#f2a3b3', '#f7d36b', '#ffffff', '#b9a3f2', '#f29b6b']

export function Flowers({ gx, gy, seed }: { gx: number; gy: number; seed: number }) {
  const [x, y] = iso(gx, gy)
  return (
    <g aria-hidden transform={`translate(${x},${y})`}>
      {[0, 1, 2, 3, 4].map((i) => {
        const dx = ((seed >> (i * 2)) % 9) - 4, dy = ((seed >> (i * 3 + 1)) % 5) - 2
        return (
          <g key={i} transform={`translate(${dx * 2.4},${dy * 1.6})`}>
            <line x1="0" y1="0" x2="0" y2="-5" stroke="#5f8f4e" strokeWidth="1" />
            <circle cy="-6" r="2.2" fill={PETALS[(seed + i) % PETALS.length]} />
          </g>
        )
      })}
    </g>
  )
}

export function Rock({ gx, gy, k = 1 }: { gx: number; gy: number; k?: number }) {
  return <IsoBox gx={gx} gy={gy} w={0.7 * k} d={0.55 * k} h={9 * k} top="#c4c2b8" left="#a8a59a" right="#93907f" />
}

/** 池塘：不规则的水面，水波线条会闪。 */
export function Pond({ gx, gy, w, d }: { gx: number; gy: number; w: number; d: number }) {
  const ring: Pt[] = []
  for (let i = 0; i < 12; i++) {
    const a = (i / 12) * Math.PI * 2
    const r = 0.86 + 0.14 * Math.sin(i * 2.3)
    ring.push(iso(gx + w / 2 + Math.cos(a) * (w / 2) * r, gy + d / 2 + Math.sin(a) * (d / 2) * r))
  }
  const c = iso(gx + w / 2, gy + d / 2)
  return (
    <g aria-hidden>
      <polygon points={pts(ring)} fill="#a9c98f" transform={`translate(0,3)`} />
      <polygon points={pts(ring)} fill="#7fb3d5" stroke="#6a9cbd" strokeWidth="1.5" />
      {[-1, 0, 1].map((i) => (
        <line key={i} className="town-shimmer" x1={c[0] - 18 + i * 10} y1={c[1] + i * 7} x2={c[0] + 10 + i * 10} y2={c[1] + i * 7} stroke="#e8f4fb" strokeWidth="2" strokeLinecap="round" strokeDasharray="6 10" />
      ))}
      <ellipse cx={c[0] + w * 6} cy={c[1] - d * 3} rx="6" ry="3" fill="#6aa673" />
    </g>
  )
}

/** 风车：塔身 + 转动的叶片。 */
export function Windmill({ gx, gy }: { gx: number; gy: number }) {
  const hub = iso(gx + 0.6, gy + 0.6, 62)
  return (
    <g aria-hidden>
      <IsoBox gx={gx} gy={gy} w={1.2} d={1.2} h={52} top="#efe3cc" left="#e4d4b8" right="#d6c3a2" stroke="#9b7b55" />
      <polygon points={pts([iso(gx - 0.15, gy + 1.35, 52), iso(gx + 1.35, gy + 1.35, 52), iso(gx + 0.6, gy + 0.6, 78)])} fill="#a6503a" stroke="#5a3a2a" />
      <polygon points={pts([iso(gx + 1.35, gy - 0.15, 52), iso(gx + 1.35, gy + 1.35, 52), iso(gx + 0.6, gy + 0.6, 78)])} fill="#864030" stroke="#5a3a2a" />
      <g transform={`translate(${hub[0] - 6},${hub[1] + 10})`}>
        <g className="town-windmill">
          {[0, 90, 180, 270].map((a) => (
            <g key={a} transform={`rotate(${a})`}>
              <rect x="-2" y="-34" width="4" height="34" fill="#7a5a3a" />
              <rect x="1" y="-32" width="9" height="24" fill="#fffaf0" stroke="#9b7b55" />
            </g>
          ))}
          <circle r="4" fill="#5a3a2a" />
        </g>
      </g>
    </g>
  )
}

/** 营火：野外小屋门口的一小堆火。 */
export function Campfire({ gx, gy }: { gx: number; gy: number }) {
  const [x, y] = iso(gx, gy)
  return (
    <g aria-hidden transform={`translate(${x},${y})`}>
      <ellipse rx="12" ry="5" fill="rgba(60,40,20,.25)" />
      {[0, 1, 2, 3, 4, 5].map((i) => {
        const a = (i / 6) * Math.PI * 2
        return <circle key={i} cx={Math.cos(a) * 9} cy={Math.sin(a) * 4} r="2.4" fill="#9a958a" />
      })}
      <rect x="-8" y="-3" width="16" height="3.5" rx="1.5" fill="#7a5233" transform="rotate(18)" />
      <rect x="-8" y="-3" width="16" height="3.5" rx="1.5" fill="#6b4529" transform="rotate(-18)" />
      <g className="town-flame">
        <path d="M0,-2 C-7,-8 -3,-16 0,-24 C3,-16 7,-8 0,-2 Z" fill="#f29b3a" />
        <path d="M0,-3 C-4,-8 -1,-13 0,-17 C1,-13 4,-8 0,-3 Z" fill="#ffd36b" />
      </g>
    </g>
  )
}

/** 一段木栅栏，沿 x 方向从 gx 画到 gx + len。 */
export function Fence({ gx, gy, len }: { gx: number; gy: number; len: number }) {
  const posts: Pt[] = []
  for (let u = 0; u <= len + 1e-6; u += 0.7) posts.push(iso(gx + u, gy))
  const a = iso(gx, gy), b = iso(gx + len, gy)
  return (
    <g aria-hidden>
      <line x1={a[0]} y1={a[1] - 9} x2={b[0]} y2={b[1] - 9} stroke="#a07a52" strokeWidth="2.5" />
      <line x1={a[0]} y1={a[1] - 4} x2={b[0]} y2={b[1] - 4} stroke="#a07a52" strokeWidth="2.5" />
      {posts.map(([x, y], i) => <rect key={i} x={x - 1.6} y={y - 13} width="3.2" height="13" fill="#8a6440" />)}
    </g>
  )
}
