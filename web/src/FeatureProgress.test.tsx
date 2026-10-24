import { renderToStaticMarkup } from 'react-dom/server'
import { describe, it, expect } from 'vitest'
import { FeatureProgress } from './FeatureProgress'
import { Queue, queueCount } from './Queue'
import type { ProjectFeature, Snapshot } from './types'

const at = '2026-10-21T00:00:00Z'
const feature: ProjectFeature = { repo_id: 1, id: 'export', title: 'Synthetic export', acceptance: 'export rows', scope_basis: 'Synthetic spec', scope_status: 'documented', scope_version: 'scope', candidate: 'sha-one', revision: 'revision', implementation: 'implemented', validation: 'not_verified', accepted: false, conflict: false, stale: false, work_item_ids: ['TEST-1'], contributions: [{ id: 'export', session_id: 1, run_id: 1, work_item_id: 'TEST-1', provider: 'claude', candidate: 'sha-one', implementation: 'implemented', validation: 'not_verified', blocker: 'sample fixture missing', next: 'supply fixture', next_owner: 'agent', at, active: true }] }
const snap = { now: at, features: [feature], sessions: [], work_items: [] } as unknown as Snapshot
const render = (f: ProjectFeature[] = [feature]) => renderToStaticMarkup(<FeatureProgress snap={{ ...snap, features: f }} repoId={1} />)
describe('project core feature progress', () => {
  it('shows implementation separately from unknown validation and user acceptance', () => {
    const html = render()
    expect(html).toContain('已实现 · Agent 回报')
    expect(html).toContain('尚未验证')
    expect(html).toContain('尚未验收此候选')
    expect(html).toContain('sample fixture missing')
    expect(html).toContain('下一步 · Claude #1')
    expect(html).toContain('独立校验尚未接入')
  })
  it('does not manufacture a denominator from proposed or absent scope', () => {
    expect(render([{ ...feature, scope_status: 'proposed' }])).not.toContain('1/1')
    expect(render([])).toContain('还没有核心功能清单')
  })
  it('keeps current implementation visible ahead of historical scope limitations', () => {
    const old = ['A baseline', 'B baseline', 'C baseline'].map((title, i) => ({ ...feature, id: `base-${i}`, title }))
    const current = { ...feature, id: 'current', title: 'Z active implementation', implementation: 'implementing', validation: 'validating', contributions: feature.contributions.map(p => ({ ...p, blocker: '' })) }
    const html = render([...old, current])
    expect(html.indexOf('Z active implementation</strong>')).toBeLessThan(html.indexOf('A baseline</strong>'))
  })
  it('counts one feature with multiple contributions and preserves both blockers', () => {
    const f = { ...feature, contributions: [...feature.contributions, { ...feature.contributions[0], run_id: 2, session_id: 2, provider: 'codex', blocker: 'encoding fails', next_owner: 'codex' }] }
    const html = render([f])
    expect(html).toContain('1/1')
    expect(html).toContain('encoding fails')
    expect(html).toContain('sample fixture missing')
    expect(html).toContain('Codex（具体会话待指定）')
  })
  it('keeps conflict visible and withholds acceptance for a failing candidate', () => {
    const html = render([{ ...feature, conflict: true, implementation: 'conflict', validation: 'failed' }])
    expect(html).toContain('会话候选或实现回报不一致')
    expect(html).toContain('Agent 回报验证失败')
    expect(html).not.toContain('确认此功能候选验收通过')
  })
  it('routes feature handoffs to the queue until the agent reports a new owner', () => {
    const f = { ...feature, contributions: feature.contributions.map(p => ({ ...p, next_owner: 'user' })) }
    const s = { ...snap, features: [f], work_items: [{ id: 'TEST-1', repo_id: 1, status: 'in_progress', ready: true, agents: ['claude'], brief: { fields: {}, by_session: { '1': { fields: {} } } } }] } as unknown as Snapshot
    expect(queueCount(s)).toBe(1)
    const html = renderToStaticMarkup(<Queue snap={s} onSelectItem={() => {}} />)
    expect(html).toContain('advisory-group')
    expect(html).toContain('Synthetic export')
    expect(html).not.toContain('允许本次')
    const answered = { ...s, work_items: s.work_items!.map(w => ({ ...w, brief: { ...w.brief!, by_session: { '1': { ...w.brief!.by_session!['1'], input_resolved_at: '2026-10-21T00:01:00Z' } } } })) }
    expect(queueCount(answered)).toBe(1)
    const continued = { ...answered, features: [{ ...f, contributions: f.contributions.map(p => ({ ...p, next_owner: 'agent' })) }] }
    expect(queueCount(continued)).toBe(0)
  })
})
