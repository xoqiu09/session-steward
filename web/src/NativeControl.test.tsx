import { describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { NativeApprovalCard, NativeSummary, type NativeState } from './NativeControl'

const state: NativeState = { host: 'Synthetic Mac Studio', workspace: '/synthetic-project', title: '合成本机任务', thread_id: 'native-one', work_item_id: 'SYN-1', session_id: 1, turn_id: '', status: 'idle', work_status: 'in_progress', owner: '', epoch: 1, desktop_handoff: false, lease_until: '', events: [], pending: [] }
describe('native control status semantics', () => {
  it('turn completion does not claim agent delivery or user handling', () => {
    const html = renderToStaticMarkup(<NativeSummary state={state} />)
    expect(html).toContain('本轮执行已结束')
    expect(html).not.toContain('Agent 已交付')
    expect(html).not.toContain('验收通过')
  })
  it('explicit agent delivery remains awaiting user handling with visible host and workspace', () => {
    const html = renderToStaticMarkup(<NativeSummary state={{ ...state, work_status: 'review', delivery_summary: '合成交付说明' }} />)
    expect(html).toContain('Agent 已交付，等你处理')
    expect(html).toContain('Agent 交付自述')
    expect(html).toContain('由你另外确认')
    expect(html).toContain('Synthetic Mac Studio')
    expect(html).toContain('/synthetic-project')
  })
  it('a new active turn remains visible while a prior delivery awaits handling', () => {
    const html = renderToStaticMarkup(<NativeSummary state={{ ...state, status: 'running', turn_id: 'new-turn', work_status: 'review' }} />)
    expect(html).toContain('正在这台 Mac 执行')
    expect(html).not.toContain('Agent 已交付，等你处理')
  })
})

describe('native approval access', () => {
  const pending = { id: 'synthetic-approval', fingerprint: 'synthetic-fp', details: '合成命令', turn: 'synthetic-turn', approvable: true }
  it.each([false, undefined])('remote or unverified access never renders an allow button (%s)', canApprove => {
    const html = renderToStaticMarkup(<NativeApprovalCard pending={pending} canApprove={canApprove} disabled={false} onDecide={() => {}} />)
    expect(html).not.toContain('仅允许这一次')
    expect(html).toContain('拒绝这一次')
    expect(html).toContain('请回到执行电脑的本机入口')
  })
  it('a server-verified local entry retains single-use command approval', () => {
    const html = renderToStaticMarkup(<NativeApprovalCard pending={pending} canApprove={true} disabled={false} onDecide={() => {}} />)
    expect(html).toContain('仅允许这一次')
    expect(html).toContain('拒绝这一次')
  })
  it('local access still cannot approve an unsupported file request', () => {
    const html = renderToStaticMarkup(<NativeApprovalCard pending={{ ...pending, approvable: false }} canApprove={true} disabled={false} onDecide={() => {}} />)
    expect(html).not.toContain('仅允许这一次')
    expect(html).toContain('本原型只支持拒绝')
  })
})
