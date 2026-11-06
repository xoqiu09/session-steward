import { useId } from 'react'
import { iso, pts, type Pt } from './iso'
import { useTownArt } from './appearance'

/** Explicit preview opt-in; the installed town and its saved settings keep their current appearance. */
export const storybookRequested = (search: string) => new URLSearchParams(search).get('town-art') === 'storybook'

export const STORY = {
  cream: '#f7efdf', grass: '#bccb9f', moss: '#78916b', wood: '#a77b51',
  ink: '#574736', path: '#e5d2ad', water: '#8bb9be',
} as const

// Viewports into the original transparent atlas. No bitmap is resampled or edited.
const PROPS = {
  cottage: { crop: [24, 65, 526, 450], foot: [278, 488] },
  oak: { crop: [555, 28, 463, 482], foot: [772, 480] },
  hydrangea: { crop: [1080, 266, 395, 246], foot: [1280, 479] },
  flowers: { crop: [90, 712, 355, 275], foot: [270, 948] },
  tea: { crop: [548, 658, 462, 331], foot: [775, 947] },
  bookcase: { crop: [1090, 575, 365, 421], foot: [1271, 957] },
  birch: { crop: [32,20,440,490], foot: [263,484], src: '/town/storybook/nature.png' },
  maple: { crop: [545,24,452,486], foot: [772,488], src: '/town/storybook/nature.png' },
  willow: { crop: [1060,75,445,434], foot: [1282,489], src: '/town/storybook/nature.png' },
  stones: { crop: [30,735,425,245], foot: [258,958], src: '/town/storybook/nature.png' },
  wildflowers: { crop: [535,696,450,280], foot: [770,956], src: '/town/storybook/nature.png' },
  ferns: { crop: [1052,688,444,285], foot: [1272,955], src: '/town/storybook/nature.png' },
} as const
export type StoryPropKind = keyof typeof PROPS

// Original miniature cutouts. Coordinates are measured from alpha silhouettes;
// image data and the CrossPet characters are never rescaled on disk.
const MINI_PROPS = {
  cottage: { crop: [70, 40, 410, 447], foot: [274, 481] },
  oak: { crop: [544, 16, 452, 472], foot: [768, 481] },
  birch: { crop: [1099, 16, 335, 470], foot: [1259, 480] },
  tea: { crop: [39, 663, 455, 317], foot: [266, 973] },
  bookcase: { crop: [589, 551, 337, 434], foot: [757, 979] },
  flowers: { crop: [1042, 710, 460, 270], foot: [1272, 973] },
} as const
const MINI_KIND: Record<StoryPropKind, keyof typeof MINI_PROPS> = {
  cottage: 'cottage', oak: 'oak', hydrangea: 'flowers', flowers: 'flowers', tea: 'tea', bookcase: 'bookcase',
  birch: 'birch', maple: 'oak', willow: 'birch', stones: 'flowers', wildflowers: 'flowers', ferns: 'flowers',
}

export function StoryProp({ kind, at, width }: { kind: StoryPropKind; at: Pt; width: number }) {
  const { miniature } = useTownArt()
  const paint = useId()
  const prop = miniature ? MINI_PROPS[MINI_KIND[kind]] : PROPS[kind], { crop: [x, y, w, h], foot: [fx, fy] } = prop
  const scale = width / w
  return <svg className={`town-story-prop${miniature ? ' town-miniature-prop' : 'src' in prop ? ' town-story-nature' : ''}`} data-town-prop={kind} data-storybook-prop={miniature ? undefined : kind} aria-hidden="true" pointerEvents="none"
    x={at[0] - (fx - x) * scale} y={at[1] - (fy - y) * scale} width={width} height={h * scale}
    viewBox={`0 0 ${w} ${h}`} overflow="hidden">
    {/* A paint definition keeps the source atlas outside visible object bounds,
        so accessible clicks target the prop rectangle rather than the atlas. */}
    <defs><pattern id={paint} patternUnits="userSpaceOnUse" width={w} height={h}>
      <image x={-x} y={-y} href={miniature ? '/town/miniature/props.png' : 'src' in prop ? prop.src : '/town/storybook/props.png'} width="1536" height="1024" />
    </pattern></defs>
    <rect width={w} height={h} fill={`url(#${paint})`} />
  </svg>
}

/** Small, static details replace the construction grid without adding animation work. */
export function StoryGrass() {
  const { miniature } = useTownArt()
  if (miniature) return <g aria-hidden="true" opacity=".23">
    <ellipse cx="55" cy="45" rx="45" ry="18" fill="#e7eed3" />
    <ellipse cx="185" cy="97" rx="45" ry="16" fill="#adcb96" />
    {[[22,26],[102,89],[170,33]].map(([x,y],i)=><g key={i}><ellipse cx={x} cy={y} rx="2.3" ry="1.1" fill="#f7f9e6" /><ellipse cx={x+5} cy={y+2} rx="1.8" ry="1" fill="#91ad7f" /></g>)}
  </g>
  return <>
    <path d="M12 30 Q46 4 81 24 Q109 44 80 61 Q39 76 12 52Z M126 74 Q155 38 198 62 Q235 84 206 111 Q165 129 126 98Z" fill="#90a777" opacity=".13" />
    {Array.from({length:23},(_,i) => {
      const x=(i*73+17)%231+4,y=(i*43+i*i*7+9)%111+4
      return <g key={i} transform={`translate(${x},${y})`} opacity={i%3 ? '.26' : '.4'}>
        <path d="M0 0 q-3-5-2-7 M0 0 q1-5 4-5" fill="none" stroke="#7b9369" strokeWidth=".65" strokeLinecap="round" />
        {i%4===0 && <ellipse cx="7" cy="3" rx="1.2" ry=".7" fill="#f6ebca" />}
      </g>
    })}
  </>
}

export function storyBlob(points: readonly Pt[]): string {
  if (points.length<3) return ''
  const mid=(a:Pt,b:Pt):Pt=>[(a[0]+b[0])/2,(a[1]+b[1])/2]
  return `M${mid(points[points.length-1],points[0]).join(',')} ${points.map((p,i)=>`Q${p.join(',')} ${mid(p,points[(i+1)%points.length]).join(',')}`).join(' ')} Z`
}

export function StoryClearing({ gx,gy,w,d,fill,opacity=.45 }: { gx:number;gy:number;w:number;d:number;fill:string;opacity?:number }) {
  const edge=[[.04,.15],[.2,.03],[.47,.08],[.75,.02],[.97,.15],[.94,.42],[1,.71],[.87,.97],[.6,.92],[.32,1],[.06,.87],[.02,.59]]
  return <path d={storyBlob(edge.map(([x,y])=>iso(gx+x*w,gy+y*d)))} fill={fill} opacity={opacity} aria-hidden="true" pointerEvents="none" />
}

/** Keep the existing walk centreline, vary only the painted edges and little pebbles. */
export function StoryTrail({ from,to,width=16 }: { from:Pt;to:Pt;width?:number }) {
  const { miniature } = useTownArt()
  const a=iso(...from),b=iso(...to),dx=b[0]-a[0],dy=b[1]-a[1],len=Math.hypot(dx,dy)
  if (len<.01) return null
  const n=Math.min(80,Math.max(3,Math.ceil(len/16))),normal:Pt=[-dy/len,dx/len]
  const side=(sign:number):Pt[] => Array.from({length:n+1},(_,i)=>{
    const t=i/n,edge=width/2*(.94+.12*Math.sin(i*1.73+a[0]*.11+a[1]*.07))
    return [a[0]+dx*t+normal[0]*edge*sign,a[1]+dy*t+normal[1]*edge*sign]
  })
  return <g aria-hidden="true" pointerEvents="none" className="town-story-trail">
    <path d={storyBlob([...side(1),...side(-1).reverse()])} fill={miniature ? '#edddbd' : '#e5d4b1'} stroke={miniature ? '#b4bc96' : '#b4a580'} strokeWidth={miniature ? '2.5' : '1.4'} strokeOpacity=".28" />
    {!miniature && Array.from({length:Math.min(16,n)},(_,i)=>{
      const t=(i+.5)/Math.min(16,n),offset=Math.sin(i*3.7+a[0])*(width*.23)
      return <ellipse key={i} cx={a[0]+dx*t+normal[0]*offset} cy={a[1]+dy*t+normal[1]*offset} rx={i%3===0 ? 1.6 : .8} ry=".6" fill={i%2 ? '#f8ebce' : '#c4b390'} opacity=".6" />
    })}
  </g>
}

export function StoryTree({ at,width }: { at:Pt;width:number }) {
  const { miniature } = useTownArt()
  const seed=Math.abs(Math.round(at[0]*.17+at[1]*.23)),kinds = miniature ? ['oak','birch'] as const : ['oak','birch','maple','willow'] as const
  const k=.92+(seed%9)*.02
  const kind = kinds[seed%kinds.length]
  return <g transform={`translate(${at.join(',')}) scale(${seed%2 ? -1 : 1},1)`} aria-hidden="true" pointerEvents="none">
    <ellipse rx={width*.16} ry={width*.045} fill="#65744d" opacity=".13" />
    <StoryProp kind={kind} at={[0,0]} width={width*k*(miniature && kind === 'birch' ? .74 : 1)} />
  </g>
}

export function StoryGardenDetails() {
  return <g aria-hidden="true" pointerEvents="none">
    {[[.2, 2.7, 37], [8.6, 4.8, 41], [7.9, 7.8, 48], [.4, 8.3, 38]].map(([x,y,w], i) =>
      <StoryProp key={i} kind={i % 2 ? 'flowers' : 'hydrangea'} at={iso(x,y)} width={w} />)}
    {[[.3,3.7], [8.5,6.1], [3.6,8.3], [6.6,.2]].map(([x,y], i) => {
      const p=iso(x,y)
      return <g key={i} transform={`translate(${p.join(',')})`}>
        <path d="M-12 1 Q-7-6 0-3 Q8-7 14 0 Q7 7-3 5Z" fill="#a5bb8a" opacity=".55" />
        <path d="M-4 0 l-2-5 M-4 0 l2-5 M7 1 l2-4" stroke="#82996d" strokeWidth=".8" fill="none" strokeLinecap="round" />
      </g>
    })}
  </g>
}

export interface StoryFootprint { gx: number; gy: number; w: number; d: number }
export function storyLounge(occupied: readonly StoryFootprint[]): StoryFootprint | null {
  const corners = [{ gx: .7, gy: 6.1, w: 3.2, d: 3.2 }, { gx: 12, gy: 6.1, w: 3.2, d: 3.2 }]
  return corners.find(c => occupied.every(o => c.gx+c.w+.25 <= o.gx || o.gx+o.w+.25 <= c.gx || c.gy+c.d+.25 <= o.gy || o.gy+o.d+.25 <= c.gy)) ?? null
}

export function StoryRoomDecor({ occupied }: { occupied: readonly StoryFootprint[] }) {
  const lounge = storyLounge(occupied)
  const corner = lounge && ((x: number, y: number) => iso(lounge.gx+x,lounge.gy+y))
  return <g aria-hidden="true" pointerEvents="none" className="town-story-room-decor">
    {corner && <>
      <polygon points={pts([corner(0,0),corner(3.2,0),corner(3.2,3.2),corner(0,3.2)])} fill="#b9c19a" stroke="#e9e0c5" strokeWidth="5" strokeLinejoin="round" />
      <polygon points={pts([corner(.2,.2),corner(3,.2),corner(3,3),corner(.2,3)])} fill="none" stroke="#e8dfc3" strokeWidth="1.5" strokeDasharray="3 3" />
      <StoryProp kind="tea" at={corner(1.3,1.4)} width={108} />
    </>}
    <StoryProp kind="bookcase" at={iso(6.5,.65)} width={95} />
    <StoryProp kind="hydrangea" at={iso(.7,.8)} width={63} />
    <StoryProp kind="hydrangea" at={iso(14.8,.8)} width={54} />
  </g>
}

export function StoryDeskDetail({ gx, gy }: { gx: number; gy: number }) {
  const cup=iso(gx+.28,gy+.78,19)
  return <g aria-hidden="true" pointerEvents="none">
    {[.2,.5,.8].map(y => <path key={y} d={`M${iso(gx+.2,gy+y,18).join(',')} L${iso(gx+2.8,gy+y,18).join(',')}`} stroke="#fff0d2" opacity=".27" strokeWidth=".8" />)}
    <g transform={`translate(${cup.join(',')})`}>
      <path d="M-3-5 L-2 0 Q0 2 3 0 L4-5Z" fill="#fff8e4" stroke="#a18a67" strokeWidth=".6" />
      <ellipse cx=".5" cy="-5" rx="3.5" ry="1.5" fill="#b99260" stroke="#fff6df" strokeWidth=".8" />
      <path d="M4-4 Q8-4 6-1 L3 0" fill="none" stroke="#e9dbc1" strokeWidth="1.1" />
    </g>
  </g>
}
