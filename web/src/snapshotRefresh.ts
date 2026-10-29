import type { Snapshot } from './types'

/** One read at a time; a change during a slow read always requests one fresh follow-up. */
export function snapshotRefresher(load: () => Promise<Snapshot>, apply: (snapshot: Snapshot, reset: boolean) => void, failed: (error: unknown) => void) {
  let wanted = false
  let stopped = false
  let active: Promise<void> | null = null
  let epoch = 0
  let cursor = -1
  let resetNext = false
  const run = async () => {
    while (wanted && !stopped) {
      wanted = false
      const started = epoch
      try {
        const snapshot = await load()
        if (stopped) return
        if (started !== epoch) { wanted = true; continue }
        if (snapshot.cursor < cursor) continue
        cursor = snapshot.cursor
        apply(snapshot, resetNext)
        resetNext = false
      } catch (error) {
        if (!stopped && started === epoch) failed(error)
      }
    }
  }
  const request = (): Promise<void> => {
    if (stopped) return Promise.resolve()
    wanted = true
    if (!active) active = run().finally(() => { active = null; if (wanted && !stopped) void request() })
    return active
  }
  return {
    request,
    reset: () => { epoch++; cursor = -1; resetNext = true; return request() },
    dispose: () => { stopped = true; wanted = false },
  }
}
