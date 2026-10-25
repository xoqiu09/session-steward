import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { ProjectSummary, MAIN_ROWS } from './ProjectSummary'
import { projectSummary, toCheck } from './projectSummaryModel'
import type { Approval, Brief, BriefField, ProjectFeature, Session, Snapshot, WorkItem } from './types'

// Synthetic project only: two sessions on one work item, one quiet and one current.
const now = '2026-10-23T12:00:00Z', old = '2026-10-19T00:00:00Z'
const field = (sid: number, text: string, at = now, source = 'report'): BriefField => ({ entry_id: sid * 100 + text.length, text, kind: 'agent', source, session_id: sid, at })
const brief = (sid: number, values: Record<string, string>, at = now, source = 'report'): Brief => ({ fields: Object.fromEntries(Object.entries(values).map(([k, v]) => [k, field(sid, v, at, source)])), tool_events_since: 0, last_event_at: at, stale: false })
const quiet = brief(1, { progress: 'API half done', blocker: 'Need synthetic fixture key', next: 'Wait for fixture key', next_owner: 'user' }, old)
const fresh = brief(2, { progress: 'Browser checks passed', blocker: '', next: 'Polish layout', next_owner: 'agent' })
const item: WorkItem = { id: 'SYN-1', repo_id: 1, title: 'Synthetic', status: 'in_progress', acceptance: '', branch: '', merge_state: 'none', needs_merge: false, created_at: old, updated_at: now, ready: true, waiting: [], agents: ['claude', 'codex'], brief: { ...fresh, by_session: { '1': quiet, '2': fresh } } }
const session = (id: number, extra: Partial<Session> = {}) => ({ id, provider: id === 1 ? 'claude' : 'codex', data_source: 'live', freshness: 'live', state: 'idle', work_item_id: item.id, last_activity_at: now, ...extra } as Session)
const ended = session(1, { state: 'ended', freshness: 'stale', last_activity_at: old })
const base: Snapshot = { cursor: 1, now, repos: [{ id: 1, name: 'Synthetic', common_dir: '/synthetic/.git', is_git: true, target_ref: 'main' }], sessions: [ended, session(2)], work_items: [item], runs: [], deps: [], approvals: [] }
const digest = (s: Snapshot = base) => projectSummary(s, s.work_items!, 1)
const html = (s: Snapshot = base) => renderToStaticMarkup(<ProjectSummary snap={s} items={s.work_items!} repoId={1} onSelectItem={() => {}} />)
const row = (markup: string, cls: string) => markup.match(new RegExp(`<div class="${cls}">[\\s\\S]*?</dd>`))![0]

describe('project brief: current actions first, dated blockers kept as to be checked', () => {
  it('keeps a quiet ended sessions blocker as to-be-checked next to a newer success', () => {
    const blocker = digest().blockers.find(f => f.text === 'Need synthetic fixture key')!
    expect(toCheck(blocker)).toBe(true)
    expect(blocker.sources[0]).toMatchObject({ label: 'Claude #1', at: old, itemId: 'SYN-1' })
    const markup = row(html(), 'digest-blocked')
    expect(markup).toContain('待核查'); expect(markup).toContain('Need synthetic fixture key')
    expect(markup).toContain('Claude #1 · 4 天前'); expect(markup).toContain('>查看 SYN-1</button>')
    expect(html()).not.toContain('未填写卡点信息')
  })
  it('keeps a recent blocker current while its session is quiet but not ended, and when a current peer shares the wording', () => {
    const idle = { ...quiet, fields: { ...quiet.fields, blocker: field(1, 'Need synthetic fixture key', '2026-10-23T09:00:00Z') } }
    const s = { ...base, sessions: [session(1), session(2)], work_items: [{ ...item, brief: { ...fresh, by_session: { '1': idle, '2': fresh } } }] }
    expect(toCheck(digest(s).blockers[0])).toBe(false)
    const shared = { ...fresh, fields: { ...fresh.fields, blocker: field(2, 'Need synthetic fixture key') } }
    const fact = digest({ ...base, work_items: [{ ...item, brief: { ...shared, by_session: { '1': quiet, '2': shared } } }] }).blockers[0]
    expect(fact.sources.map(s => s.label)).toEqual(['Codex #2', 'Claude #1'])
    expect(toCheck(fact)).toBe(false)
  })
  it('only the same source can clear its to-be-checked blocker, and a flagged entry does not return', () => {
    const peer = { ...fresh, fields: { ...fresh.fields, blocker: field(2, 'Missing synthetic contract') } }
    const cleared = { ...quiet, fields: { ...quiet.fields, blocker: field(1, '', old) } }
    const s = { ...base, work_items: [{ ...item, brief: { ...peer, by_session: { '1': cleared, '2': peer } } }] }
    expect(digest(s).blockers.map(f => f.text)).toEqual(['Missing synthetic contract'])
    const flagged = { ...item, brief: { ...item.brief!, fields: { ...item.brief!.fields, blocker: { ...quiet.fields.blocker!, flagged: true } } } }
    expect(digest({ ...base, work_items: [flagged] }).blockers).toEqual([])
  })
  it('keeps feature failures current, marks inactive same-candidate reports to be checked, and drops reports for an old candidate', () => {
    const contribution = { id: 'export', candidate: 'sha-two', session_id: 2, run_id: 2, work_item_id: item.id, provider: 'codex', at: now, active: true, validation: 'passed' }
    const feature = { repo_id: 1, id: 'export', title: 'Synthetic export', acceptance: '', scope_basis: 'spec', scope_status: 'documented', scope_version: '1', candidate: 'sha-two', revision: '1', implementation: 'implemented', validation: 'failed', conflict: false, stale: false, accepted: false, work_item_ids: [item.id],
      contributions: [contribution, { ...contribution, session_id: 1, run_id: 1, provider: 'claude', at: old, active: false, validation: 'failed', blocker: 'Large synthetic sample fails' }, { ...contribution, candidate: 'sha-one', session_id: 3, run_id: 3, active: false, blocker: 'Old candidate blocker' }] } as unknown as ProjectFeature
    const result = digest({ ...base, work_items: [{ ...item, brief: fresh }], features: [feature] })
    const failed = result.blockers.find(f => f.text === 'Synthetic export：Agent 回报验证失败')!
    expect(toCheck(failed)).toBe(false)
    expect(toCheck(result.blockers.find(f => f.text === 'Large synthetic sample fails')!)).toBe(true)
    expect(result.blockers.map(f => f.text)).not.toContain('Old candidate blocker')
    expect(result.progressText).toBe('Browser checks passed')
  })
})

describe('project brief: who acts next', () => {
  const approval = { id: 'p', kind: 'permission', status: 'pending', repo_id: 1, work_item_id: item.id, session_id: 2, created_at: now, deadline: '', handleable: true, payload: {}, preview: 'Synthetic tool' } as unknown as Approval
  const delivered: WorkItem = { ...item, id: 'SYN-2', status: 'review', brief: brief(3, { progress: 'Candidate delivered', next: 'Check the synthetic candidate', next_owner: 'user' }, now, 'deliver') }
  const s: Snapshot = { ...base, sessions: [...base.sessions!, session(3, { work_item_id: 'SYN-2' })], work_items: [item, delivered], approvals: [approval] }
  it('separates a formal request, an ordinary review and an old plan instead of merging them under one owner', () => {
    const rows = digest(s).actors
    const you = rows.filter(([owner]) => owner === '你').map(([, facts]) => [facts[0].text, facts[0].kind ?? '', toCheck(facts[0])])
    expect(you).toEqual([['处理右侧工具权限请求', 'formal', false], ['Check the synthetic candidate', 'review', false], ['Wait for fixture key', '', true]])
    const markup = row(html(s), 'digest-next')
    expect(markup).toContain('正式请求，右侧处理'); expect(markup).toContain('待审阅，非审批')
    expect(markup).toContain('<details class="more-blockers"><summary>待核查的旧安排 1 条')
  })
  it('never labels a reported next_owner=user without a formal request as a formal request', () => {
    const plain = { ...s, approvals: [] }
    expect(digest(plain).actors.some(([, facts]) => facts.some(f => f.kind === 'formal'))).toBe(false)
    expect(digest(plain).blockers.some(f => f.text.includes('等待权限审批'))).toBe(false)
  })
  it('shows dependency state without a time taken from updated_at', () => {
    const waiting = { ...item, ready: false, waiting: ['SYN-0'], updated_at: now, brief: fresh }
    const fact = digest({ ...base, work_items: [waiting] }).blockers.find(f => f.text === '等待上游工作项 SYN-0')!
    expect(fact.sources[0].at).toBe('')
    expect(toCheck(fact)).toBe(false)
    expect(row(html({ ...base, work_items: [waiting] }), 'digest-blocked')).toContain('SYN-1 · 服务状态')
  })
  it('states a reported owner whose next step is missing instead of dropping it', () => {
    const ownerOnly = { ...item, brief: brief(2, { progress: 'Working', next_owner: 'external' }) }
    expect(digest({ ...base, work_items: [ownerOnly] }).actors).toEqual([['外部依赖方', [expect.objectContaining({ text: '具体安排待回报' })]]])
  })
  it('keeps an automatic routine exception current even when it is old', () => {
    const routine = { ...item, brief: null, completion_policy: 'auto_history' as const, automatic_issue: 'Synthetic routine failed', automatic_issue_at: old }
    expect(toCheck(digest({ ...base, work_items: [routine] }).blockers[0])).toBe(false)
  })
})

describe('project brief: density and empty states', () => {
  it('limits the main card and counts every folded blocker, including ones to be checked', () => {
    const sessions = [1, 2, 3, 4, 5].map(id => session(id, id === 5 ? { state: 'ended' } : {}))
    const by = Object.fromEntries(sessions.map(x => [String(x.id), brief(x.id, { blocker: `Synthetic blocker ${x.id}` })]))
    const s = { ...base, sessions, work_items: [{ ...item, brief: { ...fresh, by_session: by } }] }
    const markup = row(html(s), 'digest-blocked')
    expect(markup.split('</ul>')[0].match(/<li /g)).toHaveLength(MAIN_ROWS)
    expect(markup).toContain('其余 2 条卡点（含待核查 1 条） · 全部保留')
    for (const id of [1, 2, 3, 4, 5]) expect(markup).toContain(`Synthetic blocker ${id}`)
  })
  it('says what is missing when nothing has been reported', () => {
    const s = { ...base, sessions: [], work_items: [{ ...item, brief: null }] }
    const markup = html(s)
    expect(markup).toContain('尚未收到项目进展回报'); expect(markup).toContain('未填写卡点信息'); expect(markup).toContain('负责人及具体安排待回报')
  })
  it('does not present only old plans as the current next step', () => {
    const s = { ...base, work_items: [{ ...item, brief: { ...quiet, by_session: { '1': quiet } } }] }
    const markup = row(html(s), 'digest-next')
    expect(markup).toContain('近期没有新的安排回报'); expect(markup).toContain('待核查的旧安排 1 条')
  })
})
