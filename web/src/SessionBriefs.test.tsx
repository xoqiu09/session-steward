import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { SessionBriefs } from './SessionBriefs'
import { primaryItem, stageSummary, stageView } from './stage'
import { Queue, queueCount } from './Queue'
import { itemSignal, queueCounts, reportedHandoffs } from './model'
import { briefMatches } from './brief'
import { Overview } from './Overview'
import { StageBand } from './StageBand'
import type { Brief, BriefField, Session, Snapshot, WorkItem } from './types'

const at = '2026-10-21T00:00:00Z'
const fields = (sid: number, values: Record<string, string>): Brief => ({ fields: Object.fromEntries(Object.entries(values).map(([key, text]) => [key, { entry_id: sid, text, kind: 'agent', source: 'report', session_id: sid, at } satisfies BriefField])), tool_events_since: 0, last_event_at: '', stale: false })
const first = fields(1, { stage: 'validating', summary: 'API check failed', progress: 'API check failed', blocker: 'Repair failed API test', next: 'Fix backend', next_owner: 'agent' })
const second = fields(2, { stage: 'implementing', summary: 'UI ready', progress: 'UI ready', next: 'Wait for contract', next_owner: 'external' })
const item: WorkItem = { id: 'MULTI-1', repo_id: 1, title: 'Shared task', status: 'in_progress', acceptance: '', branch: '', merge_state: 'none', needs_merge: false, created_at: at, updated_at: at, ready: true, waiting: [], agents: ['claude', 'codex'], brief: { ...second, by_session: { '1': first, '2': second } } }
const session = (id: number, provider: string): Session => ({ id, provider, provider_session_id: `s-${id}`, title: `Worker ${id}`, work_item_id: item.id, state: 'running', data_source: 'live', freshness: 'live', last_activity_at: at } as Session)
const snap: Snapshot = { cursor: 1, now: at, repos: [], sessions: [session(1, 'claude'), session(2, 'codex')], work_items: [item], runs: [], deps: [], approvals: [] }

describe('parallel session briefs', () => {
  it('removes only answered same-session handoffs and keeps new requests and review', () => {
    const waiting = fields(1, { next_owner: 'user', next: 'Choose a synthetic format' })
    const peer = fields(2, { next_owner: 'user', next: 'Review a separate fixture' })
    const answered = { ...waiting, input_resolved_at: '2026-10-21T00:01:00Z' }
    const w = { ...item, brief: { ...waiting, by_session: { '1': answered, '2': peer } } }
    expect(reportedHandoffs(snap, w).map((h) => h.owner.session_id)).toEqual([2])
    expect(waiting.fields.next_owner?.text).toBe('user')
    expect(renderToStaticMarkup(<SessionBriefs snap={snap} item={w} sessions={[snap.sessions![0]]} />)).toContain('已回应，等待 Agent 更新')
    const newer = { ...answered, fields: { ...answered.fields, next_owner: { ...answered.fields.next_owner!, at: '2026-10-21T00:02:00Z' } } }
    expect(reportedHandoffs(snap, { ...w, brief: { ...waiting, by_session: { '1': newer, '2': peer } } })).toHaveLength(2)
    const review = { ...w, status: 'review' as const, brief: { ...waiting, by_session: { '1': answered } } }
    expect(renderToStaticMarkup(<Queue snap={{ ...snap, work_items: [review] }} onSelectItem={() => {}} />)).toContain('待验收')
  })
  it('keeps each session phase, blocker and next actor together', () => {
    const html = renderToStaticMarkup(<SessionBriefs snap={snap} item={item} sessions={snap.sessions!} />)
    const rows = html.split('<li ')
    expect(rows[1]).toContain('API check failed')
    expect(rows[1]).toContain('Repair failed API test')
    expect(rows[1]).toContain('下一步 · Claude')
    expect(rows[1]).not.toContain('UI ready')
    expect(rows[2]).toContain('UI ready')
    expect(rows[2]).toContain('下一步 · 外部依赖方')
    expect(rows[2]).not.toContain('Repair failed API test')
    expect(briefMatches(item, 'repair failed api')).toBe(true)
  })
  it('does not borrow a peers report when a new session has not reported', () => {
    const noReport = { ...item, brief: { ...second, by_session: { '1': first } } }
    const html = renderToStaticMarkup(<SessionBriefs snap={snap} item={noReport} sessions={[snap.sessions![1]]} />)
    expect(html).toContain('此会话尚未回报进展')
    expect(html).toContain('负责人待回报')
    expect(html).not.toContain('API check failed')
    expect(html).not.toContain('UI ready')
  })
  it('uses the current reporter rather than a later ended reviewers summary', () => {
    const onlyFirst = { ...snap, sessions: [snap.sessions![0], { ...snap.sessions![1], state: 'ended' as const, work_item_id: '' }] }
    expect(primaryItem(onlyFirst, item).brief?.fields.summary?.text).toBe('API check failed')
    const missing = { ...item, brief: { ...second, by_session: { '2': second } } }
    expect(primaryItem(onlyFirst, missing).brief?.fields.summary).toBeUndefined()
  })
  it('shows two independent tasks in one project and a parallel task without a false shared phase', () => {
    const other: WorkItem = { ...item, id: 'MULTI-2', title: 'Separate task', brief: null, status: 'todo', agents: [] }
    const html = renderToStaticMarkup(<Overview snap={{ ...snap, work_items: [item, other] }} groups={[{ key: 'p', name: 'Example project', repoId: 1, items: [item, other], sessions: [] }]} onSelectItem={() => {}} onOpenAttribution={() => {}} onQueue={() => {}} pendingCount={0} />)
    expect(html).toContain('Shared task')
    expect(html).toContain('Separate task')
    expect(html).toContain('多会话协作')
    expect(html).toContain('按会话分别回报')
    expect(stageSummary([item, other], snap)).toBe('准备 1 · 并行推进 1')
  })
  it('surfaces explicit human handoffs without granting tool permission or duplicating review', () => {
    const waiting = fields(1, { ...Object.fromEntries(Object.entries(first.fields).map(([k, v]) => [k, v!.text])), next_owner: 'user', next: 'Decide whether to repair fixture' })
    const w: WorkItem = { ...item, status: 'review', updated_at: '2026-10-20T23:00:00Z', brief: { ...waiting, by_session: { '1': waiting, '2': second } } }
    const s: Snapshot = { ...snap, work_items: [w] }
    expect(stageView(w).key).toBe('validating')
    expect(itemSignal(s, w).label).toBe('待你决定')
    expect(queueCount(s)).toBe(1)
    expect(queueCounts(s, 1, 'codex')).toMatchObject({ action: 0, review: 1 }) // Work-item review is separate from this peer's request.
    const ended = { ...s, sessions: [{ ...s.sessions![0], state: 'ended' as const, work_item_id: '' }, s.sessions![1]], work_items: [{ ...w, brief: { ...second, by_session: { '1': waiting, '2': second } } }] }
    expect(queueCount(ended)).toBe(1) // A peer's progress or session ending cannot answer this request.
    const delivered = { ...s, work_items: [{ ...w, brief: { ...w.brief!, last_delivered_at: '2026-10-21T00:02:00Z' } }] }
    expect(itemSignal(delivered, delivered.work_items[0]).label).toBe('待你验收')
    expect(renderToStaticMarkup(<Queue snap={delivered} onSelectItem={() => {}} />)).not.toContain('advisory-group')
    expect(queueCount(delivered)).toBe(1)
    const oneCurrent = { ...delivered, sessions: [snap.sessions![1]] }
    expect(itemSignal(oneCurrent, primaryItem(oneCurrent, delivered.work_items[0])).label).toBe('待你验收')
    const html = renderToStaticMarkup(<Queue snap={s} onSelectItem={() => {}} />)
    expect(html).toContain('advisory-group')
    expect(html).toContain('Decide whether to repair fixture')
    expect(html).not.toContain('允许本次')
    const resolved = { ...waiting, fields: { ...waiting.fields, next_owner: { ...waiting.fields.next_owner!, text: 'agent' } } }
    const active: WorkItem = { ...w, status: 'in_progress', brief: { ...resolved, by_session: { '1': resolved, '2': second } } }
    expect(queueCount({ ...s, work_items: [active] })).toBe(0)
    expect(stageView({ ...w, status: 'done' }).key).toBe('accepted')
  })
  it('keeps parallel phases separate after an earlier delivery and labels legacy command prose', () => {
    const html = renderToStaticMarkup(<StageBand item={{ ...item, status: 'review' }} parallel />)
    expect(html).toContain('多会话协作')
    expect(html).not.toContain('aria-current="step"')
    expect(stageSummary([{ ...item, status: 'review' }], snap)).toBe('并行推进 1')
    const legacy = fields(2, { summary: '--stage validating --summary Candidate ready' })
    const w = { ...item, brief: { ...legacy, by_session: { '2': legacy } } }
    const rendered = renderToStaticMarkup(<SessionBriefs snap={snap} item={w} sessions={[snap.sessions![1]]} />)
    expect(rendered).toContain('旧格式回报，需该会话更新')
    expect(rendered).toContain('查看旧格式原文')
  })
})
