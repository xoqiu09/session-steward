// 小镇的 URL 入口：?view=town 直接打开小镇，?kiosk=1（或 #kiosk）进入桌面模式。
// 桌面模式隐藏 SS 的工具栏和侧栏，只留状态按钮、连接状态和图例，适合长期挂在副屏或手机上。
// hash 里的 #town / #kiosk 可以和已有深链并存，例如 #kiosk&approval=A-1。

export interface TownRoute {
  /** 打开时直接进入小镇视图。 */
  town: boolean
  /** 桌面模式：全屏小镇，自动轮播项目。 */
  kiosk: boolean
  /** 桌面模式下每页停留的毫秒数。 */
  rotateMs: number
  /** 预览：大地图世界（?world=1 或 #world），每个项目一个街区，可拖动缩放。 */
  world: boolean
}

export const DEFAULT_ROTATE_S = 20
const MIN_ROTATE_S = 5
const MAX_ROTATE_S = 600

const OFF = new Set(['0', 'false', 'no', 'off'])

function flag(p: URLSearchParams, key: string): boolean {
  return p.has(key) && !OFF.has((p.get(key) ?? '').trim().toLowerCase())
}

export function parseTownRoute(search: string, hash: string): TownRoute {
  const q = new URLSearchParams(search.replace(/^\?/, ''))
  const h = new URLSearchParams(hash.replace(/^#/, ''))
  const kiosk = flag(q, 'kiosk') || flag(h, 'kiosk')
  const town = kiosk || q.get('view') === 'town' || flag(h, 'town')
  const raw = Number(q.get('rotate') ?? h.get('rotate') ?? DEFAULT_ROTATE_S)
  const sec = Number.isFinite(raw) && raw > 0 ? Math.min(MAX_ROTATE_S, Math.max(MIN_ROTATE_S, raw)) : DEFAULT_ROTATE_S
  const world = flag(q, 'world') || flag(h, 'world')
  return { town: town || world, kiosk, rotateMs: sec * 1000, world }
}

/** 桌面模式的入口链接，保留当前路径。 */
export function kioskHref(pathname: string): string {
  return `${pathname}?view=town&kiosk=1`
}

/** 从桌面模式回到完整面板；带上 SS 已有的深链，打开后直接定位到同一个对象。 */
export function fullPanelHref(pathname: string, target: { kind: 'item'; id: string } | { kind: 'session'; id: number } | null): string {
  const base = `${pathname}?view=town`
  if (!target) return base
  return `${base}#${target.kind}=${encodeURIComponent(String(target.id))}`
}
