import { describe, expect, it } from 'vitest'
import { cellsInView, gridAt, gridOfView, sceneryOf, terrainAtCell } from './terrain'
import { CELL_D, CELL_W } from './world'
import { iso } from './iso'

const area = (n: number) => {
  const out: { cx: number; cy: number }[] = []
  for (let cx = -n; cx < n; cx++) for (let cy = -n; cy < n; cy++) out.push({ cx, cy })
  return out
}

describe('地形', () => {
  it('同一个位置永远是同一种地形、长同样的东西', () => {
    for (const c of area(6)) {
      expect(terrainAtCell(c.cx, c.cy)).toBe(terrainAtCell(c.cx, c.cy))
      expect(JSON.stringify(sceneryOf(c, false))).toBe(JSON.stringify(sceneryOf({ ...c }, false)))
    }
  })

  it('四种地形都有，没有哪一种铺满', () => {
    const cells = area(20)
    const count: Record<string, number> = {}
    for (const c of cells) count[terrainAtCell(c.cx, c.cy)] = (count[terrainAtCell(c.cx, c.cy)] ?? 0) + 1
    for (const t of ['meadow', 'forest', 'lake', 'hill']) {
      expect(count[t] / cells.length).toBeGreaterThan(0.05)
      expect(count[t] / cells.length).toBeLessThan(0.5)
    }
  })

  it('相邻空地多半是同一种地形，连成片而不是一格一格乱跳', () => {
    let same = 0, pairs = 0
    for (const c of area(20)) {
      const t = terrainAtCell(c.cx, c.cy)
      same += +(terrainAtCell(c.cx + 1, c.cy) === t) + +(terrainAtCell(c.cx, c.cy + 1) === t)
      pairs += 2
    }
    // 四种地形各自独立抽签时只有三成左右相同。
    expect(same / pairs).toBeGreaterThan(0.55)
  })
})

describe('空地上的景物', () => {
  const cells = area(15)
  const of = (t: string) => cells.filter((c) => terrainAtCell(c.cx, c.cy) === t).map((c) => ({ c, s: sceneryOf(c, false) }))

  it('景物都在自己的格子里，不会跑到地面外面', () => {
    for (const { c, s } of cells.map((c) => ({ c, s: sceneryOf(c, false) }))) {
      for (const p of s.props.filter((p) => p.kind !== 'reeds')) {
        expect(p.gx).toBeGreaterThanOrEqual(c.cx * CELL_W)
        expect(p.gx).toBeLessThanOrEqual((c.cx + 1) * CELL_W)
        expect(p.gy).toBeGreaterThanOrEqual(c.cy * CELL_D)
        expect(p.gy).toBeLessThanOrEqual((c.cy + 1) * CELL_D)
      }
    }
  })

  it('每个湖的轮廓都不一样，不是同一个模板挪位置', () => {
    const lakes = of('lake').map(({ c, s }) => s.pond!.ring.map(([x, y]) => [x - c.cx * CELL_W, y - c.cy * CELL_D].map((v) => v.toFixed(2)).join(',')).join(' '))
    expect(lakes.length).toBeGreaterThan(5)
    expect(new Set(lakes).size).toBe(lakes.length)
    expect(new Set(of('lake').map(({ s }) => s.pond!.ring.length)).size).toBeGreaterThan(2)
  })

  it('林子的疏密、松树比例各不相同', () => {
    const forests = of('forest')
    expect(new Set(forests.map(({ s }) => s.props.length)).size).toBeGreaterThan(4)
    const pineShare = forests.map(({ s }) => (s.props.filter((p) => p.kind === 'pine').length / Math.max(1, s.props.length)).toFixed(1))
    expect(new Set(pineShare).size).toBeGreaterThan(3)
  })

  it('同是湖的邻格，湖伸到格子边上连成一片', () => {
    const c = { cx: 0, cy: 0 }
    const alone = sceneryOf(c, false, { e: false, s: false, w: false, n: false })
    const joined = sceneryOf(c, false, { e: true, s: false, w: false, n: false })
    if (terrainAtCell(0, 0) !== 'lake') return
    expect(Math.max(...joined.pond!.ring.map((p) => p[0]))).toBeGreaterThan(Math.max(...alone.pond!.ring.map((p) => p[0])))
  })

  it('紧挨项目的空地只放少量矮的花草石头，没有湖和高树', () => {
    for (const c of cells) {
      const s = sceneryOf(c, true)
      expect(s.pond).toBeNull()
      expect(s.mounds).toEqual([])
      expect(s.props.length).toBeLessThanOrEqual(3)
      for (const p of s.props) expect(['flowers', 'bush', 'rock']).toContain(p.kind)
    }
  })
})

describe('视野', () => {
  const views = [{ x: -800, y: -300, w: 1600, h: 900 }, { x: 2400, y: 1800, w: 1200, h: 700 }, { x: -5000, y: -2000, w: 9000, h: 5600 }]

  it('地面范围盖住视野的四个角', () => {
    for (const v of views) {
      const g = gridOfView(v, 0)
      for (const [x, y] of [[v.x, v.y], [v.x + v.w, v.y], [v.x, v.y + v.h], [v.x + v.w, v.y + v.h]]) {
        const [gx, gy] = gridAt(x, y)
        expect(gx).toBeGreaterThanOrEqual(g.gx0 - 1e-9)
        expect(gx).toBeLessThanOrEqual(g.gx1 + 1e-9)
        expect(gy).toBeGreaterThanOrEqual(g.gy0 - 1e-9)
        expect(gy).toBeLessThanOrEqual(g.gy1 + 1e-9)
        const [sx, sy] = iso(gx, gy)
        expect(sx).toBeCloseTo(x)
        expect(sy).toBeCloseTo(y)
      }
    }
  })

  it('视野中心所在的格子一定在可见格子里', () => {
    for (const v of views) {
      const [gx, gy] = gridAt(v.x + v.w / 2, v.y + v.h / 2)
      const keys = new Set(cellsInView(v).map((c) => `${c.cx},${c.cy}`))
      expect(keys.has(`${Math.floor(gx / CELL_W)},${Math.floor(gy / CELL_D)}`)).toBe(true)
    }
  })
})
