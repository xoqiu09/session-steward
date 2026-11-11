import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, expect, it, vi } from 'vitest'
import type { Snapshot } from './types'

const state = vi.hoisted(() => ({ snap: null as Snapshot | null, conn: 'live' as 'live' | 'offline' }))
vi.mock('./api', async (original) => ({
  ...await original<typeof import('./api')>(),
  useSnapshot: () => ({ snap: state.snap, conn: state.conn, reload: async () => {} }),
}))
import App from './App'

afterEach(() => vi.unstubAllGlobals())

it('同一工作两种陈旧原因保留，顶部和每日统计都只算一件', () => {
  state.conn = 'live'
  vi.stubGlobal('window', { location: { search: '?view=town', hash: '', pathname: '/', hostname: '127.0.0.1', host: '127.0.0.1' } })
  vi.stubGlobal('localStorage', { getItem: () => null, setItem: () => {} })
  const now = '2026-10-30T10:00:00Z', old = '2026-10-30T09:20:00Z'
  state.snap = {
    cursor: 1, now, repos: [{ id: 1, name: '虚构花园', common_dir: '', is_git: true, target_ref: 'main' }],
    sessions: [], approvals: [], deps: [], runs: [],
    work_items: [{ id: 'SIG-1', title: '虚构的单项工作', repo_id: 1, status: 'in_progress', acceptance: '', branch: '', merge_state: 'none', needs_merge: false,
      created_at: old, updated_at: old, ready: true, waiting: [], agents: [], signal: { channel: 'hook', at: old },
      brief: { fields: { progress: { entry_id: 1, text: '合成旧进展', at: old, kind: 'agent', source: 'report', session_id: 1 } }, stale: true, tool_events_since: 25, last_event_at: old } }],
  }
  const html = renderToStaticMarkup(<App />)
  expect(html).toContain('要你处理 1 件')
  expect(html).not.toContain('要你处理 2 件')
  window.location.search = '?view=today'
  const daily = renderToStaticMarkup(<App />)
  expect(daily).toContain('<b class="is-stuck">1</b>')
  expect(daily).toContain('很久没回报进展')
  expect(daily).toContain('40 分钟没有任何信号')
  expect(daily).toContain('信息缺口：')
})

it('首次离线给重试入口；已有快照离线保留内容并显示更新时间', () => {
  vi.stubGlobal('window', { location: { search: '?view=today', hash: '', pathname: '/', hostname: '127.0.0.1', host: '127.0.0.1' } })
  vi.stubGlobal('localStorage', { getItem: () => null, setItem: () => {} })
  state.conn = 'offline'; state.snap = null
  const failed = renderToStaticMarkup(<App />)
  expect(failed).toContain('暂时连不上本机服务')
  expect(failed).toContain('重试</button>')
  expect(failed).not.toContain('加载中…')
  state.snap = { cursor: 2, now: '2026-11-09T06:00:00Z', repos: [], sessions: [], work_items: [], runs: [], deps: [], approvals: [] }
  const retained = renderToStaticMarkup(<App />)
  expect(retained).toContain('连接已中断')
  expect(retained).toContain('的记录，正在重连')
  expect(retained).toContain('每日十分钟')
  expect(retained).toContain('本机全部项目')
  expect(retained).not.toContain('aria-label="项目"')
  expect(retained).not.toContain('aria-label="Agent"')
  expect(retained).not.toContain('aria-label="搜索"')
  expect(retained).toContain('全部标为看过')
  expect(retained).toContain('不会验收或完成任何工作')
})

it('直接打开历史和列表地址时显示相应页面，不退回项目简报', () => {
  state.conn = 'live'
  state.snap = { cursor: 3, now: '2026-11-11T06:00:00Z', repos: [], sessions: [], work_items: [], runs: [], deps: [], approvals: [] }
  vi.stubGlobal('localStorage', { getItem: () => null, setItem: () => {} })
  for (const view of ['history', 'list']) {
    vi.stubGlobal('window', { location: { search: `?view=${view}`, hash: '', pathname: '/', hostname: '127.0.0.1', host: '127.0.0.1' } })
    const html = renderToStaticMarkup(<App />)
    expect(html).toContain(`<button class="on" aria-current="page">${view === 'history' ? '历史' : '列表'}</button>`)
    expect(html).not.toContain('<button class="on">项目简报</button>')
  }
})
