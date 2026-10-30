import { informationGap } from '../signals'
import type { Approval, BriefField, Snapshot, WorkItem } from '../types'
import { field } from '../brief'
import { attentionManaged } from '../workManagement'
import { itemSignal, scopedAttention, sessionBuckets, type ReportedHandoff } from '../model'
import { periodicView, queueLanes, repoLabel, type MergeGroup } from '../workbench'

// 每日十分钟：把一天里要你管的事按四个问题排好——要你决定什么、做完了什么（证据在哪）、什么卡住了、其余不用管的。
// 只整理已有数据，不推断进度；Agent 的回报一律标为自述，验收只由你点。

export type DecideRow =
  | { kind: 'permission'; key: string; approval: Approval; itemId?: string; repo: string; at: string }
  | { kind: 'decision'; key: string; approval: Approval; itemId?: string; repo: string; at: string }
  | { kind: 'merge'; key: string; group: MergeGroup; itemId?: string; repo: string; at: string }
  | { kind: 'handoff'; key: string; item: WorkItem; need: string; blocker?: string; repo: string; at: string }

export interface Evidence { label: string; tone: 'ok' | 'bad' | 'info'; detail?: string }

/** ok：有通过的验证或已合并；missing：只有自述；failed：有验证失败。 */
export type Grade = 'ok' | 'missing' | 'failed'

export interface ReviewRow { item: WorkItem; repo: string; said?: BriefField; evidence: Evidence[]; grade: Grade; at: string; fresh: boolean
  /** 这件交付还有一个合并在等你批准（批准合并和验收分开记录）。 */
  merge?: MergeGroup }

export interface StuckRow {
  item: WorkItem; repo: string
  label: string; tone: 'user' | 'wait' | 'muted'
  reason: string; next?: string; at: string
  /** 等的上游里正好有在“等你验收”的，点一下就能去验收。 */
  upstreamInReview?: string
}

export interface Today {
  decide: DecideRow[]
  review: ReviewRow[]
  stuck: StuckRow[]
  running: WorkItem[]
  managed: WorkItem[]
  acceptedSince: WorkItem[]
  unregistered: number
}

const gradeOrder: Record<Grade, number> = { ok: 0, missing: 1, failed: 2 }

// 证据只取能核对的东西：功能进度里 Agent 回报的验证结果、Git 确认的合并、分支。
export function evidenceOf(snap: Snapshot, w: WorkItem): { evidence: Evidence[]; grade: Grade } {
  const evidence: Evidence[] = []
  for (const f of snap.features ?? []) {
    const mine = f.contributions.filter((c) => c.work_item_id === w.id).sort((a, b) => (b.validation_at || b.at).localeCompare(a.validation_at || a.at))[0]
    if (!mine) continue
    if (mine.validation === 'passed') evidence.push({ label: `${f.title}：验证通过`, tone: 'ok', detail: mine.evidence })
    else if (mine.validation === 'failed') evidence.push({ label: `${f.title}：验证失败`, tone: 'bad', detail: mine.evidence || mine.blocker })
    else if (mine.evidence) evidence.push({ label: `${f.title}：有验证说明`, tone: 'info', detail: mine.evidence })
  }
  if (w.merge_state === 'merged') evidence.push({ label: w.merge_evidence?.method === 'github_pr' ? '已合并（GitHub PR 确认）' : '已合并（Git 确认）', tone: 'ok' })
  else if (w.merge_state === 'approved') evidence.push({ label: '合并已批准，未执行', tone: 'info' })
  if (w.branch) evidence.push({ label: `分支 ${w.branch}`, tone: 'info' })
  const grade: Grade = evidence.some((e) => e.tone === 'bad') ? 'failed' : evidence.some((e) => e.tone === 'ok') ? 'ok' : 'missing'
  return { evidence, grade }
}

const said = (w: WorkItem) => field(w, 'summary') ?? field(w, 'progress')

export function buildToday(snap: Snapshot, lastSeen: string): Today {
  const q = scopedAttention(snap)
  const lanes = queueLanes(q, snap.now)
  const items = snap.work_items ?? []
  const byId = (id?: string | null) => (id ? items.find((w) => w.id === id) : undefined)
  const sessionItem = (a: Approval) => a.work_item_id || (snap.sessions ?? []).find((s) => s.id === a.session_id)?.work_item_id || undefined
  const repoOf = (id?: string) => repoLabel(snap, byId(id)?.repo_id ?? null)

  const decide: DecideRow[] = []
  for (const a of lanes.permission) decide.push({ kind: 'permission', key: a.id, approval: a, itemId: sessionItem(a), repo: repoLabel(snap, a.repo_id ?? byId(sessionItem(a))?.repo_id ?? null), at: a.created_at })
  for (const a of lanes.decision) decide.push({ kind: 'decision', key: a.id, approval: a, itemId: sessionItem(a), repo: repoLabel(snap, a.repo_id ?? byId(sessionItem(a))?.repo_id ?? null), at: a.created_at })
  // 合并审批：工作项都在等你验收的，挂到验收那一行上一起看，不在这里重复列。
  const reviewIds = new Set(q.allReview.map((w) => w.id))
  const mergeFor = new Map<string, MergeGroup>()
  for (const g of lanes.merge) {
    if (g.workItemIds.length && g.workItemIds.every((id) => reviewIds.has(id))) { for (const id of g.workItemIds) mergeFor.set(id, g); continue }
    decide.push({ kind: 'merge', key: g.key, group: g, itemId: g.primary.work_item_id ?? undefined, repo: repoLabel(snap, g.primary.repo_id), at: g.primary.created_at })
  }
  // Agent 把下一步交给你、但还没交付的：也算要你决定。已在待验收的交付不重复列。
  for (const g of q.allAdvisories) {
    const w = byId(g.id)
    if (!w || reviewIds.has(w.id)) continue
    const r: ReportedHandoff | undefined = g.reported[0]
    const f = g.features[0]
    const need = r?.next?.text || f?.contribution.next || r?.blocker?.text || 'Agent 回报下一步由你处理'
    decide.push({ kind: 'handoff', key: `handoff-${w.id}`, item: w, need, blocker: r?.blocker?.text || f?.contribution.blocker || undefined, repo: repoOf(w.id), at: r?.owner.at || f?.contribution.next_at || f?.contribution.at || w.updated_at })
  }

  const review: ReviewRow[] = q.allReview.map((w) => {
    const { evidence, grade } = evidenceOf(snap, w)
    const at = w.brief?.last_delivered_at || w.updated_at
    return { item: w, repo: repoOf(w.id), said: said(w), evidence, grade, at, fresh: !lastSeen || at > lastSeen, merge: mergeFor.get(w.id) }
  }).sort((a, b) => gradeOrder[a.grade] - gradeOrder[b.grade] || b.at.localeCompare(a.at))

  const taken = new Set<string>([...reviewIds, ...decide.flatMap((d) => (d.kind === 'handoff' ? [d.item.id] : d.itemId ? [d.itemId] : []))])
  const { current } = periodicView(snap)
  const stuck: StuckRow[] = []
  for (const w of current) {
    if (attentionManaged(w) || taken.has(w.id) || ['done', 'abandoned', 'review'].includes(w.status)) continue
    const blocker = field(w, 'blocker')
    const next = field(w, 'next')?.text
    const base = { item: w, repo: repoOf(w.id), next }
    if (w.automatic_issue) stuck.push({ ...base, label: '自动任务出了问题', tone: 'user', reason: w.automatic_issue, at: w.automatic_issue_at || w.updated_at })
    // 还没开工、只是排在上游后面的，是正常排队，不算卡住
    else if (!w.ready && w.status === 'todo' && !blocker) continue
    else if (!w.ready) {
      const up = w.waiting.find((id) => reviewIds.has(id))
      stuck.push({ ...base, label: '等上游', tone: 'wait', reason: blocker?.text || `要等 ${w.waiting.join('、')} 完成`, at: blocker?.at || w.updated_at, upstreamInReview: up })
    } else if (w.status === 'blocked' || blocker) stuck.push({ ...base, label: '卡住了', tone: 'wait', reason: blocker?.text || itemSignal(snap, w).reason, at: blocker?.at || w.updated_at })
    else if (w.status === 'in_progress' && w.brief?.stale) stuck.push({ ...base, label: '很久没回报进展', tone: 'muted', reason: 'Agent 一直在动，但好一阵没有回报进展；可能卡住，也可能只是忘了回报。', at: field(w, 'progress')?.at || w.updated_at })
    const gap = informationGap(w, snap.now, snap.signal_gap_after_min)
    if (gap) stuck.push({ ...base, label: '没有信号', tone: 'muted', reason: gap, at: w.signal!.at, next: '暂时缺少新观察；请核对会话或等待下一条信号，不据此判断失败或完成。' })
  }
  const stuckIds = new Set(stuck.map((s) => s.item.id))
  const running = current.filter((w) => !attentionManaged(w) && w.status === 'in_progress' && !taken.has(w.id) && !stuckIds.has(w.id))
  const managed = items.filter((w) => attentionManaged(w) && !['done', 'abandoned'].includes(w.status))
  const since = lastSeen || new Date(Date.parse(snap.now) - 86_400_000).toISOString()
  const acceptedSince = items.filter((w) => w.status === 'done' && w.updated_at > since)
  const { recent, quiet } = sessionBuckets(snap)
  const unregistered = [...recent, ...quiet].filter((s) => !s.work_item_id).length
  return { decide, review, stuck, running, managed, acceptedSince, unregistered }
}
