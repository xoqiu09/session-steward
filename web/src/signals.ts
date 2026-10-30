import type { Signal, WorkItem } from './types'

export const DEFAULT_SIGNAL_GAP_MIN = 30

export function recentSignal(signal: Signal | undefined, now: string): string {
  const at = Date.parse(signal?.at ?? '')
  const clock = Date.parse(now)
  if (!signal || !Number.isFinite(at) || !Number.isFinite(clock)) return '最近信号：尚无记录'
  const minutes = Math.max(0, Math.floor((clock - at) / 60_000))
  const when = minutes === 0 ? '刚刚' : minutes < 60 ? `${minutes} 分钟前` : `${Math.floor(minutes / 60)} 小时前`
  return `最近信号：${when} · ${signal.channel}`
}

/** Information gaps describe missing observations, never session liveness or task state. */
export function informationGap(item: WorkItem, now: string, threshold = DEFAULT_SIGNAL_GAP_MIN): string | null {
  if (item.status !== 'in_progress' || !item.signal) return null
  const at = Date.parse(item.signal.at), clock = Date.parse(now)
  const limit = Number.isFinite(threshold) && threshold > 0 ? threshold : DEFAULT_SIGNAL_GAP_MIN
  if (!Number.isFinite(at) || !Number.isFinite(clock) || clock - at <= limit * 60_000) return null
  return `${Math.floor((clock - at) / 60_000)} 分钟没有任何信号`
}
