import { describe, expect, it } from 'vitest'
import { ripeQueue } from './harvest'
import { overdueRipe } from './moments'
import { buildTown } from './townModel'
import { fakeItem } from './fixtures'
import { staleDeliveries } from '../ui/QuickClose'
import { attention } from '../model'
import type { Snapshot } from '../types'

const now = '2026-11-20T00:00:00Z'
const hoursAgo = (h: number) => new Date(Date.parse(now) - h * 3600_000).toISOString()
const snap = (): Snapshot => ({
  cursor: 1, now, deps: [], runs: [], sessions: [], approvals: [],
  repos: [{ id: 1, name: 'synthetic', common_dir: '/synthetic/.git', is_git: true, target_ref: 'main' }],
  work_items: [
    fakeItem({ id: 'R-NEW', repo_id: 1, title: '刚交付', status: 'review', updated_at: hoursAgo(1) }),
    fakeItem({ id: 'R-OLD', repo_id: 1, title: '交付很久了', status: 'review', updated_at: hoursAgo(24 * 10) }),
    fakeItem({ id: 'R-AUTO', repo_id: 1, title: '例行整理', status: 'review', updated_at: hoursAgo(2), completion_policy: 'auto_history' }),
    fakeItem({ id: 'R-PAUSED', repo_id: 1, title: '已暂停', status: 'review', updated_at: hoursAgo(3), management: { state: 'paused', at: now } }),
  ],
} as unknown as Snapshot)

describe('收菜、队列与催促用同一口径', () => {
  it('收菜和队列的待验收是同一批：例行整理与已暂停的都不算', () => {
    const s = snap()
    const ripe = ripeQueue(buildTown(s, now).buildings).map((r) => r.item.id).sort()
    const queue = attention(s).review.map((w) => w.id).sort()
    expect(ripe).toEqual(['R-NEW', 'R-OLD'])
    expect(ripe).toEqual(queue)
  })
  it('按交付时间排序：先收等得最久的', () => {
    expect(ripeQueue(buildTown(snap(), now).buildings).map((r) => r.item.id)).toEqual(['R-OLD', 'R-NEW'])
  })
  it('超过 7 天的交付不再弹提醒，改为集中暂停', () => {
    const ids = overdueRipe(snap(), Date.parse(now)).map((m) => m.itemId)
    expect(ids).toEqual(['R-NEW'])
    expect(staleDeliveries(snap().work_items!, now).map((w) => w.id)).toEqual(['R-OLD'])
  })
})
