// 进度气泡：比较相邻两次（已脱敏的）快照，生成固定句式的事件。
// 句式全部是常量，绝不拼接来自数据的文字；项目名按项目编号的名次现算（“项目 A”）。
import type { Snapshot } from '../types'
import { liveProjectNames } from './scrub'

export type LiveEventKind = 'started' | 'run_done' | 'delivered' | 'accepted'

/** 固定句式：只替换通用项目名。 */
export const LIVE_PHRASES: Record<LiveEventKind, string> = {
  started: '一位助手开始干活',
  run_done: '一轮运行完成',
  delivered: '完成一项交付',
  accepted: '一项工作已收下',
}

export interface LiveEvent {
  key: string
  kind: LiveEventKind
  /** 气泡定位到哪栋建筑；没有项目时为 null。 */
  repoId: number | null
  text: string
}

const SUCCESS = new Set(['delivered', 'acknowledged', 'ended', 'handed_off'])
const working = (s: { state: string; freshness: string }) => s.state === 'running' && s.freshness !== 'stale' && s.freshness !== 'history'

/** 快照差异 → 事件。prev 为空（首次加载）时不出事件。 */
export function diffLiveEvents(prev: Snapshot | null, next: Snapshot): LiveEvent[] {
  if (!prev) return []
  const names = liveProjectNames((next.repos ?? []).map((r) => r.id))
  const label = (repoId: number | null | undefined) => (repoId != null && names.has(repoId) ? names.get(repoId)! : '小镇')
  const make = (kind: LiveEventKind, key: string, repoId: number | null | undefined): LiveEvent =>
    ({ key: `${kind}:${key}`, kind, repoId: repoId != null && names.has(repoId) ? repoId : null, text: `${label(repoId)} · ${LIVE_PHRASES[kind]}` })
  const out: LiveEvent[] = []

  const before = new Map((prev.sessions ?? []).map((s) => [s.id, s]))
  for (const s of next.sessions ?? []) {
    const old = before.get(s.id)
    if (working(s) && (!old || !working(old))) out.push(make('started', `${s.id}:${s.last_activity_at}`, s.repo_id))
  }

  const itemRepo = new Map((next.work_items ?? []).map((w) => [w.id, w.repo_id]))
  const sessionRepo = new Map((next.sessions ?? []).map((s) => [s.id, s.repo_id]))
  const runsBefore = new Map((prev.runs ?? []).map((r) => [r.id, r]))
  for (const r of next.runs ?? []) {
    const old = runsBefore.get(r.id)
    if (old && !old.ended_at && r.ended_at && SUCCESS.has(r.outcome)) out.push(make('run_done', String(r.id), itemRepo.get(r.work_item_id) ?? sessionRepo.get(r.session_id)))
  }

  const itemsBefore = new Map((prev.work_items ?? []).map((w) => [w.id, w]))
  for (const w of next.work_items ?? []) {
    const old = itemsBefore.get(w.id)
    if (!old || old.status === w.status) continue
    if (w.status === 'review') out.push(make('delivered', `${w.id}:${w.updated_at}`, w.repo_id))
    else if (w.status === 'done') out.push(make('accepted', `${w.id}:${w.updated_at}`, w.repo_id))
  }
  return out
}

/** 每个气泡显示多久。 */
export const BUBBLE_SHOW_MS = 8_000
/** 上一个气泡消失后，至少隔多久才出下一个。 */
export const BUBBLE_GAP_MS = 20_000
/** 积压最多保留最近几个，其余丢弃。 */
export const BUBBLE_BACKLOG = 3

export interface BubbleState {
  shown: (LiveEvent & { until: number }) | null
  queue: LiveEvent[]
  /** 上一个气泡消失的时间。 */
  lastEnd: number
}

export const emptyBubbles = (): BubbleState => ({ shown: null, queue: [], lastEnd: -Infinity })

/** 新事件入队：只保留最近 BUBBLE_BACKLOG 个，然后按时间推进。 */
export function pushBubbles(state: BubbleState, events: readonly LiveEvent[], now: number): BubbleState {
  if (!events.length) return stepBubbles(state, now)
  const queue = [...state.queue, ...events].slice(-BUBBLE_BACKLOG)
  return stepBubbles({ ...state, queue }, now)
}

/** 按时间推进：到时收起当前气泡；间隔够了再从队首取下一个。同时只显示一个。 */
export function stepBubbles(state: BubbleState, now: number): BubbleState {
  let s = state
  if (s.shown && now >= s.shown.until) s = { ...s, shown: null, lastEnd: s.shown.until }
  if (!s.shown && s.queue.length && now - s.lastEnd >= BUBBLE_GAP_MS) {
    const [next, ...rest] = s.queue
    s = { ...s, shown: { ...next, until: now + BUBBLE_SHOW_MS }, queue: rest }
  }
  return s
}

/** 下一次需要推进的时间（没有要做的事时为 null），给计时器用。 */
export function nextBubbleAt(state: BubbleState): number | null {
  if (state.shown) return state.shown.until
  if (state.queue.length) return state.lastEnd + BUBBLE_GAP_MS
  return null
}
