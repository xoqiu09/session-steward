import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ReactElement } from 'react'

const host = vi.hoisted(() => {
  let index = 0, effectIndex = 0
  const slots: any[] = [], effects: { deps: unknown[]; cleanup?: () => void }[] = [], pending: (() => void)[] = []
  return {
    begin() { index = 0; effectIndex = 0 },
    commit() { pending.splice(0).forEach(fn => fn()) },
    reset() { effects.forEach(effect => effect.cleanup?.()); slots.length = 0; effects.length = 0; pending.length = 0 },
    state(initial: any) { const i = index++; if (!(i in slots)) slots[i] = typeof initial === 'function' ? initial() : initial; return [slots[i], (value: any) => { slots[i] = typeof value === 'function' ? value(slots[i]) : value }] },
    ref(value: any) { const i = index++; if (!(i in slots)) slots[i] = { current: value }; return slots[i] },
    effect(fn: () => void | (() => void), deps: unknown[]) {
      const i = effectIndex++, before = effects[i]
      if (!before || before.deps.some((value, j) => value !== deps[j])) pending.push(() => { before?.cleanup?.(); const cleanup = fn(); effects[i] = { deps, cleanup: typeof cleanup === 'function' ? cleanup : undefined } })
    },
  }
})
vi.mock('react', async original => ({ ...await original<typeof import('react')>(), useState: host.state, useRef: host.ref, useEffect: host.effect }))
import { HandoffForm } from './P1'
import { api } from './api'
import { fakeItem } from './town/fixtures'
import type { Handoff, ManagedSession, Snapshot } from './types'

const snap: Snapshot = { cursor: 1, now: '', repos: [], sessions: [], work_items: [], deps: [], runs: [], approvals: [], agent_info: [{ name: 'claude', provider: 'claude', hooks: true }, { name: 'codex', provider: 'codex', hooks: true }] }
const item = (id = 'A') => fakeItem({ id, repo_id: 1, title: `合成工作${id}`, status: 'in_progress', agents: ['claude'] })
const nodes = (node: any): ReactElement<any>[] => Array.isArray(node) ? node.flatMap(nodes) : node?.props ? [node, ...nodes(node.props.children)] : []
const button = (tree: ReactElement<any>, label: string) => nodes(tree).find(node => node.type === 'button' && node.props.children === label)
const element = (tree: ReactElement<any>, type: string) => nodes(tree).find(node => node.type === type)!
const flush = async () => { for (let i = 0; i < 8; i++) await Promise.resolve() }
const preview = { package: '只给 Codex 的合成预览', source_branch: 'synthetic', source_sha: 'synthetic-sha' }
const launched = { handoff: {} as Handoff, managed: { work_item_id: 'A' } as ManagedSession }
const draw = (work = item(), onLaunched = () => {}) => { host.begin(); const tree = HandoffForm({ snap, item: work, onLaunched }); host.commit(); return tree! }
afterEach(() => { host.reset(); vi.restoreAllMocks() })

describe('交接确认绑定到实际展示的预览', () => {
  it('预览期间冻结输入，同一请求不重复；字段变化后晚响应不能恢复确认入口', async () => {
    let finish!: (value: typeof preview) => void
    const prepare = vi.spyOn(api, 'handoffPreview').mockImplementation(() => new Promise(resolve => { finish = resolve }))
    const tree = draw(), action = button(tree, '预览交接包')!.props.onClick
    action(); action()
    expect(prepare).toHaveBeenCalledOnce()
    const loading = draw()
    expect(element(loading, 'select').props.disabled).toBe(true)
    expect(element(loading, 'input').props.disabled).toBe(true)
    // A queued field-change event must still invalidate a previously requested preview.
    element(loading, 'select').props.onChange({ target: { value: 'claude' } })
    element(draw(), 'input').props.onChange({ target: { value: '新的补充要求' } })
    draw()
    finish(preview); await flush()
    expect(button(draw(), '确认交接并启动')).toBeUndefined()
    expect(renderToStaticMarkup(draw())).not.toContain(preview.package)
  })

  it('收起或取消预览后旧响应不能复活，旧确认回调也不能启动不同内容', async () => {
    let finish!: (value: typeof preview) => void
    vi.spyOn(api, 'handoffPreview').mockImplementationOnce(() => new Promise(resolve => { finish = resolve })).mockResolvedValue(preview)
    const launch = vi.spyOn(api, 'handoff').mockResolvedValue(launched)
    button(draw(), '预览交接包')!.props.onClick()
    draw().props.onToggle({ currentTarget: { open: false } })
    finish(preview); await flush()
    expect(button(draw(), '确认交接并启动')).toBeUndefined()
    button(draw(), '预览交接包')!.props.onClick(); await flush()
    const oldConfirm = button(draw(), '确认交接并启动')!.props.onClick
    element(draw(), 'input').props.onChange({ target: { value: '预览后新写的内容' } })
    oldConfirm(); await flush()
    expect(launch).not.toHaveBeenCalled()
    expect(button(draw(), '确认交接并启动')).toBeUndefined()
  })

  it('确认只发送展示过的对象/Agent/说明，失败保留预览与草稿，重复点击不启动两次', async () => {
    vi.spyOn(api, 'handoffPreview').mockResolvedValue(preview)
    let fail!: (reason: Error) => void
    const launch = vi.spyOn(api, 'handoff').mockImplementationOnce(() => new Promise((_, reject) => { fail = reject })).mockResolvedValue(launched)
    element(draw(), 'input').props.onChange({ target: { value: '明确给 Codex 的说明' } })
    button(draw(), '预览交接包')!.props.onClick(); await flush()
    const confirm = button(draw(), '确认交接并启动')!.props.onClick
    confirm(); confirm()
    expect(launch).toHaveBeenCalledOnce()
    expect(launch).toHaveBeenCalledWith('A', { to_agent: 'codex', note: '明确给 Codex 的说明', source_sha: preview.source_sha })
    expect(element(draw(), 'input').props.disabled).toBe(true)
    fail(new Error('合成交接拒绝')); await flush()
    expect(element(draw(), 'input').props.value).toBe('明确给 Codex 的说明')
    expect(renderToStaticMarkup(draw())).toContain('合成交接拒绝')
    expect(button(draw(), '确认交接并启动')).toBeDefined()
    button(draw(), '确认交接并启动')!.props.onClick(); await flush()
    expect(launch).toHaveBeenCalledTimes(2)
  })

  it('工作项换到 B 时隐藏 A 的预览，A 的旧确认回调不能向 B 或 A 发出新交接', async () => {
    vi.spyOn(api, 'handoffPreview').mockResolvedValue(preview)
    const launch = vi.spyOn(api, 'handoff').mockResolvedValue(launched)
    button(draw(), '预览交接包')!.props.onClick(); await flush()
    const oldConfirm = button(draw(), '确认交接并启动')!.props.onClick
    expect(button(draw(item('B')), '确认交接并启动')).toBeUndefined()
    oldConfirm(); await flush()
    expect(launch).not.toHaveBeenCalled()
    expect(button(draw(item('A')), '确认交接并启动')).toBeUndefined()
  })
})
