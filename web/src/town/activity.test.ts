import { describe, expect, it } from 'vitest'
import { hideInactive } from './activity'
import type { Snapshot } from '../types'

const at = '2026-11-04T00:00:00Z'
const repo = (id: number, activity?: 'active' | 'quiet' | 'dormant') => ({ id, name: `synthetic-${id}`, common_dir: `/synthetic/${id}/.git`, is_git: true, target_ref: 'main', activity })
const snap = (): Snapshot => ({
  cursor: 1, now: at, deps: [],
  repos: [repo(1, 'active'), repo(2, 'quiet'), repo(3, 'dormant'), repo(4)],
  work_items: [1, 2, 3, 4].map((r) => ({ id: `SYN-${r}`, repo_id: r, title: 'synthetic', status: 'in_progress', acceptance: '', branch: '', merge_state: 'none', needs_merge: false, created_at: at, updated_at: at, ready: true, waiting: [], agents: [] })),
  sessions: [], runs: [], approvals: [],
} as unknown as Snapshot)

describe('不活跃项目默认收起', () => {
  it('只收起安静和沉睡的项目及其工作，不认识的活跃度按活跃处理', () => {
    const { snap: out, hidden } = hideInactive(snap(), 'all')
    expect(hidden).toBe(2)
    expect(out.repos!.map((r) => r.id)).toEqual([1, 4])
    expect(out.work_items!.map((w) => w.id)).toEqual(['SYN-1', 'SYN-4'])
  })
  it('正在查看的项目即使不活跃也保留', () => {
    const { snap: out, hidden } = hideInactive(snap(), 3)
    expect(hidden).toBe(1)
    expect(out.repos!.map((r) => r.id)).toEqual([1, 3, 4])
  })
  it('没有不活跃项目时原样返回', () => {
    const s = snap(); s.repos = [repo(1, 'active')]
    expect(hideInactive(s, 'all').snap).toBe(s)
  })
})
