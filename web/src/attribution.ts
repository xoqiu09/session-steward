import type { Attribution, AttributionDecision, Snapshot } from './types'

export interface AttributionDraft { target?: string; repoId?: number; title?: string }

export function scopedAttributions(snap: Snapshot, repoId: number | 'all' = 'all', provider = 'all') {
  const sessions = new Map((snap.sessions ?? []).map((s) => [s.id, s]))
  return (snap.attributions ?? []).filter((a) => {
    const s = sessions.get(a.session_id)
    return (provider === 'all' || s?.provider === provider) &&
      (repoId === 'all' || (a.plan.repo_id || s?.repo_id) === repoId)
  })
}

export function attributionChoice(a: Attribution, draft: AttributionDraft = {}, bulkRepo = 0) {
  const target = draft.target ?? (a.plan.candidates.length > 1 ? '' : a.plan.action === 'link' ? a.plan.work_item_id : 'new')
  const repoId = draft.repoId ?? (a.plan.repo_id || bulkRepo)
  const title = draft.title ?? a.plan.title
  return { target, repoId, title }
}

export function attributionRequest(a: Attribution, draft?: AttributionDraft, bulkRepo = 0): AttributionDecision | undefined {
  const { target, repoId, title } = attributionChoice(a, draft, bulkRepo)
  if (a.status !== 'pending' || !target || (target === 'new' && (!repoId || !title.trim()))) return undefined
  return target === 'new'
    ? { id: a.id, fingerprint: a.fingerprint, action: 'create', repo_id: repoId, title: title.trim() }
    : { id: a.id, fingerprint: a.fingerprint, action: 'link', work_item_id: target }
}

export function canUndoAttribution(a: Attribution, snap: Snapshot) {
  if (a.status !== 'applied') return false
  const run = (snap.runs ?? []).find((r) => r.id === a.run_id)
  if (!run || run.work_item_id !== a.work_item_id) return false
  if (run.ended_at) return ['', 'historical'].includes(run.outcome) && run.binding === (a.automatic ? 'auto' : 'manual') && !(snap.runs ?? []).some((r) => r.session_id === a.session_id && r.id > a.run_id)
  return !run.ended_at && run.binding === (a.automatic ? 'auto' : 'manual')
}

// 按线索把待确认归属分组，一组一个决定。历史会话单独成组，只显示分布。
export type ClusterKind = 'target' | 'choose' | 'branch' | 'title' | 'unclear' | 'history'
export interface AttributionCluster {
  key: string
  kind: ClusterKind
  label: string
  clue: string
  repoId: number
  records: Attribution[]
  target: string // 'new'、已有工作项编号，或空串（需要选择）
}

const PUBLIC_BRANCHES = new Set(['', 'main', 'master', 'HEAD', 'develop', 'trunk'])
const normTitle = (t: string) => t.trim().toLowerCase().replace(/\s+/g, ' ').slice(0, 24)

export function clusterAttributions(snap: Snapshot, records: Attribution[]): AttributionCluster[] {
  const sessions = new Map((snap.sessions ?? []).map((s) => [s.id, s]))
  const map = new Map<string, AttributionCluster>()
  const push = (key: string, c: Omit<AttributionCluster, 'records' | 'key'>, a: Attribution) => {
    const cur = map.get(key) ?? map.set(key, { key, ...c, records: [] }).get(key)!
    cur.records.push(a)
  }
  for (const a of records) {
    if (a.status !== 'pending') continue
    const s = sessions.get(a.session_id)
    const repoId = a.plan.repo_id || s?.repo_id || 0
    if (a.plan.historical) {
      push('history', { kind: 'history', label: '历史会话', clue: '已结束或仅历史发现', repoId: 0, target: '' }, a)
      continue
    }
    const cands = a.plan.candidates ?? []
    if (cands.length > 1) {
      // 候选集合相同的放一组，不预选
      const ids = cands.map((c) => c.work_item_id).sort().join(',')
      push(`choose:${ids}`, { kind: 'choose', label: '有多个候选', clue: ids.replace(/,/g, ' / '), repoId, target: '' }, a)
      continue
    }
    if (a.plan.action === 'link' && a.plan.work_item_id) {
      // 只有明确匹配才算高把握；标题相似等弱匹配仍需确认
      const strong = !!cands[0]?.strong
      push(`target:${a.plan.work_item_id}:${strong ? 's' : 'w'}`, { kind: strong ? 'target' : 'title', label: `${strong ? '建议' : '可能'}关联到 ${a.plan.work_item_id}`, clue: a.plan.reasons[a.plan.reasons.length - 1] ?? '', repoId, target: a.plan.work_item_id }, a)
      continue
    }
    const branch = s?.branch ?? ''
    if (repoId && !PUBLIC_BRANCHES.has(branch)) {
      push(`branch:${repoId}:${branch}`, { kind: 'branch', label: '同一功能分支', clue: branch, repoId, target: 'new' }, a)
      continue
    }
    const title = s?.title?.trim() || ''
    if (repoId && title) {
      push(`title:${repoId}:${normTitle(title)}`, { kind: 'title', label: '标题相近', clue: title.slice(0, 24), repoId, target: 'new' }, a)
      continue
    }
    push(`unclear:${repoId}`, { kind: 'unclear', label: repoId ? '线索不足' : '项目不明', clue: repoId ? '没有功能分支或标题' : '不能仅凭目录判断项目', repoId, target: 'new' }, a)
  }
  const order: Record<ClusterKind, number> = { target: 0, branch: 1, title: 2, choose: 3, unclear: 4, history: 5 }
  return [...map.values()].sort((a, b) => order[a.kind] - order[b.kind] || b.records.length - a.records.length || a.key.localeCompare(b.key))
}

// 一组的批量请求。新建时整组共用一个标题与项目，后端在同一批次内复用同名同分支工作项。
export function clusterRequests(c: AttributionCluster, opts: { target: string; repoId: number; title: string }, skip: Set<string> = new Set()): AttributionDecision[] | undefined {
  const recs = c.records.filter((a) => !skip.has(a.id))
  if (!recs.length || !opts.target) return undefined
  if (opts.target === 'new') {
    if (!opts.repoId || !opts.title.trim()) return undefined
    return recs.map((a) => ({ id: a.id, fingerprint: a.fingerprint, action: 'create', repo_id: opts.repoId, title: opts.title.trim() }))
  }
  return recs.map((a) => ({ id: a.id, fingerprint: a.fingerprint, action: 'link', work_item_id: opts.target }))
}

export function clusterTitle(snap: Snapshot, c: AttributionCluster): string {
  const s = (snap.sessions ?? []).find((x) => x.id === c.records[0]?.session_id)
  return c.records[0]?.plan.title || s?.title || (c.kind === 'branch' ? c.clue : '')
}
