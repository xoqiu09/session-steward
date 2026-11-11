import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ReactElement } from 'react'

// Exercise the real asynchronous component callbacks without adding a DOM test dependency.
const host = vi.hoisted(() => {
  let index = 0, mounted = false
  const slots: any[] = [], effects: (() => void | (() => void))[] = [], cleanups: (() => void)[] = []
  return {
    begin() { index = 0 },
    commit() { if (!mounted) { mounted = true; effects.forEach(fn => { const cleanup = fn(); if (cleanup) cleanups.push(cleanup) }) } },
    reset() { cleanups.forEach(fn => fn()); slots.length = 0; effects.length = 0; cleanups.length = 0; mounted = false },
    state(initial: any) { const i = index++; if (!(i in slots)) slots[i] = initial; return [slots[i], (value: any) => { slots[i] = typeof value === 'function' ? value(slots[i]) : value }] },
    ref(value: any) { const i = index++; if (!(i in slots)) slots[i] = { current: value }; return slots[i] },
    effect(fn: () => void | (() => void)) { if (!mounted) effects.push(fn) },
  }
})
vi.mock('react', async original => ({ ...await original<typeof import('react')>(), useState: host.state, useRef: host.ref, useEffect: host.effect, useCallback: (fn: unknown) => fn }))
import { api } from '../api'
import { LiveSettings } from './LiveSettings'

const nodes = (node: any): ReactElement<any>[] => Array.isArray(node) ? node.flatMap(nodes) : node?.props ? [node, ...nodes(node.props.children)] : []
const render = (onClose = () => {}) => { host.begin(); const tree = LiveSettings({ onClose }); host.commit(); return tree }
const button = (tree: ReactElement<any>, label: string) => nodes(tree).find(node => node.type === 'button' && node.props.children === label)!
const flush = async () => { for (let i = 0; i < 6; i++) await Promise.resolve() }
const note = { doing: '合成原说明', thinking: '合成思考', contact: '合成交流', style: 'storybook-day' as const, updated_at: '' }
afterEach(() => { host.reset(); vi.restoreAllMocks(); vi.unstubAllGlobals() })

describe('直播说明的安全编辑与恢复', () => {
  it('居民动作由独立的主人接口发送，失败可重试，不保存或丢弃主题草稿', async () => {
    vi.spyOn(api, 'liveNote').mockResolvedValue(note)
    const save = vi.spyOn(api, 'saveLiveNote').mockResolvedValue(note)
    let fail!: (error: Error) => void
    const gesture = vi.spyOn(api, 'liveCompanion').mockImplementationOnce(() => new Promise((_, reject) => { fail = reject })).mockResolvedValue({ id: 'a'.repeat(32), kind: 'pat', at: '2026-11-11T20:00:00Z' })
    render(); await flush()
    nodes(render()).find(node => node.type === 'input' && node.props.placeholder === '例如：给小镇加直播画面')!.props.onChange({ target: { value: '尚未保存的公开主题' } })
    const send = button(render(), '摸摸').props.onClick
    send(); send()
    expect(gesture).toHaveBeenCalledOnce()
    expect(button(render(), '去散步').props.disabled).toBe(true)
    fail(new Error('合成动作失败')); await flush()
    expect(renderToStaticMarkup(render())).toContain('动作没有发送成功')
    expect(renderToStaticMarkup(render())).toContain('尚未保存的公开主题')
    expect(renderToStaticMarkup(render())).toContain('尚未接入直播间弹幕')
    button(render(), '摸摸').props.onClick(); await flush()
    expect(gesture).toHaveBeenCalledTimes(2)
    expect(gesture).toHaveBeenLastCalledWith('pat')
    expect(save).not.toHaveBeenCalled()
    expect(renderToStaticMarkup(render())).toContain('已发送「摸摸」')
    expect(nodes(render()).find(node => node.type === 'iframe')!.props.src).toContain('live-layout=companion')
  })
  it('读取失败时保持表单只读，不把空白初值保存；重试成功后沿用原说明和画风', async () => {
    vi.spyOn(api, 'liveNote').mockRejectedValueOnce(new Error('合成读取失败')).mockResolvedValueOnce(note)
    const save = vi.spyOn(api, 'saveLiveNote').mockResolvedValue(note)
    render(); await flush()
    let tree = render()
    expect(renderToStaticMarkup(tree)).toContain('原说明尚未读取，暂时不能编辑或保存')
    expect(button(tree, '保存').props.disabled).toBe(true)
    button(tree, '保存').props.onClick()
    await flush()
    expect(save).not.toHaveBeenCalled()
    button(tree, '重新读取说明').props.onClick()
    await flush()
    tree = render()
    expect(button(tree, '保存').props.disabled).toBe(false)
    expect(renderToStaticMarkup(tree)).toContain('合成原说明')
    button(tree, '保存').props.onClick()
    await flush()
    expect(save).toHaveBeenCalledWith({ doing: note.doing, thinking: note.thinking, contact: note.contact, style: 'storybook-day', presentation: 'companion' })
  })

  it('保存期间锁住文字和画风，重复触发也只提交一次，失败后保留草稿供重试', async () => {
    vi.spyOn(api, 'liveNote').mockResolvedValue(note)
    let reject!: (reason: Error) => void
    const save = vi.spyOn(api, 'saveLiveNote').mockImplementationOnce(() => new Promise((_, fail) => { reject = fail })).mockResolvedValue(note)
    render(); await flush()
    let tree = render()
    nodes(tree).find(node => node.type === 'input' && node.props.placeholder === '例如：给小镇加直播画面')!.props.onChange({ target: { value: '合成新草稿' } })
    tree = render()
    const submit = button(tree, '保存').props.onClick
    submit(); submit()
    tree = render()
    expect(save).toHaveBeenCalledOnce()
    expect(button(tree, '保存中…').props.disabled).toBe(true)
    expect(nodes(tree).filter(node => node.type === 'input').every(node => node.props.disabled)).toBe(true)
    expect(nodes(tree).find(node => node.type === 'fieldset')!.props.disabled).toBe(true)
    reject(new Error('合成保存失败')); await flush()
    tree = render()
    expect(renderToStaticMarkup(tree)).toContain('没有保存成功：合成保存失败')
    expect(renderToStaticMarkup(tree)).toContain('合成新草稿')
    expect(button(tree, '保存').props.disabled).toBe(false)
    button(tree, '保存').props.onClick(); await flush()
    expect(save).toHaveBeenLastCalledWith({ doing: '合成新草稿', thinking: note.thinking, contact: note.contact, style: 'storybook-day', presentation: 'companion' })
  })

  it('使用原生模态，Escape 交还给受控关闭且只调用一次', async () => {
    vi.spyOn(api, 'liveNote').mockResolvedValue(note)
    const close = vi.fn(), tree = render(close)
    expect(tree.type).toBe('dialog')
    expect(tree.props['aria-modal']).toBe('true')
    const event = { preventDefault: vi.fn(), stopPropagation: vi.fn() }
    tree.props.onCancel(event)
    expect(close).toHaveBeenCalledOnce()
    expect(event.preventDefault).toHaveBeenCalledOnce()
    expect(event.stopPropagation).toHaveBeenCalledOnce()
    await flush()
  })

  it('保存与复制并行时分别保留结果，复制不会覆盖保存失败与仍未保存的草稿', async () => {
    vi.spyOn(api, 'liveNote').mockResolvedValue(note)
    let reject!: (error: Error) => void
    vi.spyOn(api, 'saveLiveNote').mockImplementation(() => new Promise((_, fail) => { reject = fail }))
    vi.spyOn(api, 'liveLink').mockResolvedValue({ url: 'http://127.0.0.1/live?k=synthetic-token', view: '/?view=town&live=1' })
    vi.stubGlobal('navigator', { clipboard: { writeText: vi.fn().mockResolvedValue(undefined) } })
    render(); await flush()
    nodes(render()).find(node => node.type === 'input' && node.props.placeholder === '例如：给小镇加直播画面')!.props.onChange({ target: { value: '尚未保存的合成草稿' } })
    button(render(), '保存').props.onClick()
    button(render(), '复制展示地址').props.onClick(); await flush()
    expect(renderToStaticMarkup(render())).toContain('展示地址已复制')
    expect(renderToStaticMarkup(render())).toContain('正在保存，请等待结果后再关闭')
    reject(new Error('合成保存失败')); await flush()
    const html = renderToStaticMarkup(render())
    expect(html).toContain('没有保存成功：合成保存失败')
    expect(html).toContain('展示地址已复制')
    expect(html).toContain('尚未保存的合成草稿')
    expect(html).toContain('有未保存的修改')
  })

  it('复制失败单独提示，不清掉已确认的保存回执；慢复制重复点击不重复取地址', async () => {
    vi.spyOn(api, 'liveNote').mockResolvedValue(note)
    vi.spyOn(api, 'saveLiveNote').mockResolvedValue(note)
    let fail!: (error: Error) => void
    const link = vi.spyOn(api, 'liveLink').mockImplementation(() => new Promise((_, reject) => { fail = reject }))
    render(); await flush()
    button(render(), '保存').props.onClick(); await flush()
    const copy = button(render(), '复制展示地址').props.onClick
    copy(); copy()
    expect(link).toHaveBeenCalledOnce()
    expect(button(render(), '取地址中…').props.disabled).toBe(true)
    fail(new Error('合成取址失败')); await flush()
    const html = renderToStaticMarkup(render())
    expect(html).toContain('说明和画风已保存')
    expect(html).toContain('取地址失败：合成取址失败')
    expect(html).not.toContain('有未保存的修改')
  })

  it('文字或画风有改动时关闭、Escape、背景点击都先确认，继续编辑保稿，只有显式放弃才关闭', async () => {
    vi.spyOn(api, 'liveNote').mockResolvedValue(note)
    const close = vi.fn()
    render(close); await flush()
    nodes(render(close)).find(node => node.type === 'input' && node.props.placeholder === '例如：给小镇加直播画面')!.props.onChange({ target: { value: '想保留的草稿' } })
    button(render(close), '关闭').props.onClick()
    expect(close).not.toHaveBeenCalled()
    expect(renderToStaticMarkup(render(close))).toContain('还有未保存的修改')
    button(render(close), '继续编辑').props.onClick()
    expect(renderToStaticMarkup(render(close))).not.toContain('关闭前确认')
    const event = { preventDefault: vi.fn(), stopPropagation: vi.fn() }
    render(close).props.onCancel(event)
    expect(renderToStaticMarkup(render(close))).toContain('还有未保存的修改')
    render(close).props.onCancel(event)
    expect(close).not.toHaveBeenCalled()
    expect(renderToStaticMarkup(render(close))).not.toContain('关闭前确认')
    const target = { getBoundingClientRect: () => ({ left: 10, top: 10, right: 100, bottom: 100 }) }
    render(close).props.onClick({ target, currentTarget: target, clientX: 0, clientY: 0 })
    expect(renderToStaticMarkup(render(close))).toContain('想保留的草稿')
    expect(renderToStaticMarkup(render(close))).toContain('还有未保存的修改')
    button(render(close), '放弃修改并关闭').props.onClick()
    expect(close).toHaveBeenCalledOnce()
  })

  it('只改画风也需要关闭确认，保存中不关闭；收到保存 ACK 后可直接关闭', async () => {
    vi.spyOn(api, 'liveNote').mockResolvedValue(note)
    let finish!: (value: typeof note) => void
    vi.spyOn(api, 'saveLiveNote').mockImplementation(() => new Promise(resolve => { finish = resolve }))
    const close = vi.fn()
    render(close); await flush()
    const style = nodes(render(close)).find(node => node.type === 'button' && nodes(node).some(child => child.type === 'b' && child.props.children === '温暖夜景'))!
    style.props.onClick()
    button(render(close), '关闭').props.onClick()
    expect(renderToStaticMarkup(render(close))).toContain('还有未保存的修改')
    button(render(close), '继续编辑').props.onClick()
    button(render(close), '保存').props.onClick()
    const event = { preventDefault: vi.fn(), stopPropagation: vi.fn() }
    render(close).props.onCancel(event)
    expect(button(render(close), '关闭').props.disabled).toBe(true)
    expect(close).not.toHaveBeenCalled()
    finish(note); await flush()
    expect(renderToStaticMarkup(render(close))).not.toContain('有未保存的修改')
    button(render(close), '关闭').props.onClick()
    expect(close).toHaveBeenCalledOnce()
  })
})
