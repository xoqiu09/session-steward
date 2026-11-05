import { useEffect, useSyncExternalStore } from 'react'
import type { ResidentStore } from './residentLife'

export function useResidentLife(store: ResidentStore) { return useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot) }

/** 时钟不依附花园：走进项目房间后，居民的来访和回家仍继续。 */
export function ResidentClock({ store, active }: { store: ResidentStore; active: boolean }) {
  const life = useResidentLife(store)
  useEffect(() => {
    if (!active || !life.enabled) return
    const visible = () => { store.resetClock(Date.now()); if (document.hidden) store.save() }
    const save = () => store.save()
    visible()
    const clock = window.setInterval(() => { if (!document.hidden) store.tick(Date.now()) }, 500)
    document.addEventListener('visibilitychange', visible); window.addEventListener('pagehide', save)
    return () => { clearInterval(clock); document.removeEventListener('visibilitychange', visible); window.removeEventListener('pagehide', save); store.save() }
  }, [store, active, life.enabled])
  return null
}
