import { useEffect, useRef, useState } from 'react'
import type { Snapshot } from '../types'
import {
  DEFAULT_FOLLOW, FOLLOW_KEY, LAST_SEEN_KEY, MOMENT_WINDOW_MS, momentCurrent, momentsBetween, momentsWhileAway, sortMoments, updateMomentQueue,
  type FollowPreferences, type TownMoment,
} from './moments'

export function readFollowPreferences(): FollowPreferences {
  try {
    const value = JSON.parse(localStorage.getItem(FOLLOW_KEY) || 'null')
    return { enabled: typeof value?.enabled === 'boolean' ? value.enabled : true, includeMerged: value?.includeMerged === true }
  } catch { return DEFAULT_FOLLOW }
}

function readLastSeen(): number | null {
  try {
    const value = Number(localStorage.getItem(LAST_SEEN_KEY))
    return Number.isFinite(value) && value > 0 ? value : null
  } catch { return null }
}

/** 生命周期、存储和 3 秒归并在这里；相机仍由 WorldStage 的 flyTo 驱动。 */
export function useMoments(snapshot: Snapshot | undefined, onBatch: (moments: TownMoment[]) => void, onProgress: (moments: TownMoment[]) => void) {
  const [queue, setQueue] = useState<TownMoment[]>([])
  const [away, setAway] = useState<TownMoment[]>([])
  const [preferences, setPreferences] = useState(readFollowPreferences)
  const [seenAtStart] = useState(readLastSeen)
  const previous = useRef<Snapshot | null>(null)
  const latest = useRef(snapshot)
  const callbacks = useRef({ onBatch, onProgress })
  const seen = useRef(new Set<string>())
  const lastSeen = useRef<number | null>(seenAtStart)
  const resumeAt = useRef<number | null>(null)
  const batch = useRef<TownMoment[]>([])
  const timer = useRef<number | undefined>(undefined)
  // Timer callbacks must read the current guard/camera, never those captured by the first signal.
  useEffect(() => { callbacks.current = { onBatch, onProgress }; latest.current = snapshot })
  const remember = () => {
    lastSeen.current = Date.now()
    try { localStorage.setItem(LAST_SEEN_KEY, String(lastSeen.current)) } catch { /* 浏览器拒绝存储时，本次会话照常可用。 */ }
  }

  useEffect(() => {
    if (!snapshot) return
    const first = previous.current == null
    const fresh = momentsBetween(previous.current, snapshot).filter((m) => !seen.current.has(m.key))
    const caughtUp = first || resumeAt.current != null
      ? momentsWhileAway(snapshot, lastSeen.current).filter((m) => first || Date.parse(m.at) <= resumeAt.current!) : []
    previous.current = snapshot
    for (const m of [...fresh, ...caughtUp]) seen.current.add(m.key)
    setQueue((q) => updateMomentQueue(q, [...fresh, ...caughtUp], snapshot))
    setAway((q) => updateMomentQueue(q, caughtUp, snapshot))
    const caughtKeys = new Set(caughtUp.map((m) => m.key))
    const live = fresh.filter((m) => !caughtKeys.has(m.key))
    if (!document.hidden) {
      if (live.length) {
        callbacks.current.onProgress(live.filter((m) => m.kind === 'progress'))
        batch.current = sortMoments([...batch.current, ...live])
        if (timer.current == null) timer.current = window.setTimeout(() => {
          const pending = batch.current
          batch.current = []; timer.current = undefined
          if (!document.hidden && latest.current) callbacks.current.onBatch(pending.filter((m) => momentCurrent(m, latest.current!)))
        }, MOMENT_WINDOW_MS)
      }
      resumeAt.current = null
      remember()
    }
  }, [snapshot])

  useEffect(() => {
    const visibility = () => {
      window.clearTimeout(timer.current); timer.current = undefined; batch.current = []
      if (document.hidden) { remember(); return }
      resumeAt.current = Date.now()
      if (latest.current) {
        const caughtUp = momentsWhileAway(latest.current, lastSeen.current)
        setQueue((q) => updateMomentQueue(q, caughtUp, latest.current!))
        setAway((q) => updateMomentQueue(q, caughtUp, latest.current!))
        caughtUp.forEach((m) => seen.current.add(m.key))
      }
      // 下一张刷新快照仍用离开前的时间补漏，再记为已看过。
    }
    document.addEventListener('visibilitychange', visibility)
    window.addEventListener('pagehide', remember)
    return () => {
      document.removeEventListener('visibilitychange', visibility)
      window.removeEventListener('pagehide', remember)
      window.clearTimeout(timer.current)
    }
  }, [])

  const savePreferences = (value: FollowPreferences) => {
    setPreferences(value)
    try { localStorage.setItem(FOLLOW_KEY, JSON.stringify(value)) } catch { /* 仅本次会话生效。 */ }
  }
  const acknowledge = (key: string) => {
    setQueue((q) => q.filter((m) => m.key !== key))
    setAway((q) => q.filter((m) => m.key !== key))
  }
  return { queue, away, preferences, savePreferences, acknowledge, dismissAway: () => setAway([]) }
}
