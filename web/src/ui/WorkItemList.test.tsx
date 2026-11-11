import type { ReactElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Group } from '../model'
import type { WorkItem } from '../types'

const host = vi.hoisted(() => {
  let value: unknown
  return {
    reset() { value = undefined },
    state(initial: unknown) {
      if (value === undefined) value = initial
      return [value, (next: unknown) => { value = next }]
    },
  }
})
vi.mock('react', async original => ({ ...await original<typeof import('react')>(), useState: host.state }))
import { WorkItemList } from './WorkItemList'

type Node = ReactElement<any>
type Props = Parameters<typeof WorkItemList>[0]
const nodes = (node: any): Node[] => Array.isArray(node) ? node.flatMap(nodes) : node?.props ? [node, ...nodes(node.props.children)] : []
const children = (node: Node) => nodes(node.props.children).filter(child => child.type === 'tr' || child.type === 'li')
const item = (id: string, status: WorkItem['status'], day: number): WorkItem => ({
  id, title: `合成任务 ${id}`, repo_id: 1, status, acceptance: '', branch: '', merge_state: 'none', needs_merge: false,
  created_at: '2026-11-01T00:00:00Z', updated_at: `2026-11-0${day}T00:00:00Z`, ready: true, waiting: [], agents: [],
})
const groups: Group[] = [
  { key: 'repo:1', repoId: 1, name: '合成项目一', sessions: [], items: [item('Z-1', 'blocked', 1), item('A-2', 'review', 3), item('D-4', 'todo', 4), item('E-5', 'done', 6)] },
  { key: 'repo:2', repoId: 2, name: '合成项目二', sessions: [], items: [item('B-3', 'in_progress', 5), item('C-6', 'blocked', 8), item('F-7', 'abandoned', 2), item('G-8', 'review', 7)] },
]
const render = (extra: Partial<Props> = {}) => WorkItemList({ groups, onSelect() {}, ...extra })
const rows = (tree: Node) => children(nodes(tree).find(node => node.type === 'tbody')!)
const cards = (tree: Node) => children(nodes(tree).find(node => node.type === 'ul')!)
const ids = (list: Node[]) => list.map(node => node.key)
const bothOrders = (tree: Node, expected: string[]) => {
  expect(ids(rows(tree))).toEqual(expected)
  expect(ids(cards(tree))).toEqual(expected)
}
beforeEach(() => host.reset())

describe('工作列表的桌面与手机视图共用真实数据和排序', () => {
  it('保留阻塞→交付→执行→待开始→已处理→放弃优先级，同状态按新旧排列', () => {
    bothOrders(render(), ['C-6', 'Z-1', 'G-8', 'A-2', 'B-3', 'D-4', 'E-5', 'F-7'])
    expect(groups[0].items.map(item => item.id)).toEqual(['Z-1', 'A-2', 'D-4', 'E-5'])
    expect(groups[1].items.map(item => item.id)).toEqual(['B-3', 'C-6', 'F-7', 'G-8'])
  })

  it('一个排序控制同时改变表格和卡片，切换不会改变输入记录', () => {
    const select = () => nodes(render()).find(node => node.type === 'select')!
    select().props.onChange({ target: { value: 'updated' } })
    bothOrders(render(), ['C-6', 'G-8', 'E-5', 'B-3', 'D-4', 'A-2', 'F-7', 'Z-1'])
    expect(select().props.value).toBe('updated')
    select().props.onChange({ target: { value: 'id' } })
    bothOrders(render(), ['A-2', 'B-3', 'C-6', 'D-4', 'E-5', 'F-7', 'G-8', 'Z-1'])
    expect(select().props.value).toBe('id')
  })

  it('桌面保留六列，仅标题按钮可打开详情，不给整行增加重复Tab入口', () => {
    const onSelect = vi.fn(), tree = render({ onSelect })
    expect(nodes(tree).filter(node => node.type === 'th').map(node => node.props.children)).toEqual(['编号', '标题', '项目', '状态', 'Agent', '依赖'])
    for (const row of rows(tree)) {
      expect(row.props.tabIndex).toBeUndefined()
      expect(row.props.onClick).toBeUndefined()
      expect(nodes(row).filter(node => node.type === 'button')).toHaveLength(1)
    }
    const button = nodes(rows(tree)[0]).find(node => node.type === 'button')!
    expect(button.props.type).toBe('button')
    expect(button.props['aria-label']).toContain('C-6')
    button.props.onClick()
    expect(onSelect).toHaveBeenCalledExactlyOnceWith('C-6')
  })

  it('手机先呈现标题、状态和项目，次级信息在原生可展开区，标题打开同一工作项', () => {
    const onSelect = vi.fn(), tree = render({ onSelect }), card = cards(tree)[0]
    const button = nodes(card).find(node => node.type === 'button')!
    button.props.onClick()
    expect(onSelect).toHaveBeenCalledExactlyOnceWith('C-6')
    expect(nodes(card).find(node => node.type === 'h2')).toBeDefined()
    expect(nodes(card).find(node => node.props.className === 'work-item-card-project')!.props.children).toContain('合成项目二')
    expect(nodes(card).find(node => node.type === 'summary')!.props.children).toBe('编号、Agent 与依赖')
    expect(nodes(card).find(node => node.type === 'details')!.props.open).toBeUndefined()
  })

  it('完整保留长标题/项目名、Agent与等待依赖，不把等待说成完成或失败', () => {
    const title = '合成的很长工作标题'.repeat(20), repo = '合成的独立项目目录/'.repeat(20)
    const blocked = { ...item('LONG-1', 'blocked', 1), title, ready: false, waiting: ['UP-1', 'UP-2'], agents: ['claude', 'codex', '合成Agent'] }
    const html = renderToStaticMarkup(render({ groups: [{ key: 'long', repoId: 1, name: repo, items: [blocked], sessions: [] }] }))
    expect(html).toContain(title)
    expect(html).toContain(repo)
    expect(html).toContain('Claude · Codex · 合成Agent')
    expect(html).toContain('等待 UP-1、UP-2')
    expect(html).toContain('阻塞')
    expect(html).not.toContain('已完成')
    expect(html).not.toContain('读取失败')
  })
})

describe('工作列表空态给出准确的恢复入口', () => {
  it('筛选无匹配时可清除筛选，也可打开工作项面板', () => {
    const onClearFilters = vi.fn(), onOpenWorkItems = vi.fn()
    const tree = render({ groups: [], filtered: true, onClearFilters, onOpenWorkItems })
    const html = renderToStaticMarkup(tree)
    expect(html).toContain('没有匹配的工作项')
    expect(html).not.toContain('<table')
    const buttons = nodes(tree).filter(node => node.type === 'button')
    expect(buttons.map(node => node.props.children)).toEqual(['清除筛选', '打开工作项面板'])
    buttons.forEach(button => button.props.onClick())
    expect(onClearFilters).toHaveBeenCalledOnce()
    expect(onOpenWorkItems).toHaveBeenCalledOnce()
  })

  it('当前没有可显示工作时不误称筛选或读取失败，不显示无效清除动作', () => {
    const onClearFilters = vi.fn(), onOpenWorkItems = vi.fn()
    const tree = render({ groups: [], onClearFilters, onOpenWorkItems })
    const html = renderToStaticMarkup(tree)
    expect(html).toContain('当前没有可显示的工作项')
    expect(html).toContain('已处理和历史记录')
    expect(html).not.toContain('没有匹配')
    expect(html).not.toContain('读取失败')
    const buttons = nodes(tree).filter(node => node.type === 'button')
    expect(buttons).toHaveLength(1)
    buttons[0].props.onClick()
    expect(onOpenWorkItems).toHaveBeenCalledOnce()
    expect(onClearFilters).not.toHaveBeenCalled()
  })
})
