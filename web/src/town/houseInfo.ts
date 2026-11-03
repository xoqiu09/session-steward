// 房子信息卡：悬停一栋房子（一个项目）时看的概况。纯函数，只读快照。
// 口径与首页“核心功能实现进度”一致：实现、验证都是 Agent 回报，只有 accepted 才是你验收；
// 回报不一致（conflict）的功能不算已完成。没有登记功能时如实说没有，不猜。
import type { FeatureContribution, ProjectFeature, ProjectStructure, WorkItem } from '../types'
import { AGENTS, agentCounts, type Agent } from './agents'
import { featureSections, type FeatureSection } from './featureCategories'
import type { BuildingView } from './townModel'

export type FeatureGroup = 'done' | 'building' | 'todo'

export const FEATURE_GROUP_LABEL: Record<FeatureGroup, string> = { done: '已完成', building: '开发中', todo: '未开始' }

export interface HouseFeature {
  id: string
  title: string
  group: FeatureGroup
  /** 一句状态，例如“已实现 · Agent 报验证通过”“你已验收”。 */
  status: string
  acceptance: string
  /** 最近一次回报里的卡点；没有就是空串。 */
  blocker: string
  conflict: boolean
  stale: boolean
  accepted: boolean
  reportedPassed: boolean
}

export interface HouseAgent { key: Agent; label: string; color: string; active: number; total: number }

export interface HouseNext { text: string; itemId: string; owner: string; at: string }

export interface HouseInfo {
  name: string
  /** 有会话的 Agent，按 Claude、Codex、其他排。active 只数工作中和等你决定的。 */
  agents: HouseAgent[]
  active: number
  total: number
  groups: Record<FeatureGroup, HouseFeature[]>
  structure: ProjectStructure | null
  purposeMapped: boolean
  sections: FeatureSection[]
  /** 这个项目还没有登记任何核心功能。 */
  empty: boolean
  /** 未完成工作项简报里最新的一条“下一步”。 */
  next: HouseNext | null
}

const IN_PLAY = new Set(['working', 'waiting'])

/** 最近一次回报（按 at）。 */
export function latestContribution(f: ProjectFeature): FeatureContribution | null {
  return f.contributions.reduce<FeatureContribution | null>((best, p) => (!best || p.at > best.at ? p : best), null)
}

/** 功能归到哪一组：accepted 或（已实现且 Agent 报验证通过、无冲突）算已完成。 */
export function featureGroup(f: ProjectFeature): FeatureGroup {
  if (f.accepted) return 'done'
  if (f.implementation === 'implemented' && f.validation === 'passed' && !f.conflict) return 'done'
  if (f.implementation === 'implementing' || f.implementation === 'implemented' || f.implementation === 'conflict') return 'building'
  return 'todo'
}

/** 一句状态文字。 */
export function featureStatus(f: ProjectFeature): string {
  if (f.accepted) return '你已验收'
  if (f.conflict || f.implementation === 'conflict') return '回报不一致，待对齐'
  if (f.implementation === 'implemented') {
    if (f.validation === 'passed') return '已实现 · Agent 报验证通过'
    if (f.validation === 'failed') return '验证失败'
    if (f.validation === 'validating') return '已实现 · 验证中'
    return '已实现 · 待验证'
  }
  if (f.implementation === 'implementing') return f.validation === 'failed' ? '开发中 · 上次验证失败' : '开发中'
  if (f.implementation === 'not_started') return '未开始'
  return '实现待回报'
}

function toHouseFeature(f: ProjectFeature): HouseFeature {
  return {
    id: f.id, title: f.title, group: featureGroup(f), status: featureStatus(f), acceptance: f.acceptance ?? '',
    blocker: latestContribution(f)?.blocker ?? '', conflict: f.conflict, stale: f.stale, accepted: f.accepted,
    reportedPassed: f.implementation === 'implemented' && f.validation === 'passed' && !f.conflict,
  }
}

/** 下一步负责人：你、某个会话、某个 Agent 或外部依赖方。 */
function ownerLabel(b: BuildingView, w: WorkItem): string {
  const o = w.brief?.fields.next_owner
  if (!o || o.flagged) return '负责人待回报'
  if (o.text === 'user') return '你'
  if (o.text === 'external') return '外部依赖方'
  if (o.text === 'claude') return 'Claude'
  if (o.text === 'codex') return 'Codex'
  if (o.text === 'agent') return b.characters.find((c) => c.session.id === o.session_id)?.name ?? 'Agent'
  return '负责人待回报'
}

/** 该项目未完成工作项里，简报“下一步”最新的一条。 */
export function latestNext(b: BuildingView): HouseNext | null {
  let best: HouseNext | null = null
  for (const w of b.items) {
    if (w.status === 'done' || w.status === 'abandoned') continue
    const n = w.brief?.fields.next
    if (!n || n.flagged || !n.text.trim()) continue
    if (!best || n.at > best.at) best = { text: n.text.trim(), itemId: w.id, owner: ownerLabel(b, w), at: n.at }
  }
  return best
}

/** 核心功能回报里留下的下一步（没验收的功能才看），取最新一条。 */
export function featureNext(features: readonly ProjectFeature[]): HouseNext | null {
  let best: HouseNext | null = null
  for (const f of features) {
    if (f.accepted) continue
    const c = latestContribution(f)
    const text = c?.next?.trim()
    if (!c || !text) continue
    const at = c.next_at || c.at
    const owner = c.next_owner === 'user' ? '你' : c.next_owner || 'Agent'
    if (!best || at > best.at) best = { text, itemId: c.work_item_id, owner, at }
  }
  return best
}

export function houseInfo(b: BuildingView, features: readonly ProjectFeature[] | null | undefined, structure?: ProjectStructure | null): HouseInfo {
  const total = agentCounts(b)
  const active = agentCounts({ ...b, characters: b.characters.filter((c) => IN_PLAY.has(c.status)) })
  const agents = AGENTS.filter((a) => total[a.key] > 0).map((a) => ({ ...a, active: active[a.key], total: total[a.key] }))
  const mine = b.repo ? (features ?? []).filter((f) => f.repo_id === b.repo!.id) : []
  const groups: Record<FeatureGroup, HouseFeature[]> = { done: [], building: [], todo: [] }
  for (const f of [...mine].sort((x, y) => x.title.localeCompare(y.title))) {
    const h = toHouseFeature(f)
    groups[h.group].push(h)
  }
  const ownStructure = structure?.repo_id === b.repo?.id ? structure ?? null : null
  const purposes = featureSections(b, Object.values(groups).flat(), ownStructure)
  return {
    name: b.name, agents,
    active: agents.reduce((s, a) => s + a.active, 0), total: agents.reduce((s, a) => s + a.total, 0),
    structure: ownStructure, groups, purposeMapped: purposes.mapped, sections: purposes.sections, empty: mine.length === 0, next: newer(latestNext(b), featureNext(mine)),
  }
}

const newer = (a: HouseNext | null, b: HouseNext | null) => (!a ? b : !b ? a : b.at > a.at ? b : a)

/** “Claude 2 · Codex 1 在做”；有会话但都没在做时给出总数。 */
export function agentLine(info: HouseInfo): string {
  if (info.total === 0) return '现在没有会话'
  const doing = info.agents.filter((a) => a.active > 0).map((a) => `${a.label} ${a.active}`)
  const head = doing.length ? `${doing.join(' · ')} 在做` : '没有 Agent 在做'
  return info.total > info.active ? `${head}（共 ${info.total} 个会话）` : head
}
