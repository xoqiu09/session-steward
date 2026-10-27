// 小推车的数据：一个项目里，工作从一个 Agent 到另一个 Agent 的交接或接力。只用快照里已有的记录：
//   - 交接：面板里“交接给 Codex / Claude”留下的记录；
//   - 接力：同一个工作项，先后由不同 Agent 的会话运行（后一个在前一个开始之后开始）。
import type { Snapshot } from '../types'
import { agentOf, type Agent } from './agents'

export interface Relay {
  key: string
  repoId: number
  itemId: string
  title: string
  from: Agent
  to: Agent
  at: string
  kind: 'handoff' | 'relay'
}

/** 只看最近这么久的交接和接力。 */
export const RELAY_WINDOW_MS = 24 * 3600_000

/** 交接记录里的接手方是 Agent 名（配置里的名字），按名字认出是哪家。 */
function agentNamed(name: string): Agent {
  const n = name.toLowerCase()
  return n.includes('claude') ? 'claude' : n.includes('codex') ? 'codex' : 'other'
}

export function relaysOf(snap: Snapshot, now: number): Relay[] {
  const items = new Map((snap.work_items ?? []).map((w) => [w.id, w]))
  const out: Relay[] = []
  for (const h of snap.handoffs ?? []) {
    const w = items.get(h.work_item_id)
    if (!w || w.repo_id == null || now - Date.parse(h.created_at) > RELAY_WINDOW_MS) continue
    const from = agentOf({ provider: h.from_provider as never }), to = agentNamed(h.to_agent)
    if (from === to) continue
    out.push({ key: `h-${h.id}`, repoId: w.repo_id, itemId: w.id, title: w.title, from, to, at: h.created_at, kind: 'handoff' })
  }
  const byItem = new Map<string, NonNullable<Snapshot['runs']>>()
  for (const r of snap.runs ?? []) byItem.set(r.work_item_id, [...(byItem.get(r.work_item_id) ?? []), r])
  for (const [id, runs] of byItem) {
    const w = items.get(id)
    if (!w || w.repo_id == null) continue
    runs.sort((a, b) => a.started_at.localeCompare(b.started_at) || a.id - b.id)
    for (let i = 1; i < runs.length; i++) {
      const prev = runs[i - 1], cur = runs[i]
      const from = agentOf({ provider: prev.provider as never }), to = agentOf({ provider: cur.provider as never })
      if (from === to || now - Date.parse(cur.started_at) > RELAY_WINDOW_MS) continue
      // 已经有同一工作项、同方向的交接记录时，不再重复画一次接力
      if (out.some((x) => x.kind === 'handoff' && x.itemId === id && x.from === from && x.to === to)) continue
      out.push({ key: `r-${cur.id}`, repoId: w.repo_id, itemId: id, title: w.title, from, to, at: cur.started_at, kind: 'relay' })
    }
  }
  return out.sort((a, b) => b.at.localeCompare(a.at))
}
