// “按 Agent 看”：同一个世界按会话来自哪个 Agent（Claude / Codex / 其他）着色和筛选。颜色和小人衣服一致。
import type { Session } from '../types'
import type { BuildingView } from './townModel'

export type Agent = 'claude' | 'codex' | 'other'

export const AGENTS: { key: Agent; label: string; color: string }[] = [
  { key: 'claude', label: 'Claude', color: '#d9774b' },
  { key: 'codex', label: 'Codex', color: '#334055' },
  { key: 'other', label: '其他', color: '#8a7a9e' },
]

export const agentOf = (s: Pick<Session, 'provider'>): Agent => (s.provider === 'claude' || s.provider === 'codex' ? s.provider : 'other')

export type AgentCounts = Record<Agent, number>

/** 一个项目里各 Agent 的会话数（地图上站着的那些）。 */
export function agentCounts(b: BuildingView): AgentCounts {
  const n: AgentCounts = { claude: 0, codex: 0, other: 0 }
  for (const c of b.characters) n[agentOf(c.session)]++
  return n
}

export function sumAgents(list: readonly AgentCounts[]): AgentCounts {
  return list.reduce((s, x) => ({ claude: s.claude + x.claude, codex: s.codex + x.codex, other: s.other + x.other }), { claude: 0, codex: 0, other: 0 })
}

/** 会话最多的 Agent；一个会话都没有时为空。并列时按 Claude、Codex、其他的顺序。 */
export function mainAgent(n: AgentCounts): Agent | null {
  let best: Agent | null = null
  for (const a of AGENTS) if (n[a.key] > 0 && (best == null || n[a.key] > n[best])) best = a.key
  return best
}

/** 图例：每个 Agent 有几个会话、分布在几个项目。 */
export function agentLegend(buildings: readonly BuildingView[]) {
  const per = buildings.map(agentCounts)
  return AGENTS.map((a) => ({ ...a, sessions: per.reduce((s, n) => s + n[a.key], 0), projects: per.filter((n) => n[a.key] > 0).length }))
}

export function agentChips(n: AgentCounts) {
  return AGENTS.filter((a) => n[a.key] > 0).map((a) => ({ text: `${a.label} ${n[a.key]}`, dot: a.color }))
}
