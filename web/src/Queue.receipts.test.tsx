import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ReactElement } from 'react'
import type { Approval } from './types'
vi.mock('react', async original => ({ ...await original<typeof import('react')>(), useState: (initial: unknown) => [typeof initial === 'function' ? initial() : initial, vi.fn()] }))
vi.mock('./api', async original => ({ ...await original<typeof import('./api')>(), api: { ...(await original<typeof import('./api')>()).api, dismiss: vi.fn(), decide: vi.fn() } }))
import { DecisionCard, PermissionCard } from './Queue'
import { api } from './api'
import { synthSnapshot } from './ui/fixtures'

type Node = ReactElement<any>
const nodes = (node: any): Node[] => Array.isArray(node) ? node.flatMap(nodes) : node?.props ? [node, ...nodes(node.props.children)] : []
const words = (node: any): string => Array.isArray(node) ? node.map(words).join('') : typeof node === 'string' || typeof node === 'number' ? String(node) : node?.props ? words(node.props.children) : ''
const button = (tree: Node, label: string) => nodes(tree).find(node => node.type === 'button' && words(node) === label)
const question: Approval = { ...synthSnapshot.approvals![0], id: 'synthetic-question', kind: 'decision', status: 'pending', session_id: 88, work_item_id: 'SYN-12', deadline: '', preview: '合成问题：是否继续？' }
beforeEach(() => { vi.mocked(api.dismiss).mockReset().mockResolvedValue({}); vi.mocked(api.decide).mockReset().mockResolvedValue({}) })
afterEach(() => vi.unstubAllGlobals())

describe('关注队列的原会话回执文案与既有请求契约', () => {
  it.each([false, true])('恢复命令=%s时区分已回答和忽略，不在渲染时发送请求', async hasCommand => {
    const snap = { ...synthSnapshot, sessions: synthSnapshot.sessions!.map(s => s.id === 88 ? { ...s, resume_command: hasCommand ? 'codex --resume synthetic' : '' } : s) }
    const tree = DecisionCard({ a: question, snap })
    const html = renderToStaticMarkup(tree)
    expect(html).toContain('已回答可点“已在原会话回答”记录')
    expect(html).toContain('不需要回应可点“忽略这条提醒”')
    expect(html).not.toContain('不需要时点“已处理”')
    expect(api.dismiss).not.toHaveBeenCalled(); expect(api.decide).not.toHaveBeenCalled()
    await button(tree, '已在原会话回答')!.props.onClick()
    expect(api.dismiss).toHaveBeenNthCalledWith(1, question.id, 'resolved')
    await button(tree, '忽略这条提醒')!.props.onClick()
    expect(api.dismiss).toHaveBeenNthCalledWith(2, question.id, 'ignored')
    expect(api.decide).not.toHaveBeenCalled()
  })

  it('记忆问题仍只记录原会话处理，不增加面板批准或忽略路径', async () => {
    const snap = { ...synthSnapshot, work_items: synthSnapshot.work_items!.map(w => w.id === 'SYN-12' ? { ...w, completion_policy: 'auto_history' as const } : w) }
    const tree = DecisionCard({ a: question, snap })
    expect(button(tree, '已在原会话处理')).toBeDefined()
    expect(button(tree, '忽略这条提醒')).toBeUndefined()
    expect(api.dismiss).not.toHaveBeenCalled()
    await button(tree, '已在原会话处理')!.props.onClick()
    expect(api.dismiss).toHaveBeenCalledExactlyOnceWith(question.id, 'resolved')
  })

  it('低置信关注保持忽略语义和ignored原因', async () => {
    const a = { ...question, kind: 'attention' as const }
    const tree = DecisionCard({ a, snap: synthSnapshot })
    expect(button(tree, '已在原会话回答')).toBeUndefined()
    expect(renderToStaticMarkup(tree)).toContain('不需要回应时忽略即可，不影响工作项状态')
    await button(tree, '忽略')!.props.onClick()
    expect(api.dismiss).toHaveBeenCalledExactlyOnceWith(a.id, 'ignored')
  })

  it('不能在面板批准的权限请求只改回执名称，仍发handled_elsewhere', async () => {
    const a = { ...question, kind: 'permission' as const, handleable: false }
    const tree = PermissionCard({ a, snap: synthSnapshot })
    expect(button(tree, '允许本次')).toBeUndefined()
    expect(api.dismiss).not.toHaveBeenCalled()
    await button(tree, '已在原会话处理')!.props.onClick()
    expect(api.dismiss).toHaveBeenCalledExactlyOnceWith(a.id, 'handled_elsewhere')
    expect(api.decide).not.toHaveBeenCalled()
  })

  it('真正可面板批准的权限仍走allow/deny，不改为原会话回执', async () => {
    const a = { ...question, kind: 'permission' as const, handleable: true }
    const tree = PermissionCard({ a, snap: synthSnapshot })
    expect(button(tree, '已在原会话处理')).toBeUndefined()
    expect(api.decide).not.toHaveBeenCalled()
    await button(tree, '允许本次')!.props.onClick()
    await button(tree, '拒绝')!.props.onClick()
    expect(api.decide).toHaveBeenNthCalledWith(1, a.id, a.fingerprint, 'allow')
    expect(api.decide).toHaveBeenNthCalledWith(2, a.id, a.fingerprint, 'deny')
    expect(api.dismiss).not.toHaveBeenCalled()
  })
})
