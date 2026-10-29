import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ItemDetail } from '../Panels'
import { WorkOverview, nextActionFor, requestsForItem } from './WorkOverview'
import { synthSnapshot } from './fixtures'
import type { Approval, Snapshot } from '../types'

afterEach(() => vi.unstubAllGlobals())
const item = { ...synthSnapshot.work_items![0], status: 'done' as const, merge_state: 'awaiting' as const }
const pending: Approval = { ...synthSnapshot.approvals![1], id: 'synthetic-pending', status: 'pending', decision: '', payload: { ...synthSnapshot.approvals![1].payload } }
const snap: Snapshot = { ...synthSnapshot, work_items: [item], approvals: [pending], merge_jobs: [], sessions: [], runs: [], handoffs: [], managed: [] }
const render = (s: Snapshot = snap) => renderToStaticMarkup(<ItemDetail snap={s} id={item.id} onClose={() => {}} onSelectSession={() => {}} />)

describe('默认工作详情', () => {
  it('explains completed work and pending merge separately, with the merge action in this pane', () => {
    const html = render()
    expect(html).toContain('这项工作已标记完成，还有一次代码合并等你决定')
    expect(html).toContain('最近进展')
    expect(html).toContain('Agent 自述')
    expect(html).toContain('>批准合并</button>')
    expect(html.indexOf('处理代码合并')).toBeLessThan(html.indexOf('rd-inspection'))
    expect(html).not.toContain('查看右侧合并队列')
  })
  it('keeps execution records and additional management closed by default', () => {
    const html = render()
    expect(html).toContain('<details class="rd-inspection">')
    expect(html).toContain('<details class="rd-more">')
    const first = html.slice(0, html.indexOf('<details class="rd-inspection">'))
    expect(first).not.toContain('RUN DESK')
    expect(first).not.toContain('运行版本：待核实')
    expect(first).not.toContain('当前运行 vs 候选提交')
    expect(first).not.toContain('复制完整 SHA')
    expect(html).toContain('当前运行 vs 候选提交')
    expect(html).toContain('完整提交 '+String(pending.payload.source_head_sha))
  })
  it('retains all peer work items involved in the same merge', () => {
    const peer = { ...item, id: 'SYN-99', title: '合成同批工作' }
    const s = { ...snap, work_items: [item, peer], approvals: [pending, { ...pending, id: 'synthetic-peer', work_item_id: peer.id }] }
    const html = render(s)
    expect(html).toContain('本次合并涉及 2 个工作项')
    expect(html).toContain('SYN-99 · 合成同批工作')
    expect(html.match(/>批准合并<\/button>/g)).toHaveLength(1)
  })
  it('keeps invalid or moved merge candidates unapprovable', () => {
    for (const payload of [{ ...pending.payload, stale: 'target_moved' }, { ...pending.payload, source_head_sha: '' }]) {
      expect(render({ ...snap, approvals: [{ ...pending, payload }] })).toMatch(/<button[^>]*disabled=""[^>]*>批准合并<\/button>/)
    }
  })
  it('keeps the same detail read-only when opened remotely', () => {
    vi.stubGlobal('window', { location: { protocol: 'https:', hostname: 'synthetic.ts.net' } })
    const html = render()
    expect(html).toContain('处理代码合并')
    expect(html).toContain('远程只读')
    expect(html).not.toContain('>批准合并</button>')
    expect(html).not.toContain('管理状态 SYN-12')
  })
  it('does not borrow another work item request through a reused session', () => {
    const reused = { ...synthSnapshot, approvals: [{ ...synthSnapshot.approvals![3], work_item_id: 'SYN-99' }] }
    expect(requestsForItem(reused, item)).toEqual([])
  })
  it('keeps paused work recoverable while still showing formal requests', () => {
    const paused = { ...item, management: { state: 'paused' as const, at: snap.now } }
    expect(nextActionFor({ ...snap, approvals: [] }, paused)).toContain('需要恢复时')
    expect(nextActionFor(snap, paused)).toContain('代码合并等你决定')
  })
  it('leaves missing progress as missing and does not treat a completed work item as merged', () => {
    const empty = { ...item, brief: undefined, merge_state: 'not_ready' as const }
    const html = renderToStaticMarkup(<WorkOverview snap={{ ...snap, approvals: [] }} item={empty} />)
    expect(html).toContain('还没有收到工作进展说明')
    expect(html).toContain('代码合并尚未确认')
    expect(html).not.toContain('代码合并已确认')
  })
})
