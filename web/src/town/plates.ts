// 远景名牌避让：名牌钉在屋顶上，相邻的高楼和矮房名牌会叠在一起。这里只算往上抬多少，不动世界布局。

export interface PlateBox {
  key: string
  /** 名牌中心的 x 和底边（含尖角）的 y，都是世界 SVG 坐标。 */
  x: number
  y: number
  w: number
  h: number
  /** 固定不动的名牌（中央广场），其他名牌给它让位。 */
  fixed?: boolean
}

const overlaps = (a: PlateBox, ay: number, b: PlateBox, by: number, gap: number) =>
  Math.abs(a.x - b.x) < (a.w + b.w) / 2 + gap && ay - a.h < by + gap && by - b.h < ay + gap

/** 前面（y 大）的名牌留在原处，后面的往上抬到不再重叠。返回 key → 上抬距离（>0，没动的不返回）。 */
export function separatePlates(plates: readonly PlateBox[], gap = 4): Map<string, number> {
  const placed: { box: PlateBox; y: number }[] = plates.filter((p) => p.fixed).map((box) => ({ box, y: box.y }))
  const lifts = new Map<string, number>()
  const movable = plates.filter((p) => !p.fixed).sort((a, b) => b.y - a.y || a.x - b.x || a.key.localeCompare(b.key))
  for (const box of movable) {
    let y = box.y
    // 每次抬到挡路名牌的上方；y 只减不增，最多越过全部已放好的名牌。
    for (let tries = 0; tries <= placed.length; tries++) {
      const hit = placed.filter((p) => overlaps(box, y, p.box, p.y, gap))
      if (!hit.length) break
      y = Math.min(...hit.map((p) => p.y - p.box.h)) - gap
    }
    if (y !== box.y) lifts.set(box.key, box.y - y)
    placed.push({ box, y })
  }
  return lifts
}
