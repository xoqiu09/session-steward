// 展示视图的数据：只轮询两个只读接口，不用 SSE、不读面板接口、不写浏览器存储。
// 失败时保留上一份画面并标记“状态待更新”。不看 document.visibilityState：OBS 浏览器源里页面要一直更新。
import type { LiveNote } from '../api'
import type { Snapshot } from '../types'
import { liveScrub, type LiveSnapshot } from './scrub'
import { liveStyle } from './styles'
import { livePresentation, publicCompanionAction } from './companion'
import { publicLiveResidents } from './liveResidents'
import { publicLiveContent } from './content'

export const SNAPSHOT_MS = 5_000
export const NOTE_MS = 2_000
const TIMEOUT_MS = 8_000

export interface LiveFeedState {
  snap: LiveSnapshot | null
  note: LiveNote | null
  /** 最近一次拉取失败：画面停在上一份。 */
  stale: boolean
}

async function getJSON<T>(path: string): Promise<T> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS)
  try {
    const res = await fetch(path, { credentials: 'same-origin', cache: 'no-store', signal: controller.signal })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    return await res.json() as T
  } finally { clearTimeout(timer) }
}

export const liveFetch = {
  snapshot: () => getJSON<LiveSnapshot>('/api/live/snapshot'),
  note: () => getJSON<LiveNote>('/api/live/note'),
}

export interface FeedTimers { set: (fn: () => void, ms: number) => unknown; clear: (t: unknown) => void }
const realTimers: FeedTimers = { set: (fn, ms) => setTimeout(fn, ms), clear: (t) => clearTimeout(t as ReturnType<typeof setTimeout>) }

/** 快照每 5 秒、轻量说明/居民动作每 2 秒；上一轮结束后才排下一轮。 */
export function createLiveFeed(opts: {
  fetchSnapshot?: () => Promise<Snapshot>
  fetchNote?: () => Promise<LiveNote>
  onState: (s: LiveFeedState) => void
  /** 新快照到达（已在前端再脱敏一次）；首次加载时 prev 为 null。 */
  onSnapshot?: (prev: Snapshot | null, next: Snapshot) => void
  timers?: FeedTimers
}) {
  const fetchSnapshot = opts.fetchSnapshot ?? liveFetch.snapshot
  const fetchNote = opts.fetchNote ?? liveFetch.note
  const timers = opts.timers ?? realTimers
  let state: LiveFeedState = { snap: null, note: null, stale: false }
  let stopped = false
  const pending = new Map<'snapshot' | 'note', unknown>()
  const publish = (patch: Partial<LiveFeedState>) => { state = { ...state, ...patch }; opts.onState(state) }
  const later = (key: 'snapshot' | 'note', fn: () => void, ms: number) => { if (!stopped) pending.set(key, timers.set(fn, ms)) }

  const pullSnapshot = async () => {
    try {
      const next = liveScrub(await fetchSnapshot())
      if (stopped) return
      // 旧快照（慢请求迟到）不覆盖新画面。
      const prev = state.snap
      if (prev && next.cursor < prev.cursor && Date.parse(next.now) <= Date.parse(prev.now)) { publish({ stale: false }); return }
      opts.onSnapshot?.(prev, next)
      publish({ snap: next, stale: false })
    } catch {
      if (!stopped) publish({ stale: true })
    } finally { later('snapshot', () => void pullSnapshot(), SNAPSHOT_MS) }
  }
  const pullNote = async () => {
    try {
      const n = await fetchNote()
      if (!stopped) publish({ note: { doing: str(n?.doing), thinking: str(n?.thinking), contact: str(n?.contact), style: liveStyle(n?.style), presentation: livePresentation(n?.presentation), companion: publicCompanionAction(n?.companion), resident_control: publicLiveResidents(n?.resident_control), content: publicLiveContent(n?.content), updated_at: str(n?.updated_at) } })
    } catch { /* 说明失败时保留上一份；画面状态只看快照 */ } finally { later('note', () => void pullNote(), NOTE_MS) }
  }
  return {
    start() { void pullSnapshot(); void pullNote() },
    stop() { stopped = true; for (const t of pending.values()) timers.clear(t); pending.clear() },
    get state() { return state },
  }
}

const str = (v: unknown) => (typeof v === 'string' ? v : '')
