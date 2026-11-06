import { createContext, useContext, useEffect, useState, useSyncExternalStore, type ReactNode } from 'react'

export type TownThemeId = 'original' | 'storybook' | 'miniature'
export const APPEARANCE_KEY = 'ss.town.appearance.v1'
export const TOWN_THEMES: readonly { id: TownThemeId; name: string; description: string; assets: readonly string[] }[] = [
  { id: 'miniature', name: '微缩庭园', description: '圆润模型 · 清透绿意', assets: ['/town/miniature/props.png'] },
  { id: 'storybook', name: '柔和手绘', description: '暖色纸感 · 自然花园', assets: ['/town/storybook/props.png', '/town/storybook/nature.png'] },
  { id: 'original', name: '经典小镇', description: '简洁几何 · 熟悉的小镇', assets: [] },
]
export const themeName = (id: TownThemeId) => TOWN_THEMES.find(t => t.id === id)!.name
const isTheme = (id: unknown): id is TownThemeId => TOWN_THEMES.some(t => t.id === id)
type AppearanceStorage = Pick<Storage, 'getItem' | 'setItem'>

export function readAppearance(storage?: AppearanceStorage): TownThemeId {
  try {
    const raw = JSON.parse(storage?.getItem(APPEARANCE_KEY) ?? 'null')
    return raw?.version === 1 && isTheme(raw.theme) ? raw.theme : 'original'
  } catch { return 'original' }
}

export function requestedTheme(search: string): TownThemeId | null {
  const value = new URLSearchParams(search).get('town-art')
  return isTheme(value) ? value : null
}

export function writeAppearance(theme: TownThemeId, storage?: AppearanceStorage): boolean {
  try {
    if (!storage) return false
    storage.setItem(APPEARANCE_KEY, JSON.stringify({ version: 1, theme }))
    return true
  } catch { return false }
}

const assetLoads = new Map<string, Promise<void>>()
export function preloadThemeAssets(theme: TownThemeId): Promise<void> {
  return Promise.all(TOWN_THEMES.find(t => t.id === theme)!.assets.map(src => {
    if (!assetLoads.has(src)) {
      const loading = new Promise<void>((resolve, reject) => {
        const image = new Image()
        const timer = setTimeout(() => { image.onload = image.onerror = null; reject(new Error('asset-timeout')) }, 12_000)
        image.onload = () => { clearTimeout(timer); resolve() }
        image.onerror = () => { clearTimeout(timer); reject(new Error('asset-load')) }
        image.src = src
      }).catch(error => { assetLoads.delete(src); throw error })
      assetLoads.set(src, loading)
    }
    return assetLoads.get(src)!
  })).then(() => undefined)
}

export interface AppearanceSnapshot {
  theme: TownThemeId
  savedTheme: TownThemeId
  loading: TownThemeId | null
  error: string
  notice: string
}

/** Only owns appearance. No access to snapshots, life stores, layout or work APIs. */
export function createAppearanceStore(storage?: AppearanceStorage, search = '', load = preloadThemeAssets, onApply = () => {}) {
  const savedTheme = readAppearance(storage)
  let state: AppearanceSnapshot = { theme: requestedTheme(search) ?? savedTheme, savedTheme, loading: null, error: '', notice: '' }
  let request = 0
  const listeners = new Set<() => void>()
  const publish = (patch: Partial<AppearanceSnapshot>) => { state = { ...state, ...patch }; listeners.forEach(fn => fn()) }
  return {
    getSnapshot: () => state,
    subscribe: (fn: () => void) => { listeners.add(fn); return () => { listeners.delete(fn) } },
    preview: async (theme: TownThemeId) => {
      const ticket = ++request
      publish({ loading: theme, error: '', notice: '' })
      try {
        await load(theme)
        if (ticket !== request) return false
        publish({ theme, loading: null })
        return true
      } catch {
        if (ticket !== request) return false
        publish({ loading: null, error: '这个场景暂时没能加载，请重试或选择其他场景。' })
        return false
      }
    },
    cancel: (theme: TownThemeId) => { request++; publish({ theme, loading: null, error: '' }) },
    apply: () => {
      if (state.loading || state.error) return false
      const saved = writeAppearance(state.theme, storage)
      publish({ ...(saved ? { savedTheme: state.theme } : {}), notice: saved ? `已使用${themeName(state.theme)}，下次打开会记住。` : `已使用${themeName(state.theme)}，仅在本次打开中有效。` })
      onApply()
      return true
    },
    clearNotice: () => { publish({ notice: '' }) },
    dispose: () => { request++; listeners.clear() },
  }
}

function browserStorage(): AppearanceStorage | undefined { try { return globalThis.localStorage } catch { return undefined } }
function clearPreviewParameter() {
  if (typeof window === 'undefined') return
  const url = new URL(window.location.href)
  if (!url.searchParams.has('town-art')) return
  url.searchParams.delete('town-art')
  window.history.replaceState(window.history.state, '', `${url.pathname}${url.search}${url.hash}`)
}

export function useTownAppearance() {
  const [store] = useState(() => createAppearanceStore(browserStorage(), typeof window === 'undefined' ? '' : window.location?.search ?? '', preloadThemeAssets, clearPreviewParameter))
  const snapshot = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot)
  useEffect(() => () => store.dispose(), [store])
  useEffect(() => {
    if (!snapshot.notice) return
    const timer = setTimeout(store.clearNotice, 6000)
    return () => clearTimeout(timer)
  }, [store, snapshot.notice])
  return { ...snapshot, preview: store.preview, cancel: store.cancel, apply: store.apply }
}
export type TownAppearance = ReturnType<typeof useTownAppearance>

const TownArt = createContext<TownThemeId>('original')
export function TownArtProvider({ theme, children }: { theme: TownThemeId; children: ReactNode }) {
  return <TownArt.Provider value={theme}>{children}</TownArt.Provider>
}
export function useTownArt() {
  const theme = useContext(TownArt)
  return { theme, illustrated: theme !== 'original', miniature: theme === 'miniature' }
}
