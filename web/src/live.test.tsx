import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { liveSummary, parseDeepLink, projectActor, projectActorRows, resolveDeepLink } from './live'
import { groupByRepo, queueCounts } from './model'
import { ManagedPanel, NewManaged, Unmanaged } from './Managed'
import { SessionDetail } from './Panels'
import type { Approval, BriefField, ManagedSession, Session, Snapshot, WorkItem } from './types'

const at = '2026-10-20T00:00:00Z'
const owner = (text: string): BriefField => ({ entry_id: 1, text, kind: 'agent', source: 'report', session_id: 1, at })
const item = (id: string, repo: number, extra: Partial<WorkItem> = {}): WorkItem => ({ id, repo_id: repo, title: id, status: 'in_progress', acceptance: '', branch: '', merge_state: 'none', needs_merge: false, created_at: at, updated_at: at, ready: true, waiting: [], agents: [], ...extra })
const session = (id: number, extra: Partial<Session> = {}): Session => ({ id, provider: 'claude', data_source: 'live', freshness: 'live', state: 'running', work_item_id: '', repo_id: 1, worktree: '', cwd: '/synthetic', ...extra } as Session)
const managed = (extra: Partial<ManagedSession> = {}): ManagedSession => ({ id: 'abcd1234', repo_id: 1, agent: 'codex', title: 'Synthetic', work_item_id: 'SYN-1', worktree: '/wt/abcd', branch: 'steward/abcd1234', base_sha: 'x', tmux_name: 'steward-abcd1234', state: 'running', exit_code: null, error: '', session_id: null, takeover: false, created_at: at, updated_at: at, ...extra })
const base: Snapshot = { cursor: 1, now: at, repos: [{ id: 1, name: 'synthetic', common_dir: '/r/.git', is_git: true, target_ref: 'main' }], sessions: [], work_items: [], deps: [], runs: [], approvals: [] }

describe('谁在动 / 下一步', () => {
  it('counts waiting, running, blocked and quiet from real state only', () => {
    const snap: Snapshot = {
      ...base,
      work_items: [item('SYN-1', 1), item('SYN-2', 1, { status: 'blocked' })],
      sessions: [session(1, { work_item_id: 'SYN-1' }), session(2, { freshness: 'stale' }), session(3, { data_source: 'history', freshness: 'history' })],
      approvals: [{ id: 'p1', kind: 'permission', status: 'pending', session_id: 1, work_item_id: null, handleable: true } as unknown as Approval],
      managed: [managed({ session_id: null })],
    }
    const s = liveSummary(snap)
    expect(s.running).toBe(2) // 一个 hooks 会话 + 一个尚未发 hooks 的托管会话
    expect(s.blocked).toBe(1)
    expect(s.quiet).toBe(1)
    expect(s.waiting).toBeGreaterThanOrEqual(1)
  })
  it('reports the project actor: user first, then agent, external, unknown', () => {
    const waiting: Snapshot = { ...base, work_items: [item('SYN-1', 1)], sessions: [session(1, { work_item_id: 'SYN-1' })], approvals: [{ id: 'p', kind: 'decision', status: 'pending', session_id: 1 } as Approval] }
    expect(projectActor(waiting, 1)).toBe('user')
    expect(projectActor({ ...base, work_items: [item('SYN-1', 1, { brief: { fields: { next_owner: owner('codex') }, tool_events_since: 0, last_event_at: at, stale: false } })] }, 1)).toBe('agent')
    expect(projectActor({ ...base, work_items: [item('SYN-1', 1, { brief: { fields: { next_owner: owner('external') }, tool_events_since: 0, last_event_at: at, stale: false } })] }, 1)).toBe('external')
    expect(projectActor({ ...base, work_items: [item('SYN-1', 1)] }, 1)).toBe('unknown')
    expect(projectActor({ ...base, work_items: [item('SYN-1', 1, { status: 'done' })] }, 1)).toBe('idle')
  })
  const rows = (snap: Snapshot, provider = 'all') => projectActorRows(snap, groupByRepo(snap, { query: '', showDone: false, repoId: 'all', provider }), provider)
  const old = '2026-10-16T00:00:00Z'
  const quietReview = item('SYN-1', 1, { status: 'review', created_at: old, updated_at: at })
  it('folds an old review out of the live strip without changing its acceptance count', () => {
    const snap = { ...base, work_items: [quietReview] }
    expect(rows(snap).recent).toHaveLength(0)
    expect(rows(snap).quiet).toHaveLength(1)
    expect(queueCounts(snap).review).toBe(1)
    expect(quietReview.status).toBe('review')
  })
  it('labels ordinary recent review separately from a formal decision', () => {
    expect(projectActor({ ...base, work_items: [item('SYN-1', 1, { status: 'review' })] }, 1)).toBe('review')
  })
  it('shows actual execution ahead of an earlier ordinary review', () => {
    const snap = { ...base, work_items: [quietReview], sessions: [session(1, { work_item_id: 'SYN-1', last_activity_at: at })] }
    expect(rows(snap).recent[0].actor).toBe('agent')
  })
  it('returns an old project to the strip for a valid formal request but not an expired one', () => {
    const approval = { id: 'old-request', kind: 'permission', status: 'pending', session_id: null, work_item_id: 'SYN-1', repo_id: 1, created_at: at, payload: {} } as Approval
    const snap = { ...base, work_items: [quietReview], approvals: [approval] }
    expect(rows(snap).recent[0].actor).toBe('user')
    expect(rows({ ...snap, approvals: [{ ...approval, deadline: old }] }).recent).toHaveLength(0)
  })
  it('restores a quiet project after a new report and follows the same activity order as the briefs', () => {
    const updated = { ...quietReview, brief: { fields: { progress: owner('New result') }, tool_events_since: 0, last_event_at: at, stale: false } }
    const snap = { ...base, work_items: [updated] }
    expect(rows(snap).recent[0]).toMatchObject({ group: { repoId: 1 }, actor: 'review' })
  })
  it('lets a current agent-owned item lead an old review, while a recent delivery still reads as review', () => {
    const now = '2026-10-23T12:00:00Z', delivered = (time: string) => ({ fields: {}, tool_events_since: 0, last_event_at: time, stale: false, last_delivered_at: time })
    const working = item('SYN-2', 1, { brief: { fields: { next_owner: { ...owner('agent'), at: now } }, tool_events_since: 0, last_event_at: now, stale: false } })
    const snap = (time: string) => ({ ...base, now, work_items: [item('SYN-1', 1, { status: 'review', updated_at: now, brief: delivered(time) }), working] })
    expect(projectActor(snap('2026-10-19T00:00:00Z'), 1)).toBe('agent')
    expect(projectActor(snap(now), 1)).toBe('review')
    expect(projectActor({ ...snap('2026-10-19T00:00:00Z'), work_items: [snap('2026-10-19T00:00:00Z').work_items[0]] }, 1)).toBe('review')
  })
  it('does not count quiet old blockers as current blocked projects', () => {
    const snap = { ...base, work_items: [{ ...quietReview, status: 'blocked' as const }] }
    expect(liveSummary(snap).blocked).toBe(0)
  })
  it('does not turn another providers request into a decision for the current provider', () => {
    const w = item('SYN-2', 1, { agents: ['codex'] })
    const approval = { id: 'codex-request', kind: 'decision', status: 'pending', session_id: 2, work_item_id: w.id, repo_id: 1, payload: {} } as Approval
    const snap = { ...base, work_items: [item('SYN-1', 1, { agents: ['claude'] }),w], sessions: [session(2, { provider: 'codex', work_item_id: w.id, last_activity_at: at })], approvals: [approval] }
    expect(rows(snap, 'claude').recent[0].actor).not.toBe('user')
    expect(rows(snap, 'codex').recent[0].actor).toBe('user')
  })
})

describe('通知深链', () => {
  it('parses and resolves approval links to the owning work item or session', () => {
    expect(parseDeepLink('#approval=abc')).toEqual({ kind: 'approval', id: 'abc' })
    expect(parseDeepLink('#session=7')).toEqual({ kind: 'session', id: 7 })
    expect(parseDeepLink('#session=x')).toBeNull()
    const snap: Snapshot = { ...base, sessions: [session(7, { work_item_id: 'SYN-1' }), session(8)], approvals: [{ id: 'a1', kind: 'permission', session_id: 7, work_item_id: null } as unknown as Approval, { id: 'a2', kind: 'permission', session_id: 8, work_item_id: null } as unknown as Approval] }
    expect(resolveDeepLink(snap, { kind: 'approval', id: 'a1' })).toEqual({ kind: 'item', id: 'SYN-1' })
    expect(resolveDeepLink(snap, { kind: 'approval', id: 'a2' })).toEqual({ kind: 'session', id: 8 })
    expect(resolveDeepLink(snap, { kind: 'approval', id: 'gone' })).toBeNull()
  })
})

describe('托管与非托管会话', () => {
  it('marks managed sessions and keeps the terminal read-only by default', () => {
    const html = renderToStaticMarkup(<ManagedPanel snap={base} m={managed()} />)
    expect(html).toContain('托管')
    expect(html).toContain('steward/abcd1234')
    expect(html).toContain('默认只读')
    expect(html).not.toContain('终端输入')
  })
  it('shows input only after explicit takeover', () => {
    expect(renderToStaticMarkup(<ManagedPanel snap={base} m={managed({ takeover: true })} />)).toContain('终端输入')
  })
  it('does not claim work completion when a managed session exits', () => {
    const html = renderToStaticMarkup(<ManagedPanel snap={base} m={managed({ state: 'exited', exit_code: 2, error: '进程以退出码 2 结束' })} />)
    expect(html).toContain('不代表工作完成')
    expect(html).toContain('归档')
    expect(html).not.toContain('终端画面')
  })
  it('never fakes a screen for unmanaged sessions', () => {
    expect(renderToStaticMarkup(<Unmanaged />)).toContain('未托管，无画面')
    const html = renderToStaticMarkup(<SessionDetail snap={{ ...base, sessions: [session(5)] }} id={5} onClose={() => {}} onSelectItem={() => {}} />)
    expect(html).toContain('未托管，无画面')
    const viaWorktree = renderToStaticMarkup(<SessionDetail snap={{ ...base, sessions: [session(5, { worktree: '/wt/abcd' })], managed: [managed()] }} id={5} onClose={() => {}} onSelectItem={() => {}} />)
    expect(viaWorktree).not.toContain('未托管')
    expect(viaWorktree).toContain('托管')
  })
  it('only offers configured agents and explains when tmux is missing', () => {
    expect(renderToStaticMarkup(<NewManaged snap={base} onLaunched={() => {}} />)).toContain('未找到 tmux')
    const html = renderToStaticMarkup(<NewManaged snap={{ ...base, agents: ['claude', 'codex'] }} onLaunched={() => {}} />)
    expect(html).toContain('Claude')
    expect(html).toContain('Codex')
    expect(html).not.toContain('命令')
  })
})
