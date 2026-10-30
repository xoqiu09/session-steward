import { describe, expect, it } from 'vitest'
import type { Snapshot } from '../types'
import { fakeApproval, fakeItem } from './fixtures'
import { autoMoment, canAutoFollow, DEFAULT_FOLLOW, localMoment, momentsBetween, momentsWhileAway, updateMomentQueue, type FollowGuard } from './moments'

const now = '2026-10-29T08:00:00Z'
const later = '2026-10-29T08:01:00Z'
const item = fakeItem({ id: 'DEMO-1', repo_id: 1, title: '合成菜地', status: 'in_progress', updated_at: now })
const before: Snapshot = { cursor: 1, now, repos: [{ id: 1, name: '合成花园', common_dir: '', is_git: true, target_ref: 'main' }],
  work_items: [item], sessions: [], runs: [], deps: [], approvals: [] }
const review = (): Snapshot => ({ ...before, cursor: 2, now: later, work_items: [{ ...item, status: 'review', updated_at: later }] })

describe('小镇新时刻', () => {
  it('首次加载不把已有熟菜当作新时刻', () => expect(momentsBetween(null, review())).toEqual([]))
  it('进行中到待验收只产生一次熟菜，重复和同状态更新时间不再触发', () => {
    const after = review(), moments = momentsBetween(before, after)
    expect(moments.map((m) => m.kind)).toEqual(['ripe'])
    expect(momentsBetween(after, after)).toEqual([])
    expect(momentsBetween(after, { ...after, work_items: [{ ...after.work_items![0], updated_at: '2026-10-29T08:02:00Z' }] })).toEqual([])
    expect(updateMomentQueue(moments, moments, after)).toHaveLength(1)
  })
  it('同时出现权限、熟菜和合并时按优先级排列', () => {
    const after = review()
    after.work_items![0] = { ...after.work_items![0], merge_state: 'merged' }
    after.approvals = [fakeApproval({ id: 'DEMO-A', kind: 'permission', status: 'pending', repo_id: 1, work_item_id: item.id, created_at: later })]
    expect(momentsBetween(before, after).map((m) => m.kind)).toEqual(['decision', 'ripe', 'merged'])
  })
  it('远端工作入队，但不能自动飞；空设备身份和偏移审批也不会误判本机', () => {
    const after = review()
    after.repos = [{ ...after.repos![0], device: '另一台电脑' }]
    const moments = momentsBetween(before, after)
    expect(moments[0].local).toBe(false)
    expect(updateMomentQueue([], moments, after)).toHaveLength(1)
    expect(autoMoment(moments[0], DEFAULT_FOLLOW)).toBe(false)
    expect(localMoment(after, 1)).toBe(false)
    expect(localMoment(before, null, undefined, 1_000_000_020)).toBe(false)
    after.devices = [{ id: 'self', name: '另一台电脑', self: true, online: true, received_at: later }]
    expect(localMoment(after, 1)).toBe(true)
  })
  it('在别处已验收、已退回、已关闭或消失的时刻会自动离开队列', () => {
    const after = review()
    after.approvals = [fakeApproval({ id: 'DEMO-A', kind: 'decision', status: 'pending', repo_id: 1, created_at: later })]
    const moments = momentsBetween(before, after)
    expect(updateMomentQueue(moments, [], { ...after, work_items: [{ ...item, status: 'done' }], approvals: [] })).toEqual([])
    expect(updateMomentQueue(moments, [], { ...before })).toEqual([])
  })
  it('过期权限、暂停工作、自动历史、旧快照和旧记录不产生熟菜提醒', () => {
    const after = review()
    after.approvals = [fakeApproval({ id: 'DEMO-OLD', kind: 'permission', status: 'pending', deadline: now })]
    after.work_items = [{ ...after.work_items![0], completion_policy: 'auto_history' }]
    expect(momentsBetween(before, after)).toEqual([])
    expect(momentsBetween(review(), before)).toEqual([])
    expect(momentsBetween(before, { ...review(), work_items: [{ ...item, status: 'review', updated_at: '2026-10-28T00:00:00Z' }] })).toEqual([])
  })
  it('Agent 新回报和种子发芽只产生低优先级进展，合并默认不自动飞', () => {
    const report = { ...item, brief: { fields: { progress: { entry_id: 1, text: '合成进展', source: 'report', kind: 'agent' as const, session_id: 1, at: later } }, tool_events_since: 0, last_event_at: later, stale: false } }
    expect(momentsBetween(before, { ...before, work_items: [report] }).map((m) => m.kind)).toEqual(['progress'])
    expect(momentsBetween({ ...before, work_items: [{ ...item, status: 'todo' }] }, before).map((m) => m.kind)).toEqual(['progress'])
    const merged = momentsBetween(before, { ...before, work_items: [{ ...item, merge_state: 'merged' }] })[0]
    expect(autoMoment(merged, DEFAULT_FOLLOW)).toBe(false)
    expect(autoMoment(merged, { enabled: true, includeMerged: true })).toBe(true)
  })
  it('离开期间只列上次看过后的熟菜和待决定，第一次没有时间就不补旧状态', () => {
    const after = review()
    after.approvals = [fakeApproval({ id: 'DEMO-A', kind: 'decision', status: 'pending', created_at: later })]
    expect(momentsWhileAway(after, null)).toEqual([])
    expect(momentsWhileAway(after, Date.parse(now)).map((m) => m.kind)).toEqual(['decision', 'ripe'])
    expect(momentsWhileAway(after, Date.parse(later))).toEqual([])
  })
})

describe('自动取景保护', () => {
  const guard: FollowGuard = { now: 60_000, lastTouch: 0, lastFlight: 0, paused: false, inside: false, harvesting: false, replaying: false, guide: false, hidden: false, offline: false, presenting: false }
  it('30 秒操作保护和至少 3 秒飞行间隔都满足才可以飞', () => {
    expect(canAutoFollow(guard)).toBe(true)
    expect(canAutoFollow({ ...guard, lastTouch: 30_001 })).toBe(false)
    expect(canAutoFollow({ ...guard, lastFlight: 57_001 })).toBe(false)
  })
  it.each(['paused', 'inside', 'harvesting', 'replaying', 'guide', 'hidden', 'offline', 'presenting'] as const)('%s 状态保护镜头', (key) => {
    expect(canAutoFollow({ ...guard, [key]: true })).toBe(false)
  })
})
