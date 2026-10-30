import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { TownView, townSlice } from './TownView'
import { fakeApproval, fakeItem, fakeRun, fakeSession } from './fixtures'
import type { Snapshot } from '../types'

const now = '2026-10-26T06:00:00Z'
const snap: Snapshot = {
  cursor: 9,
  now,
  repos: [{ id: 1, name: 'demo-repo', common_dir: '', is_git: true, target_ref: 'main' }],
  sessions: [
    fakeSession({ id: 1, provider: 'claude', state: 'running', repo_id: 1, work_item_id: 'D-1', last_activity_at: '2026-10-26T05:58:00Z' }),
    fakeSession({ id: 2, provider: 'codex', state: 'ended', repo_id: 1, work_item_id: 'D-2' }),
    fakeSession({ id: 3, provider: 'claude', state: 'unknown', repo_id: 1, data_source: 'history', freshness: 'history' }),
  ],
  work_items: [
    fakeItem({ id: 'D-1', repo_id: 1, title: '进行中的任务', status: 'in_progress' }),
    fakeItem({ id: 'D-2', repo_id: 1, title: '待验收的任务', status: 'review' }),
  ],
  deps: [],
  runs: [
    fakeRun({ id: 10, work_item_id: 'D-1', session_id: 1, provider: 'claude' }),
    fakeRun({ id: 11, work_item_id: 'D-2', session_id: 2, provider: 'codex', ended_at: '2026-10-26T05:00:00Z', outcome: '' }),
    fakeRun({ id: 12, work_item_id: 'D-2', session_id: 2, provider: 'codex', ended_at: '2026-10-26T05:30:00Z', outcome: '' }),
    fakeRun({ id: 13, work_item_id: 'D-1', session_id: 1, provider: 'claude', ended_at: '2026-10-24T05:30:00Z', outcome: 'failed' }),
    fakeRun({ id: 14, work_item_id: 'D-1', session_id: 1, provider: 'claude', ended_at: '2026-10-26T05:40:00Z', outcome: 'failed' }),
    fakeRun({ id: 15, work_item_id: 'D-2', session_id: 2, provider: 'codex', ended_at: '2026-10-26T05:50:00Z', outcome: 'attribution_reverted' }),
  ],
  approvals: [
    fakeApproval({ id: 'A-live', kind: 'permission', status: 'pending', session_id: 1, work_item_id: 'D-1', repo_id: 1, preview: 'npm test' }),
    fakeApproval({ id: 'A-late', kind: 'permission', status: 'pending', session_id: 1, work_item_id: 'D-1', repo_id: 1, deadline: '2026-10-26T05:00:00Z' }),
    fakeApproval({ id: 'A-low', kind: 'attention', status: 'pending', session_id: 1, work_item_id: 'D-1', repo_id: 1 }),
  ],
}

describe('townSlice', () => {
  const s = townSlice(snap, 'all', 'all')

  it('只放近期的 live 会话，结束和历史会话不上画面', () => {
    expect(s.sessions!.map(x => x.id)).toEqual([1])
  })

  it('告示栏与关注队列同口径：过期权限和低置信提醒不算', () => {
    expect(s.approvals!.map(a => a.id)).toEqual(['A-live'])
  })

  it('验收台按待验收工作项取最近一次已结束运行，不依赖 outcome，也不取已撤销的归属', () => {
    expect(s.runs!.filter(r => r.work_item_id === 'D-2').map(r => r.id)).toEqual([12])
  })

  it('失败只取近一天的', () => {
    const failed = s.runs!.filter(r => r.outcome === 'failed').map(r => r.id)
    expect(failed).toEqual([14])
  })

  it('未结束的运行跟着近期会话', () => {
    expect(s.runs!.some(r => r.id === 10)).toBe(true)
  })
})

describe('TownView', () => {
  const render = (conn: 'live' | 'offline') => renderToStaticMarkup(
    <TownView snap={snap} conn={conn} repoId="all" provider="all" sel={null} onSelectItem={() => {}} onSelectSession={() => {}} onSelectRepo={() => {}} onQueue={() => {}} />)

  it('画出项目、会话和状态条', () => {
    const html = render('live')
    expect(html).toContain('demo-repo')
    expect(html).toContain('Claude #1')
    expect(html).toContain('等你决定')
    expect(html).not.toContain('连接中断')
  })

  it('断线时提示画面停住，并把“工作中”改称断线前', () => {
    const html = render('offline')
    expect(html).toContain('连接中断')
    expect(html).toContain('断线前工作中')
  })
})

describe('TownView 分页与版式', () => {
  const extra = [4, 5, 6, 7].map((id) => ({ id, name: `extra-${id}`, common_dir: '', is_git: true, target_ref: 'main' }))
  const many: Snapshot = {
    ...snap,
    repos: [...snap.repos!, ...extra],
    sessions: [...snap.sessions!, ...extra.map((r) => fakeSession({ id: r.id * 10, provider: 'codex', state: 'running', repo_id: r.id, last_activity_at: '2026-10-26T05:58:00Z' }))],
    approvals: [...snap.approvals!, fakeApproval({ id: 'A-7', kind: 'decision', status: 'pending', session_id: 70, repo_id: 7, preview: '选哪个模板？' })],
  }
  const render = (props: { kiosk?: boolean; layout?: 'wide' | 'portrait' } = {}) => renderToStaticMarkup(
    <TownView snap={many} conn="live" repoId="all" provider="all" sel={null} onSelectItem={() => {}} onSelectSession={() => {}} onSelectRepo={() => {}} onQueue={() => {}} {...props} />)
  const buildings = (html: string) => [...html.matchAll(/项目建筑 ([\w-]+)：/g)].map((m) => m[1])

  it('项目多于三栋时分页，等你处理的项目排在第一页最前面，不再提示去列表视图', () => {
    const html = render({ layout: 'wide' })
    expect(html).toContain('town-pager')
    expect(html).toContain('1/3 · 5 个项目')
    expect(html).not.toContain('另有')
    expect(buildings(html)).toEqual(['demo-repo', 'extra-7', 'extra-4'])
  })

  it('竖屏一页一栋，标签用竖屏版式', () => {
    const html = render({ layout: 'portrait' })
    expect(html).toContain('town-svg is-portrait')
    expect(html).toContain('1/5 · 5 个项目')
    expect(buildings(html)).toEqual(['demo-repo'])
  })

  it('桌面模式带上 is-kiosk，并且仍是只读场景：没有批准或验收按钮', () => {
    const html = render({ kiosk: true, layout: 'wide' })
    expect(html).toContain('town-view is-kiosk')
    expect(html).not.toMatch(/允许本次|批准合并|标记完成/)
  })

  it('只有一页时不显示分页', () => {
    expect(renderToStaticMarkup(<TownView snap={snap} conn="live" repoId="all" provider="all" sel={null} layout="wide"
      onSelectItem={() => {}} onSelectSession={() => {}} onSelectRepo={() => {}} onQueue={() => {}} />)).not.toContain('town-pager')
  })

  it('窄屏即使指定世界地图仍然分页，一页一个项目，不挂载自动跟随', () => {
    const html = renderToStaticMarkup(<TownView snap={many} conn="live" repoId="all" provider="all" sel={null} layout="portrait" world
      onSelectItem={() => {}} onSelectSession={() => {}} onSelectRepo={() => {}} onQueue={() => {}} />)
    expect(html).toContain('town-svg is-portrait')
    expect(html).toContain('town-pager')
    expect(html).toContain('1/5 · 5 个项目')
    expect(html).not.toContain('class="town-world')
    expect(html).not.toContain('项目新动态')
  })
})

describe('TownView 只看一个项目', () => {
  const render = (repoId: number | 'all', world = false) => renderToStaticMarkup(
    <TownView snap={snap} conn="live" repoId={repoId} provider="all" sel={null} layout="wide" world={world}
      onSelectItem={() => {}} onSelectSession={() => {}} onSelectRepo={() => {}} onAllRepos={() => {}} onQueue={() => {}} />)

  it('筛到一个项目时，工作室和世界地图都写明只看哪个项目，并能一键显示全部', () => {
    for (const world of [false, true]) {
      const html = render(1, world)
      expect(html).toContain('只看「demo-repo」')
      expect(html).toContain('显示全部项目')
    }
  })

  it('看全部项目时不显示', () => {
    expect(render('all')).not.toContain('town-scope')
    expect(render('all', true)).not.toContain('town-scope')
  })
})
