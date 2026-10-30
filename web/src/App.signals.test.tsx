import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, expect, it, vi } from 'vitest'
import type { Snapshot } from './types'

const state = vi.hoisted(() => ({ snap: null as Snapshot | null }))
vi.mock('./api', async (original) => ({
  ...await original<typeof import('./api')>(),
  useSnapshot: () => ({ snap: state.snap, conn: 'live' }),
}))
import App from './App'

afterEach(() => vi.unstubAllGlobals())

it('同一工作两种陈旧原因保留，顶部和每日统计都只算一件', () => {
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
