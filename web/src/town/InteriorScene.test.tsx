import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { InteriorScene, benchItems, benchSpot, interiorViewBox } from './InteriorScene'
import { buildTown } from './townModel'
import { fakeApproval, fakeItem, fakeRun, fakeSession } from './fixtures'
import type { ProjectFeature, Snapshot } from '../types'

const now = '2026-10-26T06:00:00Z'
const items = [
  ...Array.from({ length: 10 }, (_, i) => fakeItem({ id: `T-${i}`, repo_id: 1, title: `待办 ${i}`, status: 'todo' })),
  fakeItem({ id: 'R-1', repo_id: 1, title: '等你验收', status: 'review' }),
  fakeItem({ id: 'B-1', repo_id: 1, title: '卡住了', status: 'blocked' }),
  fakeItem({ id: 'W-1', repo_id: 1, title: '正在做', status: 'in_progress' }),
  fakeItem({ id: 'D-1', repo_id: 1, title: '做完了', status: 'done' }),
]
const snap: Snapshot = {
  cursor: 1, now, repos: [{ id: 1, name: 'demo-repo', common_dir: '', is_git: true, target_ref: 'main' }],
  sessions: [fakeSession({ id: 7, provider: 'claude', state: 'running', repo_id: 1, work_item_id: 'W-1', last_activity_at: now })],
  work_items: items, deps: [],
  runs: [fakeRun({ id: 1, work_item_id: 'W-1', session_id: 7, provider: 'claude' }), fakeRun({ id: 2, work_item_id: 'R-1', session_id: 7, provider: 'claude', ended_at: now })],
  approvals: [fakeApproval({ id: 'A-1', kind: 'decision', status: 'pending', repo_id: 1, session_id: 7, preview: '选 A 还是 B？' })],
}

describe('项目室内', () => {
  const model = buildTown(snap, now)
  const b = model.buildings[0]

  it('待验收、受阻先上工作台，最多 9 张，已完成不上台，其余计数', () => {
    const { shown, more } = benchItems(b)
    expect(shown.slice(0, 3).map((w) => w.id)).toEqual(['R-1', 'B-1', 'W-1'])
    expect(shown).toHaveLength(9)
    expect(more).toBe(4)
    expect(shown.some((w) => w.id === 'D-1')).toBe(false)
  })

  it('工作台互不重叠', () => {
    const spots = Array.from({ length: 9 }, (_, i) => benchSpot(i))
    for (let i = 0; i < spots.length; i++) for (let j = i + 1; j < spots.length; j++) {
      const a = spots[i], c = spots[j]
      expect(Math.abs(a.gx - c.gx) >= 3 || Math.abs(a.gy - c.gy) >= 1.1).toBe(true)
    }
  })

  it('画出工作台、站在自己台前的会话、白板上的待决定和溢出提示', () => {
    const html = renderToStaticMarkup(<InteriorScene b={b} model={model} selected={null} highlight={null} onSelect={() => {}} />)
    expect(html).toContain('工作项 W-1 正在做')
    expect(html).toContain('Claude #7')
    expect(html).toContain('等你决定 · 1')
    expect(html).toContain('选 A 还是 B？')
    expect(html).toContain('还有 4 项未摆上工作台')
    expect(html).not.toMatch(/允许本次|已处理|标记完成/)
  })
})

describe('项目室内 · 核心功能面板', () => {
  const model = buildTown(snap, now)
  const b = model.buildings[0]
  const feature = (p: Partial<ProjectFeature> & Pick<ProjectFeature, 'id' | 'title' | 'repo_id'>): ProjectFeature => ({
    acceptance: '', scope_basis: '', scope_status: 'documented', scope_version: '1', candidate: '', revision: '', implementation: 'unknown', validation: 'unknown',
    conflict: false, stale: false, accepted: false, work_item_ids: [], contributions: [], ...p,
  })
  const render = (features?: ProjectFeature[] | null) =>
    renderToStaticMarkup(<InteriorScene b={b} model={model} selected={null} highlight={null} onSelect={() => {}} features={features} />)

  it('有功能时列出本项目所有功能的名称、状态、验收标准和卡点', () => {
    const html = render([
      feature({ id: 'f1', repo_id: 1, title: '导入账单', implementation: 'implemented', validation: 'passed', acceptance: '导入 3 个样例文件无报错' }),
      feature({ id: 'f2', repo_id: 1, title: '分类规则', implementation: 'implementing', contributions: [
        { id: 'k', candidate: '', session_id: 7, run_id: 1, work_item_id: 'W-1', provider: 'claude', at: now, active: true, blocker: '缺少样例文件' },
      ] }),
      feature({ id: 'f3', repo_id: 1, title: '多币种', implementation: 'not_started' }),
      feature({ id: 'x', repo_id: 2, title: '别的项目的功能' }),
    ])
    expect(html).toContain('aria-label="核心功能"')
    for (const t of ['导入账单', '分类规则', '多币种', '已实现 · Agent 报验证通过', '开发中', '未开始', '导入 3 个样例文件无报错', '卡点：缺少样例文件', '已完成 1 · 开发中 1 · 未开始 1']) expect(html).toContain(t)
    expect(html).not.toContain('别的项目的功能')
    expect(html).toContain('工作项 W-1 正在做')
  })

  it('没有功能时显示空状态文字', () => {
    for (const f of [[], null]) expect(render(f)).toContain('还没登记核心功能：Agent 用 steward-hook features 回报后会出现在这里')
  })

  it('不传 features 时不画面板，视野不变', () => {
    const html = render()
    expect(html).not.toContain('核心功能')
    expect(html).toContain(`viewBox="${interiorViewBox()}"`)
  })
})
