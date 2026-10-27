// 门口的菜地：3×3 的田垄，每棵菜是一个工作项，长势对应状态。点菜打开工作项（验收卡片）。全部自己画的 SVG。
import { IsoBox, iso, type Pt } from './iso'
import { Tag, activate, type Selection } from './TownScene'
import { CROP_NAME, STAGE_LABEL, cropsOf, cropKindOf, type Crop, type CropKind } from './harvest'
import type { BuildingView } from './townModel'
import type { Approval } from '../types'

export const FIELD_COLS = 3

export function Field({ gx, gy, b, pending, now, selectedKey, dimClass = '', onSelect }: {
  gx: number; gy: number; b: BuildingView; pending: readonly Approval[]; now: number; selectedKey: string | null; dimClass?: string; onSelect: (s: Selection) => void
}) {
  const { crops, more } = cropsOf(b, pending, now)
  if (!crops.length) return null
  const kind = cropKindOf(b.repo?.id)
  const rows = Math.ceil(crops.length / FIELD_COLS)
  const ripe = crops.filter((c) => c.stage === 'ripe').length
  const spot = (i: number): Pt => iso(gx + 0.5 + (i % FIELD_COLS), gy + 0.5 + Math.floor(i / FIELD_COLS))
  // 远的先画，近的盖住远的。
  const order = crops.map((c, i) => ({ c, i })).sort((a, z) => (a.i % FIELD_COLS) + Math.floor(a.i / FIELD_COLS) - ((z.i % FIELD_COLS) + Math.floor(z.i / FIELD_COLS)))
  return (
    <g className={`town-field${dimClass}`} aria-label={`${b.name} 的${CROP_NAME[kind]}地：${crops.length + more} 棵，熟了 ${ripe} 棵`}>
      <IsoBox gx={gx} gy={gy} w={FIELD_COLS} d={rows} h={4} top="#8a6644" left="#6f5034" right="#5e432b" />
      {Array.from({ length: rows }, (_, r) => {
        const a = iso(gx + 0.12, gy + 0.5 + r, 4), z = iso(gx + FIELD_COLS - 0.12, gy + 0.5 + r, 4)
        return <line key={r} x1={a[0]} y1={a[1]} x2={z[0]} y2={z[1]} stroke="#6b4b2e" strokeWidth="5" strokeLinecap="round" opacity="0.55" />
      })}
      {order.map(({ c, i }) => {
        const [x, y] = spot(i)
        return (
          <g key={c.item.id} transform={`translate(${x},${y - 4})`}
            className={`town-obj town-crop is-${c.stage}${c.overripe ? ' is-overripe' : ''}${selectedKey === c.item.id ? ' is-selected' : ''}`}
            aria-label={`${c.item.id} ${c.item.title}：${STAGE_LABEL[c.stage]}${c.overripe ? '，熟了很久还没收' : ''}`}
            {...activate(() => onSelect({ kind: 'item', key: c.item.id }))}>
            <title>{`${c.item.id} ${c.item.title}\n${STAGE_LABEL[c.stage]}${c.overripe ? '（熟了很久还没收）' : ''}`}</title>
            <rect x="-18" y="-56" width="36" height="60" fill="transparent" />
            {selectedKey === c.item.id && <ellipse rx="19" ry="9" fill="none" stroke="#2d6cdf" strokeWidth="2.5" />}
            <g transform="scale(1.5)"><CropShape crop={c} kind={kind} /></g>
          </g>
        )
      })}
      {ripe > 0 && <Tag at={iso(gx + FIELD_COLS + 0.2, gy - 0.1, 30)} text={`熟了 ${ripe}${more ? ` · 另 ${more} 棵` : ''}`} bg="#fff4e0" fg="#8a3a12" small border="#e07b39" />}
      {!ripe && more > 0 && <Tag at={iso(gx + FIELD_COLS + 0.2, gy - 0.1, 30)} text={`另 ${more} 棵`} bg="#fffaf0" fg="#6b5a44" small />}
    </g>
  )
}

const LEAF = '#5f9e4f', LEAF_DARK = '#4a7f3d', DRY = '#b8a35a'

function Sprout({ color = LEAF, droop = false }: { color?: string; droop?: boolean }) {
  return (
    <g>
      <path d="M0,0 L0,-12" stroke={color} strokeWidth="2.2" />
      <path d={droop ? 'M0,-9 q-7,2 -9,8' : 'M0,-9 q-8,-5 -10,-1 q4,4 10,1'} fill={droop ? 'none' : color} stroke={color} strokeWidth="1.6" />
      <path d={droop ? 'M0,-10 q7,2 9,8' : 'M0,-11 q8,-6 11,-2 q-4,5 -11,2'} fill={droop ? 'none' : color} stroke={color} strokeWidth="1.6" />
    </g>
  )
}

function CropShape({ crop, kind }: { crop: Crop; kind: CropKind }) {
  const mound = <ellipse cy="1" rx="8" ry="3.2" fill="#6b4b2e" />
  if (crop.stage === 'seed') return <g>{mound}<circle cy="-2" r="2.4" fill="#d9b77a" /></g>
  if (crop.stage === 'sprout') return <g className="town-sway">{mound}<Sprout /></g>
  if (crop.stage === 'thirsty') return (
    <g>{mound}<Sprout color={DRY} droop />
      <path className="town-blink" d="M10,-30 q5,7 0,10 q-5,-3 0,-10z" fill="#4b9bd8" stroke="#2f6fa8" strokeWidth="1" />
    </g>
  )
  if (crop.stage === 'bug') return (
    <g>{mound}<Sprout color={DRY} droop />
      <ellipse cx="6" cy="-12" rx="4.2" ry="3.2" fill="#d2483d" /><circle cx="9.5" cy="-14" r="1.6" fill="#3a1a14" />
      <circle cx="5" cy="-13" r="0.9" fill="#3a1a14" /><circle cx="7" cy="-11" r="0.9" fill="#3a1a14" />
    </g>
  )
  // 熟了：按项目的菜画；熟太久的发蔫变暗。
  const wilt = crop.overripe
  return (
    <g className={wilt ? undefined : 'town-ripe'} opacity={wilt ? 0.8 : 1}>
      {mound}
      {kind === 'tomato' && <g>
        <path d="M0,0 L0,-20 M0,-10 l-8,-6 M0,-14 l8,-6" stroke={LEAF_DARK} strokeWidth="2" />
        <circle cx="-7" cy="-12" r="5.5" fill={wilt ? '#a8665a' : '#e2433a'} /><circle cx="6" cy="-17" r="6" fill={wilt ? '#a8665a' : '#ef5a3c'} /><circle cx="1" cy="-6" r="5" fill={wilt ? '#9c5f54' : '#d93a32'} />
      </g>}
      {kind === 'carrot' && <g>
        <path d="M-4,-2 l4,10 l4,-10 z" fill={wilt ? '#b88a5a' : '#f08a2c'} transform="translate(0,-6)" />
        <path d="M0,-8 q-6,-10 -9,-16 M0,-8 q0,-12 1,-18 M0,-8 q6,-10 9,-15" stroke={wilt ? DRY : LEAF} strokeWidth="2.4" fill="none" />
      </g>}
      {kind === 'pumpkin' && <g>
        <ellipse cy="-8" rx="12" ry="8.5" fill={wilt ? '#b88a5a' : '#f2902e'} stroke="#b9621a" strokeWidth="1" />
        <path d="M-5,-15 q-2,7 0,14 M5,-15 q2,7 0,14" stroke="#b9621a" strokeWidth="1" fill="none" />
        <path d="M0,-16 q1,-5 4,-6" stroke={LEAF_DARK} strokeWidth="2.4" fill="none" />
      </g>}
      {kind === 'cabbage' && <g>
        <circle cy="-8" r="10" fill={wilt ? '#a9b48a' : '#8fc56e'} /><circle cy="-9" r="6.5" fill={wilt ? '#c4c9a6' : '#cfe9b0'} />
        <path d="M-9,-6 q4,-4 9,-1 M9,-6 q-4,-4 -9,-1" stroke={LEAF_DARK} strokeWidth="1" fill="none" />
      </g>}
      {kind === 'corn' && <g>
        <path d="M0,0 L0,-28" stroke={wilt ? DRY : LEAF_DARK} strokeWidth="2.4" />
        <path d="M0,-8 q-10,-4 -12,-12 M0,-14 q10,-4 11,-12" stroke={wilt ? DRY : LEAF} strokeWidth="2.2" fill="none" />
        <ellipse cx="4" cy="-18" rx="3.6" ry="7.5" fill={wilt ? '#c9b46a' : '#f4cf3c'} stroke="#c49a1c" strokeWidth="0.8" />
      </g>}
      {!wilt && <path className="town-blink" d="M12,-26 l1.5,3.5 l3.5,1.5 l-3.5,1.5 l-1.5,3.5 l-1.5,-3.5 l-3.5,-1.5 l3.5,-1.5z" fill="#ffd36b" />}
    </g>
  )
}
