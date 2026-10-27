import { describe, expect, it } from 'vitest'
import { agentChips, agentCounts, agentLegend, agentOf, mainAgent, sumAgents } from './agents'
import { buildTown } from './townModel'
import { fakeSession } from './fixtures'
import type { Snapshot } from '../types'

const now = '2026-10-26T06:00:00Z'
const repo = (id: number, name: string) => ({ id, name, common_dir: '', is_git: true, target_ref: 'main' })
const snap: Snapshot = {
  cursor: 1, now, repos: [repo(1, 'a-repo'), repo(2, 'b-repo')],
  sessions: [
    fakeSession({ id: 1, provider: 'claude', state: 'running', repo_id: 1, last_activity_at: now }),
    fakeSession({ id: 2, provider: 'codex', state: 'running', repo_id: 1, last_activity_at: now }),
    fakeSession({ id: 3, provider: 'codex', state: 'running', repo_id: 1, last_activity_at: now }),
    fakeSession({ id: 4, provider: 'gemini', state: 'running', repo_id: 2, last_activity_at: now }),
  ],
  work_items: [], deps: [], runs: [], approvals: [],
}

describe('按 Agent 看', () => {
  const model = buildTown(snap, now)
  const byName = (n: string) => model.buildings.find((b) => b.name === n)!

  it('Claude、Codex 以外都算其他', () => {
    expect(agentOf({ provider: 'claude' })).toBe('claude')
    expect(agentOf({ provider: 'gemini' })).toBe('other')
  })

  it('按项目数会话，主 Agent 取会话最多的', () => {
    const a = agentCounts(byName('a-repo'))
    expect(a).toEqual({ claude: 1, codex: 2, other: 0 })
    expect(mainAgent(a)).toBe('codex')
    expect(mainAgent({ claude: 0, codex: 0, other: 0 })).toBeNull()
    expect(agentChips(a).map((c) => c.text)).toEqual(['Claude 1', 'Codex 2'])
  })

  it('图例给出每个 Agent 的会话数和项目数，村庄合计相加', () => {
    const legend = agentLegend(model.buildings)
    expect(legend.map((l) => [l.label, l.sessions, l.projects])).toEqual([['Claude', 1, 1], ['Codex', 2, 1], ['其他', 1, 1]])
    expect(sumAgents([agentCounts(byName('a-repo')), agentCounts(byName('b-repo'))])).toEqual({ claude: 1, codex: 2, other: 1 })
  })
})
