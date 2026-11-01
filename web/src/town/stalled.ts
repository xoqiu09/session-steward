// 停在你手上的工作：Agent 停了、工作没完成、没人在推、下一步该你（或没写下一步）。只读快照，不改任何状态。
import type { Snapshot, WorkItem } from '../types'
import { attentionManaged } from '../workManagement'
import { waitedText } from './moments'

export const STALL_MS = 30 * 60 * 1000
// 超过 7 天没动静视为搁置，不再提醒。
export const STALE_LIMIT_MS = 7 * 24 * 3600_000

export interface StalledItem { item: WorkItem; repoName: string; idleMs: number; lastAt: string; next: string; nextOwner: string; reason: string }

const time = (s: string | undefined) => Date.parse(s || '') || 0
const visibleItem = (w: WorkItem) => !attentionManaged(w) && w.completion_policy !== 'auto_history' && !w.automatic_history
// review 归“菜熟了”管；done、abandoned 已结束。
const OPEN = new Set<WorkItem['status']>(['todo', 'in_progress', 'blocked'])
// 下一步归这些人时是别人的事，不算停在你手上。
const OTHERS = new Set(['agent', 'claude', 'codex', 'external'])

/** 取最新的时间串；都无效时返回空串。 */
function latest(times: (string | undefined)[]): string {
  return times.filter((t): t is string => !!t && time(t) > 0).sort((a, b) => time(b) - time(a))[0] || ''
}

function stalledReason(hasSession: boolean, idleMs: number, next: string): string {
  const t = waitedText(idleMs)
  if (hasSession) return next ? `Agent 停了 ${t}，下一步该你：${next}` : `Agent 停了 ${t}，没写下一步`
  return next ? `没人在推，已经 ${t}没动静；下一步：${next}` : `没人在推，已经 ${t}没动静`
}

/**
 * 判定：工作项可见且状态为 todo/in_progress/blocked；没有关联会话在 running 或 waiting_permission；
 * 最后动静（会话 last_activity_at、简报 last_event_at、工作项 updated_at 取最新）距今满 STALL_MS 且不超过 STALE_LIMIT_MS；
 * 下一步负责人为 user、unknown 或空。结果按停滞时长从长到短排列。
 */
export function stalledItems(s: Snapshot, nowMs: number): StalledItem[] {
  const out: StalledItem[] = []
  for (const w of s.work_items ?? []) {
    if (!visibleItem(w) || !OPEN.has(w.status)) continue
    const sessions = (s.sessions ?? []).filter((v) => v.work_item_id === w.id)
    if (sessions.some((v) => v.state === 'running' || v.state === 'waiting_permission')) continue
    const nextOwner = (w.brief?.fields.next_owner?.text ?? '').trim()
    if (OTHERS.has(nextOwner.toLowerCase())) continue
    const lastAt = latest([...sessions.map((v) => v.last_activity_at), w.brief?.last_event_at, w.updated_at])
    if (!lastAt) continue
    const idleMs = nowMs - time(lastAt)
    if (idleMs < STALL_MS || idleMs > STALE_LIMIT_MS) continue
    const next = (w.brief?.fields.next?.text ?? '').trim()
    const repoName = (s.repos ?? []).find((r) => r.id === w.repo_id)?.name || '未归属'
    out.push({ item: w, repoName, idleMs, lastAt, next, nextOwner, reason: stalledReason(sessions.length > 0, idleMs, next) })
  }
  return out.sort((a, b) => b.idleMs - a.idleMs || a.item.id.localeCompare(b.item.id))
}

/** 去重键带最后动静时间：同一段停滞只提醒一次，有新动静后再停会重新提醒。 */
export function stalledKey(x: StalledItem): string {
  return JSON.stringify([x.item.id, 'stalled', x.lastAt])
}
