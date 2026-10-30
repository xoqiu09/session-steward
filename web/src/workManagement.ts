import type { WorkItem } from './types'

/** A user's reminder disposition never substitutes for a formal approval. */
export function attentionManaged(item: WorkItem) {
  return item.management?.state === 'paused' || item.management?.state === 'delegated'
}

export function managementLabel(item: WorkItem) {
  return item.management?.state === 'delegated'
    ? `已转交${item.management.owner ? `给 ${item.management.owner}` : ''}`
    : item.management?.state === 'accepted' ? '用户已处理' : '已暂停提醒'
}
