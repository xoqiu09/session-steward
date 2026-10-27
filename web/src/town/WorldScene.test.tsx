import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { WorldScene } from './WorldScene'
import { buildTown } from './townModel'
import { demoSnapshot } from './fixtures'
import { cellsInView, terrainAtCell } from './terrain'
import { worldLayout } from './world'

const model = buildTown(demoSnapshot)
const needsYou = () => false
const world = worldLayout(model.buildings, needsYou)
const draw = (view: { x: number; y: number; w: number; h: number }) => renderToStaticMarkup(
  <WorldScene model={model} world={world} view={view} far={false} selected={null} highlight={null} onSelect={() => {}} needsYou={needsYou} />)

describe('小镇世界的地面和景物', () => {
  it('没有桌子边：地面不再画成带侧面的台子', () => {
    const html = draw({ x: -900, y: -400, w: 1800, h: 1100 })
    expect(html).not.toContain('#b48a5e')
    expect(html).not.toContain('#946c48')
  })

  it('拖到项目外很远的地方，也照样有地面和按地形长出的景物', () => {
    const view = { x: 5200, y: 2600, w: 1400, h: 850 }
    const html = draw(view)
    expect(html).toContain('fill="#d7e2bf"')
    const cells = cellsInView(view)
    expect(cells.length).toBeGreaterThan(0)
    // 视野里有森林或湖时，一定画出了树或水面。
    const kinds = new Set(cells.map((c) => terrainAtCell(c.cx, c.cy)))
    if (kinds.has('forest')) expect(html).toMatch(/#4f8a5b|#7fae6a/)
    if (kinds.has('lake')) expect(html).toContain('#7fb3d5')
  })
})
