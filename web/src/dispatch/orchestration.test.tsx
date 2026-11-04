import { describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { OrchestrationSummary, type OrchestrationState } from './OrchestrationPanel'

const state: OrchestrationState = { mode: 'observe', available: true, mandates: [{ work_item_id: 'ORC-1', revision: 'grant-one', expires_at: '2026-11-02T12:00:00Z', max_turns: 10, turns: 1, revoked: false }], deliveries: [{ revision: 'grant-one', id: 'delivery-one', work_item_id: 'ORC-1', state: 'acknowledged', reason: 'native_accepted', receipt: 'turn-one' }], findings: [] }
const render = (s = state) => renderToStaticMarkup(<OrchestrationSummary state={s} items={[]} onRevoke={() => {}} onAcknowledge={() => {}} />)
describe('后台推进说明', () => {
  it('输入接纳与验收分别说明，不声称任务完成', () => {
    const html = render()
    expect(html).toContain('Codex 已接纳')
    expect(html).toContain('交付仍需你验收')
    expect(html).toContain('撤销授权')
    expect(html).not.toContain('验收通过')
  })
  it('忙时排队与结果不明不能显示成已读', () => {
    const html = render({ ...state, deliveries: [{ ...state.deliveries[0], state: 'uncertain', reason: 'restart_after_admission' }] })
    expect(html).toContain('结果待核对')
    expect(html).toContain('重启前的发送结果待核对')
    expect(html).not.toContain('Codex 已接纳')
  })
  it('看过发现仍保留问题和依据', () => {
    const html = render({ ...state, findings: [{ id: 'finding-one', work_item_id: 'ORC-1', state: 'acknowledged', fact: 'Synthetic evidence gap', basis: 'evidence-id-one', opened_at: '2026-11-02T10:00:00Z' }] })
    expect(html).toContain('仍待新证据核对')
    expect(html).toContain('evidence-id-one')
    expect(html).not.toContain('知道了，保留问题')
  })
})
