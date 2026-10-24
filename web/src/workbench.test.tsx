import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { Queue, queueCount } from './Queue'
import { groupByRepo, projectAttention } from './model'
import { HistoryItems } from './HistoryItems'
import { mergeGroups, periodicView, repoLabel } from './workbench'
import type { Approval, Snapshot, WorkItem } from './types'

const at = '2026-10-23T00:00:00Z'
const item = (id: string, title: string, created = at): WorkItem => ({ id, repo_id: 1, title, status: 'review', acceptance: '', branch: '', merge_state: 'none', needs_merge: false, created_at: created, updated_at: created, ready: true, waiting: [], agents: ['codex'] })
const snap = (items: WorkItem[]): Snapshot => ({ cursor: 1, now: at, repos: [{ id: 1, name: 'synthetic', common_dir: '/synthetic/.git', is_git: true, target_ref: 'main' }], sessions: [], runs: [], deps: [], approvals: [], work_items: items })
const approval = (id: string, work: string, kind: Approval['kind'] = 'merge'): Approval => ({ id, kind, status: 'pending', repo_id: 1, work_item_id: work, session_id: null, fingerprint: id, tool_name: '', preview: '', decision: '', handleable: true, close_reason: '', deadline: '', created_at: at, decided_at: '', delivered_at: '', confirmed_at: '', closed_at: '', payload: { repo_id: 1, source_ref: 'feat/shared', source_head_sha: 'a'.repeat(40), target_ref: 'main', target_base_sha: 'b'.repeat(40), ahead: 1, diffstat: 'synthetic diff' } })

describe('workbench deduplication', () => {
  it('folds recurring memory rounds without modifying state or removing history', () => {
    const s = snap([item('MEM-1', '整合代理记忆', '2026-10-21T00:00:00Z'), item('MEM-2', '整理本地 Agent 记忆')])
    const view = periodicView(s)
    expect(view.current.map(w => w.id)).toEqual(['MEM-2'])
    expect(view.history.map(w => w.id)).toEqual(['MEM-1'])
    expect(s.work_items!.every(w => w.status === 'review')).toBe(true)
    expect(queueCount(s)).toBe(1)
    const groups = groupByRepo(s, { query: '', showDone: false, repoId: 'all', provider: 'all' })
    expect(groups[0].history?.map(w => w.id)).toEqual(['MEM-1'])
    const history = renderToStaticMarkup(<HistoryItems snap={s} items={view.history} onSelect={() => {}} />)
    expect(history).toContain('MEM-1')
    expect(history).toContain('没有自动验收')
    expect(groupByRepo(s, { query: '#MEM-1', showDone: false, repoId: 'all', provider: 'all' })[0].items[0].id).toBe('MEM-1')
  })
  it('keeps old blocked or pending-permission rounds visible', () => {
    const a = item('MEM-1', '整合代理记忆', '2026-10-21T00:00:00Z')
    const s = snap([a, item('MEM-2', '整理本地代理记忆')])
    s.approvals = [approval('permission', a.id, 'permission')]
    expect(periodicView(s).history).toEqual([])
    s.approvals = []; a.status = 'blocked'
    expect(periodicView(s).history).toEqual([])
  })
  it('does not fold similar business tasks or different branches', () => {
    const s = snap([item('A-1', '修复日期查询'), item('A-2', '修复日期查询'), { ...item('M-1', '整合代理记忆'), branch: 'feat/a' }, { ...item('M-2', '整合代理记忆'), branch: 'feat/b' }])
    expect(periodicView(s).current).toHaveLength(4)
  })
  it('does not resurrect an old round when the latest completed round is filtered out', () => {
    const s = snap([item('MEM-1', '整合代理记忆', '2026-10-21T00:00:00Z'), { ...item('MEM-2', '整理本地代理记忆'), status: 'done' }])
    const groups = groupByRepo(s, { query: '', showDone: false, repoId: 'all', provider: 'all' })
    expect(groups[0].items).toEqual([])
    expect(groups[0].history?.map(w => w.id)).toEqual(['MEM-1'])
  })
  it('renders one exact merge operation and retains both work-item acceptance links', () => {
    const s = snap([item('A-1', 'one'), item('A-2', 'two')])
    s.approvals = [approval('merge-1', 'A-1'), approval('merge-2', 'A-2')]
    expect(mergeGroups(s.approvals)).toHaveLength(1)
    expect(queueCount(s)).toBe(1)
    expect(projectAttention(s, 1)).toBe(1)
    const html = renderToStaticMarkup(<Queue snap={s} onSelectItem={() => {}} />)
    expect(html.match(/>批准合并<\/button>/g)).toHaveLength(1)
    expect(html).toContain('本次合并涉及 2 个工作项')
    expect(html).toContain('A-1'); expect(html).toContain('A-2')
    expect(html).not.toContain('<h3>待验收')
  })
  it('does not combine different targets, repositories, or incomplete bindings', () => {
    const a = approval('a', 'A-1')
    expect(mergeGroups([a, { ...approval('b', 'A-2'), repo_id: 2 }])).toHaveLength(2)
    expect(mergeGroups([a, { ...approval('b', 'A-2'), payload: { ...a.payload, target_base_sha: 'c'.repeat(40) } }])).toHaveLength(2)
    expect(mergeGroups([{ ...a, payload: {} }, { ...approval('b', 'A-2'), payload: {} }])).toHaveLength(2)
  })
  it('shows the whole shared operation under a provider filter and disables any stale group', () => {
    const s = snap([item('A-1', 'one'), { ...item('A-2', 'two'), agents: ['claude'] }])
    s.approvals = [approval('merge-1', 'A-1'), { ...approval('merge-2', 'A-2'), payload: { ...approval('x', '').payload, stale: 'target_moved' } }]
    expect(queueCount(s, 'all', 'codex')).toBe(1)
    const html = renderToStaticMarkup(<Queue snap={s} provider="codex" onSelectItem={() => {}} />)
    expect(html).toContain('A-2')
    expect(html).toContain('disabled="">批准合并')
    expect(mergeGroups(s.approvals)).toHaveLength(1)
  })
  it('counts a review item blocked by dependencies once', () => {
    const s = snap([{ ...item('A-1', 'one'), ready: false, waiting: ['UP-1'] }])
    expect(queueCount(s)).toBe(1)
    expect(projectAttention(s, 1)).toBe(1)
  })
  it('never folds tool permission requests or explicit decisions', () => {
    const s = snap([item('A-1', 'one')]); s.work_items![0].status = 'in_progress'
    s.approvals = [approval('p1', 'A-1', 'permission'), approval('p2', 'A-1', 'permission'), approval('d1', 'A-1', 'decision')]
    expect(queueCount(s)).toBe(3)
  })
  it('counts multiple feature handoffs and review of the same item once, preserving every source', () => {
    const s = snap([item('A-1', 'one')])
    s.features = ['feature-a', 'feature-b'].map(id => ({ repo_id: 1, id, title: id, acceptance: '', scope_basis: '', scope_status: 'documented', scope_version: '1', candidate: 'a', revision: '1', implementation: 'implemented', validation: 'not_verified', conflict: false, stale: false, accepted: false, work_item_ids: ['A-1'], contributions: [{ id, candidate: 'a', next_owner: 'user', next: 'Review '+id, session_id: 7, run_id: 1, work_item_id: 'A-1', provider: 'codex', at, active: true }] }))
    expect(queueCount(s)).toBe(1)
    const html = renderToStaticMarkup(<Queue snap={s} onSelectItem={() => {}} />)
    expect(html).toContain('feature-a'); expect(html).toContain('feature-b');expect(html).toContain('2 条回报 · 计为 1 组')
  })
  it('disambiguates same-named distinct repositories by path', () => {
    const s = snap([]);s.repos!.push({ ...s.repos![0], id: 2, common_dir: '/other/work/synthetic/.git' })
    expect(repoLabel(s, 1)).not.toBe(repoLabel(s, 2))
    expect(s.repos).toHaveLength(2)
  })
})
