import { describe, expect, it } from 'vitest'
import { attemptSummary, attemptsOf, progressView, relation, sourceTag } from './brief'
import { matches } from './model'
import type { BriefField, Run, Snapshot, WorkItem } from './types'

const item = (id: string, over: Partial<WorkItem> = {}): WorkItem => ({
  id, repo_id: 1, title: id, status: 'in_progress', acceptance: '', branch: '', merge_state: 'not_ready', needs_merge: true,
  created_at: '', updated_at: '', ready: true, waiting: [], agents: [], ...over,
})
const run = (id: number, attempt: number, session_id: number, started_at: string, ended_at = '', outcome = ''): Run => ({
  id, work_item_id: 'QM-1', session_id, provider: 'codex', attempt, binding: 'tag', started_at, ended_at, outcome,
})
const snap = (runs: Run[] = [], items: WorkItem[] = []): Snapshot => ({
  cursor: 1, now: '2026-10-19T10:00:00Z', repos: [], sessions: [], work_items: items, deps: [], runs, approvals: [],
})
const f = (over: Partial<BriefField> = {}): BriefField => ({ entry_id: 1, text: '已修复重连循环', kind: 'agent', source: 'report', session_id: 47, at: '2026-10-19T09:40:00Z', ...over })

describe('progressView', () => {
  it('有回报时显示文本、来源与过期', () => {
    const w = item('QM-1', { brief: { fields: { progress: f() }, tool_events_since: 25, last_event_at: '', stale: true } })
    const v = progressView(snap(), w)
    expect(v).toMatchObject({ text: '已修复重连循环', empty: false, stale: true })
    expect(sourceTag(v.field!).label).toBe('Agent 自述')
  })
  it('没有回报时只陈述观察到的会话数，不编进展', () => {
    const v = progressView(snap([run(1, 1, 7, 'a'), run(2, 1, 8, 'b'), run(3, 2, 7, 'c')]), item('QM-1'))
    expect(v.empty).toBe(true)
    expect(v.text).toBe('暂无内容回报 · 已观察 2 个会话')
  })
  it('待开始且无会话', () => {
    expect(progressView(snap(), item('QM-1', { status: 'todo' })).text).toBe('尚未开始，没有执行会话')
  })
  it('被标记有误时不显示原文', () => {
    const w = item('QM-1', { brief: { fields: { progress: f({ flagged: true, text: '' }) }, tool_events_since: 0, last_event_at: '', stale: false } })
    const v = progressView(snap(), w)
    expect(v.empty).toBe(true)
    expect(v.text).not.toContain('重连')
  })
  it('用户确认显示为你确认', () => {
    expect(sourceTag(f({ kind: 'user', source: 'confirm' })).label).toBe('你确认')
    expect(sourceTag(f({ kind: 'user', source: 'user' })).label).toBe('你填写')
  })
})

describe('attempts', () => {
  // runs.attempt 为序号；尝试按结果推导
  const relay = [
    run(1, 1, 41, '2026-10-19T01:00:00Z', '2026-10-19T03:00:00Z', 'handed_off'),
    run(2, 2, 47, '2026-10-19T03:10:00Z'),
    run(3, 3, 52, '2026-10-19T09:00:00Z'),
  ]
  it('转交与并行仍是同一次尝试', () => {
    const a = attemptsOf(snap(relay), 'QM-1')
    expect(a).toHaveLength(1)
    expect(a[0].runs.map((r) => r.session_id)).toEqual([41, 47, 52])
    expect(relation(a[0].runs[0], a[0].runs[1])).toBe('relay')
    expect(relation(a[0].runs[1], a[0].runs[2])).toBe('parallel')
    expect(attemptSummary(snap(relay), 'QM-1')).toBe('3 个会话')
  })
  it('明确失败或放弃后开始新尝试，新到旧', () => {
    const runs = [
      run(1, 1, 31, '2026-10-18T01:00:00Z', '2026-10-18T02:00:00Z', 'failed'),
      run(2, 2, 38, '2026-10-18T03:00:00Z', '2026-10-18T04:00:00Z', 'abandoned'),
      run(3, 3, 61, '2026-10-19T08:00:00Z'),
      run(4, 4, 62, '2026-10-19T08:30:00Z'),
    ]
    const a = attemptsOf(snap(runs), 'QM-1')
    expect(a.map((x) => [x.attempt, x.runs.map((r) => r.session_id)])).toEqual([[3, [61, 62]], [2, [38]], [1, [31]]])
    expect(attemptSummary(snap(runs), 'QM-1')).toBe('第 3 次尝试 · 4 个会话')
  })
  it('失败段仍有并行会话未结束时不切分', () => {
    const runs = [
      run(1, 1, 31, '2026-10-18T01:00:00Z', '2026-10-18T02:00:00Z', 'failed'),
      run(2, 2, 32, '2026-10-18T01:30:00Z'),
      run(3, 3, 33, '2026-10-18T03:00:00Z'),
    ]
    expect(attemptsOf(snap(runs), 'QM-1')).toHaveLength(1)
  })
  it('撤销的归属不计入', () => {
    const runs = [run(1, 1, 31, 'a', 'b', 'attribution_reverted')]
    expect(attemptSummary(snap(runs), 'QM-1')).toBe('无会话')
  })
})

describe('搜索覆盖简报', () => {
  it('能按进展文本找到工作项', () => {
    const w = item('QM-1', { title: '行情', brief: { fields: { progress: f() }, tool_events_since: 0, last_event_at: '', stale: false } })
    expect(matches(w, '重连')).toBe(true)
    expect(matches(w, '支付')).toBe(false)
  })
})
