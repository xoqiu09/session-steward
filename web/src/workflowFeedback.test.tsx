import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import type { ReactElement } from 'react'
import type { ManagedSession, Snapshot } from './types'

// Each rendered component owns its hook frame. In particular, removing a
// reviewed row cannot accidentally keep its local state alive in the parent.
const host = vi.hoisted(() => {
  type Frame = { index: number; slots: any[]; effects: (() => void)[] }
  const frames = new Map<string, Frame>()
  let active: Frame
  const same = (a: any[], b: any[]) => a.length === b.length && a.every((v, i) => Object.is(v, b[i]))
  return {
    begin(key: string) { active = frames.get(key) ?? { index: 0, slots: [], effects: [] }; frames.set(key, active); active.index = 0; active.effects = [] },
    commit() { active.effects.forEach(effect => effect()) },
    unmount(key: string) { frames.delete(key) },
    reset() { frames.clear() },
    state(initial: any) {
      const frame = active, index = frame.index++
      if (!(index in frame.slots)) frame.slots[index] = typeof initial === 'function' ? initial() : initial
      return [frame.slots[index], (value: any) => { frame.slots[index] = typeof value === 'function' ? value(frame.slots[index]) : value }]
    },
    ref(value: any) { const index = active.index++; if (!(index in active.slots)) active.slots[index] = { current: value }; return active.slots[index] },
    memo(fn: () => any, deps: any[]) {
      const index = active.index++
      if (!active.slots[index] || !same(active.slots[index].deps, deps)) active.slots[index] = { deps, value: fn() }
      return active.slots[index].value
    },
    effect(fn: () => void, deps: any[]) {
      const index = active.index++
      if (!active.slots[index] || !same(active.slots[index], deps)) { active.slots[index] = deps; active.effects.push(fn) }
    },
  }
})
vi.mock('react', async original => ({ ...await original<typeof import('react')>(), useState: host.state, useRef: host.ref, useMemo: host.memo, useEffect: host.effect }))
vi.mock('./api', async original => ({ ...await original<typeof import('./api')>(), api: { ...(await original<typeof import('./api')>()).api, createItem: vi.fn(), patchItem: vi.fn(), launchManaged: vi.fn() } }))
import { ItemDetail, NewItem } from './Panels'
import { NewManaged } from './Managed'
import { TodayView } from './today/TodayView'
import { ActionFeedback } from './ui/ActionFeedback'
import { DeliveryActionReceipt, DeliveryReview } from './ui/DeliveryReview'
import { ProjectPicker } from './ui/ProjectPicker'
import { api } from './api'
import { synthSnapshot } from './ui/fixtures'

type Node = ReactElement<any>
const nodes = (node: any): Node[] => Array.isArray(node) ? node.flatMap(nodes) : node?.props ? [node, ...['children', 'attention', 'actions'].flatMap(key => nodes(node.props[key]))] : []
const words = (node: any): string => Array.isArray(node) ? node.map(words).join('') : typeof node === 'string' || typeof node === 'number' ? String(node) : node?.props ? words(node.props.children) : ''
const button = (tree: any, text: string) => nodes(tree).find(node => node.type === 'button' && words(node) === text)!
const field = (tree: any, label: string) => {
  const lab = nodes(tree).find(node => node.type === 'label' && Array.isArray(node.props.children) && node.props.children[0] === label)!
  return nodes(lab).find(node => ['input', 'select', 'textarea'].includes(node.type as string))!
}
const form = (tree: any, label: string) => nodes(tree).find(node => node.type === 'form' && node.props['aria-label'] === label)!
const submit = (tree: any, label: string) => form(tree, label).props.onSubmit({ preventDefault() {} }) as Promise<void> | undefined
const render = (key: string, fn: () => any): Node => { host.begin(key); const tree = fn(); host.commit(); return tree }
function deferred<T = unknown>() { let resolve!: (value: T) => void, reject!: (error: Error) => void; const promise = new Promise<T>((ok, no) => { resolve = ok; reject = no }); return { promise, resolve, reject } }
const feedback = (tree: any) => nodes(tree).filter(node => node.type === ActionFeedback)
const reviewSnap = (): Snapshot => ({ ...synthSnapshot, work_items: [{ ...synthSnapshot.work_items![0], status: 'review' }], approvals: [], merge_jobs: [] })

beforeEach(() => {
  vi.mocked(api.createItem).mockReset(); vi.mocked(api.patchItem).mockReset(); vi.mocked(api.launchManaged).mockReset()
  vi.stubGlobal('localStorage', { getItem: () => null, setItem: vi.fn() })
})
afterEach(() => { host.reset(); vi.unstubAllGlobals() })

describe('普通表单的在途目标与稿件保护', () => {
  it('新建工作项同步阻止双发和在途改稿，失败保稿，成功回执随原导航传出', async () => {
    const created = vi.fn(), pending = deferred()
    const draw = () => render('new-item', () => NewItem({ snap: synthSnapshot, initialRepoId: 1, onCreated: created }))
    let tree = draw()
    field(tree, '编号').props.onChange({ target: { value: 'SYN-99' } })
    field(tree, '标题').props.onChange({ target: { value: '合成稿件' } })
    field(tree, '验收条件').props.onChange({ target: { value: '合成验收条件' } })
    tree = draw()
    const oldChange = field(tree, '标题').props.onChange
    vi.mocked(api.createItem).mockReturnValueOnce(pending.promise)
    const request = submit(tree, '新建工作项'); submit(tree, '新建工作项')
    oldChange({ target: { value: '在途新稿不得被接受后丢失' } })
    tree = draw()
    expect(nodes(tree).find(n => n.type === 'fieldset')!.props.disabled).toBe(true)
    expect(api.createItem).toHaveBeenCalledTimes(1)
    expect(field(tree, '标题').props.value).toBe('合成稿件')
    pending.reject(new Error('synthetic save failure')); await request; tree = draw()
    expect(field(tree, '编号').props.value).toBe('SYN-99')
    expect(field(tree, '验收条件').props.value).toBe('合成验收条件')
    expect(feedback(tree).some(n => n.props.tone === 'error' && words(n).includes('填写内容已保留'))).toBe(true)
    expect(created).not.toHaveBeenCalled()
    vi.mocked(api.createItem).mockResolvedValueOnce({})
    await submit(tree, '新建工作项'); tree = draw()
    expect(created).toHaveBeenCalledExactlyOnceWith('SYN-99', expect.stringContaining('已创建 SYN-99 · 合成稿件'))
    expect(feedback(tree).some(n => words(n).includes('已创建 SYN-99 · 合成稿件'))).toBe(true)
    field(tree, '标题').props.onChange({ target: { value: '下一份稿件' } }); tree = draw()
    expect(field(tree, '标题').props.value).toBe('下一份稿件')
  })

  it('编辑标题和所属项目在途锁定，失败不关闭表单，成功回执留在表单原位置', async () => {
    const snap: Snapshot = { ...synthSnapshot, repos: [...synthSnapshot.repos!, { id: 2, name: '第二合成项目', common_dir: '/synthetic/b/.git', is_git: true, target_ref: 'main' }] }
    const draw = () => render('edit', () => ItemDetail({ snap, id: 'SYN-12', onClose() {}, onSelectSession() {} }))
    let tree = draw(); button(tree, '修改标题 / 项目').props.onClick(); tree = draw()
    field(tree, '工作标题').props.onChange({ target: { value: '新的合成标题' } })
    field(tree, '所属项目').props.onChange({ target: { value: '2' } }); tree = draw()
    const oldChange = field(tree, '工作标题').props.onChange, pending = deferred()
    vi.mocked(api.patchItem).mockReturnValueOnce(pending.promise)
    const request = submit(tree, '修改工作信息 SYN-12'); submit(tree, '修改工作信息 SYN-12')
    oldChange({ target: { value: '不应覆盖的新稿' } }); tree = draw()
    expect(api.patchItem).toHaveBeenCalledExactlyOnceWith('SYN-12', { title: '新的合成标题', repo_id: 2 })
    expect(nodes(form(tree, '修改工作信息 SYN-12')).find(n => n.type === 'fieldset')!.props.disabled).toBe(true)
    pending.reject(new Error('synthetic edit failed')); await request; tree = draw()
    expect(field(tree, '工作标题').props.value).toBe('新的合成标题'); expect(field(tree, '所属项目').props.value).toBe(2)
    expect(feedback(tree).some(n => words(n).includes('保存失败，填写内容已保留'))).toBe(true)
    vi.mocked(api.patchItem).mockResolvedValueOnce({})
    await submit(tree, '修改工作信息 SYN-12'); tree = draw()
    expect(form(tree, '修改工作信息 SYN-12')).toBeUndefined()
    expect(feedback(tree).some(n => words(n).includes('已保存 SYN-12 · 新的合成标题；所属项目：第二合成项目'))).toBe(true)
  })

  it('新建会话冻结项目/Agent/标题，失败保留目标，成功仍自动开详情并传对象回执', async () => {
    const snap: Snapshot = { ...synthSnapshot, repos: [...synthSnapshot.repos!, { id: 2, name: '第二合成项目', common_dir: '/synthetic/b/.git', is_git: true, target_ref: 'main' }] }
    let initialRepoId = 1
    const launched = vi.fn(), pending = deferred<ManagedSession>()
    const draw = () => render('launch', () => NewManaged({ snap, initialRepoId, onLaunched: launched }))
    let tree = draw(); field(tree, '任务标题').props.onChange({ target: { value: '合成会话任务' } }); tree = draw()
    const oldTitle = field(tree, '任务标题').props.onChange
    const oldAgent = field(tree, 'Agent').props.onChange
    const oldProject = nodes(tree).find(n => n.type === ProjectPicker)!.props.onChange
    vi.mocked(api.launchManaged).mockReturnValueOnce(pending.promise)
    const request = submit(tree, '新建托管会话'); submit(tree, '新建托管会话')
    oldTitle({ target: { value: '在途新稿' } }); oldAgent({ target: { value: 'codex' } }); oldProject(2)
    initialRepoId = 2; tree = draw()
    expect(nodes(tree).find(n => n.type === 'fieldset')!.props.disabled).toBe(true)
    expect(api.launchManaged).toHaveBeenCalledExactlyOnceWith({ repo_id: 1, agent: 'claude', title: '合成会话任务' })
    pending.reject(new Error('synthetic launch rejected')); await request; tree = draw()
    expect(field(tree, '任务标题').props.value).toBe('合成会话任务')
    expect(field(tree, 'Agent').props.value).toBe('claude')
    expect(nodes(tree).find(n => n.type === ProjectPicker)!.props.value).toBe(1)
    expect(launched).not.toHaveBeenCalled()
    const managed = { ...synthSnapshot.managed![0], agent: 'claude', work_item_id: 'SYN-99', title: '合成会话任务' }
    vi.mocked(api.launchManaged).mockResolvedValueOnce(managed)
    await submit(tree, '新建托管会话'); tree = draw()
    expect(launched).toHaveBeenCalledExactlyOnceWith(managed, expect.stringContaining('已创建 SYN-99 · 合成会话任务 的 Claude 会话（synthetic-app）'))
    expect(launched.mock.calls[0][1]).toContain('执行状态请看会话画面')
    expect(field(tree, '任务标题').props.value).toBe('')
  })
})

describe('交付处理回执与状态含义', () => {
  it('原会话处理记录与工作项验收分别命名', () => {
    const snap: Snapshot = { ...reviewSnap(), approvals: [
      { ...synthSnapshot.approvals![0], id: 'synthetic-manual-permission', status: 'pending', kind: 'permission', handleable: false },
      { ...synthSnapshot.approvals![0], id: 'synthetic-question', status: 'pending', kind: 'decision' },
    ] }
    const tree = render('today-language', () => TodayView({ snap, onSelectItem() {}, onOpenTown() {} }))
    const rows = nodes(tree).filter(n => n.props.d?.kind === 'permission' || n.props.d?.kind === 'decision')
    const labels = rows.map((row, index) => render(`decide-${index}`, () => (row.type as (props: any) => Node)(row.props)))
    expect(labels.some(row => button(row, '已在原会话处理'))).toBe(true)
    expect(labels.some(row => button(row, '已在原会话回答'))).toBe(true)
    const review = nodes(tree).find(n => n.props.onRecorded)!
    const reviewTree = render('language-review', () => (review.type as (props: any) => Node)(review.props))
    expect(button(reviewTree, '验收并完成')).toBeDefined()
  })

  it.each([
    ['退回修改', 'in_progress', '已记录需修改，请回原会话说明要求。'],
    ['验收并完成', 'done', '已验收并完成此工作项。'],
  ] as const)('详情%s同步防重；新状态移除交付卡后仍有准确回执和原交付', async (label, status, message) => {
    let snap = reviewSnap()
    const draw = () => render('detail', () => ItemDetail({ snap, id: 'SYN-12', onClose() {}, onSelectSession() {} }))
    let tree = draw(), pending = deferred()
    vi.mocked(api.patchItem).mockReturnValueOnce(pending.promise)
    const click = button(tree, label).props.onClick
    const request = click(); click()
    expect(api.patchItem).toHaveBeenCalledExactlyOnceWith('SYN-12', { status })
    snap = { ...snap, work_items: [{ ...snap.work_items![0], status, brief: undefined }] }
    tree = draw()
    expect(nodes(tree).some(n => n.type === DeliveryReview)).toBe(false)
    pending.resolve({}); await request; tree = draw()
    const receipt = nodes(tree).find(n => n.type === DeliveryActionReceipt)!
    expect(receipt.props.receipt.item.status).toBe('review')
    host.begin('receipt')
    const html = renderToStaticMarkup(receipt)
    expect(html).toContain(message)
    expect(html).toContain('查看上一轮交付与来源')
    expect(html).toContain('排序修复已提交')
    expect(html).not.toContain('已通知')
    expect(api.launchManaged).not.toHaveBeenCalled()
  })

  it('今日页回执属于父页面，交付行随快照卸载后仍保留；标为看过不验收', async () => {
    let snap = reviewSnap()
    const draw = () => render('today', () => TodayView({ snap, onSelectItem() {}, onOpenTown() {} }))
    let tree = draw()
    const row = nodes(tree).find(n => n.props.onRecorded && n.props.r.item.id === 'SYN-12')!
    const rowTree = render('review-row', () => (row.type as (props: any) => Node)(row.props))
    vi.mocked(api.patchItem).mockResolvedValueOnce({})
    await button(rowTree, '退回修改').props.onClick()
    host.unmount('review-row')
    snap = { ...snap, work_items: [{ ...snap.work_items![0], status: 'in_progress', brief: undefined }] }
    tree = draw()
    expect(nodes(tree).some(n => n.props.onRecorded)).toBe(false)
    const receipt = nodes(tree).find(n => n.type === DeliveryActionReceipt)!
    expect(receipt.props.receipt.item.id).toBe('SYN-12')
    expect(receipt.props.receipt.status).toBe('in_progress')
    button(tree, '全部标为看过').props.onClick(); tree = draw()
    expect(feedback(tree).some(n => words(n).includes('仅更新“新”提示。工作状态和验收结果保留原样'))).toBe(true)
    expect(api.patchItem).toHaveBeenCalledTimes(1)
  })

  it('处理失败保留交付行并就地解释，不生成成功回执', async () => {
    const snap = reviewSnap()
    const draw = () => render('today', () => TodayView({ snap, onSelectItem() {}, onOpenTown() {} }))
    const row = nodes(draw()).find(n => n.props.onRecorded)!
    const drawRow = () => render('review-row', () => (row.type as (props: any) => Node)(row.props))
    vi.mocked(api.patchItem).mockRejectedValueOnce(new Error('synthetic return failure'))
    await button(drawRow(), '退回修改').props.onClick()
    expect(feedback(draw()).some(n => n.props.tone === 'error' && words(n).includes('未确认这次交付处理成功'))).toBe(true)
    expect(nodes(draw()).some(n => n.type === DeliveryActionReceipt)).toBe(false)
    expect(nodes(draw()).some(n => n.props.onRecorded)).toBe(true)
  })

  it('刷新先移除交付行、随后请求结果未知时，失败提示也保留在父页面', async () => {
    let snap = reviewSnap()
    const draw = () => render('today', () => TodayView({ snap, onSelectItem() {}, onOpenTown() {} }))
    const row = nodes(draw()).find(n => n.props.onRecorded)!
    const rowTree = render('review-row', () => (row.type as (props: any) => Node)(row.props))
    const pending = deferred()
    vi.mocked(api.patchItem).mockReturnValueOnce(pending.promise)
    const request = button(rowTree, '退回修改').props.onClick()
    snap = { ...snap, work_items: [{ ...snap.work_items![0], status: 'in_progress' }] }
    host.unmount('review-row'); draw()
    pending.reject(new Error('synthetic response unknown')); await request
    const tree = draw()
    expect(feedback(tree).some(n => words(n).includes('SYN-12') && words(n).includes('synthetic response unknown'))).toBe(true)
    expect(nodes(tree).some(n => n.type === DeliveryActionReceipt)).toBe(false)
  })
})

describe('持久内联反馈的可访问语义', () => {
  it.each(['success', 'warning', 'error'] as const)('%s提供文字和对应播报角色', tone => {
    const html = renderToStaticMarkup(<ActionFeedback tone={tone}>合成操作对象 SYN-99 的具体结果</ActionFeedback>)
    expect(html).toContain(tone === 'error' ? 'role="alert"' : 'role="status"')
    expect(html).toContain('合成操作对象 SYN-99 的具体结果')
  })
})
