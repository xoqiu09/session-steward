import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import TownScene, { buildingTasks, parcelTitle } from './TownScene'
import { buildTown } from './townModel'
import { SessionDetail } from '../Panels'
import { fakeItem, fakeRun, fakeSession } from './fixtures'
import type { Snapshot } from '../types'

const now = '2026-10-26T06:00:00Z'

describe('建筑上的任务标题', () => {
  const items = [
    fakeItem({ id: 'T-1', repo_id: 1, title: '进行中的一项', status: 'in_progress', updated_at: '2026-10-26T05:00:00Z' }),
    fakeItem({ id: 'T-2', repo_id: 1, title: '等你验收的一项', status: 'review' }),
    fakeItem({ id: 'T-3', repo_id: 1, title: '已完成的一项', status: 'done' }),
    fakeItem({ id: 'T-4', repo_id: 1, title: '受阻的一项', status: 'blocked' }),
    fakeItem({ id: 'T-5', repo_id: 1, title: '待开始的一项', status: 'todo' }),
  ]

  it('待验收、受阻排前面，最多两行，其余汇总，已完成不列', () => {
    const t = buildingTasks(items)
    expect(t.lines.map((w) => w.id)).toEqual(['T-2', 'T-4'])
    expect(t.more).toBe(2)
  })

  it('画进招牌上方', () => {
    const snap: Snapshot = { cursor: 1, now, repos: [{ id: 1, name: 'demo-repo', common_dir: '', is_git: true, target_ref: 'main' }], sessions: [], work_items: items, deps: [], runs: [], approvals: [] }
    const html = renderToStaticMarkup(<TownScene model={buildTown(snap, now)} selected={null} highlight={null} onSelect={() => {}} />)
    expect(html).toContain('等你验收的一项')
    expect(html).toContain('受阻的一项')
    expect(html).toContain('>等 2 项<')
    expect(html).not.toContain('已完成的一项')
  })
})

describe('包裹标签', () => {
  const snap: Snapshot = {
    cursor: 1, now, repos: [{ id: 1, name: 'demo-repo', common_dir: '', is_git: true, target_ref: 'main' }],
    sessions: [fakeSession({ id: 1, provider: 'claude', state: 'idle', repo_id: 1 })],
    work_items: [fakeItem({ id: 'AGE-001', repo_id: 1, title: 'Agent 工作小镇一屏视觉候选', status: 'review' })],
    deps: [], runs: [fakeRun({ id: 5, work_item_id: 'AGE-001', session_id: 1, provider: 'claude', ended_at: '2026-10-26T05:00:00Z' })], approvals: [],
  }

  it('编号后跟截短的任务标题', () => {
    const p = buildTown(snap, now).buildings[0].parcels[0]
    expect(parcelTitle(p, 12)).toBe('AGE-001 Agent 工作小镇一…')
  })

  it('验收台上的包裹显示标题', () => {
    const html = renderToStaticMarkup(<TownScene model={buildTown(snap, now)} selected={null} highlight={null} onSelect={() => {}} />)
    expect(html).toContain('AGE-001 Agent 工作小镇一…')
  })
})

describe('桌面模式抽屉里的会话详情', () => {
  const snap: Snapshot = { cursor: 1, now, repos: [], sessions: [fakeSession({ id: 80, provider: 'claude', state: 'idle' })], work_items: [], deps: [], runs: [], approvals: [] }

  it('最近活动默认折叠', () => {
    const html = renderToStaticMarkup(<SessionDetail snap={snap} id={80} onClose={() => {}} onSelectItem={() => {}} foldEvents />)
    expect(html).toContain('<details class="events-fold">')
    expect(html).not.toContain('<h3>最近活动')
  })

  it('完整面板里照旧展开', () => {
    const html = renderToStaticMarkup(<SessionDetail snap={snap} id={80} onClose={() => {}} onSelectItem={() => {}} />)
    expect(html).toContain('<h3>最近活动')
    expect(html).not.toContain('events-fold')
  })
})
