// 地图上始终要看得见的四种状态：谁在干活、等你决定、待验收、受阻。名牌、村庄名牌、小地图都用这一份计数。
import type { Approval } from '../types'
import { attentionManaged } from '../workManagement'
import { onReviewDesk } from './TownScene'
import type { BuildingView } from './townModel'

export interface StatusCounts { working: number; waiting: number; review: number; blocked: number }

export type StatusTone = keyof StatusCounts

/** 名牌上的顺序和配色：等你决定最先。 */
export const STATUS_CHIPS: { key: StatusTone; label: string; short: string; dot: string }[] = [
  { key: 'waiting', label: '等你决定', short: '决定', dot: '#e0a400' },
  { key: 'working', label: '工作中', short: '工作', dot: '#e3712d' },
  { key: 'review', label: '待验收', short: '验收', dot: '#5b6cd8' },
  { key: 'blocked', label: '受阻', short: '受阻', dot: '#d2483d' },
]

export function statusOf(b: BuildingView, pending: readonly Approval[]): StatusCounts {
  const waiting = new Set<string>()
  for (const c of b.characters) for (const a of c.pendingApprovals) waiting.add(a.id)
  if (b.repo) for (const a of pending) if (a.repo_id === b.repo.id) waiting.add(a.id)
  return {
    working: b.characters.filter((c) => c.status === 'working').length,
    waiting: waiting.size,
    review: b.parcels.filter(onReviewDesk).length,
    blocked: b.items.filter((w) => !attentionManaged(w) && w.status === 'blocked').length,
  }
}

export function sumStatus(list: readonly StatusCounts[]): StatusCounts {
  return list.reduce((s, x) => ({ working: s.working + x.working, waiting: s.waiting + x.waiting, review: s.review + x.review, blocked: s.blocked + x.blocked }),
    { working: 0, waiting: 0, review: 0, blocked: 0 })
}

/** 非零的状态按固定顺序列出；全是零时返回空，由调用方写“安静”之类的说明。 */
export function statusChips(s: StatusCounts): { key: StatusTone; text: string; short: string; dot: string }[] {
  return STATUS_CHIPS.filter((c) => s[c.key] > 0).map((c) => ({ key: c.key, text: `${c.label} ${s[c.key]}`, short: `${c.short} ${s[c.key]}`, dot: c.dot }))
}
