import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { StageBand } from './StageBand'
import { nextOwner, stageSummary, stageView } from './stage'
import type { BriefField, Session, Snapshot, WorkItem } from './types'

const f = (text: string): BriefField => ({ entry_id: 1, text, kind: 'agent', source: 'report', session_id: 7, at: '2026-10-21T00:00:00Z' })
const item = (over: Partial<WorkItem> = {}): WorkItem => ({ id: 'TEST-1', repo_id: 1, title: 'Example', status: 'in_progress', acceptance: '', branch: '', merge_state: 'none', needs_merge: false, created_at: '', updated_at: '', ready: true, waiting: [], agents: [], ...over })
const snap: Snapshot = { cursor: 1, now: '', repos: [], sessions: [{ id: 7, provider: 'claude' } as Session], work_items: [], deps: [], runs: [], approvals: [] }
const brief = (fields: Record<string, BriefField>) => ({ fields, tool_events_since: 0, last_event_at: '', stale: false })

describe('evidence-aware stage track', () => {
  it('leaves unreported work unknown instead of guessing from running state', () => {
    const w = item()
    expect(stageView(w).key).toBe('unknown')
    const html = renderToStaticMarkup(<StageBand item={w} />)
    expect(html).not.toContain('aria-current="step"')
    expect(html).not.toContain('role="progressbar"')
    expect(html).not.toContain('%')
  })
  it('highlights only the reported phase and keeps blockers independent', () => {
    const w = item({ brief: brief({ stage: f('validating'), blocker: f('Full check failed') }) })
    const html = renderToStaticMarkup(<StageBand item={w} />)
    expect(html.match(/aria-current="step"/g)).toHaveLength(1)
    expect(html).toContain('验证中')
    expect(html).toContain('有卡点')
    expect(stageView(w).key).toBe('validating')
  })
  it('only user-completed status reaches accepted; reopened work does not retain acceptance', () => {
    expect(stageView(item({ brief: brief({ stage: f('accepted') }) })).key).toBe('unknown')
    expect(stageView(item({ status: 'done' })).key).toBe('accepted')
    expect(stageView(item({ status: 'review' })).key).toBe('review')
    expect(stageView(item({ brief: brief({ stage: f('unknown') }) })).key).toBe('unknown')
  })
  it('shows the actual next actor only when reported or handed off', () => {
    expect(nextOwner(snap, item())).toBe('负责人待回报')
    expect(nextOwner(snap, item({ brief: brief({ next_owner: f('agent') }) }))).toBe('Claude')
    expect(nextOwner(snap, item({ brief: brief({ next_owner: f('external') }) }))).toBe('外部依赖方')
    expect(nextOwner(snap, item({ status: 'review' }))).toBe('你')
  })
  it('aggregates stage counts without inventing a project percentage', () => {
    expect(stageSummary([item(), item({ brief: brief({ stage: f('validating') }) }), item({ status: 'review' })])).toBe('验证 1 · 待验收 1 · 待同步 1')
  })
})
