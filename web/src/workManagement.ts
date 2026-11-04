import type { WorkItem } from './types'

/** A user's reminder disposition never substitutes for a formal approval. */
export function attentionManaged(item: WorkItem) {
  return item.management?.state === 'paused' || item.management?.state === 'delegated'
}

/** 待你验收的交付：队列、每日十分钟和小镇收菜共用这一条，数字才对得上。例行整理的轮次自动收进历史，不算。 */
export function awaitingAcceptance(item: WorkItem) {
  return item.status === 'review' && !attentionManaged(item) && item.completion_policy !== 'auto_history'
}

/** 交付到现在超过这么久就不再标红催促，改为在列表里集中给出“暂停提醒”。 */
export const STALE_REVIEW_MS = 7 * 24 * 3600_000

/** 交付时间：有交付记录用交付时间，否则用最后更新时间。 */
export const deliveredAt = (w: WorkItem) => w.brief?.last_delivered_at || w.updated_at

export function managementLabel(item: WorkItem) {
  return item.management?.state === 'delegated'
    ? `已转交${item.management.owner ? `给 ${item.management.owner}` : ''}`
    : item.management?.state === 'accepted' ? '用户已处理' : '已暂停提醒'
}
