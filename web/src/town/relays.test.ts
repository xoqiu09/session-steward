import { describe, expect, it } from 'vitest'
import { relaysOf } from './relays'
import { shedSeat, shedSpots } from './workshop'
import { fakeItem, fakeRun } from './fixtures'
import type { Snapshot } from '../types'

const now = '2026-10-27T06:00:00Z'
const ago = (h: number) => new Date(Date.parse(now) - h * 3600_000).toISOString()
const snap: Snapshot = {
  cursor: 1, now, repos: [], sessions: [], deps: [], approvals: [],
  work_items: [fakeItem({ id: 'A-1', repo_id: 1, title: '导出', status: 'review' }), fakeItem({ id: 'A-2', repo_id: 1, title: '旧活', status: 'review' }), fakeItem({ id: 'A-3', repo_id: 2, title: '交接', status: 'in_progress' })],
  runs: [
    fakeRun({ id: 1, work_item_id: 'A-1', session_id: 1, provider: 'claude', started_at: ago(5), ended_at: ago(4) }),
    fakeRun({ id: 2, work_item_id: 'A-1', session_id: 2, provider: 'codex', started_at: ago(3) }),
    fakeRun({ id: 3, work_item_id: 'A-1', session_id: 3, provider: 'codex', started_at: ago(2) }),
    fakeRun({ id: 4, work_item_id: 'A-2', session_id: 1, provider: 'claude', started_at: ago(50) }),
    fakeRun({ id: 5, work_item_id: 'A-2', session_id: 2, provider: 'codex', started_at: ago(40) }),
    fakeRun({ id: 6, work_item_id: 'A-3', session_id: 4, provider: 'claude', started_at: ago(2) }),
    fakeRun({ id: 7, work_item_id: 'A-3', session_id: 5, provider: 'codex', started_at: ago(1) }),
  ],
  handoffs: [{ id: 'h1', work_item_id: 'A-3', from_session_id: 4, from_provider: 'claude', to_agent: 'codex', source_branch: 'b', source_sha: 's', managed_id: '', state: 'launched', created_at: ago(1.5) }],
}

describe('小推车：交接和接力', () => {
  const r = relaysOf(snap, Date.parse(now))

  it('同一工作项先后由不同 Agent 运行算一次接力；同一 Agent 连着跑不算；超过一天的不算', () => {
    const relays = r.filter((x) => x.kind === 'relay')
    expect(relays.map((x) => [x.itemId, x.from, x.to])).toEqual([['A-1', 'claude', 'codex']])
  })

  it('有交接记录时用交接，不再重复画同方向的接力', () => {
    expect(r.filter((x) => x.itemId === 'A-3').map((x) => [x.kind, x.from, x.to])).toEqual([['handoff', 'claude', 'codex']])
  })

  it('最新的排在前面，带项目编号', () => {
    expect(r[0].itemId).toBe('A-3')
    expect(r.every((x) => x.repoId > 0)).toBe(true)
  })
})

describe('作坊位置', () => {
  it('两家时左右各一间、中间留路；站位在作坊门口', () => {
    const s = shedSpots(['claude', 'codex'], 0, 0)
    expect(s.map((x) => x.agent)).toEqual(['claude', 'codex'])
    expect(s[0].gx + s[0].w).toBeLessThan(s[1].gx)
    const [, gy] = shedSeat(s[0], 0)
    expect(gy).toBeGreaterThan(s[0].gy + 0.95)
    expect(shedSpots(['codex'], 0, 0)).toHaveLength(1)
  })
})
