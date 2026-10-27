import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { InteriorScene, agentZones, zoneBenchSpot } from './InteriorScene'
import { buildTown } from './townModel'
import { fakeItem, fakeRun, fakeSession } from './fixtures'
import type { Snapshot } from '../types'

const now = '2026-10-27T06:00:00Z'
const snap: Snapshot = {
  cursor: 1, now, repos: [{ id: 1, name: 'mix-repo', common_dir: '', is_git: true, target_ref: 'main' }],
  sessions: [
    fakeSession({ id: 1, provider: 'claude', state: 'running', repo_id: 1, work_item_id: 'C-1', last_activity_at: now }),
    fakeSession({ id: 2, provider: 'codex', state: 'running', repo_id: 1, work_item_id: 'X-1', last_activity_at: now }),
  ],
  work_items: [
    fakeItem({ id: 'C-1', repo_id: 1, title: 'Claude 在做', status: 'in_progress' }),
    fakeItem({ id: 'X-1', repo_id: 1, title: 'Codex 在做', status: 'in_progress' }),
    fakeItem({ id: 'X-2', repo_id: 1, title: 'Codex 交付过', status: 'review' }),
    fakeItem({ id: 'U-1', repo_id: 1, title: '还没人碰', status: 'todo' }),
  ],
  deps: [], approvals: [],
  runs: [
    fakeRun({ id: 1, work_item_id: 'C-1', session_id: 1, provider: 'claude' }),
    fakeRun({ id: 2, work_item_id: 'X-1', session_id: 2, provider: 'codex' }),
    fakeRun({ id: 3, work_item_id: 'X-2', session_id: 2, provider: 'codex', ended_at: now }),
  ],
}

describe('项目室内按 Agent 分区', () => {
  const model = buildTown(snap, now)
  const b = model.buildings[0]
  const zones = agentZones(b)!

  it('两个 Agent 时分成左 Claude、右 Codex，工作项按谁在做 / 谁跑过分到各区，没人碰的放到台子少的区', () => {
    expect(zones.map((z) => z.agent)).toEqual(['claude', 'codex'])
    expect(zones[0].items.map((w) => w.id).sort()).toEqual(['C-1', 'U-1'])
    expect(zones[1].items.map((w) => w.id).sort()).toEqual(['X-1', 'X-2'])
    expect(zones[0].gx1).toBe(zones[1].gx0)
  })

  it('同一区里的台子不重叠，也不越出自己的区', () => {
    for (const z of zones) {
      const spots = Array.from({ length: 4 }, (_, i) => zoneBenchSpot(z, 2, i))
      for (const s of spots) { expect(s.gx).toBeGreaterThanOrEqual(z.gx0); expect(s.gx + 3).toBeLessThanOrEqual(z.gx1) }
      for (let i = 0; i < spots.length; i++) for (let j = i + 1; j < spots.length; j++) {
        expect(Math.abs(spots[i].gx - spots[j].gx) >= 3 || Math.abs(spots[i].gy - spots[j].gy) >= 1.1).toBe(true)
      }
    }
  })

  it('只有一个 Agent 时不分区', () => {
    const one = buildTown({ ...snap, sessions: snap.sessions!.slice(0, 1), runs: snap.runs!.slice(0, 1), work_items: snap.work_items!.slice(0, 1) }, now)
    expect(agentZones(one.buildings[0])).toBeNull()
  })

  it('画出两块区名牌', () => {
    const html = renderToStaticMarkup(<InteriorScene b={b} model={model} selected={null} highlight={null} onSelect={() => {}} />)
    expect(html).toContain('Claude 区')
    expect(html).toContain('Codex 区')
  })
})
