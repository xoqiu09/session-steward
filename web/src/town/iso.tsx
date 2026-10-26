// 等距投影小工具：网格坐标 (gx, gy) → 屏幕坐标，以及盒子、屋顶、地块的多边形。
export const HW = 30
export const HH = 15

export type Pt = [number, number]

export function iso(gx: number, gy: number, z = 0): Pt {
  return [(gx - gy) * HW, (gx + gy) * HH - z]
}

export function pts(list: Pt[]): string {
  return list.map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`).join(' ')
}

export interface BoxProps {
  gx: number; gy: number; w: number; d: number; h: number; z?: number
  top: string; left: string; right: string; stroke?: string; className?: string
}

/** 左面朝左下（y = gy + d），右面朝右下（x = gx + w）。 */
export function IsoBox({ gx, gy, w, d, h, z = 0, top, left, right, stroke, className }: BoxProps) {
  const A = iso(gx, gy, z), B = iso(gx + w, gy, z), C = iso(gx + w, gy + d, z), D = iso(gx, gy + d, z)
  const up = (p: Pt): Pt => [p[0], p[1] - h]
  const s = stroke ? { stroke, strokeWidth: 1, strokeLinejoin: 'round' as const } : {}
  return (
    <g className={className}>
      <polygon points={pts([D, C, up(C), up(D)])} fill={left} {...s} />
      <polygon points={pts([B, C, up(C), up(B)])} fill={right} {...s} />
      <polygon points={pts([up(A), up(B), up(C), up(D)])} fill={top} {...s} />
    </g>
  )
}

/** 四坡屋顶，屋脊沿长边。只画朝向镜头的两面。 */
export function HipRoof({ gx, gy, w, d, z, rise, front, side, stroke }: { gx: number; gy: number; w: number; d: number; z: number; rise: number; front: string; side: string; stroke: string }) {
  const o = 0.25
  const x0 = gx - o, y0 = gy - o, x1 = gx + w + o, y1 = gy + d + o
  const B = iso(x1, y0, z), C = iso(x1, y1, z), D = iso(x0, y1, z)
  const s = { stroke, strokeWidth: 1.2, strokeLinejoin: 'round' as const }
  if (w >= d) {
    const cy = (y0 + y1) / 2, e = (y1 - y0) / 2
    const R1 = iso(x0 + e, cy, z + rise), R2 = iso(x1 - e, cy, z + rise)
    return (
      <g>
        <polygon points={pts([B, C, R2])} fill={side} {...s} />
        <polygon points={pts([D, C, R2, R1])} fill={front} {...s} />
      </g>
    )
  }
  const cx = (x0 + x1) / 2, e = (x1 - x0) / 2
  const R1 = iso(cx, y0 + e, z + rise), R2 = iso(cx, y1 - e, z + rise)
  return (
    <g>
      <polygon points={pts([D, C, R2])} fill={side} {...s} />
      <polygon points={pts([B, C, R2, R1])} fill={front} {...s} />
    </g>
  )
}

export function IsoTile({ gx, gy, w, d, fill, stroke, className, dash, opacity }: { gx: number; gy: number; w: number; d: number; fill: string; stroke?: string; className?: string; dash?: string; opacity?: number }) {
  return (
    <polygon className={className} opacity={opacity} points={pts([iso(gx, gy), iso(gx + w, gy), iso(gx + w, gy + d), iso(gx, gy + d)])}
      fill={fill} stroke={stroke} strokeDasharray={dash} strokeWidth={stroke ? 1 : 0} />
  )
}
