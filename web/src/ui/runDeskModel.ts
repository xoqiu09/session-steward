import type { Approval, Handoff, ManagedSession, MergeJob, MergePayload, Run, Session, Snapshot, WorkItem } from '../types'
import { providerLabel, sessionsFor, sessionSignal } from '../model'
import { shownNo } from '../hub/ids'

// 运行台只做展示映射：把快照里已有的字段归到六种执行状态，不新增判断规则。
// 命令文本、已复制、已发送都不是执行证据；只有服务实际运行的检查才有成功/失败。
export type RunState = 'generated' | 'requested' | 'running' | 'succeeded' | 'failed' | 'unknown' | 'neutral'

export const runStateLabel: Record<RunState, string> = {
  generated: '已生成', requested: '已请求', running: '执行中', succeeded: '成功', failed: '失败', unknown: '未知', neutral: '已结束',
}
export const runStateMark: Record<RunState, string> = {
  generated: '○', requested: '●', running: '◐', succeeded: '✓', failed: '✗', unknown: '?', neutral: '–',
}

export function jobRunState(j: MergeJob): RunState {
  switch (j.state) {
    case 'queued': return 'requested'
    case 'running': case 'passed': return 'running'
    case 'merged': return 'succeeded'
    case 'failed': case 'aborted': return 'failed'
    default: return 'unknown'
  }
}

export const checkRunState = (exitCode?: number | null): RunState => typeof exitCode === 'number' && Number.isFinite(exitCode) ? (exitCode === 0 ? 'succeeded' : 'failed') : 'unknown'

export function managedRunState(m: ManagedSession): RunState {
  if (m.state === 'starting' || m.state === 'running') return 'running'
  if (m.state === 'failed') return 'failed'
  if (m.state === 'exited' || m.state === 'stopped' || m.state === 'archived') return 'neutral'
  return 'unknown'
}

export function handoffRunState(h: Handoff): RunState {
  if (h.state === 'launched') return 'requested'
  if (h.state === 'failed') return 'failed'
  return 'unknown'
}

export function approvalRunState(a: Approval): RunState {
  switch (a.status) {
    case 'pending': case 'decided': return 'requested'
    case 'delivered': case 'confirmed': return 'requested'
    case 'cancelled': return 'neutral'
    default: return 'unknown'
  }
}

const liveSession = (s: Session) => s.data_source === 'live' && s.freshness !== 'history' && s.state !== 'ended'
const activeSession = (s: Session) => liveSession(s) && (s.state === 'running' || s.state === 'waiting_permission')

export interface Candidate { sha: string; ref: string; source: string; target?: { ref: string; sha: string; moved: boolean }; pending?: { sha: string; ref: string; targetRef: string; targetSha: string } }

// 候选提交：按“服务实际执行的合并检查 → 合并审批 → 交接来源 → 工作项分支”的顺序取已有字段。
export function candidateOf(snap: Snapshot, item: WorkItem): Candidate | null {
  const jobs = (snap.merge_jobs ?? []).filter((j) => j.work_item_id === item.id).sort((a, b) => b.updated_at.localeCompare(a.updated_at))
  const merge = (snap.approvals ?? []).filter((a) => a.kind === 'merge' && a.work_item_id === item.id).sort((a, b) => b.created_at.localeCompare(a.created_at))[0]
  const p = merge?.payload as unknown as MergePayload | undefined
  const target = p ? { ref: p.target_ref, sha: p.target_base_sha, moved: p.stale === 'target_moved' } : undefined
  if (jobs[0]) {
    const approval = (snap.approvals ?? []).find((a) => a.id === jobs[0].approval_id && a.work_item_id === item.id)
    const checked = approval?.payload as unknown as MergePayload | undefined
    return { sha: jobs[0].source_sha, ref: checked?.source_ref ?? '', source: '合并检查（最近记录）', target: { ref: jobs[0].target_ref, sha: jobs[0].target_sha, moved: checked?.stale === 'target_moved' },
      pending: merge && merge.id !== jobs[0].approval_id && p?.source_head_sha ? { sha: p.source_head_sha, ref: p.source_ref, targetRef: p.target_ref, targetSha: p.target_base_sha } : undefined }
  }
  if (p?.source_head_sha) return { sha: p.source_head_sha, ref: p.source_ref, source: '合并审批', target }
  const h = (snap.handoffs ?? []).filter((x) => x.work_item_id === item.id).sort((a, b) => b.created_at.localeCompare(a.created_at))[0]
  if (h?.source_sha) return { sha: h.source_sha, ref: h.source_branch, source: '交接来源' }
  if (item.branch) return { sha: '', ref: item.branch, source: '工作项分支' }
  return null
}

export interface CurrentRun { kind: 'session' | 'managed'; id: string; sessionId?: number; provider: string; label: string; since: string; state: RunState; statusLabel: string }

export function currentRuns(snap: Snapshot, item: WorkItem): CurrentRun[] {
  const out: CurrentRun[] = sessionsFor(snap, item.id).filter(activeSession).map((s) => ({
    kind: 'session', id: `s${s.id}`, sessionId: s.id, provider: s.provider, label: `会话 #${shownNo(s.id)}`, since: s.last_activity_at || s.first_seen_at,
    state: s.freshness === 'stale' ? 'unknown' : sessionSignal(snap, s).tone === 'run' ? 'running' : 'requested',
    statusLabel: s.freshness === 'stale' ? '状态待核实' : sessionSignal(snap, s).label,
  }))
  for (const m of snap.managed ?? []) {
    if (m.work_item_id !== item.id || m.session_id != null || (m.state !== 'running' && m.state !== 'starting')) continue
    out.push({ kind: 'managed', id: `m${m.id}`, provider: m.agent, label: `托管 ${m.id}`, since: m.created_at, state: 'running', statusLabel: m.state === 'starting' ? '启动中' : '运行中' })
  }
  return out
}

export interface StaleWriter { session: Session; handoff?: Handoff; reason: string }

// 交接不撤销上一位的写入权：来源会话仍在运行时持续提示，Steward 不提供停止入口。
export function staleWriters(snap: Snapshot, item: WorkItem): StaleWriter[] {
  const sessions = new Map((snap.sessions ?? []).map((s) => [s.id, s]))
  const out: StaleWriter[] = []
  const seen = new Set<number>()
  for (const h of (snap.handoffs ?? []).filter((x) => x.work_item_id === item.id)) {
    const s = h.from_session_id != null ? sessions.get(h.from_session_id) : undefined
    if (s && liveSession(s) && !seen.has(s.id)) {
      seen.add(s.id)
      out.push({ session: s, handoff: h, reason: '交接不撤销写入权' })
    }
  }
  return out
}

export interface TimelineEvent { key: string; at: string; state: RunState; title: string; detail?: string }

export function timelineOf(snap: Snapshot, item: WorkItem): TimelineEvent[] {
  const sids = new Set(sessionsFor(snap, item.id).map((s) => s.id))
  const mine = (a: Approval) => a.work_item_id ? a.work_item_id === item.id : a.session_id != null && sids.has(a.session_id)
  const jobs = (snap.merge_jobs ?? []).filter((j) => j.work_item_id === item.id)
  const ev: TimelineEvent[] = []
  for (const a of (snap.approvals ?? []).filter(mine)) {
    const at = a.confirmed_at || a.delivered_at || a.decided_at || a.closed_at || a.created_at
    if (a.kind === 'merge') {
      const p = a.payload as unknown as MergePayload
      if (a.status === 'pending') ev.push({ key: a.id, at, state: 'requested', title: '合并待审批', detail: `${p.source_ref || '来源分支待核实'} → ${p.target_ref || '目标分支待核实'}` })
      else if (p.copied_at && !jobs.some((j) => j.approval_id === a.id)) ev.push({ key: `${a.id}-copied`, at: p.copied_at, state: 'unknown', title: '已复制合并指令，执行结果待核实', detail: '复制不是执行证据；工作项已合并也不能证明这条旧指令已执行' })
      else if (a.status === 'decided') ev.push({ key: a.id, at, state: 'generated', title: '合并已批准，合并指令可生成', detail: '尚无执行证据' })
      continue
    }
    const what = a.kind === 'permission' ? `权限 ${a.tool_name || '请求'}` : a.kind === 'decision' ? '需要你决定' : '提醒'
    const status = { pending: '待处理', decided: '面板已决定，待送达', delivered: '已送达，待 Agent 确认继续', confirmed: '已确认继续', expired: '已过期，需回原界面', cancelled: '已取消' }[a.status]
    ev.push({ key: a.id, at, state: approvalRunState(a), title: `${what} · ${status ?? '状态待核实'}`, detail: `${a.decision ? `决定：${a.decision === 'allow' ? '允许' : a.decision === 'deny' ? '拒绝' : a.decision}。` : ''}请求送达、确认继续均不代表工具执行成功。` })
  }
  for (const j of jobs) {
    const failed = (j.checks ?? []).find((c) => c.exit_code !== 0)
    ev.push({ key: j.id, at: j.updated_at, state: jobRunState(j), title: `检查门 · ${{ queued: '排队中', running: '检查中', passed: '检查通过，正在合并', failed: '检查未通过', merged: '已合并到本地目标分支', aborted: '已中止，未合并' }[j.state] ?? '状态待核实'}`, detail: failed ? `${failed.argv.join(' ')} 退出码 ${failed.exit_code ?? '待核实'}` : j.error || undefined })
  }
  for (const m of (snap.managed ?? []).filter((x) => x.work_item_id === item.id && x.state !== 'archived')) {
    ev.push({ key: m.id, at: m.updated_at || m.created_at, state: managedRunState(m), title: `托管会话 ${m.id} · ${{ starting: '启动中', running: '运行中', exited: '已退出', stopped: '已停止', failed: '启动失败', archived: '已归档' }[m.state] ?? '状态待核实'}`, detail: m.state === 'exited' || m.state === 'stopped' ? '退出不代表工作完成' : m.error || undefined })
  }
  for (const h of (snap.handoffs ?? []).filter((x) => x.work_item_id === item.id)) {
    ev.push({ key: h.id, at: h.created_at, state: handoffRunState(h), title: `交接 ${providerLabel(h.from_provider)} → ${h.to_agent}`, detail: h.state === 'launched' ? '已启动接手会话；来源会话未被停止' : h.state === 'failed' ? '接手会话启动失败' : `状态 “${h.state}” 未识别` })
  }
  return ev.sort((a, b) => b.at.localeCompare(a.at))
}

export interface CommandEntry { key: string; text: string; state: RunState; evidence: string; exitCode?: number; seconds?: number; tail?: string; copyable: boolean }

export function commandsOf(snap: Snapshot, item: WorkItem): CommandEntry[] {
  const out: CommandEntry[] = []
  const jobs = (snap.merge_jobs ?? []).filter((j) => j.work_item_id === item.id).sort((a, b) => b.updated_at.localeCompare(a.updated_at))
  for (const j of jobs.slice(0, 1)) {
    ;(j.checks ?? []).forEach((c, i) => out.push({
      key: `${j.id}-${i}`, text: c.argv.join(' '), state: checkRunState(c.exit_code), evidence: checkRunState(c.exit_code) === 'unknown' ? '检查记录缺少退出码，结果待核实' : '服务实际运行', exitCode: c.exit_code, seconds: c.seconds, tail: c.tail, copyable: false,
    }))
    if (!(j.checks ?? []).length && (j.state === 'queued' || j.state === 'running')) out.push({ key: j.id, text: '检查命令（仓库配置）', state: jobRunState(j), evidence: '等待服务运行结果', copyable: false })
  }
  for (const s of sessionsFor(snap, item.id)) {
    if (s.resume_command) out.push({ key: `resume-${s.id}`, text: s.resume_command, state: 'generated', evidence: `会话 #${shownNo(s.id)} 恢复命令 · 无执行证据`, copyable: true })
  }
  return out
}

export const shortSha = (sha: string) => sha.slice(0, 12)

export function clock(ts: string): string {
  const d = new Date(ts)
  if (!ts || Number.isNaN(d.getTime())) return '—'
  return `${String(d.getMonth() + 1).padStart(2, '0')}/${String(d.getDate()).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

export interface SessionRuns { sessionId: number; provider: Run['provider']; runs: Run[]; open: boolean; outcome: string }

/** 同一尝试里同一会话的多段运行合成一行：会话被重复关联时，层级里不再出现一串相同的 #号。 */
export function runsBySession(runs: readonly Run[]): SessionRuns[] {
  const out = new Map<number, SessionRuns>()
  for (const r of runs) {
    const g = out.get(r.session_id) ?? { sessionId: r.session_id, provider: r.provider, runs: [], open: false, outcome: '' }
    g.runs.push(r)
    g.open = g.open || !r.ended_at
    g.outcome = r.ended_at ? r.outcome : g.outcome
    out.set(r.session_id, g)
  }
  return [...out.values()]
}

export interface ReviewWhere {
  repo: string
  /** 目录：交付会话的 worktree 或工作目录；不知道时为空。 */
  path: string
  branch: string
  /** 这个位置是从哪条记录来的。 */
  source: 'session' | 'candidate' | 'item'
}

export interface ReviewGuide {
  /** Agent 交付时说的话（自述），没有则为空。 */
  said: { text: string; sessionId: number | null; at: string } | null
  acceptance: string
  /** 在哪看：优先用交付会话自己记下的仓库、目录和分支。 */
  where: ReviewWhere | null
  /** 交付会话：用来回到原对话。 */
  session: Session | null
  /** 交付会话所在项目与工作项项目不同。 */
  mismatch: { delivered: string; item: string } | null
}

/** 验收卡片要讲清楚：Agent 说交付了什么、在哪看、怎么回到原对话。都只是快照里已有的字段。 */
export function reviewGuide(snap: Snapshot, item: WorkItem): ReviewGuide {
  const f = item.brief?.fields ?? {}
  const said = f.summary?.text ? f.summary : f.progress?.text ? f.progress : null
  const sessions = snap.sessions ?? []
  // 交付会话：写交付说明的那个会话；没有说明时取这项工作最近一段运行的会话。
  const lastRun = (snap.runs ?? []).filter((r) => r.work_item_id === item.id).sort((a, b) => (b.ended_at || b.started_at).localeCompare(a.ended_at || a.started_at))[0]
  const sid = said?.session_id ?? lastRun?.session_id ?? null
  const session = sessions.find((s) => s.id === sid) ?? null
  const repoName = (id: number | null) => (snap.repos ?? []).find((r) => r.id === id)?.name ?? ''
  const sessionPath = session ? session.worktree || session.cwd : ''
  let where: ReviewWhere | null = null
  if (session && (session.branch || session.repo_id != null)) {
    where = { repo: repoName(session.repo_id), path: sessionPath, branch: session.branch, source: 'session' }
  } else {
    const cand = candidateOf(snap, item)
    if (cand?.ref) where = { repo: repoName(item.repo_id), path: '', branch: cand.ref, source: cand.source === '工作项分支' ? 'item' : 'candidate' }
  }
  const mismatch = session?.repo_id != null && item.repo_id != null && session.repo_id !== item.repo_id
    ? { delivered: repoName(session.repo_id) || `项目 ${session.repo_id}`, item: repoName(item.repo_id) || `项目 ${item.repo_id}` } : null
  return {
    said: said ? { text: said.text, sessionId: said.session_id, at: said.at } : null,
    acceptance: item.acceptance.trim(),
    where,
    session,
    mismatch,
  }
}
