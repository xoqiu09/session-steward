import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ItemDetail } from '../Panels'
import type { Handoff, MergeJob, Snapshot } from '../types'
import { synthSnapshot } from './fixtures'
import { approvalRunState, candidateOf, checkRunState, clock, commandsOf, currentRuns, handoffRunState, jobRunState, staleWriters, timelineOf } from './runDeskModel'

const item = synthSnapshot.work_items!.find((w) => w.id === 'SYN-12')!
afterEach(() => vi.unstubAllGlobals())
const render = (remote: boolean, snap: Snapshot = synthSnapshot) => {
  vi.stubGlobal('window', { location: { protocol: remote ? 'https:' : 'http:', hostname: remote ? 'synthetic.ts.net' : '127.0.0.1' } })
  return renderToStaticMarkup(<ItemDetail snap={snap} id="SYN-12" onClose={() => {}} onSelectSession={() => {}} />)
}

describe('运行台状态映射', () => {
  it('maps merge jobs onto the six states without inventing success', () => {
    const s = (state: MergeJob['state']) => jobRunState({ state } as MergeJob)
    expect([s('queued'), s('running'), s('passed'), s('merged'), s('failed'), s('aborted')]).toEqual(['requested', 'running', 'running', 'succeeded', 'failed', 'failed'])
  })
  it('treats unrecognised handoff states as unknown', () => {
    expect(handoffRunState({ state: 'launched' } as Handoff)).toBe('requested')
    expect(handoffRunState({ state: 'failed' } as Handoff)).toBe('failed')
    expect(handoffRunState({ state: 'something-new' } as Handoff)).toBe('unknown')
  })
  it('does not attribute an item-level merge to a copied historical instruction', () => {
    const copied = timelineOf(synthSnapshot, item).find((e) => e.key === 'a-syn-80-copied')!
    expect(copied.state).toBe('unknown')
    const merged = { ...synthSnapshot, work_items: [{ ...item, merge_state: 'merged' as const }] }
    expect(timelineOf(merged, merged.work_items[0]).find((e) => e.key === 'a-syn-80-copied')!.state).toBe('unknown')
  })
  it('only marks commands with an exit code as succeeded or failed', () => {
    const cmds = commandsOf(synthSnapshot, item)
    expect(cmds.filter((c) => c.exitCode != null).map((c) => c.state)).toEqual(['failed', 'succeeded'])
    expect(cmds.filter((c) => c.exitCode == null).every((c) => c.state === 'generated')).toBe(true)
    expect(checkRunState(undefined)).toBe('unknown')
    expect(checkRunState(null)).toBe('unknown')
    expect(checkRunState(Number.NaN)).toBe('unknown')
  })
  it('prefers the executed check candidate and flags a moved target', () => {
    const c = candidateOf(synthSnapshot, item)!
    expect(c.sha).toBe('3f9a1c2e8b7d4a60c1e2f3a4b5c6d7e8f9a0b1c2')
    expect(c.source).toBe('合并检查（最近记录）')
    expect(c.target?.moved).toBe(true)
  })
  it('keeps warning while the handoff source session is still live', () => {
    expect(staleWriters(synthSnapshot, item).map((w) => w.session.id)).toEqual([87])
    const ended = { ...synthSnapshot, sessions: synthSnapshot.sessions!.map((s) => (s.id === 87 ? { ...s, state: 'ended' as const } : s)) }
    expect(staleWriters(ended, item)).toEqual([])
  })
  it('never maps approval delivery or confirmation to operation success', () => {
    const confirmed = synthSnapshot.approvals![0]
    expect(approvalRunState(confirmed)).toBe('requested')
    expect(approvalRunState({ ...confirmed, status: 'delivered' })).toBe('requested')
    const event = timelineOf(synthSnapshot, item).find(e => e.key === confirmed.id)!
    expect(event.state).not.toBe('succeeded')
    expect(event.detail).toContain('不代表工具执行成功')
  })
  it('does not attach an explicit other-item approval through a reused session', () => {
    const other = { ...synthSnapshot.approvals![0], id: 'other-item', work_item_id: 'SYN-13', session_id: 88 }
    expect(timelineOf({ ...synthSnapshot, approvals: [other] }, item)).toEqual(expect.not.arrayContaining([expect.objectContaining({ key: 'other-item' })]))
  })
  it('keeps waiting and stale session states distinct from live execution', () => {
    const snap = { ...synthSnapshot, sessions: synthSnapshot.sessions!.map(s => s.id === 88 ? { ...s, state: 'waiting_permission' as const } : { ...s, freshness: 'stale' as const }) }
    const runs = currentRuns(snap, item)
    expect(runs.find(r => r.sessionId === 88)?.state).toBe('requested')
    expect(runs.find(r => r.sessionId === 87)?.state).toBe('unknown')
  })
  it('does not borrow a newer approval target warning for an older checked candidate', () => {
    const snap = { ...synthSnapshot, merge_jobs: synthSnapshot.merge_jobs!.map(j => ({ ...j, approval_id: 'missing-old-approval' })) }
    expect(candidateOf(snap, item)?.target?.moved).toBe(false)
    const newer = { ...synthSnapshot.approvals![2], id: 'new-proposal', created_at: synthSnapshot.now, payload: { source_ref: 'new-branch', source_head_sha: 'f'.repeat(40), target_ref: 'next-main', target_base_sha: 'e'.repeat(40), stale: 'target_moved' } }
    const candidate = candidateOf({ ...synthSnapshot, approvals: [...synthSnapshot.approvals!, newer] }, item)!
    expect(candidate.sha).toBe(synthSnapshot.merge_jobs![0].source_sha)
    expect(candidate.ref).toBe('steward/syn-12')
    expect(candidate.pending).toMatchObject({ sha: 'f'.repeat(40), ref: 'new-branch', targetRef: 'next-main' })
  })
  it('handles empty records and invalid timestamps without inventing a candidate', () => {
    const empty: Snapshot = { cursor: 0, now: synthSnapshot.now, repos: [], sessions: [], work_items: [], deps: [], runs: [], approvals: [] }
    expect(candidateOf(empty, { ...item, branch: '' })).toBeNull()
    expect(timelineOf(empty, item)).toEqual([])
    expect(clock('invalid')).toBe('—')
  })
  it('keeps missing exit codes and future managed states unknown', () => {
    const snap: Snapshot = { ...synthSnapshot, managed: synthSnapshot.managed!.map(m => ({ ...m, state: 'future-state' as typeof m.state })),
      merge_jobs: synthSnapshot.merge_jobs!.map(j => ({ ...j, state: 'future-state' as typeof j.state, checks: [{ ...j.checks![0], exit_code: undefined as unknown as number }] })) }
    expect(commandsOf(snap, item)[0]).toMatchObject({ state: 'unknown', evidence: '检查记录缺少退出码，结果待核实' })
    expect(timelineOf(snap, item).find(e => e.key === 'syn88')).toMatchObject({ state: 'unknown', title: '托管会话 syn88 · 状态待核实' })
    expect(timelineOf(snap, item).find(e => e.key === 'job-syn-1')).toMatchObject({ state: 'unknown', title: '检查门 · 状态待核实' })
  })
})

describe('运行台渲染', () => {
  it('shows current vs candidate, the full SHA and an unverified running version', () => {
    const html = render(false)
    expect(html).toContain('当前运行 vs 候选提交')
    expect(html).toContain('完整提交 3f9a1c2e8b7d4a60c1e2f3a4b5c6d7e8f9a0b1c2')
    expect(html).toContain('运行版本：待核实')
    expect(html).toContain('交接不撤销写入权')
  })
  it('keeps local write controls in local mode', () => {
    const html = render(false)
    for (const label of ['允许本次', '标为阻塞', '修改标题 / 项目', '交接给其他 Agent', '停止会话', '添加', '确认此功能符合要求']) expect(html).toContain(label)
  })
  it('puts delivery acceptance before runtime and feature details', () => {
    const snap = { ...synthSnapshot, work_items: synthSnapshot.work_items!.map(w => w.id === item.id ? { ...w, status: 'review' as const } : w) }
    const html = render(false, snap)
    expect(html).toContain('这项交付待你处理')
    expect(html.indexOf('>已处理</button>')).toBeLessThan(html.indexOf('当前运行 vs 候选提交'))
    expect(html.match(/>已处理<\/button>/g)).toHaveLength(1)
    expect(html).toContain('“已处理”只记录这件事已处理，验证结果与功能确认分别保留')
  })
  it('keeps delivery acceptance read-only remotely', () => {
    const snap = { ...synthSnapshot, work_items: synthSnapshot.work_items!.map(w => w.id === item.id ? { ...w, status: 'review' as const } : w) }
    const html = render(true, snap)
    expect(html).toContain('这项交付待你处理')
    expect(html).toContain('请在本机面板验收')
    expect(html).not.toContain('>已处理</button>')
    expect(html).not.toContain('>退回修改</button>')
  })
  it('removes every write entry in remote read-only mode', () => {
    const html = render(true)
    expect(html).toContain('远程 · 全局只读')
    expect(html).toContain('go test ./... -run TestQueueOrder')
    expect(html).toContain('归属队列排序（合成功能）')
    for (const label of ['允许本次', '>拒绝<', '标为阻塞', '标为执行中', '提交验收', '>放弃<', '修改标题 / 项目', '交接给其他 Agent', '停止会话', '接管输入', '>添加<', '>移除<', '确认无误', '更正', '标记有误', '由我补充', '补记结果', '生成 AI 摘要', '确认此功能符合要求']) {
      expect(html).not.toContain(label)
    }
  })
})
