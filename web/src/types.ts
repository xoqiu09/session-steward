export type Provider = 'claude' | 'codex' | 'other' | string

export interface Repo {
  id: number
  name: string
  common_dir: string
  is_git: boolean
  target_ref: string
}

export interface Session {
  id: number
  host_id: string
  provider: Provider
  provider_session_id: string
  client: string
  version: string
  cwd: string
  worktree: string
  branch: string
  repo_id: number | null
  state: 'running' | 'waiting_permission' | 'idle' | 'interrupted' | 'error' | 'ended' | 'unknown'
  state_reason: string
  data_source: 'live' | 'history'
  freshness: 'live' | 'history' | 'stale'
  suggested_work_item: string
  first_seen_at: string
  last_activity_at: string
  last_progress_at: string
  work_item_id: string
  binding: string
  worktree_conflict: boolean
  resume_command: string
  title?: string
  title_source?: string
  last_tool_preview?: string
  last_tool_at?: string
}

export type ItemStatus = 'todo' | 'in_progress' | 'blocked' | 'review' | 'done' | 'abandoned'

export interface WorkItem {
  completion_policy?: 'auto_history' | 'manual'
  automatic_history?: boolean
  automatic_issue?: string
  automatic_issue_kind?: string
  automatic_issue_at?: string
  id: string
  repo_id: number | null
  title: string
  status: ItemStatus
  acceptance: string
  branch: string
  merge_state: 'none' | 'not_ready' | 'awaiting' | 'approved' | 'merged'
  needs_merge: boolean
  created_at: string
  updated_at: string
  ready: boolean
  waiting: string[]
  agents: Provider[]
  brief?: Brief | null
}

export type BriefKey = 'goal' | 'summary' | 'progress' | 'blocker' | 'next' | 'stage' | 'next_owner'

// 简报字段：kind=agent 为 Agent 自述（report/ask/deliver），kind=user 为你填写或确认
export interface BriefField {
  entry_id: number
  text: string
  kind: 'agent' | 'user'
  source: 'report' | 'ask' | 'deliver' | 'user' | 'confirm' | string
  session_id: number | null
  at: string
  pending?: BriefField
  flagged?: boolean
}

export interface Brief {
  fields: Partial<Record<BriefKey, BriefField>>
  by_session?: Record<string, Brief>
  last_delivered_at?: string
  input_resolved_at?: string
  tool_events_since: number
  last_event_at: string
  stale: boolean
}

export interface BriefEdit {
  field: BriefKey
  action: 'set' | 'confirm' | 'flag' | 'undo'
  text?: string
  entry_id?: number
}

export interface Dep {
  upstream: string
  downstream: string
  cond: 'accepted' | 'merged'
  satisfied: boolean
}

export interface Run {
  id: number
  work_item_id: string
  session_id: number
  provider: Provider
  attempt: number
  binding: string
  started_at: string
  ended_at: string
  outcome: string
}

export interface MergePayload {
  repo_id: number
  source_ref: string
  source_head_sha: string
  target_ref: string
  target_base_sha: string
  ahead: number
  diffstat: string
  stale?: string
  copied_at?: string
}

export interface Approval {
  id: string
  kind: 'permission' | 'merge' | 'decision' | 'attention'
  status: 'pending' | 'decided' | 'delivered' | 'confirmed' | 'expired' | 'cancelled'
  session_id: number | null
  work_item_id: string | null
  repo_id: number | null
  fingerprint: string
  tool_name: string
  preview: string
  decision: string
  handleable: boolean
  payload: Record<string, unknown>
  close_reason: string
  deadline: string
  created_at: string
  decided_at: string
  delivered_at: string
  confirmed_at: string
  closed_at: string
}

export interface Snapshot {
	features?: ProjectFeature[] | null
  cursor: number
  now: string
  repos: Repo[] | null
  sessions: Session[] | null
  work_items: WorkItem[] | null
  deps: Dep[] | null
  runs: Run[] | null
  approvals: Approval[] | null
  attributions?: Attribution[] | null
  managed?: ManagedSession[] | null
  agents?: string[] | null
  agent_info?: AgentInfo[] | null
  merge_jobs?: MergeJob[] | null
  checked_repos?: number[] | null
  session_usage?: SessionUsage[] | null
  item_usage?: ItemUsage[] | null
  handoffs?: Handoff[] | null
  summary_repos?: number[] | null
}

export interface AgentReview {
  provider: string; runs: number; delivered: number; accepted: number; reopened: number; abandoned: number
  handed_off: number; checks_pass: number; checks_fail: number; open_pending: number
}
export interface Review { since: string; days: number; agents: AgentReview[] }
export interface AISummary { work_item_id: string; text: string; basis_hash: string; current: boolean; created_at: string }

export interface AgentInfo { name: string; provider: string; hooks: boolean }
export interface CheckResult { argv: string[]; exit_code: number; seconds: number; tail: string }
export interface MergeJob {
  id: string; approval_id: string; work_item_id: string; repo_id: number; source_sha: string; target_ref: string; target_sha: string; merge_sha: string
  state: 'queued' | 'running' | 'passed' | 'failed' | 'merged' | 'aborted'; checks: CheckResult[] | null; error: string; created_at: string; updated_at: string
}
export interface Tokens { input: number; output: number; cache_read: number; cache_write: number }
export interface SessionUsage extends Tokens { session_id: number; updated_at: string }
export interface ItemUsage extends Tokens { work_item_id: string; sessions: number; shared: number }
export interface Handoff {
  id: string; work_item_id: string; from_session_id: number | null; from_provider: string; to_agent: string
  source_branch: string; source_sha: string; managed_id: string; state: string; created_at: string
}

export interface ManagedSession {
  id: string; repo_id: number; agent: string; title: string; work_item_id: string
  worktree: string; branch: string; base_sha: string; tmux_name: string
  state: 'starting' | 'running' | 'exited' | 'stopped' | 'failed' | 'archived'
  exit_code: number | null; error: string; session_id: number | null; takeover: boolean
  created_at: string; updated_at: string
}

export interface FeatureContribution {
  id: string; candidate: string; implementation?: string; validation?: string; evidence?: string
  blocker?: string; next?: string; next_owner?: string
  session_id: number; run_id: number; work_item_id: string; provider: Provider
  at: string; implementation_at?: string; validation_at?: string; next_at?: string; active: boolean
}
export interface ProjectFeature {
  repo_id: number; id: string; title: string; acceptance: string; scope_basis: string; scope_status: string; scope_version: string
  candidate: string; revision: string; implementation: string; validation: string
  conflict: boolean; stale: boolean; accepted: boolean; accepted_at?: string
  work_item_ids: string[]; contributions: FeatureContribution[]
}

export interface Attribution {
  id: string
  session_id: number
  fingerprint: string
  status: 'pending' | 'applied' | 'dismissed' | 'undone' | 'superseded'
  plan: {
    session_id: number
    fingerprint: string
    title: string
    repo_id: number
    action: 'create' | 'link'
    work_item_id: string
    automatic: boolean
    historical: boolean
    reasons: string[]
    candidates: { work_item_id: string; repo_id: number; title: string; reason: string; strong?: boolean }[]
  }
  work_item_id: string
  run_id: number
  automatic: boolean
  created_item: boolean
  created_at: string
  decided_at: string
}

export interface AttributionDecision {
  id: string
  fingerprint: string
  action: 'create' | 'link' | 'dismiss' | 'undo'
  work_item_id?: string
  repo_id?: number
  title?: string
}

// ---- 历史回看 ----
export interface DayStat {
  day: string
  tokens: Tokens
  by_provider: Record<string, number>
  by_model: Record<string, number>
  sessions: number; prompts: number; tools: number; subagents: number
  delivered: number; accepted: number; returned: number; blocked: number; failed: number
}
export interface HistoryResp { from: string; to: string; tokens_enabled: boolean; days: DayStat[] }
export interface DayChange { from: string; to: string; at: string }
export interface DayItem { id: string; title: string; repo_id: number | null; changes: DayChange[] }
export interface DaySession {
  id: number; provider: Provider; repo_id: number | null; work_item_id: string; first: string; last: string
  prompts: number; tools: number; tool_failed: number; subagents: number; tokens: Tokens
}
export interface DayDetail { day: string; items: DayItem[]; sessions: DaySession[] }
export interface TurnUsage extends Tokens { start: string }
export interface SubagentUsage { id: string; type: string; description: string; finished: boolean; start: string; end: string; total: Tokens }
export interface SessionUsageDetail {
  enabled: boolean; found: boolean
  self: { models: Record<string, Tokens>; turns: TurnUsage[]; total: Tokens }
  subagents: SubagentUsage[]
  with_subagents: Tokens
}
