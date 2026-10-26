import { describe, expect, test } from 'vitest'
import { MAX_SEATS, buildTown, changedKeys, characterStatus, clip, mergeSnapshot, runPhase, townSignature } from './townModel'
import { demoSnapshot, fakeSession } from './fixtures'
import type { Run, Session, Snapshot } from '../types'

const chars = (snap: Snapshot) => buildTown(snap).buildings.flatMap((b) => b.characters)
const parcels = (snap: Snapshot) => buildTown(snap).buildings.flatMap((b) => b.parcels)

describe('buildTown（合成快照）', () => {
  test('同 provider 的多个会话是不同角色', () => {
    const codex = chars(demoSnapshot).filter((c) => c.session.provider === 'codex')
    expect(codex.map((c) => c.key)).toEqual(['session-21', 'session-22'])
  })

  test('重复的 Run 记录只产生一个包裹，并保留已结束的那条', () => {
    const raw = demoSnapshot.runs!
    expect(raw.length).toBeGreaterThan(new Set(raw.map((r) => r.id)).size)
    const ps = parcels(demoSnapshot)
    expect(ps).toHaveLength(new Set(raw.map((r) => r.id)).size)
    expect(ps.find((p) => p.run.id === 201)!.phase).toBe('failed')
  })

  test('重试是独立包裹', () => {
    const mb3 = parcels(demoSnapshot).filter((p) => p.run.work_item_id === 'MB-3')
    expect(mb3.map((p) => [p.run.attempt, p.phase])).toEqual([[1, 'failed'], [2, 'moving']])
  })

  test('history 会话不当成当前工作，stale 会话显示待更新', () => {
    const town = buildTown(demoSnapshot)
    expect(town.historySessions.map((s) => s.id)).toEqual([9])
    expect(chars(demoSnapshot).some((c) => c.session.id === 9)).toBe(false)
    expect(chars(demoSnapshot).find((c) => c.session.id === 13)!.status).toBe('stale')
  })

  test('空闲会话的任务仍是待验收，不算完成', () => {
    const c12 = chars(demoSnapshot).find((c) => c.session.id === 12)!
    expect(c12.status).toBe('idle')
    expect(c12.item!.status).toBe('review')
  })

  test('只把 pending 审批计为等你决定', () => {
    const town = buildTown(demoSnapshot)
    expect(town.pendingApprovals.map((a) => a.id)).toEqual(['A-1', 'A-2'])
    expect(town.closedApprovals.map((a) => a.status)).toEqual(['expired'])
    expect(town.counts.waiting).toBe(2)
  })

  test('null 数组不会出错', () => {
    const empty: Snapshot = { cursor: 1, now: demoSnapshot.now, repos: null, sessions: null, work_items: null, deps: null, runs: null, approvals: null }
    const town = buildTown(empty)
    expect(town.buildings).toEqual([])
    expect(town.counts).toEqual({ working: 0, waiting: 0, failed: 0, review: 0, stale: 0 })
  })

  test('没有归属项目的会话放进“未归属”', () => {
    const snap = { ...demoSnapshot, sessions: [...demoSnapshot.sessions!, fakeSession({ id: 50, provider: 'claude', state: 'running' })] }
    const none = buildTown(snap).buildings.at(-1)!
    expect(none.key).toBe('repo-none')
    expect(none.characters.map((c) => c.key)).toEqual(['session-50'])
  })

  test('客户端时钟前进后，长时间无活动的 running 会话变成待更新', () => {
    const later = new Date(Date.parse(demoSnapshot.now) + 60 * 60_000).toISOString()
    const running = buildTown(demoSnapshot, later).buildings.flatMap((b) => b.characters).filter((c) => c.session.state === 'running')
    expect(running.length).toBeGreaterThan(0)
    expect(running.every((c) => c.status === 'stale')).toBe(true)
  })
})

describe('每栋建筑最多 3 个工位', () => {
  test('不超过时 hiddenCharacters 为 0', () => {
    expect(buildTown(demoSnapshot).buildings.map((b) => b.hiddenCharacters)).toEqual([0, 0, 0])
  })

  test('超过时记下没画出的数量，角色本身仍全部保留', () => {
    const extra = [51, 52, 53].map((id) => fakeSession({ id, provider: 'codex', state: 'running', repo_id: 1 }))
    const b = buildTown({ ...demoSnapshot, sessions: [...demoSnapshot.sessions!, ...extra] }).buildings.find((x) => x.key === 'repo-1')!
    expect(MAX_SEATS).toBe(3)
    expect(b.characters).toHaveLength(5)
    expect(b.hiddenCharacters).toBe(2)
  })
})

describe('mergeSnapshot', () => {
  test('旧 cursor 不覆盖新快照', () => {
    const newer = { ...demoSnapshot, cursor: 50 }
    const older = { ...demoSnapshot, cursor: 49 }
    expect(mergeSnapshot(newer, older)).toBe(newer)
    expect(mergeSnapshot(older, newer)).toBe(newer)
    expect(mergeSnapshot(null, older)).toBe(older)
  })
})

describe('runPhase', () => {
  const base: Run = { id: 1, work_item_id: 'X', session_id: 1, provider: 'claude', attempt: 1, binding: '', started_at: '2026-10-26T05:00:00Z', ended_at: '', outcome: '' }
  test('未结束为运行中；未知 outcome 不猜测成功', () => {
    expect(runPhase(base)).toBe('moving')
    expect(runPhase({ ...base, ended_at: base.started_at, outcome: 'delivered' })).toBe('delivered')
    expect(runPhase({ ...base, ended_at: base.started_at, outcome: 'failed: tests' })).toBe('failed')
    expect(runPhase({ ...base, ended_at: base.started_at, outcome: 'something-new' })).toBe('other')
  })
})

describe('characterStatus', () => {
  const s: Session = demoSnapshot.sessions!.find((x) => x.id === 22)!
  const now = Date.parse(demoSnapshot.now)
  test('running 但长时间无活动视为待更新', () => {
    expect(characterStatus(s, [], now)).toBe('working')
    expect(characterStatus({ ...s, last_activity_at: '2026-10-26T04:00:00Z' }, [], now)).toBe('stale')
  })
})

describe('clip', () => {
  test('超长按字符截断并加省略号', () => {
    expect(clip('short', 18)).toBe('short')
    expect(clip('a-very-long-repository-name', 18)).toBe('a-very-long-repos…')
    expect(Array.from(clip('一二三四五六七八九十一二三四五六七八九十', 18))).toHaveLength(18)
  })
})

describe('changedKeys', () => {
  test('只标出状态变化或新出现的对象', () => {
    const before = townSignature(buildTown(demoSnapshot))
    const sessions = demoSnapshot.sessions!.map((s) => (s.id === 21 ? { ...s, state: 'running' as const } : s))
    const approvals = demoSnapshot.approvals!.filter((a) => a.id !== 'A-1')
    const after = townSignature(buildTown({ ...demoSnapshot, cursor: 43, sessions, approvals }))
    expect([...changedKeys(before, after)]).toEqual(['session-21'])
    expect(changedKeys(null, after).size).toBe(0)
  })
})
