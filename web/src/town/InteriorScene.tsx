// 项目室内：走进一栋建筑，看这个项目里的事。工作台 = 工作项，会话小人站在自己的工作台前，
// 待验收的箱子放在台上，墙上白板是这个项目里等你决定的事。只读：点任何东西都打开 SS 原有详情。
import { IsoBox, IsoTile, iso, pts, type Pt } from './iso'
import { characterStatusLabel, clip, itemStatusLabel, type BuildingView, type Highlight, type TownModel } from './townModel'
import {
  Character, Crate, Parcel, StatusPill, Tag, activate, buildingColors, charLook, charMatches, onReviewDesk, parcelMatches, parcelTitle,
  type Selection,
} from './TownScene'
import { Flowers, Pine } from './scenery'
import type { WorkItem } from '../types'

const ROOM_W = 16
const ROOM_D = 12
const WALL_H = 120
const COLS = 3
const ROWS = 3
const BENCH_W = 3.0
const BENCH_D = 1.1

const ORDER: Record<WorkItem['status'], number> = { review: 0, blocked: 1, in_progress: 2, todo: 3, done: 4, abandoned: 5 }
const BENCH_TOP: Record<WorkItem['status'], string> = {
  review: '#c9d0f5', blocked: '#f2c4bd', in_progress: '#f6dfa6', todo: '#e6dccb', done: '#cfe3c9', abandoned: '#ddd',
}
const STATUS_FG: Record<WorkItem['status'], string> = {
  review: '#2f3a8f', blocked: '#8f2a22', in_progress: '#7a5400', todo: '#6b5a44', done: '#2e5d34', abandoned: '#777',
}

/** 工作台在房间里的位置（格子坐标，左上角）。 */
export function benchSpot(i: number): { gx: number; gy: number } {
  const col = i % COLS, row = Math.floor(i / COLS)
  return { gx: 1.2 + col * 4.9, gy: 2.2 + row * 3.2 }
}

/** 摆上工作台的工作项：未完成的，待验收、受阻优先，最多 COLS×ROWS 张台。 */
export function benchItems(b: BuildingView): { shown: WorkItem[]; more: number } {
  const open = b.items.filter((w) => w.status !== 'done' && w.status !== 'abandoned')
    .slice().sort((x, y) => ORDER[x.status] - ORDER[y.status] || y.updated_at.localeCompare(x.updated_at))
  const cap = COLS * ROWS
  return { shown: open.slice(0, cap), more: Math.max(0, open.length - cap) }
}

export function interiorViewBox(): string {
  const a = iso(0, 0, WALL_H + 40), r = iso(ROOM_W, 0), b = iso(ROOM_W, ROOM_D), l = iso(0, ROOM_D)
  const x0 = l[0] - 30, x1 = r[0] + 30, y0 = a[1] - 20, y1 = b[1] + 60
  return `${x0} ${y0} ${x1 - x0} ${y1 - y0}`
}

export function InteriorScene({ b, model, selected, highlight, onSelect, changed = new Set(), offline = false }: {
  b: BuildingView
  model: TownModel
  selected: Selection | null
  highlight: Highlight | null
  onSelect: (s: Selection) => void
  changed?: ReadonlySet<string>
  offline?: boolean
}) {
  const isSel = (kind: Selection['kind'], key: string) => selected?.kind === kind && selected.key === key
  const dim = (match: boolean) => (highlight && !match ? ' is-dim' : '')
  const flash = (key: string) => (changed.has(key) ? ' is-changed' : '')
  const colors = buildingColors(b.repo?.id)
  const { shown, more } = benchItems(b)
  const benchOf = new Map(shown.map((w, i) => [w.id, i]))
  const approvals = model.pendingApprovals.filter((a) => (b.repo && a.repo_id === b.repo.id) || b.characters.some((c) => c.session.id === a.session_id))
  const failed = b.parcels.filter((p) => p.phase === 'failed')

  // 小人：有工作台的站在台前，没有的在门口休息区。
  let lobby = 0
  const people = b.characters.map((c) => {
    const i = c.item ? benchOf.get(c.item.id) : undefined
    if (i != null) {
      const s = benchSpot(i)
      const sameBench = b.characters.filter((x) => x.item?.id === c.item!.id)
      const k = sameBench.indexOf(c)
      return { c, at: iso(s.gx + 0.8 + k * 1.2, s.gy + BENCH_D + 0.9) }
    }
    const at = iso(ROOM_W - 2.2 - (lobby % 2) * 1.4, ROOM_D - 1.2 - Math.floor(lobby / 2) * 1.3)
    lobby++
    return { c, at }
  })

  const wallLeft = (gx0: number, gx1: number, z0: number, z1: number) => pts([iso(gx0, 0, z0), iso(gx1, 0, z0), iso(gx1, 0, z1), iso(gx0, 0, z1)])
  const wallRight = (gy0: number, gy1: number, z0: number, z1: number) => pts([iso(0, gy0, z0), iso(0, gy1, z0), iso(0, gy1, z1), iso(0, gy0, z1)])
  const board = iso(ROOM_W - 3.2, 0, 96)

  return (
    <svg className={`town-svg is-interior${offline ? ' is-offline' : ''}`} viewBox={interiorViewBox()} role="group" aria-label={`${b.name} 室内`}>
      <defs>
        <pattern id="interior-planks" width="60" height="30" patternUnits="userSpaceOnUse">
          <path d="M0 15 L30 0 M30 30 L60 15" stroke="#c8a77a" strokeWidth="1" />
        </pattern>
      </defs>
      {/* 地板与墙 */}
      <IsoBox gx={0} gy={0} w={ROOM_W} d={ROOM_D} h={14} z={-14} top="#e3c79b" left="#b98a52" right="#9c7140" />
      <IsoTile gx={0} gy={0} w={ROOM_W} d={ROOM_D} fill="url(#interior-planks)" />
      <polygon points={wallLeft(0, ROOM_W, 0, WALL_H)} fill="#f4ead8" stroke="#c9b48e" />
      <polygon points={wallRight(0, ROOM_D, 0, WALL_H)} fill="#e9dcc2" stroke="#c9b48e" />
      <polygon points={wallLeft(0, ROOM_W, 0, 16)} fill={colors.accent} opacity="0.35" />
      <polygon points={wallRight(0, ROOM_D, 0, 16)} fill={colors.accent} opacity="0.3" />
      {/* 窗户：右墙两扇，能看到外面的树 */}
      {[2.2, 6.4].map((gy) => (
        <g key={gy} aria-hidden>
          <polygon points={wallRight(gy, gy + 2.4, 50, 96)} fill="#cfe6f2" stroke="#8a6a3a" strokeWidth="3" />
          <Pine at={iso(0, gy + 1.2, 52)} k={0.55} />
        </g>
      ))}
      {/* 项目名横幅 */}
      <g transform={`translate(${iso(3.8, 0, 104)[0]},${iso(3.8, 0, 104)[1]})`}>
        <rect x={-(Math.min(b.name.length, 22) * 9 + 30) / 2} y={-16} width={Math.min(b.name.length, 22) * 9 + 30} height={30} rx="6" fill="#fffaf0" stroke={colors.accent} strokeWidth="3" />
        <text y="5" textAnchor="middle" fontSize="16" fontWeight="800" fill="#3a2a1c">{clip(b.name, 22)}</text>
      </g>
      {/* 白板：这个项目里等你决定的事 */}
      <g transform={`translate(${board[0]},${board[1]})`} className={dim(highlight === 'waiting')}>
        <rect x="-92" y="-46" width="184" height={58 + Math.max(1, Math.min(3, approvals.length)) * 28} rx="6" fill="#fdfdfb" stroke="#8d8270" strokeWidth="3" />
        <text x="0" y="-24" textAnchor="middle" fontSize="14" fontWeight="800" fill="#3a2a1c">等你决定 · {approvals.length}</text>
        {approvals.length === 0 && <text x="0" y="6" textAnchor="middle" fontSize="12" fill="#7a6a55">这里暂时没有</text>}
        {approvals.slice(0, 3).map((a, i) => (
          <g key={a.id} className={`town-obj${isSel('approval', a.id) ? ' is-selected' : ''}`} {...activate(() => onSelect({ kind: 'approval', key: a.id }))} aria-label={`待决定：${a.preview}`}>
            <rect x="-84" y={-12 + i * 28} width="168" height="24" rx="4" fill="#fffbe6" stroke={isSel('approval', a.id) ? '#2d6cdf' : '#c9a227'} />
            <text x="-78" y={4 + i * 28} fontSize="11" fill="#3a2a1c"><tspan fontWeight="700" fill="#8a6a10">{a.kind === 'permission' ? '权限' : a.kind === 'merge' ? '合并' : '决定'}</tspan> {clip(a.preview, 14)}</text>
          </g>
        ))}
      </g>
      {/* 角落：盆栽、地毯、退件筐 */}
      <IsoTile gx={ROOM_W - 4.6} gy={ROOM_D - 3.4} w={4} d={2.8} fill={colors.accent} opacity={0.18} />
      <Flowers gx={0.8} gy={ROOM_D - 0.8} seed={b.key.length * 13} />
      <IsoBox gx={0.4} gy={0.4} w={1} d={1} h={14} top="#a07a52" left="#b98a52" right="#9c7140" />
      <Pine at={iso(0.9, 0.9, 14)} k={0.6} />
      {failed.length > 0 && (
        <g className={dim(highlight === 'failed')}>
          <IsoBox gx={ROOM_W - 1.8} gy={0.8} w={1.3} d={1.1} h={12} top="#7a3a32" left="#a5483e" right="#8a3c33" />
          <Tag at={iso(ROOM_W - 1.15, 1.35, 44)} text={`退件 ${failed.length}`} bg="#d2483d" fg="#fff" small />
        </g>
      )}

      {/* 工作台：按前后顺序画 */}
      {shown.map((w, i) => ({ w, s: benchSpot(i) })).sort((a, b) => a.s.gx + a.s.gy - (b.s.gx + b.s.gy)).map(({ w, s }) => {
        const review = b.parcels.filter((p) => p.item?.id === w.id && onReviewDesk(p))
        return (
          <g key={w.id} className={`town-obj town-bench${isSel('item', w.id) ? ' is-selected' : ''}${dim(highlight === 'review' ? w.status === 'review' : highlight === 'failed' ? false : !highlight)}`}
            {...activate(() => onSelect({ kind: 'item', key: w.id }))} aria-label={`工作项 ${w.id} ${w.title}：${itemStatusLabel[w.status]}`}>
            <IsoBox gx={s.gx} gy={s.gy} w={BENCH_W} d={BENCH_D} h={18} top={BENCH_TOP[w.status]} left="#b98a52" right="#9c7140" stroke={isSel('item', w.id) ? '#2d6cdf' : undefined} />
            {review.slice(0, 2).map((p, k) => <Crate key={p.key} at={iso(s.gx + 2.1 + k * 0.5, s.gy + 0.5, 18)} fill="#d6b27a" tape="#5b6cd8" />)}
          </g>
        )
      })}
      {more > 0 && <Tag at={iso(2.6, ROOM_D - 0.6)} text={`还有 ${more} 项未摆上工作台，在列表里`} bg="#fffaf0" fg="#6b5a44" />}
      {shown.length === 0 && <Tag at={iso(ROOM_W / 2, ROOM_D / 2)} text="这里暂时没有未完成的工作" bg="#fffaf0" fg="#6b5a44" />}

      {/* 运行中的包裹放在对应工作台上 */}
      {b.parcels.filter((p) => p.phase === 'moving' && p.item && benchOf.has(p.item.id)).sort((x, y) => x.run.id - y.run.id).map((p) => {
        const s = benchSpot(benchOf.get(p.item!.id)!)
        const stale = p.session ? b.characters.find((c) => c.session.id === p.session!.id)?.status === 'stale' : false
        return <Parcel key={p.key} at={iso(s.gx + 0.7, s.gy + 0.5, 18)} p={p} stale={stale} moving={!stale} selected={isSel('parcel', p.key)}
          dimClass={dim(highlight ? parcelMatches(p, highlight, !!stale) : true) + flash(p.key)} onSelect={() => onSelect({ kind: 'parcel', key: p.key })} label={<title>{parcelTitle(p, 40)}</title>} />
      })}

      {/* 工作台名牌：放在上层，避免被后面的台子挡住 */}
      {shown.map((w, i) => {
        const s = benchSpot(i)
        const label = iso(s.gx + BENCH_W / 2, s.gy + BENCH_D / 2, 44)
        return (
          <g key={`lb-${w.id}`} className={`town-obj${dim(highlight === 'review' ? w.status === 'review' : highlight === 'failed' ? false : !highlight)}`} transform={`translate(${label[0]},${label[1]})`}
            {...activate(() => onSelect({ kind: 'item', key: w.id }))} aria-hidden>
            <rect x="-64" y="-30" width="128" height="32" rx="6" fill="#fffaf0" stroke={STATUS_FG[w.status]} strokeWidth="1.5" />
            <text x="0" y="-17" textAnchor="middle" fontSize="9.5" fontWeight="700" fill={STATUS_FG[w.status]}>{itemStatusLabel[w.status]} · {w.id}</text>
            <text x="0" y="-4" textAnchor="middle" fontSize="11" fill="#3a2a1c">{clip(w.title, 11)}</text>
            {w.status === 'blocked' && <g transform="translate(58,-30)"><circle r="9" fill="#d2483d" /><text y="4" textAnchor="middle" fontSize="12" fontWeight="800" fill="#fff">!</text></g>}
          </g>
        )
      })}

      {/* 小人与状态牌 */}
      {people.map(({ c, at }) => (
        <Character key={c.key} at={at} c={c} selected={isSel('character', c.key)}
          dimClass={dim(highlight ? charMatches(c, highlight) : true) + flash(c.key)} onSelect={() => onSelect({ kind: 'character', key: c.key })} />
      ))}
      {people.map(({ c, at }) => {
        const { style, st } = charLook(c)
        const label = characterStatusLabel[c.status]
        return (
          <g key={`${c.key}-pill`} transform={`translate(${at[0]},${at[1]}) scale(1.22)`} aria-hidden className={dim(highlight ? charMatches(c, highlight) : true)}>
            <StatusPill at={[0, 17]} name={c.name} status={offline && c.status === 'working' ? `断线前·${label}` : label} bg={st.bg} fg={st.fg} edge={style.body} />
          </g>
        )
      })}
      {b.characters.length === 0 && <Tag at={[iso(ROOM_W - 2.5, ROOM_D - 1.5)[0], iso(ROOM_W - 2.5, ROOM_D - 1.5)[1] - 10] as Pt} text="现在没有会话在这里" bg="#fffaf0" fg="#6b5a44" small />}
    </svg>
  )
}
