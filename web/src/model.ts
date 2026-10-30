import type { Approval, BriefField, Dep, ItemStatus, Session, Snapshot, WorkItem } from './types'
import { briefMatches } from './brief'
import { attentionManaged, managementLabel } from './workManagement'
import { attentionCount, mergeGroups, organizeAttention, periodicView, queueLanes, repoLabel } from './workbench'

export const itemStatusLabel: Record<ItemStatus, string> = {
  todo: '待开始',
  in_progress: '执行中',
  blocked: '阻塞',
  review: '交付待处理',
  done: '已处理',
  abandoned: '已放弃',
}

export const sessionStateLabel: Record<Session['state'], string> = {
  running: '运行中',
  waiting_permission: '等待权限',
  idle: '空闲',
  interrupted: '已中断',
  error: '出错',
  ended: '已结束',
  unknown: '状态未知',
}

export const mergeStateLabel: Record<WorkItem['merge_state'], string> = {
  none: '无需合并',
  not_ready: '未就绪',
  awaiting: '待合并审批',
  approved: '已批准合并',
  merged: '已合并',
}

export const approvalStatusLabel: Record<Approval['status'], string> = {
  pending: '待处理',
  decided: '已决定',
  delivered: '已送达',
  confirmed: '已确认',
  expired: '已过期',
  cancelled: '已取消',
}

export const providerLabel = (p: string) => (p === 'claude' ? 'Claude' : p === 'codex' ? 'Codex' : p || '其他')

export const freshnessLabel: Record<Session['freshness'], string> = {
  live: '实时',
  history: '仅历史发现',
  stale: '长时间无活动',
}

export function ago(ts: string, now: string): string {
  if (!ts) return '—'
  const d = (Date.parse(now) - Date.parse(ts)) / 1000
  if (!isFinite(d)) return '—'
  if (d < 60) return '刚刚'
  if (d < 3600) return `${Math.floor(d / 60)} 分钟前`
  if (d < 86400) return `${Math.floor(d / 3600)} 小时前`
  return `${Math.floor(d / 86400)} 天前`
}

export const openApprovals = (s: Snapshot) => (s.approvals ?? []).filter((a) => a.status === 'pending' || a.status === 'decided')

export type SessionScope = 'recent' | 'quiet' | 'all'
const IDLE_HIDE_AFTER_MS = 30 * 60 * 1000

export function sessionRepo(snap: Snapshot, session: Session): number | null {
  if (!session.work_item_id) return session.repo_id
  return (snap.work_items ?? []).find((w) => w.id === session.work_item_id)?.repo_id ?? session.repo_id
}

function quietWithoutApproval(snap: Snapshot, session: Session) {
  const idle = !['running', 'waiting_permission', 'ended'].includes(session.state)
  return session.freshness === 'stale' || (idle && Date.parse(snap.now) - Date.parse(session.last_activity_at) >= IDLE_HIDE_AFTER_MS)
}

// 只改变展示范围，不改变会话、工作项或执行记录的真实状态。
export function sessionBuckets(s: Snapshot, provider = 'all', repoId: number | 'all' = 'all') {
  const needsAttention = new Set(openApprovals(s).filter((a) => a.kind !== 'attention').map((a) => a.session_id))
  const all = (s.sessions ?? []).filter((x) =>
    (provider === 'all' || x.provider === provider) && (repoId === 'all' || sessionRepo(s, x) === repoId))
  const recent: Session[] = []
  const quiet: Session[] = []
  for (const session of all) {
    if (session.data_source !== 'live' || session.state === 'ended') continue
    if (!needsAttention.has(session.id) && quietWithoutApproval(s, session)) quiet.push(session)
    else recent.push(session)
  }
  return { recent, quiet, all }
}

export function sessionName(snap: Snapshot, session: Session) {
  const item = (snap.work_items ?? []).find((w) => w.id === session.work_item_id)
  if (item) return { title: item.title, source: '工作项', id: item.id }
  if (session.title?.trim()) return { title: session.title, source: '会话标题', id: '' }
  if (session.branch && !['main', 'master', 'HEAD'].includes(session.branch)) return { title: session.branch, source: '分支线索', id: '' }
  return { title: '工作内容待登记', source: '待登记', id: '' }
}

export type Signal = { label: string; reason: string; tone: 'run' | 'warn' | 'danger' | 'muted' | 'review' }

function approvalSignal(approvals: Approval[]): Signal | undefined {
  const a = ['permission', 'decision', 'merge', 'attention'].map((kind) => approvals.find((a) => a.kind === kind)).find(Boolean)
  if (!a) return undefined
  if (a.kind === 'permission') return { label: a.status === 'decided' ? '等待审批送达' : a.handleable ? '待你批准' : '回原界面审批', reason: a.preview || a.tool_name || '工具权限请求', tone: 'warn' }
  if (a.kind === 'decision') return { label: '待你决定', reason: a.preview || 'Agent 请求输入', tone: 'danger' }
  if (a.kind === 'merge') return { label: a.status === 'decided' ? '等待合并' : '待合并审批', reason: '查看右侧合并队列', tone: 'review' }
  return { label: '需关注', reason: a.preview || '疑似需要输入，尚未确认', tone: 'warn' }
}

export function sessionSignal(snap: Snapshot, s: Session): Signal {
  const approval = approvalSignal(openApprovals(snap).filter((a) => a.session_id === s.id))
  if (approval) return approval
  if (s.freshness === 'history') return { label: '历史记录', reason: '未收到实时事件', tone: 'muted' }
  if (quietWithoutApproval(snap, s)) return { label: '无新活动', reason: '尚无新事件，不能据此判断卡死', tone: 'muted' }
  if (s.state === 'running') return { label: '运行中', reason: s.last_tool_preview ? `最近操作：${s.last_tool_preview}` : '已收到活动事件；具体进展待回报', tone: 'run' }
  if (s.state === 'waiting_permission') return { label: '等待新状态', reason: '权限请求已关闭，等待会话新事件', tone: 'muted' }
  if (s.state === 'error') return { label: '执行出错', reason: s.state_reason || '未提供错误原因', tone: 'danger' }
  if (s.state === 'interrupted') return { label: '已中断', reason: s.state_reason || '会话被中断，结果待确认', tone: 'muted' }
  if (s.state === 'ended') return { label: '已结束', reason: '会话已结束，工作项验收另行处理', tone: 'muted' }
  if (s.state === 'idle' && s.state_reason === 'quota_auto_resume_stale') return { label: '等待继续', reason: '额度已恢复，请回原会话按 Enter 继续', tone: 'warn' }
  return { label: '等待新指令', reason: '本轮已停止；不代表工作项已完成', tone: 'muted' }
}

/** 目录移动是事实；人工确认的工作关联继续保留，由用户核对。 */
export function locationBindingNotice(snap: Snapshot, s: Session): string {
  if (!['manual', 'tag', 'managed'].includes(s.binding) || s.repo_id == null) return ''
  const item = (snap.work_items ?? []).find(w => w.id === s.work_item_id)
  return item?.repo_id != null && item.repo_id !== s.repo_id
    ? '当前工作目录已切换到其他项目；原工作项关联保留，请核对归属。' : ''
}

export function itemSignal(snap: Snapshot, w: WorkItem): Signal {
  const sessions = sessionsFor(snap, w.id)
  const ids = new Set(sessions.map((s) => s.id))
  const approval = approvalSignal(openApprovals(snap).filter((a) => a.work_item_id === w.id || (a.session_id != null && ids.has(a.session_id))))
  if (approval) return approval
  if (attentionManaged(w)) return { label: managementLabel(w), reason: w.management?.note || '由你手动收起日常提醒，可在管理状态中恢复', tone: 'muted' }
  if (w.automatic_issue) return { label: '自动任务需检查', reason: w.automatic_issue, tone: 'warn' }
  if (w.automatic_history) return { label: '已自动归档', reason: 'Agent 回报本轮完成；按已配置规则收进历史，无需逐轮验收', tone: 'muted' }
  const handoff = reportedHandoffs(snap, w)[0]
  if (handoff) return { label: handoff.blocker ? '待你决定' : '待你接手', reason: handoff.next?.text || handoff.blocker?.text || 'Agent 已回报下一步由你处理', tone: 'danger' }
  const feature = featureHandoffs(snap).find(h => h.contribution.work_item_id === w.id)
  if (feature) return { label: '待你接手', reason: `${feature.feature.title}：${feature.contribution.next || '执行 Agent 等待你的回应'}`, tone: 'danger' }
  if (!w.ready) return { label: '等上游', reason: `等待 ${w.waiting.join('、')}`, tone: 'warn' }
  if (w.status === 'blocked') return { label: '工作受阻', reason: '已标记阻塞；具体原因待补充', tone: 'danger' }
  if (w.status === 'review') return { label: '待你验收', reason: '检查交付和验收条件', tone: 'review' }
  if (sessions.length) return sessionSignal(snap, sessions.find((s) => s.state === 'running' && s.freshness === 'live') ?? sessions[0])
  return { label: w.status === 'todo' ? '待分配' : '暂无执行会话', reason: '关联一个会话后可查看执行 Agent 与运行状态', tone: 'muted' }
}

export interface ReportedHandoff { item: WorkItem; session?: Session; owner: BriefField; next?: BriefField; blocker?: BriefField; summary?: BriefField }

// Explicit next_owner=user is a reported handoff, never a tool permission grant.
export function reportedHandoffs(snap: Snapshot, w: WorkItem): ReportedHandoff[] {
  // Routine routing reports are not decisions. Questions and failures have
  // formal requests / automatic_issue, each with its own lifecycle.
  if (w.completion_policy === 'auto_history' || attentionManaged(w) || ['done', 'abandoned'].includes(w.status)) return []
  const live = (value?: BriefField) => value && !value.flagged && value.text ? value : undefined
  const sources = w.brief?.by_session ? Object.values(w.brief.by_session) : w.brief ? [w.brief] : []
  const out: ReportedHandoff[] = []
  for (const source of sources) {
    const owner = live(source.fields.next_owner)
    if (owner?.text !== 'user' || owner.source === 'deliver') continue
    if (source.input_resolved_at && source.input_resolved_at > owner.at) continue
    // A newer whole-task delivery folds earlier advisory handoffs into review.
    // Formal decision and permission requests remain governed by their own lifecycle.
    if (w.status === 'review' && w.brief?.last_delivered_at && w.brief.last_delivered_at > owner.at) continue
    const session = (snap.sessions ?? []).find((s) => s.id === owner.session_id)
    const next = live(source.fields.next)
    const blocker = live(source.fields.blocker)
    if (next || blocker) out.push({ item: w, session, owner, next, blocker, summary: live(source.fields.summary) || live(source.fields.progress) })
  }
  return out.sort((a, b) => (a.owner.session_id ?? 0) - (b.owner.session_id ?? 0))
}

export function approvalRepo(snap: Snapshot, a: Approval): number | null {
  const s = (snap.sessions ?? []).find((s) => s.id === a.session_id)
  return a.repo_id ?? (snap.work_items ?? []).find((w) => w.id === (a.work_item_id || s?.work_item_id))?.repo_id ?? s?.repo_id ?? null
}

export function projectAttention(snap: Snapshot, repoId: number | null) {
  const q = attention(snap)
  const approvals = (a: Approval) => approvalRepo(snap, a) === repoId
  const items = (w: WorkItem) => w.repo_id === repoId
  return attentionCount(organizeAttention({ permission: q.permission.filter(approvals), decision: q.decision.filter(approvals), merge: q.merge.filter(approvals), attention: [],
    reported: q.reported.filter(h => items(h.item)), features: q.features.filter(h => h.feature.repo_id === repoId), blocked: q.blocked.filter(items), review: q.review.filter(items) }))
}

export function featureHandoffs(s: Snapshot) {
  return (s.features ?? []).flatMap(feature => feature.accepted ? [] : feature.contributions.filter(p => {
    const item = s.work_items?.find(w => w.id === p.work_item_id)
    // A generic input may be an integration reminder, not the requested decision.
    // Feature handoffs close on the Agent's new feature report, not unrelated chat activity.
    return p.next_owner === 'user' && !(item && attentionManaged(item)) && !['done', 'abandoned'].includes(item?.status || '') && (p.active || p.candidate === feature.candidate)
  }).map(contribution => ({ feature, contribution })))
}

// 关注队列分组与排序：权限 > 决策 > 合并 > 低置信提醒
export function attention(s: Snapshot) {
  const open = openApprovals(s)
  const by = (k: Approval['kind']) => open.filter((a) => a.kind === k)
  const { current: items, hidden } = periodicView(s)
  const reported = items.flatMap((w) => reportedHandoffs(s, w)).filter((h) => !open.some((a) => a.kind === 'decision' && a.session_id === h.owner.session_id))
  const features = featureHandoffs(s).filter(h => !hidden.has(h.contribution.work_item_id) && !open.some(a => ['permission', 'decision'].includes(a.kind) && a.session_id === h.contribution.session_id))
  return {
    features,
    permission: by('permission'),
    decision: by('decision'),
    merge: by('merge'),
    attention: by('attention'),
    reported,
    blocked: items.filter((w) => !attentionManaged(w) && (!!w.automatic_issue || w.status === 'blocked' || (!w.ready && !['done', 'abandoned'].includes(w.status)))),
    review: items.filter((w) => !attentionManaged(w) && w.status === 'review' && w.completion_policy !== 'auto_history'),
  }
}

export function scopedAttention(snap: Snapshot, repoId: number | 'all' = 'all', provider = 'all') {
  const q = attention(snap)
  const approvalMatches = (a: Approval) => (repoId === 'all' || approvalRepo(snap, a) === repoId) &&
    (provider === 'all' || snap.sessions?.find(s => s.id === a.session_id)?.provider === provider || snap.work_items?.find(w => w.id === a.work_item_id)?.agents.includes(provider))
  const itemMatches = (w: WorkItem) => (repoId === 'all' || w.repo_id === repoId) && (provider === 'all' || w.agents.includes(provider))
  // A filter must not hide another member of the operation being approved.
  const merge = mergeGroups(q.merge).filter(g => g.members.some(approvalMatches)).flatMap(g => g.members)
  return organizeAttention({ permission: q.permission.filter(approvalMatches), decision: q.decision.filter(approvalMatches), merge,
    attention: q.attention.filter(approvalMatches), reported: q.reported.filter(h => itemMatches(h.item) && (provider === 'all' || h.session?.provider === provider)),
    features: q.features.filter(h => (repoId === 'all' || h.feature.repo_id === repoId) && (provider === 'all' || h.contribution.provider === provider)),
    blocked: q.blocked.filter(itemMatches), review: q.review.filter(itemMatches) })
}

export function queueCounts(snap: Snapshot, repoId: number | 'all' = 'all', provider = 'all') {
  return queueLanes(scopedAttention(snap, repoId, provider), snap.now).counts
}

export function projectQueueCounts(snap: Snapshot, repoId: number | null) {
  if (repoId != null) return queueCounts(snap, repoId)
  const q = attention(snap)
  return queueLanes(organizeAttention({ permission: q.permission.filter(a => approvalRepo(snap, a) == null), decision: q.decision.filter(a => approvalRepo(snap, a) == null),
    merge: q.merge.filter(a => approvalRepo(snap, a) == null), attention: [], reported: q.reported.filter(h => h.item.repo_id == null), features: [],
    blocked: q.blocked.filter(w => w.repo_id == null), review: q.review.filter(w => w.repo_id == null) }), snap.now).counts
}

export interface Group {
  key: string
  repoId: number | null
  name: string
  items: WorkItem[]
  history?: WorkItem[]
  sessions: Session[] // 未归属到工作项的会话
}

export interface FilterOpts {
  query: string
  showDone: boolean
  repoId: number | 'all'
  provider: string | 'all'
}

// 搜索时展开相关依赖子图：匹配项的所有上下游一并保留。
export function relatedIds(deps: Dep[], seeds: Set<string>): Set<string> {
  const out = new Set(seeds)
  const up = new Map<string, string[]>()
  const down = new Map<string, string[]>()
  for (const d of deps) {
    ;(down.get(d.upstream) ?? down.set(d.upstream, []).get(d.upstream)!).push(d.downstream)
    ;(up.get(d.downstream) ?? up.set(d.downstream, []).get(d.downstream)!).push(d.upstream)
  }
  const walk = (m: Map<string, string[]>) => {
    const stack = [...seeds]
    while (stack.length) {
      const id = stack.pop()!
      for (const n of m.get(id) ?? []) {
        if (!out.has(n)) {
          out.add(n)
          stack.push(n)
        }
      }
    }
  }
  walk(up)
  walk(down)
  return out
}

export function matches(w: WorkItem, q: string): boolean {
  const t = q.trim().toLowerCase().replace(/^#/, '')
  if (!t) return true
  return w.id.toLowerCase().includes(t) || w.title.toLowerCase().includes(t) || w.branch.toLowerCase().includes(t) || briefMatches(w, t)
}

export function groupByRepo(s: Snapshot, f: FilterOpts): Group[] {
  const repos = s.repos ?? []
  const deps = s.deps ?? []
  const periodic = periodicView(s)
  let items = (s.work_items ?? []).filter((w) => f.showDone || (w.status !== 'done' && w.status !== 'abandoned'))
  if (f.provider !== 'all') items = items.filter((w) => w.agents.includes(f.provider))
  if (f.query.trim()) {
    const seeds = new Set(items.filter((w) => matches(w, f.query)).map((w) => w.id))
    const keep = relatedIds(deps, seeds)
    items = (s.work_items ?? []).filter((w) => keep.has(w.id))
  }
  if (!f.query.trim()) items = items.filter(w => !periodic.hidden.has(w.id))
  const term = f.query.trim().toLowerCase().replace(/^#/, '')
  const sessions = sessionBuckets(s, f.provider, f.repoId).recent.filter((x) => !x.work_item_id &&
    (!term || `${sessionName(s, x).title} ${x.provider_session_id} ${x.suggested_work_item}`.toLowerCase().includes(term)))
  const groups = new Map<string, Group>()
  const get = (repoId: number | null) => {
    const key = repoId == null ? 'none' : String(repoId)
    let g = groups.get(key)
    if (!g) {
      const r = repos.find((r) => r.id === repoId)
      g = { key, repoId, name: r ? repoLabel(s, r.id) : '未关联仓库', items: [], sessions: [], history: [] }
      groups.set(key, g)
    }
    return g
  }
  for (const w of items) {
    if (f.repoId !== 'all' && w.repo_id !== f.repoId) continue
    get(w.repo_id).items.push(w)
  }
  for (const x of sessions) {
    if (f.repoId !== 'all' && x.repo_id !== f.repoId) continue
    get(x.repo_id).sessions.push(x)
  }
  if (!f.query.trim()) for (const w of periodic.history) {
    if ((f.repoId === 'all' || w.repo_id === f.repoId) && (f.provider === 'all' || w.agents.includes(f.provider))) get(w.repo_id).history!.push(w)
  }
  return [...groups.values()].sort((a, b) => projectAttention(s, b.repoId) - projectAttention(s, a.repoId) || score(b) - score(a) || a.name.localeCompare(b.name))
}

// 有待处理事项的项目排在前面
function score(g: Group) {
  return g.items.filter((w) => w.status === 'review' || w.status === 'blocked' || w.status === 'in_progress').length * 10 + g.sessions.length
}

// 依赖分层：没有上游的在第 0 层，其余为最长上游路径 + 1。
export function layers(items: WorkItem[], deps: Dep[]): Map<string, number> {
  const ids = new Set(items.map((w) => w.id))
  const ups = new Map<string, string[]>()
  for (const d of deps) {
    if (ids.has(d.upstream) && ids.has(d.downstream)) {
      ;(ups.get(d.downstream) ?? ups.set(d.downstream, []).get(d.downstream)!).push(d.upstream)
    }
  }
  const memo = new Map<string, number>()
  const depth = (id: string, seen: Set<string>): number => {
    if (memo.has(id)) return memo.get(id)!
    if (seen.has(id)) return 0 // 后端已禁止环，这里仅防御
    seen.add(id)
    const u = ups.get(id) ?? []
    const v = u.length ? Math.max(...u.map((x) => depth(x, seen))) + 1 : 0
    seen.delete(id)
    memo.set(id, v)
    return v
  }
  for (const w of items) depth(w.id, new Set())
  return memo
}

export function sessionsFor(s: Snapshot, itemId: string): Session[] {
  return (s.sessions ?? []).filter((x) => x.work_item_id === itemId)
}

export function nextItemId(s: Snapshot, prefix: string): string {
  const p = prefix.toUpperCase()
  let max = 0
  for (const w of s.work_items ?? []) {
    const m = w.id.match(/^([A-Z0-9]+)-(\d+)$/)
    if (m && m[1] === p) max = Math.max(max, Number(m[2]))
  }
  return `${p}-${String(max + 1).padStart(3, '0')}`
}

export function repoPrefix(name: string): string {
  const letters = name.replace(/[^A-Za-z0-9]/g, '').toUpperCase()
  return (letters.slice(0, 3) || 'WI').replace(/^[0-9]/, 'W')
}
