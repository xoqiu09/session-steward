// 小镇世界的景物：松树、花丛、石头、池塘、风车、营火、栅栏。全部自己画的 SVG，按格子坐标摆放。
import { IsoBox, iso, pts, type Pt } from './iso'
import { StoryProp, storyBlob } from './storybook'
import { useTownArt } from './appearance'

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
  const { illustrated, miniature } = useTownArt()
  const [x, y] = at
  if (miniature) return <g aria-hidden="true" pointerEvents="none" transform={`translate(${x},${y}) scale(${k})`}>
    <ellipse rx="17" ry="5" fill="#5d7952" opacity=".15" />
    <path d="M-3 0V-22H3V0Z" fill="#a48561" />
    {[[-10, 28],[-24, 24],[-38, 18]].map(([y,w],i)=><path key={i} d={`M0 ${y-26} Q${-w*.35} ${y-17} ${-w} ${y} Q0 ${y+12} ${w} ${y} Q${w*.35} ${y-17} 0 ${y-26}Z`} fill={['#82ad74','#99bf82','#bdd795'][i]} stroke="#628b5a" strokeOpacity=".13" />)}
  </g>
  if (illustrated) return <g aria-hidden="true" transform={`translate(${x},${y}) scale(${k})`}>
    <ellipse rx="17" ry="5.5" fill="#69794d" opacity=".14" />
    <path d="M-3 0 L-2-27 3-27 3 0Z" fill="#977249" />
    <path d="M0-64 Q-4-51-14-43 Q-10-40-5-41 Q-12-31-22-23 Q-15-19-9-21 Q-15-10-24-8 Q-11 2 0-3 Q15 3 24-8 Q13-16 9-21 Q18-19 22-23 Q12-32 5-41 Q11-40 14-43 Q5-53 0-64Z" fill="#799668" stroke="#65855e" strokeWidth=".8" strokeLinejoin="round" />
    <path d="M0-59 Q-3-48-11-43 M-4-36 Q-8-28-15-24 M-7-17 Q-11-11-17-8" fill="none" stroke="#a9bd85" strokeWidth="3" opacity=".65" strokeLinecap="round" />
  </g>
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
  const { illustrated } = useTownArt()
  const [x, y] = iso(gx, gy)
  if (illustrated) return <StoryProp kind="wildflowers" at={[x,y]} width={23+Math.abs(seed)%5} />
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
  const { illustrated, miniature } = useTownArt()
  if (miniature) return <g aria-hidden="true" pointerEvents="none" transform={`translate(${iso(gx+.3*k,gy+.25*k).join(',')}) scale(${k})`}>
    <ellipse rx="20" ry="6" fill="#729563" opacity=".13" />
    <path d="M-19-3Q-19-12-8-12Q0-22 11-13Q20-10 19-2Q3 7-19-3" fill="#adbba6" />
    <path d="M-17-6Q-15-13-7-13Q0-20 9-12Q5-5-6-3Z" fill="#d8dfc9" />
    <ellipse cx="21" cy="1" rx="5" ry="3" fill="#c8d5bb" />
  </g>
  if (illustrated) return <StoryProp kind="stones" at={iso(gx+.3*k,gy+.25*k)} width={29*k} />
  return <IsoBox gx={gx} gy={gy} w={0.7 * k} d={0.55 * k} h={9 * k} top="#c4c2b8" left="#a8a59a" right="#93907f" />
}

/** 池塘：不规则的水面，水波线条会闪。 */
export function Pond({ gx, gy, w, d }: { gx: number; gy: number; w: number; d: number }) {
  const { illustrated, miniature } = useTownArt()
  const ring: Pt[] = []
  for (let i = 0; i < 12; i++) {
    const a = (i / 12) * Math.PI * 2
    const r = 0.86 + 0.14 * Math.sin(i * 2.3)
    ring.push(iso(gx + w / 2 + Math.cos(a) * (w / 2) * r, gy + d / 2 + Math.sin(a) * (d / 2) * r))
  }
  const c = iso(gx + w / 2, gy + d / 2)
  const mid = (a: Pt, b: Pt): Pt => [(a[0]+b[0])/2,(a[1]+b[1])/2]
  const waterPath = `M${mid(ring[ring.length-1],ring[0]).join(',')} ${ring.map((p,i) => `Q${p.join(',')} ${mid(p,ring[(i+1)%ring.length]).join(',')}`).join(' ')} Z`
  return (
    <g aria-hidden>
      <polygon points={pts(ring)} fill="#a9c98f" transform={`translate(0,3)`} />
      {illustrated ? <path d={waterPath} fill={miniature ? "#a7d2ca" : "#8db8bf"} stroke={miniature ? "#7fafa5" : "#789ea3"} strokeWidth="1.5" /> : <polygon points={pts(ring)} fill="#7fb3d5" stroke="#6a9cbd" strokeWidth="1.5" />}
      {illustrated && ring.map(([x,y], i) => <ellipse key={i} cx={x} cy={y} rx={4.5+i%3} ry={2.5+i%2} transform={`rotate(${i*27},${x},${y})`} fill={i%2 ? '#d4cbb0' : '#e7dec6'} stroke="#b4ad91" strokeWidth=".6" />)}
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

type LakeShape = { ring: [number, number][]; cx: number; cy: number; island: { gx: number; gy: number; r: number } | null }

/**
 * 按轮廓画的湖，轮廓由地形按位置生成，每个湖都不一样。湖是平的，统一画在地面层：
 * 先画所有湖的岸和描边，再盖上所有水面，相邻格子的湖叠在一起时看不到接缝。
 */
export function Lakes({ shapes }: { shapes: LakeShape[] }) {
  const { illustrated, miniature } = useTownArt()
  const rings = shapes.map((s) => pts(s.ring.map(([gx, gy]) => iso(gx, gy))))
  const paths = illustrated ? shapes.map(s=>storyBlob(s.ring.map(([gx,gy])=>iso(gx,gy)))) : []
  return (
    <g aria-hidden>
      {illustrated ? <>
        {paths.map((p,i)=><path key={`shore${i}`} d={p} fill="#a9b995" stroke="#b8c49c" strokeWidth="10" />)}
        {paths.map((p,i)=><path key={`water${i}`} d={p} fill={miniature ? "#a7d2ca" : "#91b9bc"} />)}
      </> : <>
        {rings.map((r, i) => <polygon key={`b${i}`} points={r} fill="#a9c98f" transform="translate(0,4)" />)}
        {rings.map((r, i) => <polygon key={`s${i}`} points={r} fill="#6a9cbd" stroke="#6a9cbd" strokeWidth="3" strokeLinejoin="round" />)}
        {rings.map((r, i) => <polygon key={`w${i}`} points={r} fill="#7fb3d5" />)}
      </>}
      {shapes.map((s, i) => {
        const c = iso(s.cx, s.cy)
        return [-1, 0, 1].map((j) => (
          <line key={`l${i}-${j}`} className="town-shimmer" x1={c[0] - 22 + j * 14} y1={c[1] + j * 9} x2={c[0] + 8 + j * 14} y2={c[1] + j * 9} stroke="#e8f4fb" strokeWidth="2" strokeLinecap="round" strokeDasharray="6 10" />
        ))
      })}
      {shapes.map((s, i) => {
        if (!s.island) return null
        const [x, y] = iso(s.island.gx, s.island.gy)
        return <g key={`i${i}`}><ellipse cx={x} cy={y + 2} rx={s.island.r * 34} ry={s.island.r * 17} fill="#9cc07f" /><ellipse cx={x} cy={y} rx={s.island.r * 30} ry={s.island.r * 15} fill="#b7d79a" /></g>
      })}
    </g>
  )
}

/** 山坡上的土丘：底下一圈深色、上面抬起一圈浅色。 */
export function Mound({ ring, lift }: { ring: [number, number][]; lift: number }) {
  const base = ring.map(([gx, gy]) => iso(gx, gy))
  const cx = ring.reduce((n, p) => n + p[0], 0) / ring.length, cy = ring.reduce((n, p) => n + p[1], 0) / ring.length
  const top = ring.map(([gx, gy]) => iso(cx + (gx - cx) * 0.62, cy + (gy - cy) * 0.62, lift))
  return (
    <g aria-hidden>
      <polygon points={pts(base)} fill="#cfc79f" />
      <polygon points={pts(base.map(([x, y], i) => [(x + top[i][0]) / 2, (y + top[i][1]) / 2] as Pt))} fill="#d8d1aa" />
      <polygon points={pts(top)} fill="#e2dcb8" />
    </g>
  )
}

/** 矮灌木：几团圆。 */
export function Bush({ at, k = 1 }: { at: Pt; k?: number }) {
  const { illustrated } = useTownArt()
  const [x, y] = at
  if (illustrated) return <StoryProp kind="ferns" at={at} width={34*k} />
  return (
    <g aria-hidden transform={`translate(${x},${y}) scale(${k})`}>
      <ellipse rx="11" ry="4" fill="rgba(40,25,10,.16)" />
      <circle cx="-5" cy="-6" r="6.5" fill="#7aa866" />
      <circle cx="5" cy="-6" r="6" fill="#86b46f" />
      <circle cy="-10" r="6" fill="#93c27b" />
    </g>
  )
}

/** 岸边的芦苇。 */
export function Reeds({ at, k = 1 }: { at: Pt; k?: number }) {
  const [x, y] = at
  return (
    <g aria-hidden transform={`translate(${x},${y}) scale(${k})`} stroke="#6f9a52" strokeWidth="1.6" strokeLinecap="round">
      <line x1="-4" y1="0" x2="-6" y2="-14" />
      <line x1="0" y1="0" x2="0" y2="-18" />
      <line x1="4" y1="0" x2="6" y2="-12" />
      <rect x="-1.6" y="-22" width="3.2" height="7" rx="1.6" fill="#8a6440" stroke="none" />
    </g>
  )
}
