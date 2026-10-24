import type { Brief, BriefField, Snapshot, WorkItem } from './types'
import { legacyBrief } from './brief'
import { providerLabel, scopedAttention } from './model'
import { currentReporters } from './stage'
import { queueLanes } from './workbench'

export interface FactSource { itemId: string; sessionId: number | null; label: string; at: string; observed: boolean; feature?: string }
export interface ProjectFact { key: string; text: string; owner?: string; sources: FactSource[]; priority: number }
const visible = (f?: BriefField) => f && !f.flagged && f.text.trim() && !legacyBrief(f) ? f : undefined
const timeOf = (f: ProjectFact) => f.sources.map(s => s.at).sort().at(-1) || ''

export function projectSummary(snap: Snapshot, items: WorkItem[], repoId: number | null) {
  const progress: ProjectFact[] = [], blockers: ProjectFact[] = [], next: ProjectFact[] = []
  const ids = new Set(items.map(w => w.id))
  let blockerReported = false
  const add = (list: ProjectFact[], text: string, source: FactSource, owner?: string, priority = 0) => {
    if (!text.trim()) return
    // Identical wording is displayed once, with every contributing source retained.
    const key = JSON.stringify([text.trim(), owner ?? ''])
    const existing = list.find(f => f.key === key)
    if (existing) { existing.sources.push(source); existing.priority = Math.max(existing.priority, priority) }
    else list.push({ key, text: text.trim(), owner, sources: [source], priority })
  }
  const owner = (value: string | undefined, source: FactSource) => {
    if (value === 'user') return '你'
    if (value === 'external') return '外部依赖方'
    if (value === 'agent') return source.sessionId != null ? source.label : '执行 Agent（会话待指定）'
    if (value === 'claude' || value === 'codex') return `${providerLabel(value)}（会话待指定）`
    return '负责人待回报'
  }
  for (const w of items) {
    const closed = ['done', 'abandoned'].includes(w.status)
    const entries: [string, Brief][] = w.brief?.by_session ? Object.entries(w.brief.by_session) : w.brief ? [['aggregate', w.brief]] : []
    // User corrections are additional evidence; disputed entries cannot return through by_session.
    const disputed = new Set(Object.entries(w.brief?.fields ?? {}).filter(([, f]) => f?.flagged).map(([key, f]) => `${key}/${f!.entry_id}`))
    const corrections = Object.fromEntries(Object.entries(w.brief?.fields ?? {}).filter(([, f]) => f?.kind === 'user'))
    if (Object.keys(corrections).length && w.brief?.by_session) entries.push(['user', { ...w.brief, fields: corrections }])
    const current = currentReporters(snap, w)
    for (const [sid, brief] of entries) {
      const read = (key: keyof Brief['fields']) => {
        const f = visible(brief.fields[key])
        if (!f || disputed.has(`${key}/${f.entry_id}`)) return undefined
        const correction = corrections[key]
        return sid !== 'user' && f.kind !== 'user' && correction && correction.at >= f.at ? undefined : f
      }
      const headline = [read('summary'), read('progress')].filter((f): f is BriefField => !!f).sort((a,b) => b.at.localeCompare(a.at))[0]
      const source = (value: BriefField): FactSource => {
        const sessionId = value.session_id ?? (Number(sid) || null)
        const session = snap.sessions?.find(s => s.id === sessionId)
        const label = value.kind === 'user' ? '你填写' : session ? `${providerLabel(session.provider)} #${session.id}` : sessionId != null ? `会话 #${sessionId}` : '工作项回报'
        return { itemId: w.id, sessionId, label, at: value.at, observed: false }
      }
      if (headline) add(progress, headline.text, source(headline), undefined, headline.kind === 'user' ? 90 : current.some(s => s.id === headline.session_id) ? 60 : 20)
      if (!closed) {
        const rawBlocker = brief.fields.blocker
        if (rawBlocker && !rawBlocker.flagged && !disputed.has(`blocker/${rawBlocker.entry_id}`)) blockerReported = true
        const blocker = read('blocker')
        if (blocker) add(blockers, blocker.text, source(blocker), undefined, 50)
        const n = read('next'), o = read('next_owner')
        if (n) {
          const ownOwner = o?.kind === 'user' || o?.session_id === n.session_id ? o : undefined
          if (w.completion_policy === 'auto_history' && n.source === 'deliver' && ownOwner?.text === 'user') continue
          const answered = ownOwner?.text === 'user' && ownOwner.source !== 'deliver' && !!brief.input_resolved_at && brief.input_resolved_at > ownOwner.at
          add(next, answered ? '已收到回应，等待该会话回报新的安排' : n.text, source(n), answered ? source(n).label : owner(ownOwner?.text, source(n)), 50)
        }
      }
    }
    const observed: FactSource = { itemId: w.id, sessionId: null, label: w.id, at: w.updated_at, observed: true }
    if (w.automatic_issue) {
      const source = { ...observed, at: w.automatic_issue_at || w.updated_at }
      add(blockers, w.automatic_issue, source, undefined, 95)
      add(next, '查看自动任务的异常与来源，确认是否需要干预', source, '你', 95)
    }
    if (!closed && !w.ready) add(blockers, `等待上游工作项 ${w.waiting.join('、') || '就绪'}`, observed, undefined, 90)
    else if (w.status === 'blocked' && !blockers.some(f => f.sources.some(s => s.itemId === w.id))) add(blockers, '工作项已标记阻塞，具体原因待 Agent 回报', observed, undefined, 80)
    if (w.status === 'review' && w.completion_policy !== 'auto_history' && !next.some(f => f.sources.some(s => s.itemId === w.id))) add(next, '审阅交付与验收条件', observed, '你', 10)
  }
  for (const f of snap.features ?? []) {
    if (f.repo_id !== repoId || f.accepted) continue
    for (const p of f.contributions) {
      if (!ids.has(p.work_item_id) || items.some(w => w.id === p.work_item_id && ['done','abandoned'].includes(w.status))) continue
      if (!p.active && p.candidate !== f.candidate && !f.conflict) continue
      const source: FactSource = { itemId: p.work_item_id, sessionId: p.session_id, label: `${providerLabel(p.provider)} #${p.session_id}`, at: p.at, observed: false, feature: f.title }
      if (p.blocker !== undefined) blockerReported = true
      if (p.blocker) add(blockers, p.blocker, source, undefined, p.active ? 60 : 30)
      if (p.next) add(next, p.next, { ...source, at: p.next_at || p.at }, owner(p.next_owner, source), p.active ? 55 : 25)
    }
    const source: FactSource = { itemId: f.work_item_ids.find(id => ids.has(id)) || '', sessionId: null, label: f.title, at: '', observed: true }
    if (source.itemId && f.conflict) add(blockers, `${f.title}：存在候选或回报冲突，需执行方对齐`, source, undefined, 95)
    if (source.itemId && f.validation === 'failed') add(blockers, `${f.title}：Agent 回报验证失败`, source, undefined, 85)
  }
  const q = scopedAttention(snap, repoId ?? 'all')
  const lanes = queueLanes(q, snap.now)
  const belongs = (item: string | null, sessionId: number | null) => ids.has(item || snap.sessions?.find(s => s.id === sessionId)?.work_item_id || '')
  for (const a of [...lanes.permission, ...lanes.decision]) {
    if (!belongs(a.work_item_id, a.session_id)) continue
    const session = snap.sessions?.find(s => s.id === a.session_id)
    const source: FactSource = { itemId: a.work_item_id || session?.work_item_id || '', sessionId: a.session_id, label: session ? `${providerLabel(session.provider)} #${session.id}` : '正式请求', at: a.created_at, observed: true }
    add(blockers, `${a.kind === 'permission' ? '等待权限审批' : '等待你的决定'}：${a.preview || a.tool_name || '查看右侧请求'}`, source, undefined, 100)
    add(next, a.kind === 'permission' ? '处理右侧工具权限请求' : '回应右侧明确提问', source, '你', 100)
  }
  for (const g of lanes.merge) {
    for (const id of g.workItemIds.filter(id => ids.has(id))) {
      const source: FactSource = { itemId: id, sessionId: null, label: '合并候选', at: g.primary.created_at, observed: true }
      add(next, `决定是否合并 ${String(g.primary.payload.source_ref)} → ${String(g.primary.payload.target_ref)}`, source, '你', 100)
    }
  }
  const sort = (facts: ProjectFact[]) => {
    // Repeated wording retains every source, but the visible attribution is the latest.
    for (const f of facts) f.sources.sort((a,b) => (Date.parse(b.at) || 0) - (Date.parse(a.at) || 0) || a.label.localeCompare(b.label))
    return facts.sort((a,b) => b.priority - a.priority || timeOf(b).localeCompare(timeOf(a)) || a.text.localeCompare(b.text))
  }
  sort(progress); sort(blockers); sort(next)
  const actors = new Map<string, ProjectFact[]>()
  for (const f of next) actors.set(f.owner!, [...(actors.get(f.owner!) ?? []), f])
  const latest = progress[0]
  const features = (snap.features ?? []).filter(f => f.repo_id === repoId)
  const scopeKnown = features.length && features.every(f => ['documented','confirmed'].includes(f.scope_status))
  const fallback = scopeKnown ? `Agent 已登记 ${features.length} 项功能，回报已实现 ${features.filter(f => f.implementation === 'implemented' && !f.conflict).length} 项；具体验证见详情` : '尚未收到项目进展回报'
  const reporters = items.flatMap(w => currentReporters(snap, w))
  const unreported = reporters.filter(s => {
    const w = items.find(w => w.id === s.work_item_id)
    const own = w?.brief?.by_session ? w.brief.by_session[String(s.id)] : w?.brief
    return ![visible(own?.fields.progress), visible(own?.fields.summary)].some(f => f?.session_id === s.id)
  })
  return { progress: latest, progressText: latest?.text || fallback, progressPrefix: items.length > 1 ? `${items.length}项工作，最近回报：` : reporters.length > 1 ? `${reporters.length}个会话协作，最近回报：` : '',
    blockers, blockerEmpty: blockerReported ? '当前未报告阻塞' : '未填写卡点信息', next, actors: [...actors.entries()], sources: [...progress, ...blockers, ...next], unreported: unreported.length }
}
