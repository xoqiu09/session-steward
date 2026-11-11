import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import type { ReactElement } from 'react'
import type { Snapshot } from './types'

const host = vi.hoisted(() => {
  let index = 0
  let slots: unknown[] = []
  return {
    begin() { index = 0 },
    reset() { index = 0; slots = [] },
    state(initial: unknown) {
      const i = index++
      if (!(i in slots)) slots[i] = typeof initial === 'function' ? initial() : initial
      return [slots[i], (value: unknown) => { slots[i] = typeof value === 'function' ? value(slots[i]) : value }]
    },
    ref(value: unknown) { const i = index++; if (!(i in slots)) slots[i] = { current: value }; return slots[i] },
  }
})
vi.mock('react', async original => ({ ...await original<typeof import('react')>(), useState: host.state, useRef: host.ref, useEffect: () => {} }))
vi.mock('./api', async original => ({ ...await original<typeof import('./api')>(), api: { ...(await original<typeof import('./api')>()).api, unbind: vi.fn() } }))
import { ItemDetail, SessionDetail } from './Panels'
import { api } from './api'
import { ErrorLine } from './bits'
import { currentUnbindTarget } from './sessionBinding'
import { synthSnapshot } from './ui/fixtures'

type Node = ReactElement<any>
const nodes = (node: any): Node[] => Array.isArray(node) ? node.flatMap(nodes) : node?.props ? [node, ...nodes(node.props.children)] : []
const select = (tree: Node) => nodes(tree).find(node => node.type === 'select' && node.props['aria-label'] === '结束当前绑定')!
const render = (snap: Snapshot) => { host.begin(); return SessionDetail({ snap, id: 88, onClose() {}, onSelectItem() {} })! }
const session = synthSnapshot.sessions!.find(s => s.id === 88)!
beforeEach(() => { vi.mocked(api.unbind).mockReset() })
afterEach(() => { host.reset(); vi.unstubAllGlobals() })

describe('结束绑定只针对页面看到的运行', () => {
  it.each([false, true])('托管状态=%s 时携带同一已显示的工作项和运行身份', async managed => {
    const snap = { ...synthSnapshot, managed: managed ? synthSnapshot.managed : [] }
    vi.mocked(api.unbind).mockResolvedValue(undefined)
    const tree = render(snap)
    await select(tree).props.onChange({ target: { value: 'delivered' } })
    expect(api.unbind).toHaveBeenCalledWith(88, 'delivered', { expected_run_id: 3, expected_work_item_id: 'SYN-12' })
    expect(select(render(snap)).props.value).toBe('')
  })

  it('旧页面动作保留旧运行身份，冲突提示刷新而不改投新工作项', async () => {
    const oldChange = select(render(synthSnapshot)).props.onChange
    const changed: Snapshot = { ...synthSnapshot, sessions: synthSnapshot.sessions!.map(s => s.id === 88 ? { ...s, work_item_id: 'SYN-13' } : s), runs: [{ ...synthSnapshot.runs![2], id: 4, work_item_id: 'SYN-13' }] }
    render(changed)
    vi.mocked(api.unbind).mockRejectedValue(new Error('会话绑定或运行已变化，请刷新后重新选择；未结束任何运行'))
    await oldChange({ target: { value: 'delivered' } })
    expect(api.unbind).toHaveBeenCalledExactlyOnceWith(88, 'delivered', { expected_run_id: 3, expected_work_item_id: 'SYN-12' })
    const tree = render(changed)
    expect(nodes(tree).find(n => n.type === ErrorLine)?.props.msg).toContain('刷新后重新选择')
  })

  it.each(['missing', 'ambiguous', 'mismatched'] as const)('运行身份 %s 时不允许无条件解绑', async kind => {
    const run = synthSnapshot.runs![2]
    const runs = kind === 'missing' ? [] : kind === 'ambiguous' ? [run, { ...run, id: 4 }] : [{ ...run, work_item_id: 'SYN-13' }]
    const snap = { ...synthSnapshot, runs }
    const tree = render(snap)
    expect(select(tree).props.disabled).toBe(true)
    await select(tree).props.onChange({ target: { value: 'delivered' } })
    expect(api.unbind).not.toHaveBeenCalled()
    expect(renderToStaticMarkup(tree)).toContain('请刷新面板后再结束绑定')
  })

  it('请求进行中暂时禁用同一绑定操作', async () => {
    let complete!: () => void
    vi.mocked(api.unbind).mockReturnValue(new Promise(resolve => { complete = () => resolve(undefined) }))
    const request = select(render(synthSnapshot)).props.onChange({ target: { value: 'delivered' } })
    expect(select(render(synthSnapshot)).props.disabled).toBe(true)
    complete(); await request
    expect(select(render(synthSnapshot)).props.disabled).toBe(false)
  })

  it('不把已结束、缺失或无效的运行当作可结束的当前绑定', () => {
    const run = synthSnapshot.runs![2]
    expect(currentUnbindTarget({ ...synthSnapshot, runs: [{ ...run, ended_at: synthSnapshot.now }] }, session)).toBeNull()
    expect(currentUnbindTarget({ ...synthSnapshot, runs: [{ ...run, id: 0 }] }, session)).toBeNull()
    expect(currentUnbindTarget(synthSnapshot, { ...session, work_item_id: '' })).toBeNull()
    expect(currentUnbindTarget(synthSnapshot, session)).toEqual({ expected_run_id: 3, expected_work_item_id: 'SYN-12' })
  })
})

describe('历史入口的缺失记录恢复', () => {
  it.each(['item', 'session'] as const)('%s 不在当前范围时保留身份并可返回', kind => {
    const onClose = vi.fn()
    const snap = { ...synthSnapshot, work_items: [], sessions: [], runs: [] }
    host.begin()
    const tree = kind === 'item'
      ? ItemDetail({ snap, id: 'ARCHIVED-12', onClose, onSelectSession() {} })
      : SessionDetail({ snap, id: 123, onClose, onSelectItem() {} })
    const html = renderToStaticMarkup(tree)
    expect(html).toContain(kind === 'item' ? 'ARCHIVED-12' : '#123')
    expect(html).toContain('不在当前范围中')
    expect(html).toContain('项目归档、移除或来源设备')
    expect(html).toContain('返回原页面')
    expect(html).not.toContain('新建工作项')
    expect(html).not.toContain('停止会话')
    const recovery = (tree.type as (props: any) => Node)(tree.props)
    const close = nodes(recovery).find(n => n.type === 'button' && n.props['aria-label'])!
    const back = nodes(recovery).find(n => n.type === 'button' && !n.props['aria-label'])!
    close.props.onClick(); back.props.onClick()
    expect(onClose).toHaveBeenCalledTimes(2)
  })
})
