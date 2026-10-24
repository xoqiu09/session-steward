import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { HandoffForm, ItemUsageLine, MergeGate } from './P1'
import type { Approval, MergeJob, Snapshot, WorkItem } from './types'

const at = '2026-10-20T00:00:00Z'
const base: Snapshot = { cursor: 1, now: at, repos: [{ id: 1, name: 'synthetic', common_dir: '/r/.git', is_git: true, target_ref: 'main' }], sessions: [], work_items: [], deps: [], runs: [], approvals: [] }
const approval = { id: 'm1', kind: 'merge', status: 'decided', repo_id: 1, work_item_id: 'SYN-1', payload: {} } as unknown as Approval
const job = (extra: Partial<MergeJob>): MergeJob => ({ id: 'mj', approval_id: 'm1', work_item_id: 'SYN-1', repo_id: 1, source_sha: 's', target_ref: 'main', target_sha: 't', merge_sha: '', state: 'running', checks: [], error: '', created_at: at, updated_at: at, ...extra })
const item: WorkItem = { id: 'SYN-1', repo_id: 1, title: 'x', status: 'in_progress', acceptance: '', branch: 'steward/a', merge_state: 'none', needs_merge: true, created_at: at, updated_at: at, ready: true, waiting: [], agents: ['claude'] }

describe('检查门', () => {
  it('keeps copy-instruction flow when no checks are configured', () => {
    expect(renderToStaticMarkup(<MergeGate snap={base} a={approval} />)).toContain('未配置检查命令')
  })
  it('offers a checked merge only when configured and approved', () => {
    const html = renderToStaticMarkup(<MergeGate snap={{ ...base, checked_repos: [1] }} a={approval} />)
    expect(html).toContain('运行检查并合并')
    expect(renderToStaticMarkup(<MergeGate snap={{ ...base, checked_repos: [1] }} a={{ ...approval, status: 'pending' }} />)).not.toContain('运行检查并合并')
  })
  it('shows failing check output and never claims a merge', () => {
    const html = renderToStaticMarkup(<MergeGate snap={{ ...base, checked_repos: [1], merge_jobs: [job({ state: 'failed', error: '检查未通过', checks: [{ argv: ['go', 'test'], exit_code: 1, seconds: 2, tail: 'FAIL x' }] })] }} a={approval} />)
    expect(html).toContain('检查未通过')
    expect(html).toContain('FAIL x')
    expect(html).toContain('重新运行')
    expect(html).not.toContain('已合并')
  })
  it('hides the run button while a job is in flight and notes push is separate', () => {
    expect(renderToStaticMarkup(<MergeGate snap={{ ...base, checked_repos: [1], merge_jobs: [job({ state: 'running' })] }} a={approval} />)).not.toContain('运行检查并合并')
    expect(renderToStaticMarkup(<MergeGate snap={{ ...base, checked_repos: [1], merge_jobs: [job({ state: 'merged' })] }} a={approval} />)).toContain('推送远程仍需你决定')
  })
})

describe('用量与交接', () => {
  it('labels shared sessions so per-item usage is not overstated silently', () => {
    const html = renderToStaticMarkup(<ItemUsageLine snap={{ ...base, item_usage: [{ work_item_id: 'SYN-1', input: 1500, output: 20, cache_read: 0, cache_write: 0, sessions: 2, shared: 1 }] }} id="SYN-1" />)
    expect(html).toContain('1.5k')
    expect(html).toContain('重复计入')
    expect(renderToStaticMarkup(<ItemUsageLine snap={base} id="SYN-1" />)).toBe('')
  })
  it('suggests the other agent and marks agents without hooks', () => {
    const snap = { ...base, agent_info: [{ name: 'claude', provider: 'claude', hooks: true }, { name: 'codex', provider: 'codex', hooks: true }, { name: 'gemini', provider: 'gemini', hooks: false }] }
    const html = renderToStaticMarkup(<HandoffForm snap={snap} item={item} onLaunched={() => {}} />)
    expect(html).toMatch(/<option value="codex" selected="">/)
    expect(html).toContain('无 hooks')
    expect(html).toContain('不含对话正文')
    expect(renderToStaticMarkup(<HandoffForm snap={snap} item={{ ...item, status: 'done' }} onLaunched={() => {}} />)).toBe('')
  })
})
