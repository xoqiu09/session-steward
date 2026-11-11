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
import { DispatchDesk, NewTask, ProjectManager, TaskPanel } from './DispatchDesk'
import { OrchestrationPanel, type OrchestrationState } from './OrchestrationPanel'
import type { DispatchDeskState, DispatchTask } from './dispatchModel'
import { fakeItem } from '../town/fixtures'
import type { WorkItem } from '../types'

const nodes = (node: any): ReactElement<any>[] => Array.isArray(node) ? node.flatMap(nodes) : node?.props ? [node, ...nodes(node.props.children)] : []
const render = <P,>(component: (props: P) => ReactElement<any>, props: P) => { host.begin(); const tree = component(props); host.commit(); return tree }
const element = (tree: ReactElement<any>, type: string) => nodes(tree).find(node => node.type === type)!
const submit = (tree: ReactElement<any>) => element(tree, 'form').props.onSubmit({ preventDefault() {} })
const flush = async () => { for (let i = 0; i < 12; i++) await Promise.resolve() }
const response = (data: unknown, ok = true, status = ok ? 200 : 500) => ({ ok, status, json: async () => data }) as Response
const task = (id: string): DispatchTask => ({ id, repo_id: id === 'A' ? 1 : 2, repo_name: `合成项目${id}`, title: `合成任务${id}`, work_item_id: `SYN-${id}`, worktree: `/synthetic/${id}`, branch: `steward/${id}`, thread_id: `thread-${id}`, turn_id: '', status: 'idle', created_at: '', work_status: 'in_progress', desktop_handoff: false, pending: [] })
const desk = (): DispatchDeskState => ({ host: '合成电脑', codex_version: '', owner: 'test-client', epoch: 1, lease_until: new Date(Date.now() + 3600_000).toISOString(), desktop_handoff_enabled: false, projects: [{ repo_id: 1, name: '项目A', common_dir: '/synthetic/A/.git', added_at: '' }, { repo_id: 2, name: '项目B', common_dir: '/synthetic/B/.git', added_at: '' }], tasks: [task('A'), task('B')] })
let timers: (() => void)[]
beforeEach(() => {
  timers = []
  vi.stubGlobal('window', { location: { search: '', pathname: '/' }, setInterval: (fn: () => void) => { timers.push(fn); return timers.length }, clearInterval: vi.fn() })
  vi.stubGlobal('history', { replaceState: vi.fn() })
  vi.stubGlobal('sessionStorage', { getItem: () => 'test-client', setItem: vi.fn() })
})
afterEach(() => { host.reset(); vi.restoreAllMocks(); vi.unstubAllGlobals() })

describe('派活台按明确对象隔离输入', () => {
  it('同名仓库在选项与提交前都能按真实位置辨认，位置缺失不能执行', async () => {
    let data = desk()
    data = { ...data, projects: data.projects.map(p => ({ ...p, name: '同名项目' })) }
    const create = vi.fn(async (_body: object) => false)
    const draw = () => render(NewTask, { desk: data, disabled: false, onCreate: create })
    let html = renderToStaticMarkup(draw())
    expect(html).toContain('同名项目 · /synthetic/A/.git')
    expect(html).toContain('同名项目 · /synthetic/B/.git')
    element(draw(), 'select').props.onChange({ target: { value: '2' } })
    element(draw(), 'input').props.onChange({ target: { value: '只给 B 的标题' } })
    element(draw(), 'textarea').props.onChange({ target: { value: '只给 B 的要求' } })
    html = renderToStaticMarkup(draw())
    expect(html).toContain('本次目标：')
    expect(html).toContain('仓库位置：<span class="dd-mono" style="overflow-wrap:anywhere">/synthetic/B/.git</span>')
    await submit(draw())
    expect(create).toHaveBeenCalledWith(expect.objectContaining({ repo_id: 2 }))
    data = { ...data, projects: data.projects.map(p => p.repo_id === 2 ? { ...p, common_dir: '' } : p) }
    expect(element(draw(), 'button').props.disabled).toBe(true)
    await submit(draw()); expect(create).toHaveBeenCalledOnce()
  })

  it('新建不默认选第一项目，已选项目移除或排序变化都不能静默换目标', async () => {
    let data = desk()
    const create = vi.fn(async (_body: object) => false)
    const draw = () => render(NewTask, { desk: data, disabled: false, onCreate: create })
    let tree = draw()
    expect(element(tree, 'select').props.value).toBe('')
    element(tree, 'input').props.onChange({ target: { value: 'A 的标题' } })
    element(tree, 'textarea').props.onChange({ target: { value: 'A 的要求' } })
    await submit(draw()); expect(create).not.toHaveBeenCalled()
    element(draw(), 'select').props.onChange({ target: { value: '1' } })
    data = { ...data, projects: [...data.projects].reverse() }
    expect(element(draw(), 'select').props.value).toBe(1)
    data = { ...data, projects: data.projects.filter(project => project.repo_id !== 1) }
    tree = draw()
    expect(element(tree, 'select').props.value).toBe('')
    expect(element(tree, 'textarea').props.value).toBe('A 的要求')
    expect(renderToStaticMarkup(tree)).toContain('原项目已不在可派活范围')
    await submit(tree); expect(create).not.toHaveBeenCalled()
  })

  it('新建失败保留标题和要求，同一请求未结束前不重复提交', async () => {
    let finish!: (result: boolean) => void
    const create = vi.fn((_body: object) => new Promise<boolean>(resolve => { finish = resolve }))
    const draw = () => render(NewTask, { desk: desk(), disabled: false, onCreate: create })
    element(draw(), 'select').props.onChange({ target: { value: '1' } })
    element(draw(), 'input').props.onChange({ target: { value: '合成标题' } })
    element(draw(), 'textarea').props.onChange({ target: { value: '合成要求' } })
    const pending = submit(draw()); await submit(draw())
    expect(create).toHaveBeenCalledOnce()
    const first = create.mock.calls[0][0]
    finish(false); await pending
    expect(element(draw(), 'input').props.value).toBe('合成标题')
    expect(element(draw(), 'textarea').props.value).toBe('合成要求')
    const retry = submit(draw())
    expect(create.mock.calls[1][0]).toEqual(first)
    finish(false); await retry
  })

  it('A/B 草稿独立，A 请求晚到不清空 B；失败原文可重试且不会并发重复', async () => {
    let current = task('A'), busy = false, finish!: (result: DispatchTask | null) => void
    const action = vi.fn((_path: string, _body: object) => new Promise<DispatchTask | null>(resolve => { finish = resolve }))
    const draw = () => render(TaskPanel, { t: current, desk: desk(), busy, owns: true, act: action })
    element(draw(), 'textarea').props.onChange({ target: { value: '只给 A 的下一步' } })
    const pending = submit(draw()); await submit(draw())
    expect(action).toHaveBeenCalledOnce()
    expect(action.mock.calls[0][0]).toBe('/api/dispatch/tasks/A/start')
    busy = true; current = task('B')
    expect(element(draw(), 'textarea').props.value).toBe('')
    expect(element(draw(), 'textarea').props.disabled).toBe(true)
    element(draw(), 'textarea').props.onChange({ target: { value: '只给 B 的下一步' } })
    finish(task('A')); await pending
    busy = false
    expect(element(draw(), 'textarea').props.value).toBe('只给 B 的下一步')
    current = task('A')
    expect(element(draw(), 'textarea').props.value).toBe('')
    current = task('B')
    const failed = submit(draw()), first = action.mock.calls[1][1]
    finish(null); await failed
    expect(element(draw(), 'textarea').props.value).toBe('只给 B 的下一步')
    const retry = submit(draw())
    expect(action.mock.calls[2][1]).toEqual(first)
    finish(null); await retry
  })

  it('新建请求晚到时不把已切到 B 的页面抢回 A', async () => {
    const data = desk()
    let finish!: (result: Response) => void
    vi.stubGlobal('fetch', vi.fn((path: string, init?: RequestInit) => {
      if (init?.method === 'POST') return new Promise<Response>(resolve => { finish = resolve })
      return Promise.resolve(response(data))
    }))
    const draw = () => render(DispatchDesk, {})
    draw(); await flush()
    const create = nodes(draw()).find(node => node.type === NewTask)!.props.onCreate
    const pending = create({ operation: 'synthetic-new', repo_id: 1, title: '新任务 A', prompt: '只给 A' })
    const chooseB = nodes(draw()).find(node => node.type === 'button' && node.props.className === 'dd-task' && nodes(node).some(child => child.props.children === '合成任务B'))!
    chooseB.props.onClick(); draw()
    finish(response(task('A'))); await pending; await flush()
    expect(nodes(draw()).find(node => node.type === TaskPanel)!.props.t.id).toBe('B')
  })
})

describe('可派活项目按真实仓库辨认', () => {
  it('同名候选明确显示路径，加入必须手选，加入后不回落首项或重复旧对象', async () => {
    let data = { ...desk(), projects: [] as DispatchDeskState['projects'] }
    const projects = desk().projects.map(p => ({ id: p.repo_id, name: '同名项目', common_dir: p.common_dir, is_git: true, archived_at: '' }))
    const posts: any[] = []
    vi.stubGlobal('fetch', vi.fn(async (path: string, init?: RequestInit) => {
      if (init?.method === 'POST') {
        const body = JSON.parse(String(init.body)); posts.push(body)
        return response({ ...data, projects: [desk().projects[body.repo_id - 1]] })
      }
      expect(path).toBe('/api/projects')
      return response(projects)
    }))
    const draw = () => render(ProjectManager, { desk: data, onChange: (next: DispatchDeskState) => { data = next }, onError: vi.fn() })
    draw(); await flush()
    expect(element(draw(), 'select').props.value).toBe('')
    expect(element(draw(), 'button').props.disabled).toBe(true)
    const html = renderToStaticMarkup(draw())
    expect(html).toContain('同名项目 · /synthetic/A/.git')
    expect(html).toContain('同名项目 · /synthetic/B/.git')
    element(draw(), 'select').props.onChange({ target: { value: '2' } })
    expect(renderToStaticMarkup(draw())).toContain('将加入：同名项目')
    expect(renderToStaticMarkup(draw())).toContain('仓库位置：<span class="dd-mono">/synthetic/B/.git</span>')
    element(draw(), 'button').props.onClick(); await flush()
    expect(posts).toEqual([{ repo_id: 2, allowed: true }])
    expect(element(draw(), 'select').props.value).toBe('')
    const add = nodes(draw()).find(node => node.type === 'button' && node.props.children === '加入')!
    expect(add.props.disabled).toBe(true)
    add.props.onClick(); await flush()
    expect(posts).toHaveLength(1)
    expect(renderToStaticMarkup(draw())).toContain('/synthetic/B/.git')
  })
})

describe('后台授权不随轮询换工作', () => {
  const orchestration: OrchestrationState = { mode: 'observe', available: true, mandates: [], deliveries: [], findings: [] }
  function setup() {
    let items: WorkItem[] = [fakeItem({ id: 'A', title: '合成工作 A', repo_id: 1, status: 'in_progress' }), fakeItem({ id: 'B', title: '合成工作 B', repo_id: 2, status: 'in_progress' })]
    let finish!: (result: Response) => void
    const posts: { path: string; body: any }[] = []
    vi.stubGlobal('fetch', vi.fn((path: string, init?: RequestInit) => {
      if (init?.method === 'POST') { posts.push({ path, body: JSON.parse(String(init.body)) }); return new Promise<Response>(resolve => { finish = resolve }) }
      return Promise.resolve(response(path === '/api/orchestration' ? orchestration : { work_items: items }))
    }))
    const draw = () => render(OrchestrationPanel, {})
    const choose = (id: string) => element(draw(), 'select').props.onChange({ target: { value: id } })
    const edit = (text: string) => {
      element(draw(), 'textarea').props.onChange({ target: { value: text } })
      nodes(draw()).filter(node => node.type === 'input' && node.props.type === 'checkbox')[1].props.onChange({ target: { checked: true } })
    }
    return { draw, choose, edit, posts, finish: (data: Response) => finish(data), poll: async (next: WorkItem[]) => { items = next; timers[0](); await flush() }, items: () => items }
  }

  it('必须手选工作；排序不变选择，A 退出可授权范围后不能把 A 的要求送到 B', async () => {
    const x = setup(); x.draw(); await flush()
    expect(element(x.draw(), 'select').props.value).toBe('')
    x.choose('A'); x.edit('只授权 A 的范围')
    await x.poll([...x.items()].reverse())
    expect(element(x.draw(), 'select').props.value).toBe('A')
    await x.poll(x.items().map(item => item.id === 'A' ? { ...item, status: 'review' } : item))
    const tree = x.draw()
    expect(element(tree, 'select').props.value).toBe('')
    expect(element(tree, 'textarea').props.value).toBe('只授权 A 的范围')
    expect(element(tree, 'textarea').props.disabled).toBe(true)
    expect(renderToStaticMarkup(tree)).toContain('不会自动交给其他工作')
    await submit(tree); expect(x.posts).toHaveLength(0)
    x.choose('B')
    expect(element(x.draw(), 'textarea').props.value).toBe('')
    expect(nodes(x.draw()).filter(node => node.type === 'input' && node.props.type === 'checkbox')[1].props.checked).toBe(false)
  })

  it('A 请求晚到只清 A；B 草稿与暂存同意保持独立，重复授权只发一次', async () => {
    const x = setup(); x.draw(); await flush()
    x.choose('A'); x.edit('A 的要求')
    const pending = submit(x.draw()); await submit(x.draw())
    expect(x.posts).toHaveLength(1)
    expect(x.posts[0].body.work_item_id).toBe('A')
    x.choose('B'); x.edit('B 的要求')
    x.finish(response({ ok: true })); await pending; await flush()
    expect(element(x.draw(), 'textarea').props.value).toBe('B 的要求')
    x.choose('A')
    expect(element(x.draw(), 'textarea').props.value).toBe('')
  })

  it('失败保留原工作草稿、同意与 revision，重试不会换一件工作或新建一份授权', async () => {
    const x = setup(); x.draw(); await flush()
    x.choose('A'); x.edit('失败后保留 A 的要求')
    const pending = submit(x.draw())
    x.finish(response({ error: '合成拒绝' }, false)); await pending
    expect(element(x.draw(), 'textarea').props.value).toBe('失败后保留 A 的要求')
    expect(renderToStaticMarkup(x.draw())).toContain('合成拒绝')
    const retry = submit(x.draw())
    expect(x.posts[1]).toEqual(x.posts[0])
    x.finish(response({ error: '合成拒绝' }, false)); await retry
  })
})
