import { describe, expect, it } from 'vitest'
import { parseDeepLink } from '../live'
import { DEFAULT_ROTATE_S, fullPanelHref, kioskHref, parseTownRoute, worldTownRoute } from './route'

describe('parseTownRoute', () => {
  it('没有参数时是普通面板', () => {
    expect(parseTownRoute('', '')).toEqual({ town: false, kiosk: false, rotateMs: DEFAULT_ROTATE_S * 1000, world: false })
  })

  it('?world=1 或 #world 打开大地图预览，并直接进入小镇', () => {
    expect(parseTownRoute('?world=1', '')).toMatchObject({ town: true, world: true, kiosk: false })
    expect(parseTownRoute('?kiosk=1&world=1', '')).toMatchObject({ town: true, world: true, kiosk: true })
    expect(parseTownRoute('', '#world')).toMatchObject({ world: true })
    expect(parseTownRoute('?world=0', '')).toMatchObject({ world: false, town: false })
  })

  it('普通小镇入口默认打开世界地图，不进工作室', () => {
    expect(parseTownRoute('?view=town', '')).toMatchObject({ town: true, kiosk: false, world: true })
    expect(parseTownRoute('', '#town')).toMatchObject({ town: true, kiosk: false, world: true })
    expect(parseTownRoute('?view=list', '')).toMatchObject({ town: false, kiosk: false })
  })

  it('每日十分钟不是小镇入口，明确关闭世界模式时仍尊重参数', () => {
    expect(parseTownRoute('?view=today', '')).toMatchObject({ town: false, world: false })
    expect(parseTownRoute('?view=town&world=0', '')).toMatchObject({ town: true, world: false })
  })

  it('从每日十分钟或旧工作室返回小镇时恢复完整世界', () => {
    for (const search of ['?view=today', '?view=history', '?kiosk=1&rotate=30', '?view=town&world=0']) {
      const entry = parseTownRoute(search, '')
      expect(worldTownRoute(entry)).toEqual({ town: true, kiosk: false, world: true, rotateMs: entry.rotateMs })
      expect(entry).toEqual(parseTownRoute(search, ''))
    }
  })

  it('?kiosk=1 与 #kiosk 都进入桌面模式，并且直接是小镇', () => {
    expect(parseTownRoute('?view=town&kiosk=1', '')).toMatchObject({ town: true, kiosk: true })
    expect(parseTownRoute('?kiosk', '')).toMatchObject({ town: true, kiosk: true })
    expect(parseTownRoute('', '#kiosk')).toMatchObject({ town: true, kiosk: true })
    expect(parseTownRoute('', '#town')).toMatchObject({ town: true, kiosk: false })
  })

  it('kiosk=0/false 不算打开', () => {
    expect(parseTownRoute('?kiosk=0', '').kiosk).toBe(false)
    expect(parseTownRoute('?kiosk=false', '').kiosk).toBe(false)
  })

  it('hash 里的桌面模式和已有深链并存，深链照常解析', () => {
    const hash = '#kiosk&approval=A-1'
    expect(parseTownRoute('', hash).kiosk).toBe(true)
    expect(parseDeepLink(hash)).toEqual({ kind: 'approval', id: 'A-1' })
    expect(parseDeepLink('#town')).toBeNull()
  })

  it('轮播间隔按秒读，限制在 5–600 秒，非法值用默认', () => {
    expect(parseTownRoute('?kiosk=1&rotate=30', '').rotateMs).toBe(30_000)
    expect(parseTownRoute('?kiosk=1&rotate=1', '').rotateMs).toBe(5_000)
    expect(parseTownRoute('?kiosk=1&rotate=99999', '').rotateMs).toBe(600_000)
    expect(parseTownRoute('?kiosk=1&rotate=abc', '').rotateMs).toBe(DEFAULT_ROTATE_S * 1000)
    expect(parseTownRoute('', '#kiosk&rotate=12').rotateMs).toBe(12_000)
  })
})

describe('入口链接', () => {
  it('桌面模式入口保留路径', () => {
    expect(kioskHref('/')).toBe('/?view=town&kiosk=1')
    expect(parseTownRoute(kioskHref('/').slice(1), '')).toMatchObject({ town: true, kiosk: true })
  })

  it('从世界地图进入桌面模式时保留完整地图', () => {
    const href = kioskHref('/', true)
    expect(parseTownRoute(href.slice(1), '')).toMatchObject({ town: true, kiosk: true, world: true })
  })

  it('回到完整面板时带上 SS 已有的深链', () => {
    expect(fullPanelHref('/', null)).toBe('/?view=town&world=1')
    expect(fullPanelHref('/', { kind: 'item', id: 'PL-7' })).toBe('/?view=town&world=1#item=PL-7')
    const href = fullPanelHref('/', { kind: 'session', id: 21 })
    expect(parseDeepLink(href.slice(href.indexOf('#')))).toEqual({ kind: 'session', id: 21 })
    expect(parseTownRoute('?view=town', '').kiosk).toBe(false)
  })
})
