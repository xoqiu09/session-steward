import { describe, expect, test } from 'vitest'
import { acceptSnapshot } from './feed'
import { buildTown } from './townModel'
import { demoSnapshot, fakeRun } from './fixtures'
import type { Snapshot } from '../types'

const at = (min: number) => new Date(Date.parse(demoSnapshot.now) + min * 60_000).toISOString()

// #43：批准送达，Codex #21 继续工作。#44：小猫第 2 次失败并开始第 3 次。
const s42 = demoSnapshot
const s43: Snapshot = {
  ...s42, cursor: 43, now: at(2),
  sessions: s42.sessions!.map((s) => (s.id === 21 ? { ...s, state: 'running', state_reason: '', last_activity_at: at(2) } : s)),
  approvals: s42.approvals!.map((a) => (a.id === 'A-1' ? { ...a, status: 'delivered', decision: 'allow', decided_at: at(1), delivered_at: at(2) } : a)),
}
const s44: Snapshot = {
  ...s43, cursor: 44, now: at(4),
  runs: [
    ...s43.runs!.map((r) => (r.id === 202 ? { ...r, ended_at: at(4), outcome: 'failed' } : r)),
    fakeRun({ id: 203, work_item_id: 'MB-3', session_id: 31, provider: 'other', attempt: 3, started_at: at(4) }),
  ],
}

const parcelKeys = (snap: Snapshot) => buildTown(snap).buildings.flatMap((b) => b.parcels).map((p) => p.key).sort()

describe('acceptSnapshot', () => {
  test('第一版直接接受', () => {
    expect(acceptSnapshot(null, s42, false)).toEqual({ snap: s42, verdict: 'accepted' })
  })

  test('更大的 cursor 接受', () => {
    expect(acceptSnapshot(s42, s43, false)).toEqual({ snap: s43, verdict: 'accepted' })
  })

  test('重复快照被忽略，包裹不变', () => {
    const r = acceptSnapshot(s44, { ...s44 }, false)
    expect(r.verdict).toBe('duplicate')
    expect(r.snap).toBe(s44)
    expect(parcelKeys(r.snap)).toEqual(parcelKeys(s44))
  })

  test('迟到的旧快照被丢弃，不回退画面', () => {
    const r = acceptSnapshot(s44, s43, false)
    expect(r.verdict).toBe('stale')
    expect(r.snap.cursor).toBe(44)
  })

  test('服务端重置后 cursor 回退也接受', () => {
    const fresh = { ...s42, cursor: 1 }
    expect(acceptSnapshot(s44, fresh, true)).toEqual({ snap: fresh, verdict: 'accepted' })
    expect(acceptSnapshot(s44, s44, true).verdict).toBe('accepted')
  })

  test('乱序到达时每一步包裹数都等于不同的 run id 数', () => {
    let cur: Snapshot | null = null
    const verdicts: string[] = []
    for (const next of [s42, s43, s44, s44, s43]) {
      const r = acceptSnapshot(cur, next, false)
      verdicts.push(r.verdict)
      cur = r.snap
      expect(parcelKeys(cur)).toHaveLength(new Set(cur.runs!.map((x) => x.id)).size)
    }
    expect(verdicts).toEqual(['accepted', 'accepted', 'accepted', 'duplicate', 'stale'])
    expect(cur!.cursor).toBe(44)
  })

  test('失败重试是三个独立包裹', () => {
    const mb3 = buildTown(s44).buildings.flatMap((b) => b.parcels).filter((p) => p.run.work_item_id === 'MB-3').map((p) => [p.run.attempt, p.phase])
    expect(mb3).toEqual([[1, 'failed'], [2, 'failed'], [3, 'moving']])
  })

  test('批准送达后告示卡下板，会话回到工作中', () => {
    const town = buildTown(s43)
    expect(town.pendingApprovals.map((a) => a.id)).toEqual(['A-2'])
    expect(town.buildings.flatMap((b) => b.characters).find((c) => c.key === 'session-21')!.status).toBe('working')
  })
})
