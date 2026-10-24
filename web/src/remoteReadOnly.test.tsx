import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { api } from './api'
import { PermissionCard } from './Queue'
import { ItemDetail, WorkItemsPanel } from './Panels'
import { AttributionPanel } from './AttributionPanel'
import type { Approval, Snapshot, WorkItem } from './types'

const at = '2026-10-23T00:00:00Z'
const item: WorkItem = { id: 'SYN-1', repo_id: 1, title: 'Synthetic task', status: 'review', acceptance: 'Synthetic acceptance', branch: '', merge_state: 'none', needs_merge: false, created_at: at, updated_at: at, ready: true, waiting: [], agents: [] }
const snap: Snapshot = { cursor: 1, now: at, repos: [], sessions: [], work_items: [item], deps: [], runs: [], approvals: [] }
const approval = { id: 'permission', kind: 'permission', status: 'pending', work_item_id: item.id, session_id: null, handleable: true, preview: 'printf synthetic', created_at: at, payload: {} } as Approval
const remote = () => vi.stubGlobal('window', { location: { protocol: 'https:', hostname: 'mac.tailnet-synthetic.ts.net' } })
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks() })

describe('remote read-only controls', () => {
  it('keeps pending request content but sends approvals back to the local panel', () => {
    remote()
    const html = renderToStaticMarkup(<PermissionCard snap={snap} a={approval} />)
    expect(html).toContain('printf synthetic')
    expect(html).toContain('远程只读')
    expect(html).not.toContain('>允许本次<')
    expect(html).not.toContain('>拒绝<')
  })
  it('keeps local approval buttons available', () => {
    const html = renderToStaticMarkup(<PermissionCard snap={snap} a={approval} />)
    expect(html).toContain('>允许本次<')
    expect(html).toContain('>拒绝<')
  })
  it('hides work item writes while retaining read navigation', () => {
    remote()
    const html = renderToStaticMarkup(<ItemDetail snap={snap} id={item.id} onClose={() => {}} onSelectSession={() => {}} />)
    expect(html).toContain('Synthetic acceptance')
    expect(html).not.toContain('>验收通过<')
    expect(html).not.toContain('>修改标题 / 项目<')
    expect(html).not.toContain('aria-label="上游编号"')
    expect(html).toMatch(/<button(?![^>]*disabled)[^>]*aria-label="关闭运行台"/)
    const list = renderToStaticMarkup(<WorkItemsPanel snap={snap} items={[item]} repoId="all" onSelect={() => {}} />)
    expect(list).toMatch(/<button[^>]*disabled=""[^>]*>新建工作项<\/button>/)
    expect(list).toMatch(/<button(?![^>]*disabled)[^>]*class="session-entry"/)
  })
  it('keeps attribution viewing available but disables reconciliation', () => {
    remote()
    const html = renderToStaticMarkup(<AttributionPanel snap={snap} repoId="all" provider="all" onClose={() => {}} onSelectItem={() => {}} />)
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>立即整理<\/button>/)
    expect(html).toContain('aria-label="归属查看范围"')
    expect(html).toMatch(/<button(?![^>]*disabled)[^>]*>按线索分组<\/button>/)
  })
  it('rejects a direct client mutation before contacting the server', async () => {
    remote()
    const fetch = vi.fn()
    vi.stubGlobal('fetch', fetch)
    await expect(api.decide('synthetic', 'fingerprint', 'allow')).rejects.toMatchObject({ status: 403, message: expect.stringContaining('远程只读') })
    await expect(api.patchItem('SYN-1', { status: 'done' })).rejects.toMatchObject({ status: 403 })
    expect(fetch).not.toHaveBeenCalled()
  })
  it('continues to fetch remote snapshots', async () => {
    remote()
    const fetch = vi.fn().mockResolvedValue({ ok: true, text: async () => JSON.stringify(snap) })
    vi.stubGlobal('fetch', fetch)
    expect(await api.snapshot()).toEqual(snap)
    expect(fetch).toHaveBeenCalledWith('/api/snapshot', expect.objectContaining({ method: 'GET' }))
  })
})
