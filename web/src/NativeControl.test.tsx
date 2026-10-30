import { describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { NativeSummary, type NativeState } from './NativeControl'

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
