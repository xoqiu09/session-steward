import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { Overview } from './Overview'
import type { Approval, BriefField, Session, Snapshot, WorkItem } from './types'

const at = '2026-10-20T00:00:00Z'
const brief = (text: string): BriefField => ({ entry_id: 1, text, kind: 'agent', source: 'report', session_id: 7, at })
const item: WorkItem = { id: 'TEST-1', repo_id: 1, title: 'Example task', status: 'in_progress', acceptance: '', branch: '', merge_state: 'none', needs_merge: false, created_at: at, updated_at: at, ready: true, waiting: [], agents: ['claude'], brief: { fields: { progress: brief('Progress fact'), blocker: brief('Earlier reported blocker'), next: brief('Next action') }, tool_events_since: 0, last_event_at: at, stale: false } }
const snapshot: Snapshot = { cursor: 1, now: '2026-10-20T00:05:00Z', repos: [], sessions: [{ id: 7, provider: 'claude', work_item_id: 'TEST-1', data_source: 'live', freshness: 'live', state: 'running' } as Session], work_items: [item], deps: [], runs: [], approvals: [{ id: 'request', kind: 'permission', status: 'pending', work_item_id: 'TEST-1', session_id: 7, preview: 'Current approval command' } as Approval] }

function render(snap: Snapshot = snapshot, workItem: WorkItem = item) {
  return renderToStaticMarkup(<Overview snap={snap} groups={[{ key: 'project', repoId: 1, name: 'Example project', items: [workItem], sessions: [] }]} onSelectItem={() => {}} onOpenAttribution={() => {}} onQueue={() => {}} pendingCount={1} />)
}

describe('project brief for returning users', () => {
  it('keeps a current permission reason separate from an older reported blocker', () => {
    const html = render()
    expect(html).toContain('Current approval command')
    expect(html).toContain('Earlier reported blocker')
    expect(html).toContain('审批／决定 1')
  })
  it('shows who reported blocker and next action, including their content time', () => {
    const html = render()
    expect(html).toContain('Next action')
    expect((html.match(/Claude · 会话 #7 · Agent 自述 · 5 分钟前/g) ?? []).length).toBeGreaterThanOrEqual(3)
    expect(html).toContain('会话 #7 · steward-hook report')
  })
  it('renders a reported brief even when the session is absent from the snapshot', () => {
    expect(render({ ...snapshot, sessions: null })).toContain('Next action')
  })
  it('keeps a known agent visible while its session is quiet without claiming it is active', () => {
    const sessions = snapshot.sessions!.map((s) => ({ ...s, freshness: 'stale' as const }))
    const html = render({ ...snapshot, sessions })
    expect(html).toContain('已关联 1 个会话 · 暂无新活动')
    expect(html).not.toContain('执行者待关联')
    expect(html).not.toContain('1 个执行会话')
  })
  it('explains observed dependency and blocked status when no blocker was reported', () => {
    const w: WorkItem = { ...item, brief: { ...item.brief!, fields: { progress: brief('Work in progress') } } }
    const upstream = render({ ...snapshot, approvals: [] }, { ...w, ready: false, waiting: ['TEST-0'] })
    expect(upstream).toContain('等待上游工作项 TEST-0')
    expect(upstream).not.toContain('当前未报告阻塞')
    const blocked = render({ ...snapshot, approvals: [] }, { ...w, status: 'blocked' })
    expect(blocked).toContain('具体原因待 Agent 回报')
    expect(blocked).not.toContain('当前未报告阻塞')
  })
  it('uses newer legacy progress as the headline rather than an older summary', () => {
    const w: WorkItem = { ...item, brief: { ...item.brief!, fields: { summary: brief('Older short conclusion'), progress: { ...brief('Newer actual result'), at: '2026-10-20T00:01:00Z' } } } }
    const html = render({ ...snapshot, approvals: [] }, w)
    expect(html).toMatch(/brief-headline[^>]*>Newer actual result<\/p>/)
    expect(html).not.toMatch(/brief-headline[^>]*>Older short conclusion<\/p>/)
    expect(html).toContain('Older short conclusion')
  })
  it('ignores metadata-only updates while prioritizing formal requests', () => {
    const a = { ...item, id: 'AAA-1', repo_id: 1 }
    const b = { ...item, id: 'BBB-1', repo_id: 2, updated_at: '2026-10-20T01:00:00Z' }
    const snap = { ...snapshot, sessions: [], approvals: [], work_items: [a, b] }
    const groups = [{ key: 'b', repoId: 2, name: 'B project', items: [b], sessions: [] }, { key: 'a', repoId: 1, name: 'A project', items: [a], sessions: [] }]
    const markup = (s: Snapshot) => renderToStaticMarkup(<Overview snap={s} groups={groups} onSelectItem={() => {}} onOpenAttribution={() => {}} onQueue={() => {}} pendingCount={0} />)
    expect(markup(snap).indexOf('A project')).toBeLessThan(markup(snap).indexOf('B project'))
    const requested = { ...snap, approvals: [{ ...snapshot.approvals![0], work_item_id: 'BBB-1', session_id: null }] }
    expect(markup(requested).indexOf('B project')).toBeLessThan(markup(requested).indexOf('A project'))
  })
  it('folds quiet projects, preserves their review count and reveals explicit search results', () => {
    const old = { ...item, status: 'review' as const }
    const snap = { ...snapshot, now: '2026-10-24T00:00:00Z', approvals: [], sessions: [], work_items: [old] }
    const groups = [{ key: 'old', repoId: 1, name: 'Quiet project', items: [old], sessions: [] }]
    const markup = (expandQuiet = false) => renderToStaticMarkup(<Overview snap={snap} groups={groups} expandQuiet={expandQuiet} onSelectItem={() => {}} onOpenAttribution={() => {}} onQueue={() => {}} pendingCount={0} reviewCount={1} />)
    const collapsed = markup()
    expect(collapsed).toContain('显示 0 个项目 · 已收起 1 个')
    expect(collapsed).toMatch(/<details class="quiet-projects"><summary>近期无活动 · 1 个项目 · 待审阅／验收 1<\/summary>/)
    expect(collapsed).toContain('Quiet project')
    expect(collapsed).toContain('待审阅／验收 1')
    expect(markup(true)).not.toContain('class="quiet-projects"')
    expect(markup(true)).toContain('显示 1 个项目')
  })
})
