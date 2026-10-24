import type { Approval, ManagedSession, MergeJob, Run, Session, Snapshot, WorkItem } from '../types'

// 合成数据：仅用于运行台渲染测试与样板截图，不来自任何真实项目或 .steward 目录。
export const SYN_NOW = '2026-10-23T06:20:00Z'
const t = (min: number) => new Date(Date.parse(SYN_NOW) - min * 60_000).toISOString()

const session = (id: number, provider: string, extra: Partial<Session>): Session => ({
  id, host_id: 'synthetic-host', provider, provider_session_id: `syn-${id}`, client: 'cli', version: '', cwd: `/synthetic/wt/${id}`, worktree: `/synthetic/wt/${id}`,
  branch: 'steward/syn-12', repo_id: 1, state: 'running', state_reason: '', data_source: 'live', freshness: 'live', suggested_work_item: '',
  first_seen_at: t(90), last_activity_at: t(2), last_progress_at: t(6), work_item_id: 'SYN-12', binding: 'tag', worktree_conflict: false,
  resume_command: `${provider} --resume syn-${id}`, ...extra,
})

const item = (id: string, title: string, extra: Partial<WorkItem> = {}): WorkItem => ({
  id, repo_id: 1, title, status: 'in_progress', acceptance: '', branch: '', merge_state: 'none', needs_merge: false,
  created_at: t(300), updated_at: t(3), ready: true, waiting: [], agents: [], ...extra,
})

const run = (id: number, sid: number, provider: string, started: number, ended: number | null, outcome = ''): Run => ({
  id, work_item_id: 'SYN-12', session_id: sid, provider, attempt: id, binding: 'tag', started_at: t(started), ended_at: ended == null ? '' : t(ended), outcome,
})

const approval = (a: Partial<Approval> & Pick<Approval, 'id' | 'kind' | 'status'>): Approval => ({
  session_id: null, work_item_id: 'SYN-12', repo_id: 1, fingerprint: 'syn', tool_name: '', preview: '', decision: '', handleable: true, payload: {},
  close_reason: '', deadline: '', created_at: t(40), decided_at: '', delivered_at: '', confirmed_at: '', closed_at: '', ...a,
})

const job: MergeJob = {
  id: 'job-syn-1', approval_id: 'a-syn-81', work_item_id: 'SYN-12', repo_id: 1,
  source_sha: '3f9a1c2e8b7d4a60c1e2f3a4b5c6d7e8f9a0b1c2', target_ref: 'main', target_sha: '9e01ab37c4d5e6f708192a3b4c5d6e7f8091a2b3', merge_sha: '',
  state: 'failed', error: '', created_at: t(9), updated_at: t(7),
  checks: [
    { argv: ['go', 'test', './...'], exit_code: 1, seconds: 12.4, tail: '--- FAIL: TestQueueOrder (0.02s)\n    queue_test.go:41: synthetic failure: want 3 got 2\nFAIL\tsynthetic/queue\t0.31s' },
    { argv: ['npm', 'run', 'build', '--prefix', 'web'], exit_code: 0, seconds: 3.1, tail: '' },
  ],
}

const managed: ManagedSession = {
  id: 'syn88', repo_id: 1, agent: 'codex', title: '接手归属队列', work_item_id: 'SYN-12', worktree: '/synthetic/wt/88', branch: 'steward/syn88',
  base_sha: '3f9a1c2e8b7d4a60c1e2f3a4b5c6d7e8f9a0b1c2', tmux_name: 'steward-syn88', state: 'running', exit_code: null, error: '', session_id: 88, takeover: false,
  created_at: t(25), updated_at: t(25),
}

export const synthSnapshot: Snapshot = {
  cursor: 1, now: SYN_NOW,
  repos: [{ id: 1, name: 'synthetic-app', common_dir: '/synthetic/app/.git', is_git: true, target_ref: 'main' }],
  work_items: [
    item('SYN-12', '重构归属队列（合成样例）', {
      branch: 'steward/syn-12', needs_merge: true, merge_state: 'approved', agents: ['claude', 'codex'], acceptance: '队列按状态与时间排序；合成测试全部通过',
      brief: {
        tool_events_since: 0, last_event_at: t(2), stale: false,
        fields: {
          summary: { entry_id: 1, text: '排序修复已提交，检查门里 go test 仍有一项失败。', kind: 'agent', source: 'report', session_id: 88, at: t(8) },
          progress: { entry_id: 2, text: '接手后修正了排序比较函数，正在补测试。', kind: 'agent', source: 'report', session_id: 88, at: t(8) },
          next: { entry_id: 3, text: '修复 TestQueueOrder 后重新运行检查门。', kind: 'agent', source: 'report', session_id: 88, at: t(8) },
        },
      },
    }),
    item('SYN-13', '补充通知深链（合成样例）', { agents: ['claude'] }),
  ],
  sessions: [
    session(86, 'claude', { state: 'ended', freshness: 'history', data_source: 'live', last_activity_at: t(200) }),
    session(87, 'claude', { state: 'running', last_activity_at: t(4) }),
    session(88, 'codex', { state: 'running', last_activity_at: t(1) }),
    session(90, 'claude', { work_item_id: 'SYN-13', state: 'idle', last_activity_at: t(30) }),
  ],
  runs: [run(1, 86, 'claude', 240, 200, 'failed'), run(2, 87, 'claude', 120, 30, 'handed_off'), run(3, 88, 'codex', 25, null)],
  deps: [],
  approvals: [
    approval({ id: 'a-syn-77', kind: 'permission', status: 'confirmed', session_id: 87, tool_name: 'Bash', preview: 'go test ./internal/queue', decision: 'allow', created_at: t(60), decided_at: t(59), delivered_at: t(59), confirmed_at: t(58) }),
    approval({ id: 'a-syn-80', kind: 'merge', status: 'decided', created_at: t(50), decided_at: t(48), payload: { repo_id: 1, source_ref: 'steward/syn-12', source_head_sha: '1a2b3c4d5e6f708192a3b4c5d6e7f8091a2b3c4d', target_ref: 'main', target_base_sha: '9e01ab37c4d5e6f708192a3b4c5d6e7f8091a2b3', ahead: 2, diffstat: '3 files', copied_at: t(47) } }),
    approval({ id: 'a-syn-81', kind: 'merge', status: 'decided', created_at: t(12), decided_at: t(10), payload: { repo_id: 1, source_ref: 'steward/syn-12', source_head_sha: '3f9a1c2e8b7d4a60c1e2f3a4b5c6d7e8f9a0b1c2', target_ref: 'main', target_base_sha: '9e01ab37c4d5e6f708192a3b4c5d6e7f8091a2b3', ahead: 3, diffstat: '4 files', stale: 'target_moved' } }),
    approval({ id: 'a-syn-90', kind: 'permission', status: 'pending', session_id: 88, tool_name: 'Bash', preview: 'go test ./... -run TestQueueOrder -count=1 -v ./internal/queue/... ./internal/server/...', created_at: t(1) }),
  ],
  managed: [managed],
  agents: ['claude', 'codex'],
  agent_info: [{ name: 'claude', provider: 'claude', hooks: true }, { name: 'codex', provider: 'codex', hooks: true }],
  merge_jobs: [job],
  checked_repos: [1],
  features: [{
    repo_id: 1, id: 'synthetic-sorting', title: '归属队列排序（合成功能）', acceptance: '排序与稳定性检查通过', scope_basis: '合成验收规格', scope_status: 'documented', scope_version: 'synthetic-v1',
    candidate: job.source_sha, revision: 'synthetic-revision', implementation: 'implemented', validation: 'not_verified', conflict: false, stale: false, accepted: false, work_item_ids: ['SYN-12'],
    contributions: [{ id: 'synthetic-sorting', candidate: job.source_sha, implementation: 'implemented', validation: 'not_verified', blocker: '排序测试尚未通过', next: '修复排序后补验证', next_owner: 'agent', session_id: 88, run_id: 3, work_item_id: 'SYN-12', provider: 'codex', at: t(8), active: true }],
  }],
  handoffs: [{ id: 'h-syn-3', work_item_id: 'SYN-12', from_session_id: 87, from_provider: 'claude', to_agent: 'codex', source_branch: 'steward/syn-12', source_sha: '1a2b3c4d5e6f708192a3b4c5d6e7f8091a2b3c4d', managed_id: 'syn88', state: 'launched', created_at: t(26) }],
}
