import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { InteriorScene, benchItems, benchSpot, interiorViewBox, roomSize } from './InteriorScene'
import { interiorVisitorPoint } from './residentTrips'
import { storyLounge } from './storybook'
import { houseInfo } from './houseInfo'
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

  it('默认概况只显示本项目统计和阅读入口，工作台仍可使用', () => {
    const html = render([
      feature({ id: 'f1', repo_id: 1, title: '导入账单', implementation: 'implemented', validation: 'passed', acceptance: '导入 3 个样例文件无报错' }),
      feature({ id: 'f2', repo_id: 1, title: '分类规则', implementation: 'implementing', contributions: [
        { id: 'k', candidate: '', session_id: 7, run_id: 1, work_item_id: 'W-1', provider: 'claude', at: now, active: true, blocker: '缺少样例文件' },
      ] }),
      feature({ id: 'f3', repo_id: 1, title: '多币种', implementation: 'not_started' }),
      feature({ id: 'x', repo_id: 2, title: '别的项目的功能' }),
    ])
    expect(html).toContain('aria-label="demo-repo 项目结构"')
    for (const t of ['3 项功能', '你已确认 0 · Agent 自报通过 1（未经你确认）', '项目概况', '功能地图', '当前推进', '验证依据']) expect(html).toContain(t)
    expect(html).not.toContain('别的项目的功能')
    expect(html).toContain('工作项 W-1 正在做')
    // 面板必须在 SVG 之外，原生 WebKit 的滚动合成不再经过 foreignObject 坐标系。
    expect(html).not.toContain('<foreignObject')
    expect(html).toMatch(/<\/svg><\/div><section class="town-house-features town-project-room"/)
    expect(html).toContain(`viewBox="${interiorViewBox(roomSize(b))}"`)
  })

  it('没有功能时显示空状态文字', () => {
    for (const f of [[], null]) expect(render(f)).toContain('目标、用途和功能关系尚未整理。已有任务和功能回报仍可查看。')
  })

  it('不传 features 时不画面板，视野不变', () => {
    const html = render()
    expect(html).not.toContain('核心功能')
    expect(html).toContain(`viewBox="${interiorViewBox(roomSize(b))}"`)
  })
  it('长清单完整留在功能地图的数据中，首屏不堆叠功能，只有一处独立 HTML 面板', () => {
    const input = Array.from({ length: 36 }, (_, i) => feature({ id: `f-${i}`, repo_id: 1, title: `合成功能 ${i + 1}` }))
    const html = render(input)
    expect(houseInfo(b, input).sections.flatMap(s => s.items)).toHaveLength(36)
    expect(html).toContain('36 项功能')
    expect(html).not.toContain('合成功能 1')
    expect(html.match(/aria-label="demo-repo 项目结构"/g)).toHaveLength(1)
    expect(html.match(/role="tab"/g)).toHaveLength(4)
    expect(html).not.toContain('<foreignObject')
    expect(html).not.toMatch(/<form|<input|保存目录|派活/)
  })
})

describe('项目室内 · 房间随工作量伸缩', () => {
  const build = (n: number, name = 'demo-repo') => buildTown({
    ...snap, repos: [{ ...snap.repos![0], name }], approvals: [], runs: [],
    sessions: [fakeSession({ id: 7, provider: 'claude', state: 'idle', repo_id: 1 })],
    work_items: Array.from({ length: n }, (_, i) => fakeItem({ id: `S-${i}`, repo_id: 1, title: `合成 ${i}`, status: 'todo' })),
  }, now)

  it('三排工作台时仍是原来的 16×12，视野不变', () => {
    expect(roomSize(build(9).buildings[0])).toEqual({ w: 16, d: 12 })
    expect(interiorViewBox(roomSize(build(9).buildings[0]))).toBe(interiorViewBox())
  })

  it('一两张台子时房间变浅变窄，排数越多越深', () => {
    const one = roomSize(build(1).buildings[0]), three = roomSize(build(3).buildings[0]), six = roomSize(build(6).buildings[0])
    expect(one.d).toBeLessThan(8)
    expect(one.w).toBeLessThan(16)
    expect(three).toEqual({ w: 16, d: one.d })
    expect(six.d).toBeGreaterThan(one.d)
    expect(six.d).toBeLessThan(12)
    expect(roomSize(build(0).buildings[0]).d).toBe(one.d)
  })

  it('长项目名时房间加宽，后墙放得下横幅和白板', () => {
    expect(roomSize(build(1, '一个名字特别特别长的合成示例项目名称').buildings[0]).w).toBeGreaterThan(roomSize(build(1, 'ab').buildings[0]).w)
  })

  it('台子、站在台前的人、过道上的来访居民和茶歇角都落在缩小后的房间里', () => {
    for (const n of [0, 1, 2, 3, 4, 7]) {
      const b = build(n).buildings[0], room = roomSize(b)
      for (let i = 0; i < benchItems(b).shown.length; i++) {
        const s = benchSpot(i)
        expect(s.gx + 3).toBeLessThanOrEqual(room.w)
        expect(s.gy + 1.1 + 0.9 + 0.6).toBeLessThanOrEqual(room.d)
      }
      for (const id of ['claude', 'qwen', 'glm'] as const) for (const ms of [0, 6500, 13000, 19500, 26000]) {
        const p = interiorVisitorPoint({ insideMs: ms } as never, id as never, room)
        expect(p.x).toBeGreaterThan(0); expect(p.x).toBeLessThan(room.w)
        expect(p.y).toBeGreaterThan(0); expect(p.y).toBeLessThan(room.d)
      }
      const lounge = storyLounge(Array.from({ length: benchItems(b).shown.length }, (_, i) => ({ ...benchSpot(i), w: 3, d: 2.4 })), room)
      if (lounge) { expect(lounge.gx + lounge.w).toBeLessThanOrEqual(room.w); expect(lounge.gy + lounge.d).toBeLessThanOrEqual(room.d) }
    }
  })

  it('房间缩小后画面用新的视野，只画放得下的窗户', () => {
    const b = build(1).buildings[0], room = roomSize(b)
    const html = renderToStaticMarkup(<InteriorScene b={b} model={build(1)} selected={null} highlight={null} onSelect={() => {}} />)
    expect(html).toContain(`viewBox="${interiorViewBox(room)}"`)
    const full = renderToStaticMarkup(<InteriorScene b={build(9).buildings[0]} model={build(9)} selected={null} highlight={null} onSelect={() => {}} />)
    expect((html.match(/fill="#cfe6f2"/g) ?? []).length).toBeLessThan((full.match(/fill="#cfe6f2"/g) ?? []).length)
  })
})
