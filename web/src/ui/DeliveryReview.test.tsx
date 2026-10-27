import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { DeliveryReview } from './DeliveryReview'
import { runsBySession } from './runDeskModel'
import { fakeItem, fakeRun } from '../town/fixtures'
import type { Snapshot, WorkItem } from '../types'

const now = '2026-10-27T02:00:00Z'
const runs = [
  fakeRun({ id: 1, work_item_id: 'AGE-1', session_id: 80, provider: 'claude', started_at: '2026-10-26T13:00:00Z', ended_at: '2026-10-26T13:10:00Z' }),
  fakeRun({ id: 2, work_item_id: 'AGE-1', session_id: 80, provider: 'claude', started_at: '2026-10-26T14:00:00Z', ended_at: '2026-10-26T14:30:00Z' }),
  fakeRun({ id: 3, work_item_id: 'AGE-1', session_id: 80, provider: 'claude', started_at: '2026-10-26T15:00:00Z' }),
  fakeRun({ id: 4, work_item_id: 'AGE-1', session_id: 81, provider: 'codex', started_at: '2026-10-26T15:00:00Z', ended_at: '2026-10-26T16:00:00Z', outcome: 'handed_off' }),
]
const snap = (item: WorkItem): Snapshot => ({ cursor: 1, now, repos: [], sessions: [], work_items: [item], deps: [], runs, approvals: [] })

describe('运行层级', () => {
  it('同一会话的多段运行合成一行，记下段数和最后结果', () => {
    const g = runsBySession(runs)
    expect(g.map((x) => [x.sessionId, x.runs.length, x.open, x.outcome])).toEqual([[80, 3, true, ''], [81, 1, false, 'handed_off']])
  })
})

describe('待验收卡片', () => {
  it('写出 Agent 的交付说明、分支、验收标准和该怎么做', () => {
    const item = fakeItem({
      id: 'AGE-1', repo_id: null, title: '小镇候选', status: 'review', branch: 'claude/work-town-visual', acceptance: '一屏看清所有项目',
      brief: { fields: { summary: { entry_id: 1, text: '做好了一屏小镇', kind: 'agent', source: 'deliver', session_id: 80, at: '2026-10-26T15:30:00Z' } }, tool_events_since: 0, last_event_at: now, stale: false },
    })
    const html = renderToStaticMarkup(<DeliveryReview snap={snap(item)} item={item} onSelectSession={() => {}} actions={null} />)
    expect(html).toContain('做好了一屏小镇')
    expect(html).toContain('Agent 自述，会话 #80')
    expect(html).toContain('claude/work-town-visual')
    expect(html).toContain('一屏看清所有项目')
    expect(html).toContain('>#80<')
    expect(html).toContain('>#81<')
  })

  it('没有交付说明和验收条件时说清楚怎么办', () => {
    const item = fakeItem({ id: 'AGE-1', repo_id: null, title: '小镇候选', status: 'review' })
    const html = renderToStaticMarkup(<DeliveryReview snap={snap(item)} item={item} onSelectSession={() => {}} actions={null} />)
    expect(html).toContain('Agent 没有写交付说明')
    expect(html).toContain('没有写验收条件')
  })
})
