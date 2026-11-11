import { useCallback, useEffect, useState } from 'react'
import { parseTownRoute } from './town/route'
import type { PanelView } from './panelScope'

interface PanelLocation { pathname: string; search: string; hash: string }
const VIEWS: readonly PanelView[] = ['today', 'overview', 'town', 'canvas', 'list', 'history']

export function panelViewFromLocation(search: string, hash: string): PanelView {
  const route = parseTownRoute(search, hash)
  if (route.kiosk) return 'town'
  const view = new URLSearchParams(search).get('view') as PanelView | null
  return view && VIEWS.includes(view) ? view : route.town ? 'town' : 'overview'
}

/** Page navigation keeps unrelated URL options, but never carries town-only modes into another page. */
export function panelViewHref(pathname: string, search: string, view: PanelView): string {
  const query = new URLSearchParams(search)
  query.set('view', view)
  for (const key of ['world', 'kiosk', 'live', 'rotate']) query.delete(key)
  if (view === 'town') query.set('world', '1')
  return `${pathname}?${query}`
}

export function withoutSelectionHash(hash: string): string {
  const parts = hash.replace(/^#/, '').split('&').filter(part => {
    const key = new URLSearchParams(part).keys().next().value
    return key !== 'item' && key !== 'session' && key !== 'approval'
  }).filter(Boolean)
  return parts.length ? `#${parts.join('&')}` : ''
}

const readLocation = (): PanelLocation => {
  const { pathname, search, hash } = window.location
  return { pathname, search, hash }
}

/** The selected page, shareable URL and browser back/forward history have one owner. */
export function usePanelNavigation() {
  const [location, setLocation] = useState(readLocation)
  useEffect(() => {
    const onLocation = () => setLocation(readLocation())
    window.addEventListener('popstate', onLocation)
    window.addEventListener('hashchange', onLocation)
    return () => {
      window.removeEventListener('popstate', onLocation)
      window.removeEventListener('hashchange', onLocation)
    }
  }, [])
  const navigate = useCallback((view: PanelView) => {
    const current = readLocation()
    const href = panelViewHref(current.pathname, current.search, view)
    if (href !== current.pathname + current.search + current.hash) window.history.pushState(null, '', href)
    setLocation(readLocation())
  }, [])
  const consumeDeepLink = useCallback(() => {
    const current = readLocation(), hash = withoutSelectionHash(current.hash)
    if (hash !== current.hash) window.history.replaceState(null, '', current.pathname + current.search + hash)
    setLocation(readLocation())
  }, [])
  return { view: panelViewFromLocation(location.search, location.hash), route: parseTownRoute(location.search, location.hash), navigate, consumeDeepLink }
}
