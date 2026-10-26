// 测试用合成快照：形状遵循 SS Snapshot 类型，所有项目、会话与任务都是虚构的。
// 故意包含重复 Run 记录、过期审批、陈旧会话、history 会话、同 provider 多会话、失败后重试。
import type { Approval, Brief, BriefField, Repo, Run, Session, Snapshot, WorkItem } from '../types'

export const DEMO_NOW = '2026-10-26T06:00:00Z'

const repos: Repo[] = [
  { id: 1, name: 'pixel-ledger', common_dir: '', is_git: true, target_ref: 'main' },
  { id: 2, name: 'morning-brief', common_dir: '', is_git: true, target_ref: 'main' },
  { id: 3, name: 'town-workshop', common_dir: '', is_git: true, target_ref: 'main' },
]

export function fakeSession(p: Partial<Session> & Pick<Session, 'id' | 'provider' | 'state'>): Session {
  return {
    host_id: 'demo-host', provider_session_id: `demo-${p.id}`, client: '', version: '', cwd: '', worktree: '', branch: '', repo_id: null,
    state_reason: '', data_source: 'live', freshness: 'live', suggested_work_item: '', first_seen_at: '2026-10-26T04:30:00Z',
    last_activity_at: '2026-10-26T05:58:00Z', last_progress_at: '2026-10-26T05:55:00Z', work_item_id: '', binding: 'explicit',
    worktree_conflict: false, resume_command: '', ...p,
  }
}

const sessions: Session[] = [
  fakeSession({ id: 11, provider: 'claude', state: 'running', repo_id: 3, work_item_id: 'TW-1', branch: 'claude/scene', title: '画小镇一屏候选', last_tool_preview: 'Edit src/scene.tsx', last_tool_at: '2026-10-26T05:59:10Z' }),
  fakeSession({ id: 12, provider: 'claude', state: 'idle', repo_id: 3, work_item_id: 'TW-2', branch: 'claude/list-toggle', title: '小镇/列表切换', last_activity_at: '2026-10-26T05:40:00Z' }),
  fakeSession({ id: 21, provider: 'codex', state: 'waiting_permission', state_reason: '请求运行迁移脚本', repo_id: 1, work_item_id: 'PL-7', branch: 'codex/import-csv', title: '导入银行账单 CSV', last_tool_preview: 'Bash npm run migrate -- --dry-run', last_activity_at: '2026-10-26T05:57:00Z' }),
  fakeSession({ id: 22, provider: 'codex', state: 'running', repo_id: 1, work_item_id: 'PL-8', branch: 'codex/monthly-chart', title: '月度报表图表', last_tool_preview: 'Read src/report/chart.ts' }),
  fakeSession({ id: 31, provider: 'other', client: '小猫', state: 'running', repo_id: 2, work_item_id: 'MB-3', branch: 'cat/weather-card', title: '晨报天气卡片（第 2 次）', last_tool_preview: 'Write src/cards/weather.tsx' }),
  fakeSession({ id: 13, provider: 'claude', state: 'running', repo_id: 2, work_item_id: 'MB-4', branch: 'claude/layout', title: '晨报头图排版', freshness: 'stale', last_activity_at: '2026-10-26T05:12:00Z', last_progress_at: '2026-10-26T05:10:00Z' }),
  fakeSession({ id: 9, provider: 'claude', state: 'ended', repo_id: 3, work_item_id: 'TW-0', data_source: 'history', freshness: 'history', title: '中文界面适配', last_activity_at: '2026-10-25T09:00:00Z' }),
]

const field = (text: string, kind: BriefField['kind'], source: string, at: string): BriefField => ({ entry_id: 0, text, kind, source, session_id: kind === 'agent' ? 12 : null, at })

const tw2Brief: Brief = {
  fields: {
    summary: field('列表与小镇两种视图可切换，选中状态保留。', 'agent', 'deliver', '2026-10-26T05:38:00Z'),
    progress: field('切换、键盘操作与窄屏布局已完成；检查通过。', 'agent', 'deliver', '2026-10-26T05:38:00Z'),
    next_owner: field('user', 'agent', 'deliver', '2026-10-26T05:38:00Z'),
  },
  last_delivered_at: '2026-10-26T05:38:00Z', tool_events_since: 0, last_event_at: '2026-10-26T05:38:00Z', stale: false,
}

export function fakeItem(p: Partial<WorkItem> & Pick<WorkItem, 'id' | 'title' | 'status' | 'repo_id'>): WorkItem {
  return { acceptance: '', branch: '', merge_state: 'none', needs_merge: false, created_at: '2026-10-26T03:00:00Z', updated_at: '2026-10-26T05:50:00Z', ready: true, waiting: [], agents: [], ...p }
}

const workItems: WorkItem[] = [
  fakeItem({ id: 'TW-0', repo_id: 3, title: '中文界面适配', status: 'done', agents: ['claude'] }),
  fakeItem({ id: 'TW-1', repo_id: 3, title: '一屏视觉候选', status: 'in_progress', agents: ['claude'] }),
  fakeItem({ id: 'TW-2', repo_id: 3, title: '小镇/列表切换', status: 'review', acceptance: '两种视图切换后，选中对象不丢失。', agents: ['claude'], brief: tw2Brief }),
  fakeItem({ id: 'PL-7', repo_id: 1, title: '导入银行账单 CSV', status: 'in_progress', agents: ['codex'] }),
  fakeItem({ id: 'PL-8', repo_id: 1, title: '月度报表图表', status: 'in_progress', ready: false, waiting: ['PL-7'], agents: ['codex'] }),
  fakeItem({ id: 'MB-3', repo_id: 2, title: '晨报天气卡片', status: 'in_progress', agents: ['小猫'] }),
  fakeItem({ id: 'MB-4', repo_id: 2, title: '晨报头图排版', status: 'blocked', agents: ['claude'] }),
]

export function fakeRun(p: Partial<Run> & Pick<Run, 'id' | 'work_item_id' | 'session_id' | 'provider'>): Run {
  return { attempt: 1, binding: 'explicit', started_at: '2026-10-26T05:20:00Z', ended_at: '', outcome: '', ...p }
}

const runs: Run[] = [
  fakeRun({ id: 301, work_item_id: 'TW-1', session_id: 11, provider: 'claude' }),
  fakeRun({ id: 302, work_item_id: 'TW-2', session_id: 12, provider: 'claude', started_at: '2026-10-26T04:50:00Z', ended_at: '2026-10-26T05:38:00Z', outcome: 'delivered' }),
  fakeRun({ id: 101, work_item_id: 'PL-7', session_id: 21, provider: 'codex' }),
  fakeRun({ id: 102, work_item_id: 'PL-8', session_id: 22, provider: 'codex' }),
  // 第 1 次失败的旧副本（未结束）和新副本同时出现：只能算一个包裹。
  fakeRun({ id: 201, work_item_id: 'MB-3', session_id: 31, provider: 'other', started_at: '2026-10-26T04:40:00Z' }),
  fakeRun({ id: 201, work_item_id: 'MB-3', session_id: 31, provider: 'other', started_at: '2026-10-26T04:40:00Z', ended_at: '2026-10-26T05:05:00Z', outcome: 'failed' }),
  fakeRun({ id: 202, work_item_id: 'MB-3', session_id: 31, provider: 'other', attempt: 2, started_at: '2026-10-26T05:15:00Z' }),
  fakeRun({ id: 301, work_item_id: 'TW-1', session_id: 11, provider: 'claude' }),
  fakeRun({ id: 401, work_item_id: 'MB-4', session_id: 13, provider: 'claude', started_at: '2026-10-26T05:00:00Z' }),
]

export function fakeApproval(p: Partial<Approval> & Pick<Approval, 'id' | 'kind' | 'status'>): Approval {
  return {
    session_id: null, work_item_id: null, repo_id: null, fingerprint: '', tool_name: '', preview: '', decision: '', handleable: true, payload: {},
    close_reason: '', deadline: '', created_at: '2026-10-26T05:50:00Z', decided_at: '', delivered_at: '', confirmed_at: '', closed_at: '', ...p,
  }
}

const approvals: Approval[] = [
  fakeApproval({ id: 'A-1', kind: 'permission', status: 'pending', session_id: 21, work_item_id: 'PL-7', repo_id: 1, tool_name: 'Bash', preview: 'npm run migrate -- --dry-run', created_at: '2026-10-26T05:57:00Z' }),
  fakeApproval({ id: 'A-2', kind: 'decision', status: 'pending', session_id: 13, work_item_id: 'MB-4', repo_id: 2, preview: '晨报头图用插画还是照片？', created_at: '2026-10-26T05:11:00Z' }),
  fakeApproval({ id: 'A-0', kind: 'permission', status: 'expired', session_id: 21, work_item_id: 'PL-7', repo_id: 1, tool_name: 'Bash', preview: 'rm -rf tmp/import-cache', created_at: '2026-10-26T05:20:00Z', closed_at: '2026-10-26T05:35:00Z', close_reason: 'deadline' }),
]

export const demoSnapshot: Snapshot = {
  cursor: 42, now: DEMO_NOW, repos, sessions, work_items: workItems,
  deps: [{ upstream: 'PL-7', downstream: 'PL-8', cond: 'accepted', satisfied: false }],
  runs, approvals,
}
