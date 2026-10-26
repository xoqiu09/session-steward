import { describe, expect, it } from 'vitest'
import { statusChips, statusOf, sumStatus } from './status'
import { buildTown } from './townModel'
import { fakeApproval, fakeItem, fakeRun, fakeSession } from './fixtures'
import type { Snapshot } from '../types'

const now = '2026-10-26T06:00:00Z'
const snap: Snapshot = {
  cursor: 1, now, repos: [{ id: 1, name: 'demo-repo', common_dir: '', is_git: true, target_ref: 'main' }],
  sessions: [
    fakeSession({ id: 7, provider: 'claude', state: 'running', repo_id: 1, work_item_id: 'W-1', last_activity_at: now }),
    fakeSession({ id: 8, provider: 'codex', state: 'running', repo_id: 1, work_item_id: 'B-1', last_activity_at: now }),
  ],
  work_items: [
    fakeItem({ id: 'W-1', repo_id: 1, title: '正在做', status: 'in_progress' }),
    fakeItem({ id: 'B-1', repo_id: 1, title: '卡住了', status: 'blocked' }),
    fakeItem({ id: 'B-2', repo_id: 1, title: '也卡住了', status: 'blocked' }),
    fakeItem({ id: 'R-1', repo_id: 1, title: '等你验收', status: 'review' }),
  ],
  deps: [],
  runs: [fakeRun({ id: 1, work_item_id: 'W-1', session_id: 7, provider: 'claude' }), fakeRun({ id: 2, work_item_id: 'R-1', session_id: 7, provider: 'claude', ended_at: now })],
  approvals: [
    fakeApproval({ id: 'A-1', kind: 'decision', status: 'pending', repo_id: 1, session_id: 8, preview: '选哪个？' }),
    fakeApproval({ id: 'A-2', kind: 'decision', status: 'pending', repo_id: 1, session_id: 99, preview: '另一个' }),
  ],
}

describe('地图上的四种状态', () => {
  const model = buildTown(snap, now)
  const st = statusOf(model.buildings[0], model.pendingApprovals)

  it('同一个决定不重复计数，受阻按工作项数', () => {
    expect(st).toEqual({ working: 1, waiting: 2, review: 1, blocked: 2 })
  })

  it('名牌按 等你决定、工作中、待验收、受阻 的顺序，只列非零的', () => {
    expect(statusChips(st).map((c) => c.text)).toEqual(['等你决定 2', '工作中 1', '待验收 1', '受阻 2'])
    expect(statusChips({ working: 0, waiting: 0, review: 3, blocked: 0 }).map((c) => c.text)).toEqual(['待验收 3'])
  })

  it('村庄名牌把成员加起来', () => {
    expect(sumStatus([st, st])).toEqual({ working: 2, waiting: 4, review: 2, blocked: 4 })
  })
})
