import { describe, expect, it } from 'vitest'
import { orderedProjects, projectActivity } from './projectActivity'
import { queueCounts, type Group } from './model'
import type { Approval, Brief, Session, Snapshot, WorkItem } from './types'

const now = '2026-10-24T04:00:00Z'
const old = '2026-10-21T00:00:00Z'
const recent = '2026-10-24T03:00:00Z'
const brief = (at = old): Brief => ({ fields: { progress: { entry_id: 1, text: 'Synthetic progress', kind: 'agent', source: 'report', session_id: 1, at } }, tool_events_since: 0, last_event_at: '', stale: false })
const item = (id: number, at = old): WorkItem => ({ id: `SYN-${id}`, repo_id: id, title: 'Synthetic task', status: 'in_progress', acceptance: '', branch: '', merge_state: 'none', needs_merge: false, created_at: old, updated_at: now, ready: true, waiting: [], agents: ['codex'], brief: brief(at) })
const group = (id: number, at = old): Group => ({ key: String(id), name: id === 1 ? 'A old project' : 'Z recent project', repoId: id, items: [item(id, at)], sessions: [] })
const base: Snapshot = { now, cursor: 1, work_items: [item(1), item(2, recent)], repos: [], sessions: [], runs: [], approvals: [], deps: [] }
const session = (work_item_id = 'SYN-1', over: Partial<Session> = {}): Session => ({ id: 1, work_item_id, repo_id: 1, data_source: 'live', freshness: 'live', state: 'running', last_activity_at: now, ...over } as Session)

describe('project activity rather than names or bookkeeping', () => {
  it('puts newer work before alphabetically earlier old work', () => {
    expect(orderedProjects(base, [group(1), group(2, recent)]).map(p => p.group.repoId)).toEqual([2, 1])
  })
  it('does not revive a quiet project when only updated_at or historical discovery changes', () => {
    const snap = { ...base, sessions: [session('SYN-1', { data_source: 'history' })] }
    expect(projectActivity(snap, group(1))).toMatchObject({ quiet: true, running: 0, lastActivityAt: Date.parse(old) })
  })
  it('keeps current execution ahead of newer idle work, without treating stale running state as active', () => {
    const g = group(1)
    const active = { ...base, sessions: [session('SYN-1', { last_activity_at: '2026-10-24T02:00:00Z' })] }
    expect(orderedProjects(active, [g, group(2, recent)])[0].group.repoId).toBe(1)
    expect(orderedProjects({ ...active, sessions: [session('SYN-1', { freshness: 'stale', last_activity_at: old })] }, [g, group(2, recent)])[0].group.repoId).toBe(2)
  })
  it('keeps a live tool event separate from the last business report', () => {
    expect(projectActivity({ ...base, sessions: [session()] }, group(1))).toMatchObject({ quiet: false, running: 1, lastActivityAt: Date.parse(now), lastReportAt: Date.parse(old) })
  })
  it('prioritizes an unresolved formal request even on an old project', () => {
    const a = { id: 'request', kind: 'permission', status: 'pending', work_item_id: 'SYN-1', repo_id: 1, session_id: null, payload: {} } as Approval
    const snap = { ...base, approvals: [a] }
    expect(orderedProjects(snap, [group(1), group(2, recent)])[0]).toMatchObject({ group: { repoId: 1 }, quiet: false, counts: { action: 1 } })
    expect(projectActivity({ ...snap, approvals: [{ ...a, deadline: old }] }, group(1)).quiet).toBe(true)
  })
  it('folds an old delivery without removing it from the review count or changing status', () => {
    const g = group(1); g.items[0].status = 'review'
    const snap = { ...base, work_items: g.items }
    expect(projectActivity(snap, g)).toMatchObject({ quiet: true, counts: { action: 0, review: 1 } })
    expect(queueCounts(snap).review).toBe(1)
    expect(g.items[0].status).toBe('review')
  })
  it('revives a quiet project when a new report arrives, including a separate session contribution', () => {
    const g = group(1)
    expect(projectActivity(base, g).quiet).toBe(true)
    g.items[0].brief!.by_session = { '2': brief(recent) }
    expect(projectActivity(base, g)).toMatchObject({ quiet: false, lastReportAt: Date.parse(recent) })
  })
  it('uses an exact 24-hour boundary and handles unknown, flagged and future times', () => {
    expect(projectActivity(base, group(1, '2026-10-23T04:00:00Z')).quiet).toBe(true)
    expect(projectActivity(base, group(1, '2026-10-23T04:00:01Z')).quiet).toBe(false)
    const g = group(1, now)
    g.items[0].brief!.fields.progress!.flagged = true
    g.items[0].created_at = 'invalid'
    expect(projectActivity(base, g)).toMatchObject({ quiet: true, lastReportAt: 0, lastActivityAt: 0 })
    g.items[0].brief = brief('2026-10-25T00:00:00Z')
    expect(projectActivity(base, g).lastReportAt).toBe(0)
  })
  it('ignores events belonging to another completed or hidden task', () => {
    expect(projectActivity({ ...base, sessions: [session('SYN-99')] }, group(1)).quiet).toBe(true)
  })
})
