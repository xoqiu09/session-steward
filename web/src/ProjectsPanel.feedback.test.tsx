import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import type { ReactElement } from 'react'

const host = vi.hoisted(() => {
  let index = 0, mounted = false
  const slots: any[] = [], effects: (() => void | (() => void))[] = [], cleanups: (() => void)[] = []
  return {
    begin() { index = 0 },
    commit() { if (!mounted) { mounted = true; effects.forEach(fn => { const cleanup = fn(); if (cleanup) cleanups.push(cleanup) }) } },
    reset() { cleanups.forEach(fn => fn()); slots.length = 0; effects.length = 0; cleanups.length = 0; mounted = false },
    state(initial: any) { const i = index++; if (!(i in slots)) slots[i] = typeof initial === 'function' ? initial() : initial; return [slots[i], (value: any) => { slots[i] = typeof value === 'function' ? value(slots[i]) : value }] },
    ref(value: any) { const i = index++; if (!(i in slots)) slots[i] = { current: value }; return slots[i] },
    effect(fn: () => void | (() => void)) { if (!mounted) effects.push(fn) },
  }
})
vi.mock('react', async original => ({ ...await original<typeof import('react')>(), useState: host.state, useRef: host.ref, useEffect: host.effect, useCallback: (fn: unknown) => fn }))
import { api } from './api'
import { ProjectManager, ProjectsPanel } from './ProjectsPanel'
import type { ProjectInfo } from './types'

const projects: ProjectInfo[] = [{ id: 1, name: '合成项目', common_dir: '/synthetic/project/.git', is_git: true, target_ref: 'main', archived_at: '', open_items: 1, sessions: 1, running: 0, pending: 0 }]
const nodes = (node: any): ReactElement<any>[] => Array.isArray(node) ? node.flatMap(nodes) : node?.props ? [node, ...nodes(node.props.children)] : []
const render = <P,>(component: (props: P) => ReactElement<any>, props: P) => { host.begin(); const tree = component(props); host.commit(); return tree }
const button = (tree: ReactElement<any>, label: string) => nodes(tree).find(node => node.type === 'button' && node.props.children === label)!
const manager = (tree: ReactElement<any>) => nodes(tree).find(node => node.type === ProjectManager)!
const flush = async () => { for (let i = 0; i < 12; i++) await Promise.resolve() }
let timers: (() => void)[], listeners: Map<string, () => void>
beforeEach(() => {
  timers = []; listeners = new Map()
  vi.stubGlobal('window', { location: { protocol: 'http:', hostname: '127.0.0.1' }, setInterval: (fn: () => void) => { timers.push(fn); return timers.length }, clearInterval: vi.fn(), addEventListener: (name: string, fn: () => void) => listeners.set(name, fn), removeEventListener: (name: string) => listeners.delete(name) })
  vi.spyOn(api, 'mergeSync').mockResolvedValue([])
})
afterEach(() => { host.reset(); vi.restoreAllMocks(); vi.unstubAllGlobals() })

describe('项目列表读取与刷新', () => {
  it('首次失败结束加载并明确重试；旧列表刷新失败保留内容并标记未更新', async () => {
    const read = vi.spyOn(api, 'projects').mockRejectedValueOnce(new Error('合成读取失败')).mockResolvedValueOnce(projects).mockRejectedValueOnce(new Error('合成刷新失败')).mockResolvedValueOnce(projects)
    const draw = () => render(ProjectsPanel, { onClose() {} })
    draw(); await flush()
    let tree = draw(), html = renderToStaticMarkup(tree)
    expect(html).toContain('项目暂时无法读取')
    expect(html).not.toContain('正在读取项目…')
    expect(manager(tree)).toBeUndefined()
    button(tree, '重试').props.onClick(); await flush()
    tree = draw(); expect(manager(tree).props.projects).toEqual(projects)
    timers[0](); await flush()
    tree = draw(); html = renderToStaticMarkup(tree)
    expect(html).toContain('项目列表未更新')
    expect(html).toContain('合成项目')
    expect(manager(tree).props.projects).toEqual(projects)
    expect(manager(tree).props.refreshRequired).toBe(true)
    expect(manager(tree).props.readOnly).toBe(false)
    button(tree, '刷新列表').props.onClick(); await flush()
    tree = draw()
    expect(read).toHaveBeenCalledTimes(4)
    expect(manager(tree).props.refreshRequired).toBe(false)
    expect(renderToStaticMarkup(tree)).not.toContain('项目列表未更新')
  })

  it('写 ACK 先通知归档目标再读取；后续 GET 失败不把已完成写入当失败或重复写', async () => {
    const order: string[] = []
    const read = vi.spyOn(api, 'projects').mockResolvedValueOnce(projects).mockImplementation(() => { order.push('refresh'); return Promise.reject(new Error('合成刷新失败')) })
    let acknowledge!: () => void
    vi.spyOn(api, 'archiveProjects').mockImplementation(() => new Promise(resolve => { acknowledge = () => { order.push('ack'); resolve({}) } }))
    const changed = vi.fn((ids: number[]) => { expect(ids).toEqual([1]); order.push('visibility') })
    const draw = () => render(ProjectsPanel, { onClose() {}, onVisibilityChange: changed })
    draw(); await flush()
    const pending = manager(draw()).props.onArchive([1], true)
    expect(changed).not.toHaveBeenCalled()
    listeners.get('steward:changed')!()
    expect(read).toHaveBeenCalledOnce()
    acknowledge(); await expect(pending).resolves.toBeUndefined(); await flush()
    expect(order).toEqual(['ack', 'visibility', 'refresh'])
    expect(changed).toHaveBeenCalledOnce()
    const tree = draw()
    expect(renderToStaticMarkup(tree)).toContain('项目列表未更新')
    expect(manager(tree).props.projects).toEqual(projects)
    expect(manager(tree).props.refreshRequired).toBe(true)
    button(tree, '刷新列表').props.onClick(); await flush()
    expect(changed).toHaveBeenCalledOnce()
    expect(api.archiveProjects).toHaveBeenCalledOnce()
  })

  it('只有 archive=true 或 trash=true 的成功 ACK 通知收起目标，失败/恢复/普通关闭都不通知', async () => {
    vi.spyOn(api, 'projects').mockResolvedValue(projects)
    const archive = vi.spyOn(api, 'archiveProjects').mockRejectedValueOnce(new Error('合成写失败')).mockResolvedValue({})
    vi.spyOn(api, 'trashProjects').mockResolvedValue({})
    const close = vi.fn(), changed = vi.fn()
    const draw = () => render(ProjectsPanel, { onClose: close, onVisibilityChange: changed })
    draw(); await flush()
    await expect(manager(draw()).props.onArchive([1], true)).rejects.toThrow('合成写失败')
    expect(changed).not.toHaveBeenCalled()
    await manager(draw()).props.onArchive([1], false); await flush()
    await manager(draw()).props.onTrash([1], false); await flush()
    expect(changed).not.toHaveBeenCalled()
    await manager(draw()).props.onTrash([1], true); await flush()
    expect(changed).toHaveBeenCalledExactlyOnceWith([1])
    await manager(draw()).props.onArchive([1], true); await flush()
    expect(changed).toHaveBeenCalledTimes(2)
    expect(archive).toHaveBeenCalledTimes(3)
    button(draw(), '关闭').props.onClick()
    expect(close).toHaveBeenCalledOnce(); expect(changed).toHaveBeenCalledTimes(2)
  })
})

describe('项目操作回执', () => {
  it('失败保留确认对象可重试，慢响应连续点击只写一次，ACK 后显示独立成功回执', async () => {
    let fail!: (reason: Error) => void, succeed!: () => void
    const archive = vi.fn().mockImplementationOnce(() => new Promise((_, reject) => { fail = reject })).mockImplementationOnce(() => new Promise(resolve => { succeed = () => resolve({}) }))
    const draw = () => render(ProjectManager, { projects, statuses: [], onArchive: archive, onTrash: vi.fn(), onSync: vi.fn() })
    button(draw(), '归档').props.onClick()
    let tree = draw()
    const apply = button(tree, '确认归档').props.onClick
    apply(); apply(); expect(archive).toHaveBeenCalledExactlyOnceWith([1], true)
    fail(new Error('合成写失败')); await flush()
    tree = draw()
    expect(renderToStaticMarkup(tree)).toContain('操作没有完成：合成写失败')
    expect(button(tree, '确认归档')).toBeDefined()
    button(tree, '确认归档').props.onClick(); succeed(); await flush()
    tree = draw()
    expect(button(tree, '确认归档')).toBeUndefined()
    expect(renderToStaticMarkup(tree)).toContain('已归档 1 个项目')
    expect(renderToStaticMarkup(tree)).not.toContain('合成写失败')
    expect(archive).toHaveBeenCalledTimes(2)
  })

  it('未更新的旧列表仍可阅读，但不能再确认项目写入', () => {
    const archive = vi.fn(), trash = vi.fn()
    const tree = render(ProjectManager, { projects, statuses: [], refreshRequired: true, onArchive: archive, onTrash: trash, onSync: vi.fn() })
    expect(renderToStaticMarkup(tree)).toContain('合成项目')
    expect(button(tree, '归档').props.disabled).toBe(true)
    expect(button(tree, '移入回收站').props.disabled).toBe(true)
    button(tree, '归档').props.onClick(); button(tree, '移入回收站').props.onClick()
    expect(archive).not.toHaveBeenCalled(); expect(trash).not.toHaveBeenCalled()
  })
})
