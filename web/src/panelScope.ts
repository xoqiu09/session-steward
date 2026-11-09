export type PanelView = 'today' | 'overview' | 'town' | 'canvas' | 'list' | 'history'

/** Daily inbox and history are whole-device views; preserve the caller's filters for returning. */
export function panelScope(view: PanelView, repoId: number | 'all', provider: string, query: string, showDone: boolean) {
  const global = view === 'today' || view === 'history'
  const textFilters = view === 'overview' || view === 'canvas' || view === 'list'
  return {
    global, textFilters,
    repoId: global ? 'all' as const : repoId,
    provider: global ? 'all' : provider,
    query: textFilters ? query : '',
    showDone: textFilters && showDone,
  }
}
