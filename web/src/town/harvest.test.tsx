import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { cropKindOf, cropsOf, harvestResult, ripeQueue } from './harvest'
import { Field } from './field'
import { buildTown } from './townModel'
import { fakeApproval, fakeItem, fakeSession } from './fixtures'
import type { Snapshot } from '../types'

const now = '2026-10-27T06:00:00Z'
const ago = (days: number) => new Date(Date.parse(now) - days * 86400_000).toISOString()
const snap: Snapshot = {
  cursor: 1, now, repos: [{ id: 1, name: 'farm-repo', common_dir: '', is_git: true, target_ref: 'main' }],
  sessions: [fakeSession({ id: 7, provider: 'claude', state: 'waiting_permission', repo_id: 1, work_item_id: 'W-2', last_activity_at: now })],
  work_items: [
    fakeItem({ id: 'R-1', repo_id: 1, title: '熟了', status: 'review', updated_at: ago(0.5) }),
    fakeItem({ id: 'R-2', repo_id: 1, title: '熟太久', status: 'review', updated_at: ago(3) }),
    fakeItem({ id: 'B-1', repo_id: 1, title: '受阻', status: 'blocked' }),
    fakeItem({ id: 'W-1', repo_id: 1, title: '在干', status: 'in_progress' }),
    fakeItem({ id: 'W-2', repo_id: 1, title: '等决定', status: 'in_progress' }),
    fakeItem({ id: 'T-1', repo_id: 1, title: '没开始', status: 'todo' }),
    fakeItem({ id: 'D-1', repo_id: 1, title: '收过了', status: 'done' }),
  ],
  deps: [], runs: [],
  approvals: [fakeApproval({ id: 'A-1', kind: 'decision', status: 'pending', repo_id: 1, session_id: 7, work_item_id: 'W-2' })],
}

describe('菜地', () => {
  const model = buildTown(snap, now)
  const b = model.buildings[0]
  const t = Date.parse(now)

  it('长势对应状态，熟了的排前面，熟太久的发蔫，收过的不在地里', () => {
    const { crops, more } = cropsOf(b, model.pendingApprovals, t)
    expect(crops.map((c) => [c.item.id, c.stage, c.overripe])).toEqual([
      ['R-1', 'ripe', false], ['R-2', 'ripe', true], ['W-2', 'thirsty', false], ['B-1', 'bug', false], ['W-1', 'sprout', false], ['T-1', 'seed', false],
    ])
    expect(more).toBe(0)
  })

  it('同一个项目永远种同一种菜', () => {
    expect(cropKindOf(1)).toBe(cropKindOf(1))
    expect(new Set([1, 2, 3, 4, 5].map(cropKindOf)).size).toBe(5)
  })

  it('收菜顺序先收熟得最久的；之后能看出收下还是退回', () => {
    expect(ripeQueue(model.buildings).map((r) => r.item.id)).toEqual(['R-2', 'R-1'])
    const after = buildTown({ ...snap, work_items: snap.work_items!.map((w) => w.id === 'R-1' ? { ...w, status: 'done' as const } : w.id === 'R-2' ? { ...w, status: 'in_progress' as const } : w) }, now)
    expect(harvestResult('R-1', after.buildings)).toBe('harvested')
    expect(harvestResult('R-2', after.buildings)).toBe('returned')
    expect(harvestResult('R-1', model.buildings)).toBe('pending')
    expect(harvestResult('X-9', model.buildings)).toBe('gone')
  })

  it('画出每棵菜，点它就是打开工作项，没有验收按钮', () => {
    const html = renderToStaticMarkup(<svg><Field gx={0} gy={0} b={b} pending={model.pendingApprovals} now={t} selectedKey={null} onSelect={() => {}} /></svg>)
    expect(html).toContain('R-1 熟了：熟了 · 待你验收')
    expect(html).toContain('熟了很久还没收')
    expect(html).toContain('W-2 等决定：缺水 · 等你决定')
    expect(html).toContain('熟了 2')
    expect(html).not.toMatch(/验收通过|退回修改/)
  })
})
