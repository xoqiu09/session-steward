import { describe, expect, it } from 'vitest'
import { activityByRepo, nameFamily, planWorld, projectLinks } from './clusters'
import { worldLayout } from './world'
import { buildTown } from './townModel'
import { fakeItem, fakeRun, fakeSession } from './fixtures'
import type { Repo, Snapshot } from '../types'

const now = Date.parse('2026-10-26T06:00:00Z')
const at = (daysAgo: number) => new Date(now - daysAgo * 86400_000).toISOString()
const repo = (id: number, name: string): Repo => ({ id, name, common_dir: '', is_git: true, target_ref: 'main' })

const repos = [repo(1, 'pixel-ledger'), repo(2, 'pixel-shop'), repo(3, 'garden-notes'), repo(4, 'plant-diary'), repo(5, 'budget-buddy'), repo(6, 'study-cards'), repo(7, 'recipe-box'), repo(8, 'old-notes')]
const snap: Snapshot = {
  cursor: 1, now: at(0), repos,
  sessions: [
    fakeSession({ id: 1, provider: 'claude', state: 'running', repo_id: 1, last_activity_at: at(0) }),
    fakeSession({ id: 2, provider: 'claude', state: 'running', repo_id: 5, last_activity_at: at(0) }),
    fakeSession({ id: 3, provider: 'claude', state: 'ended', repo_id: 8, last_activity_at: at(30) }),
  ],
  work_items: [
    fakeItem({ id: 'P-1', repo_id: 1, title: 'a', status: 'in_progress', updated_at: at(1) }),
    fakeItem({ id: 'P-2', repo_id: 2, title: 'b', status: 'review', updated_at: at(2) }),
    fakeItem({ id: 'G-1', repo_id: 3, title: 'c', status: 'blocked', updated_at: at(1) }),
    fakeItem({ id: 'G-2', repo_id: 4, title: 'd', status: 'in_progress', updated_at: at(3) }),
    fakeItem({ id: 'B-1', repo_id: 5, title: 'e', status: 'in_progress', updated_at: at(1) }),
    fakeItem({ id: 'S-1', repo_id: 6, title: 'f', status: 'in_progress', updated_at: at(4) }),
    fakeItem({ id: 'R-1', repo_id: 7, title: 'g', status: 'in_progress', updated_at: at(1) }),
    fakeItem({ id: 'O-1', repo_id: 8, title: 'h', status: 'review', updated_at: at(30) }),
  ],
  deps: [{ upstream: 'G-1', downstream: 'G-2', cond: 'accepted', satisfied: false }],
  runs: [
    // 同一会话近期在两个项目里都干过活
    fakeRun({ id: 1, work_item_id: 'B-1', session_id: 2, provider: 'claude', started_at: at(1) }),
    fakeRun({ id: 2, work_item_id: 'S-1', session_id: 2, provider: 'claude', started_at: at(2), ended_at: at(2) }),
    // 很久以前同一会话碰过两个项目：不算关联
    fakeRun({ id: 3, work_item_id: 'O-1', session_id: 3, provider: 'claude', started_at: at(40), ended_at: at(30) }),
    fakeRun({ id: 4, work_item_id: 'R-1', session_id: 3, provider: 'claude', started_at: at(40), ended_at: at(30) }),
  ],
  approvals: [],
}

describe('村庄与野外', () => {
  it('名字家族取第一个分隔符前的部分', () => {
    expect(nameFamily('pixel-ledger')).toBe('pixel')
    expect(nameFamily('grok_bot')).toBe('grok')
    expect(nameFamily('ai-town')).toBe('')
  })

  it('近 7 天有活动才算常开发', () => {
    const a = activityByRepo(snap, now)
    expect(a.get(1)).toBeGreaterThan(0)
    expect(a.get(8) ?? 0).toBe(0)
  })

  it('关联只看近期会话和跨项目依赖', () => {
    const links = projectLinks(snap, now)
    expect(links.get('5-6')).toBeGreaterThan(0)
    expect(links.get('3-4')).toBeGreaterThan(0)
    expect(links.has('7-8')).toBe(false)
  })

  it('常开发且相关的成村，常开发但无关联的在中央，不动的去野外', () => {
    const plan = planWorld(repos, snap, now)
    const villages = plan.villages.map((v) => [...v.repoIds].sort((a, b) => a - b))
    expect(villages).toEqual(expect.arrayContaining([[1, 2], [3, 4], [5, 6]]))
    expect(plan.villages.find((v) => v.repoIds.includes(1))!.name).toBe('pixel 村')
    expect(plan.central).toEqual([7])
    expect(plan.wild).toEqual([8])
  })

  it('同样的数据得到同样的布局，村庄成员挨在一起，野外离得更远', () => {
    const model = buildTown(snap, at(0))
    const plan = planWorld(repos, snap, now)
    const a = worldLayout(model.buildings, () => false, plan)
    const b = worldLayout(model.buildings, () => false, planWorld(repos, snap, now))
    expect(a.districts.map((d) => [d.key, d.cell])).toEqual(b.districts.map((d) => [d.key, d.cell]))
    const cells = new Set(a.districts.map((d) => `${d.cell.cx},${d.cell.cy}`))
    expect(cells.size).toBe(a.districts.length)
    for (const v of a.villages) {
      const members = a.districts.filter((d) => d.village === v.key)
      for (const d of members) expect(Math.max(Math.abs(d.cell.cx - v.square.cx), Math.abs(d.cell.cy - v.square.cy))).toBeLessThanOrEqual(2)
    }
    const wild = a.districts.find((d) => d.kind === 'wild')!
    const central = a.districts.find((d) => d.kind === 'central')!
    expect(wild.ring).toBeGreaterThan(central.ring)
  })
})

describe('建筑档次', () => {
  const b = (open: number, sessions = 0) => ({
    key: 'repo-x', repo: repo(9, 'x'), name: 'x', hiddenCharacters: 0, parcels: [],
    items: Array.from({ length: open }, (_, i) => fakeItem({ id: `X-${i}`, repo_id: 9, title: 't', status: 'in_progress' })),
    characters: Array.from({ length: sessions }, () => ({}) as never),
  })
  it('按未完成工作项、近期活动和在场会话分四档', async () => {
    const { buildingTier } = await import('./world')
    expect(buildingTier(b(1) as never)).toBe(0)
    expect(buildingTier(b(4) as never)).toBe(1)
    expect(buildingTier(b(6, 1) as never)).toBe(2)
    expect(buildingTier(b(10, 1), 30)).toBe(3)
  })
})
