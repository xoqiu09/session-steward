import { describe, expect, it } from 'vitest'
import { buildTown } from './townModel'
import { demoSnapshot } from './fixtures'
import { FAR_W, NEAR_MIN_SCALE, PLATE_MIN_PX, contentBox, fitCamera, isFar, overviewCamera, plateScale, tourStops, viewBoxOf, worldLayout } from './world'

// 小镇“看不看得清”的基线。2026-11-10 走查发现：1024×768 时地图文字只有 2.5–5.5px；
// 断线提示被工具栏挡住，只露出半句“Agent 仍在工作”；小镇本体只占地图中间约四成。
// 这里把这三件事写成检查，以后改镜头、名牌或工具栏时不会悄悄退回去。

/** 走查时量到的地图实际宽度：1024 宽窗口 / 1440 宽窗口 / 桌面模式。 */
const MAP_WIDTHS = [580, 1096, 1408]
const world = worldLayout(buildTown(demoSnapshot).buildings, () => false)

describe('远景名牌在屏幕上不小于最小字号', () => {
  it.each(MAP_WIDTHS)('地图宽 %ipx：标题至少 14px，状态字至少 10px', (pxW) => {
    for (let viewW = 600; viewW <= 9000; viewW += 200) {
      const k = plateScale(viewW, pxW), px = (units: number) => (units * k * pxW) / viewW
      // 极远处封顶（k=6），不让名牌大到盖住半张地图；封顶前必须够大。
      if (k < 6) {
        expect(px(22), `视野 ${viewW}`).toBeGreaterThanOrEqual(PLATE_MIN_PX - 0.01)
        expect(px(17), `视野 ${viewW}`).toBeGreaterThanOrEqual(10)
      }
    }
  })

  it('不知道屏幕宽度时（服务端渲染、旧调用方）保持原来的缩放', () => {
    expect(plateScale(1450)).toBe(0.8)
    expect(plateScale(2900)).toBe(1)
    expect(plateScale(9000)).toBe(2.4)
  })
})

describe('近景只在文字读得了的时候出现', () => {
  it.each(MAP_WIDTHS)('地图宽 %ipx：近景时房子招牌（15 单位）至少约 9px', (pxW) => {
    for (let w = 520; w <= 9000; w += 60) {
      if (!isFar({ cx: 0, cy: 0, w }, pxW)) expect((15 * pxW) / w, `视野 ${w}`).toBeGreaterThanOrEqual(15 * NEAR_MIN_SCALE - 0.01)
    }
  })

  it('窄地图比宽地图更早切到远景名牌；视野很宽时始终是远景', () => {
    const cam = { cx: 0, cy: 0, w: 1200 }
    expect(isFar(cam, 580)).toBe(true)
    expect(isFar(cam, 1408)).toBe(false)
    expect(isFar({ ...cam, w: FAR_W + 1 }, 4000)).toBe(true)
    expect(isFar({ ...cam, w: FAR_W + 1 })).toBe(true)
    expect(isFar({ ...cam, w: FAR_W - 1 })).toBe(false)
  })
})

describe('全景对准小镇本体，不是外圈树林', () => {
  const box = contentBox(world)

  it('小镇本体完全落在世界范围里，而且比世界范围小', () => {
    const b = world.bounds
    expect(box.x).toBeGreaterThanOrEqual(b.x)
    expect(box.y).toBeGreaterThanOrEqual(b.y)
    expect(box.x + box.w).toBeLessThanOrEqual(b.x + b.w)
    expect(box.y + box.h).toBeLessThanOrEqual(b.y + b.h)
    expect(box.w).toBeLessThan(b.w)
  })

  it.each([580 / 436, 1096 / 567, 1408 / 752])('地图比例 %f：小镇本体至少占全景宽或高的八成，且完整落在视野里', (aspect) => {
    const cam = overviewCamera(world, aspect), view = viewBoxOf(cam, aspect)
    expect(Math.max(box.w / view.w, box.h / view.h)).toBeGreaterThanOrEqual(0.8)
    expect(cam.w).toBeLessThan(fitCamera(world.bounds, aspect, 1.02).w)
    expect(box.y).toBeGreaterThanOrEqual(view.y)
    expect(box.y + box.h).toBeLessThanOrEqual(view.y + view.h)
  })

  it('桌面巡游的第一站也用同一个全景', () => {
    const aspect = 1096 / 567
    expect(tourStops(world, () => false, aspect)[0]).toEqual(overviewCamera(world, aspect))
  })
})

describe('断线提示不被地图工具栏挡住', () => {
  it('提示占地图顶边一整条、层级高于工具栏，世界地图整体下移让出位置', async () => {
    // 测试环境会把 CSS 导入替换成空内容，所以直接读源文件。
    const { readFileSync } = await import('node:fs' as string)
    const css: string = readFileSync(new URL('./town.css', import.meta.url), 'utf8')
    const rule = (selector: string) => css.split(`${selector} {`)[1].split('}')[0]
    const z = (selector: string) => Number(rule(selector).match(/z-index:\s*(\d+)/)![1])
    const offline = rule('.town-view .town-offline')
    expect(offline).toMatch(/top:\s*0;\s*left:\s*0;\s*right:\s*0/)
    expect(z('.town-view .town-offline')).toBeGreaterThan(z('.town-view .town-world-tools'))
    const strip = Number(offline.match(/min-height:\s*(\d+)px/)![1])
    expect(Number(rule('.town-view.is-offline .town-world').match(/top:\s*(\d+)px/)![1])).toBeGreaterThanOrEqual(strip)
  })
})

describe('画风入口只占一行里的一个按钮', () => {
  it('不独占整行，高度留给地图（2026-11-10 Owner 决定）', async () => {
    const { readFileSync } = await import('node:fs' as string)
    const css: string = readFileSync(new URL('./appearance.css', import.meta.url), 'utf8')
    const menu = css.split('.town-scene-menu {')[1].split('}')[0]
    expect(menu).toMatch(/flex:\s*0 1 auto/)
    expect(menu).not.toMatch(/width:\s*100%/)
  })
})

