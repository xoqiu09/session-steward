import { useEffect, useRef, useState } from 'react'
import type { Snapshot } from '../types'
import {
  DEFAULT_FOLLOW, FOLLOW_KEY, LAST_SEEN_KEY, MOMENT_WINDOW_MS, OVERDUE_MS, momentCurrent, handledElsewhere, momentsBetween, overdueRipe, stalledMoments, readSeenMoments, sortMoments, unseenWhileAway, updateMomentQueue, writeSeenMoments,
  type FollowPreferences, type HandledReceipt, type TownMoment,
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

/** 生命周期、存储和 3 秒归并在这里；相机仍由 WorldStage 的 flyTo 驱动。
 *  baseline 变了（本机 / 全部设备切换）时下一张快照重新当首屏，不把另一个范围里早就有的东西算成新动态。 */
export function useMoments(snapshot: Snapshot | undefined, onBatch: (moments: TownMoment[]) => void, onProgress: (moments: TownMoment[]) => void, baseline = '',
  onHandled?: (receipts: HandledReceipt[]) => void) {
  const [queue, setQueue] = useState<TownMoment[]>([])
  const [away, setAway] = useState<TownMoment[]>([])
  const [preferences, setPreferences] = useState(readFollowPreferences)
  const [seenAtStart] = useState(readLastSeen)
  const previous = useRef<Snapshot | null>(null)
  const base = useRef(baseline)
  const latest = useRef(snapshot)
  const callbacks = useRef({ onBatch, onProgress, onHandled })
  const seen = useRef<Set<string> | null>(null)
  seen.current ??= new Set(readSeenMoments())
  const lastSeen = useRef<number | null>(seenAtStart)
  const resumeAt = useRef<number | null>(null)
  const batch = useRef<TownMoment[]>([])
  const timer = useRef<number | undefined>(undefined)
  // Timer callbacks must read the current guard/camera, never those captured by the first signal.
  useEffect(() => { callbacks.current = { onBatch, onProgress, onHandled }; latest.current = snapshot })
  const remember = () => {
    lastSeen.current = Date.now()
    try { localStorage.setItem(LAST_SEEN_KEY, String(lastSeen.current)) } catch { /* 浏览器拒绝存储时，本次会话照常可用。 */ }
    writeSeenMoments(seen.current!)
  }

  useEffect(() => {
    if (!snapshot) return
    if (base.current !== baseline) { base.current = baseline; previous.current = null }
    const first = previous.current == null
    const fresh = momentsBetween(previous.current, snapshot).filter((m) => !seen.current!.has(m.key))
    // 在 Claude / Codex 里处理掉的事给一句回执；页面在后台时看不到，就不发。
    const handled = first ? [] : handledElsewhere(previous.current, snapshot).filter((r) => r.local)
    if (handled.length && !document.hidden) callbacks.current.onHandled?.(handled)
    const caughtUp = first || resumeAt.current != null
      ? unseenWhileAway(snapshot, lastSeen.current, seen.current!).filter((m) => first || Date.parse(m.at) <= resumeAt.current!) : []
    previous.current = snapshot
    // 页面在后台时到达的动态还没被看到，不记为看过，回到前台后才进“你离开期间”。
    for (const m of [...(document.hidden ? [] : fresh), ...caughtUp]) seen.current!.add(m.key)
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
  }, [snapshot, baseline])

  useEffect(() => {
    const visibility = () => {
      window.clearTimeout(timer.current); timer.current = undefined; batch.current = []
      if (document.hidden) { remember(); return }
      resumeAt.current = Date.now()
      if (latest.current) {
        const caughtUp = unseenWhileAway(latest.current, lastSeen.current, seen.current!)
        setQueue((q) => updateMomentQueue(q, caughtUp, latest.current!))
        setAway((q) => updateMomentQueue(q, caughtUp, latest.current!))
        caughtUp.forEach((m) => seen.current!.add(m.key))
        writeSeenMoments(seen.current!)
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

  // 熟了 30 分钟还没收的菜、停在你手上的工作：每分钟查一次，每次交付只提醒一次；页面在后台时不算看过，回来再提醒。
  // 首屏不飞：打开页面时就已超时的，只在“收菜”上标出最久等了多久；页面开着期间新跨过 30 分钟的才弹出来。
  const openedAt = useRef(Date.now())
  useEffect(() => {
    const check = () => {
      const s = latest.current
      if (!s || document.hidden) return
      const now = Date.now()
      // 熟了没收、停在你手上，都只提醒页面开着期间新跨过 30 分钟的。
      const due = [...overdueRipe(s, now), ...stalledMoments(s, now).filter((m) => m.local)]
        .filter((m) => !seen.current!.has(m.key) && Date.parse(m.at) + OVERDUE_MS > openedAt.current)
      if (!due.length) return
      due.forEach((m) => seen.current!.add(m.key))
      writeSeenMoments(seen.current!)
      setQueue((q) => updateMomentQueue(q, due, s))
      callbacks.current.onBatch(due)
    }
    check()
    const t = window.setInterval(check, 60_000)
    return () => window.clearInterval(t)
  }, [snapshot == null])

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
