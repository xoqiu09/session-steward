import { describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { DecisionBoard } from './TownScene'
import { buildTown } from './townModel'
import { demoSnapshot } from './fixtures'
import { iso } from './iso'
import { separatePlates, type PlateBox } from './plates'
import { plazaCoreBoxes, treeHidesPlaza } from './plazaView'
import { roadCells, worldRoads } from './roads'
import { lakeJoin, sceneryOf } from './terrain'
import { CELL_D, CELL_W, worldLayout } from './world'

const zOf = (source: string, selector: string) => Number(source.split(`${selector} {`)[1].split('}')[0].match(/z-index:\s*(\d+)/)![1])

describe('弹层顺序', () => {
  it('收起的画风条低于详情抽屉和遮罩，关闭按钮不会被盖住；展开时才盖住地图工具', async () => {
    // 测试环境会把 CSS 导入替换成空内容（?raw 也一样），所以直接读源文件。
    const { readFileSync } = await import('node:fs' as string)
    const read = (name: string): string => readFileSync(new URL(name, import.meta.url), 'utf8')
    const bar = read('./appearance.css'), kiosk = read('./townView.css')
    expect(zOf(bar, '.town-scene-menu')).toBeLessThan(zOf(kiosk, '.kiosk-scrim'))
    expect(zOf(kiosk, '.kiosk-scrim')).toBeLessThan(zOf(kiosk, '.kiosk-drawer'))
    expect(zOf(bar, '.town-scene-menu.is-open')).toBeGreaterThan(zOf(kiosk, '.kiosk-drawer'))
  })
})

describe('名牌避让', () => {
  const box = (key: string, x: number, y: number, w = 100, extra: Partial<PlateBox> = {}): PlateBox => ({ key, x, y, w, h: 30, ...extra })
  const final = (boxes: PlateBox[], lifts: Map<string, number>) => boxes.map((b) => ({ ...b, y: b.y - (lifts.get(b.key) ?? 0) }))
  const clashes = (boxes: PlateBox[]) => boxes.flatMap((a, i) => boxes.slice(i + 1).filter((b) => Math.abs(a.x - b.x) < (a.w + b.w) / 2 && a.y - a.h < b.y && b.y - b.h < a.y))

  it('不重叠的名牌留在原处', () => {
    expect(separatePlates([box('a', 0, 0), box('b', 500, 0)]).size).toBe(0)
  })

  it('后面的名牌抬高，前面的不动，结果没有重叠', () => {
    const boxes = [box('back', 20, 100), box('front', 0, 110), box('third', 40, 95)]
    const lifts = separatePlates(boxes)
    expect(lifts.has('front')).toBe(false)
    expect(lifts.get('back')).toBeGreaterThan(0)
    expect(clashes(final(boxes, lifts))).toEqual([])
  })

  it('中央广场固定，其他名牌让位；一串相邻名牌也能全部分开', () => {
    const boxes = [box('plaza', 0, 100, 160, { fixed: true }), ...Array.from({ length: 12 }, (_, i) => box(`p${i}`, i * 12, 100 + i))]
    const lifts = separatePlates(boxes)
    expect(lifts.has('plaza')).toBe(false)
    expect(clashes(final(boxes, lifts))).toEqual([])
  })
})

describe('广场视线', () => {
  const core = plazaCoreBoxes(iso(6, 8), 200, { gx: 5, gy: 1.2 })
  it('正前方街区的大树会挡告示栏；经典画风的小树够不到，继续保留', () => {
    expect(treeHidesPlaza(iso(8.6, 10.4), 1, true, core)).toBe(true)
    expect(treeHidesPlaza(iso(8.6, 10.4), 1, false, core)).toBe(false)
  })
  it('离广场远的树不受影响', () => {
    expect(treeHidesPlaza(iso(30, 40), 1, true, core)).toBe(false)
    expect(treeHidesPlaza(iso(-20, 20), 1, true, core)).toBe(false)
  })
})

describe('告示栏', () => {
  const model = buildTown(demoSnapshot)
  const place = { x: 0, y: 0, anchor: 'bottom' as const, scale: 1 }
  const html = (m: typeof model) => renderToStaticMarkup(<svg><DecisionBoard place={place} model={m} isSel={() => false} dimClass="" onSelect={() => {}} /></svg>)
  it('有待决定时木牌本身是按钮，打开第一件', () => {
    const cards = [{ id: 'a1', kind: 'decision', preview: '合成提问' }] as unknown as typeof model.pendingApprovals
    const out = html({ ...model, pendingApprovals: cards })
    expect(out).toContain('aria-label="告示栏：1 件等你决定，打开第一件"')
    expect(out).toContain('aria-label="待决定 a1：合成提问"')
  })
  it('空告示栏不是按钮', () => {
    const out = html({ ...model, pendingApprovals: [] })
    expect(out).not.toContain('role="button"')
    expect(out).toContain('暂时没有待决定')
  })
})

describe('湖和路', () => {
  it('四格交汇的补丁落在这四格内部，并盖住交汇点周围的星形缺口', () => {
    const ring = lakeJoin(3, -2), gx = 3 * CELL_W, gy = -2 * CELL_D
    for (const [x, y] of ring) {
      expect(Math.abs(x - gx)).toBeLessThan(CELL_W)
      expect(Math.abs(y - gy)).toBeLessThan(CELL_D)
    }
    expect(Math.max(...ring.map(([x]) => x)) - gx).toBeGreaterThan(CELL_W / 2)
    expect(Math.max(...ring.map(([, y]) => y)) - gy).toBeGreaterThan(CELL_D / 2)
  })

  it('路经过的每一处都算进占用格，那些格子不长湖', () => {
    const world = worldLayout(buildTown(demoSnapshot).buildings, () => false)
    const taken = roadCells(world)
    for (const { from, to } of worldRoads(world)) {
      for (let t = 0; t <= 1; t += .1) {
        const x = from.x + (to.x - from.x) * t, y = from.y + (to.y - from.y) * t
        expect(taken.has(`${Math.floor(x / CELL_W)},${Math.floor(y / CELL_D)}`)).toBe(true)
      }
    }
    for (const key of taken) {
      const [cx, cy] = key.split(',').map(Number)
      expect(sceneryOf({ cx, cy }, true).pond).toBeNull()
    }
  })
})
