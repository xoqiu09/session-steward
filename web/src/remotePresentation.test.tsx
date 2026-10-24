import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Queue } from './Queue'
import { MergeGate } from './P1'
import { BriefSection } from './BriefSection'
import * as bits from './bits'
import { remoteReadOnlyMessage } from './access'
import type { Approval, MergeJob, Snapshot, WorkItem } from './types'

const at = '2026-10-23T00:00:00Z'
const item: WorkItem = {
  id: 'SYN-1', repo_id: 1, title: 'Synthetic merge task', status: 'review',
  acceptance: '', branch: 'feat/synthetic', merge_state: 'approved', needs_merge: true,
  created_at: at, updated_at: at, ready: true, waiting: [], agents: [],
}
const approval: Approval = {
  id: 'merge-1', kind: 'merge', status: 'decided', repo_id: 1, work_item_id: item.id,
  session_id: null, created_at: at, payload: { source_ref: item.branch, target_ref: 'main', ahead: 1, diffstat: '1 file changed', source_head_sha: 'a'.repeat(40), target_base_sha: 'b'.repeat(40) },
  fingerprint: '', tool_name: '', preview: '', decision: '', handleable: false,
  close_reason: '', deadline: '', decided_at: at, delivered_at: '', confirmed_at: '', closed_at: '',
}
const base: Snapshot = {
  cursor: 1, now: at, repos: [{ id: 1, name: 'synthetic', common_dir: '/synthetic/.git', is_git: true, target_ref: 'main' }],
  sessions: [], work_items: [item], deps: [], runs: [], approvals: [approval], checked_repos: [1],
}
const job = (state: MergeJob['state']): MergeJob => ({
  id: 'job-1', approval_id: approval.id, work_item_id: item.id, repo_id: 1,
  source_sha: 'a'.repeat(40), target_ref: 'main', target_sha: 'b'.repeat(40), merge_sha: '', state,
  error: state === 'failed' ? 'synthetic check failure' : '',
  checks: state === 'running' ? [] : [{ argv: ['go', 'test', './...'], exit_code: state === 'failed' ? 1 : 0, seconds: 2, tail: state === 'failed' ? 'FAIL synthetic check output' : 'PASS synthetic check output' }],
  created_at: at, updated_at: at,
})
const remote = () => vi.stubGlobal('window', { location: { protocol: 'https:', hostname: 'mac.tailnet-synthetic.ts.net' } })
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks() })

function buttonAttrs(html: string, label: string) {
  const match = [...html.matchAll(/<button\b([^>]*)>([^<]*)<\/button>/g)].find(m => m[2] === label)
  expect(match, `missing ${label} button`).toBeDefined()
  return match![1]
}

describe('remote merge result presentation', () => {
  it.each([
    ['running', '检查门：检查中'],
    ['failed', '检查门：检查未通过'],
    ['passed', '检查门：检查通过，正在合并'],
  ] as const)('shows %s status in the queue without merge actions', (state, status) => {
    remote()
    const html = renderToStaticMarkup(<Queue snap={{ ...base, merge_jobs: [job(state)] }} onSelectItem={() => {}} />)
    expect(html).toContain(status)
    expect(html).toContain(remoteReadOnlyMessage)
    expect(html).not.toContain('运行检查并合并')
    expect(html).not.toContain('复制合并指令')
    expect(html).not.toContain('>撤回<')
    if (state === 'failed') {
      expect(html).toContain('synthetic check failure')
      expect(html).toContain('FAIL synthetic check output')
      expect(html).toContain('退出码 1')
      expect(html).toContain('go test ./...')
    }
    if (state === 'passed') expect(html).toContain('PASS synthetic check output')
  })
  it('does not expose a start button when the remote gate has no job yet', () => {
    remote()
    expect(renderToStaticMarkup(<MergeGate snap={base} a={approval} />)).not.toContain('运行检查并合并')
  })
  it('retains the local start button', () => {
    const html = renderToStaticMarkup(<MergeGate snap={base} a={approval} />)
    expect(buttonAttrs(html, '运行检查并合并')).not.toContain('disabled')
  })
  it('retains local failure evidence and retry', () => {
    const html = renderToStaticMarkup(<Queue snap={{ ...base, merge_jobs: [job('failed')] }} onSelectItem={() => {}} />)
    expect(html).toContain('synthetic check failure')
    expect(buttonAttrs(html, '重新运行检查并合并')).not.toContain('disabled')
  })
})

const briefItem: WorkItem = {
  ...item,
  brief: { stale: false, tool_events_since: 0, last_event_at: at, fields: {
    progress: { entry_id: 1, text: 'Synthetic Agent progress', kind: 'agent', source: 'report', session_id: 7, at },
    goal: { entry_id: 2, text: 'Owner pinned goal', kind: 'user', source: 'confirm', session_id: null, at,
      pending: { entry_id: 3, text: 'New Agent goal pending comparison', kind: 'agent', source: 'report', session_id: 7, at } },
  } },
}
const briefButtons = ['确认无误', '标记有误', '采用这条']
const renderBrief = () => renderToStaticMarkup(<BriefSection snap={base} item={briefItem} />)

describe('remote brief read-only presentation', () => {
  it('disables all three writes with an accessible reason while preserving content and sources', () => {
    remote()
    const html = renderBrief()
    expect(html).toContain(remoteReadOnlyMessage)
    expect(html).toContain('Synthetic Agent progress')
    expect(html).toContain('Owner pinned goal')
    expect(html).toContain('New Agent goal pending comparison')
    expect(html).toContain('会话 #7')
    expect(html).toContain('steward-hook report')
    for (const label of briefButtons) {
      const attrs = buttonAttrs(html, label)
      expect(attrs).toContain('disabled=""')
      expect(attrs).toContain('aria-describedby="brief-read-only-SYN-1"')
    }
    expect(html).toContain('id="brief-read-only-SYN-1"')
  })
  it('retains all three local actions', () => {
    const html = renderBrief()
    expect(html).not.toContain(remoteReadOnlyMessage)
    for (const label of briefButtons) expect(buttonAttrs(html, label)).not.toContain('disabled')
  })
  it('disables the local actions while another brief action is pending', () => {
    vi.spyOn(bits, 'useAction').mockReturnValue({ busy: true, error: '', run: vi.fn().mockResolvedValue(undefined), setError: vi.fn() })
    const html = renderBrief()
    for (const label of briefButtons) expect(buttonAttrs(html, label)).toContain('disabled=""')
  })
})
