import { describe, expect, it } from 'vitest'
import type { Snapshot } from '../types'
import { fakeApproval, fakeItem, fakeSession } from './fixtures'
import { autoMoment, canAutoFollow, DEFAULT_FOLLOW, handledElsewhere, localMoment, momentsBetween, momentsWhileAway, OVERDUE_MS, overdueRipe, stalledMoments, updateMomentQueue, waitedText, type FollowGuard } from './moments'

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

describe('熟了没收的再提醒', () => {
  const at = Date.parse(later)
  it('不到 30 分钟不提醒，超过后提醒一条，键随交付时间变化', () => {
    expect(overdueRipe(review(), at + OVERDUE_MS - 1)).toEqual([])
    const [m] = overdueRipe(review(), at + OVERDUE_MS + 5 * 60_000)
    expect(m).toMatchObject({ kind: 'ripe', itemId: 'DEMO-1', at: later })
    expect(m.message).toBe('合成花园：DEMO-1 熟了 35 分钟，还没收')
    const again = { ...review(), work_items: [{ ...review().work_items![0], brief: { fields: {}, last_delivered_at: '2026-10-29T09:00:00Z', tool_events_since: 0, last_event_at: '', stale: false } }] }
    expect(overdueRipe(again, Date.parse('2026-10-29T10:00:00Z'))[0].key).not.toBe(m.key)
  })
  it('只看待验收：收下、退回或进行中的都不提醒', () => {
    for (const status of ['done', 'in_progress', 'abandoned'] as const)
      expect(overdueRipe({ ...review(), work_items: [{ ...item, status, updated_at: later }] }, at + 2 * OVERDUE_MS)).toEqual([])
  })
  it('等待时间写成分钟、小时、天', () => {
    expect(waitedText(30_000)).toBe('1 分钟')
    expect(waitedText(59 * 60_000)).toBe('59 分钟')
    expect(waitedText(3 * 3600_000)).toBe('3 小时')
    expect(waitedText(72 * 3600_000)).toBe('3 天')
  })
})

describe('交付后你回来过', () => {
  const delivered = (returned?: string): Snapshot => ({ ...review(), cursor: 3, work_items: [{ ...review().work_items![0],
    brief: { fields: {}, last_delivered_at: later, tool_events_since: 0, last_event_at: '', stale: false }, ...(returned ? { returned_at: returned } : {}) }] })
  it('回到会话后问一次，同一时间不重复，晚于交付才算', () => {
    const back = '2026-10-29T08:05:00Z'
    const [m] = momentsBetween(delivered(), delivered(back))
    expect(m).toMatchObject({ kind: 'returned', itemId: 'DEMO-1', at: back })
    expect(m.message).toContain('这件算处理了吗')
    expect(momentsBetween(delivered(back), delivered(back))).toEqual([])
    expect(momentsBetween(delivered(), delivered('2026-10-29T07:00:00Z'))).toEqual([])
    expect(autoMoment(m, DEFAULT_FOLLOW)).toBe(true)
  })
  it('收下或退回后提示失效；离开期间回来过也会补上', () => {
    const back = '2026-10-29T08:05:00Z'
    const [m] = momentsBetween(delivered(), delivered(back))
    expect(updateMomentQueue([m], [], { ...delivered(back), work_items: [{ ...delivered(back).work_items![0], status: 'done' }] })).toEqual([])
    expect(momentsWhileAway(delivered(back), Date.parse(now)).map((x) => x.kind)).toContain('returned')
  })
})

describe('停在你手上', () => {
  it('没人在推满 30 分钟才提醒，带项目和下一步；有新动静后提示失效', () => {
    const idle: Snapshot = { ...before, work_items: [{ ...item, updated_at: now }] }
    expect(stalledMoments(idle, Date.parse(now) + 29 * 60_000)).toEqual([])
    const [m] = stalledMoments(idle, Date.parse(now) + 31 * 60_000)
    expect(m).toMatchObject({ kind: 'stalled', itemId: 'DEMO-1', buildingKey: 'repo-1', local: true })
    expect(m.message).toMatch(/^合成花园：DEMO-1 /)
    expect(autoMoment(m, DEFAULT_FOLLOW)).toBe(true)
    const moved = { ...idle, now: '2099-01-01T00:00:00Z', work_items: [{ ...item, status: 'done' as const, updated_at: later }] }
    expect(updateMomentQueue([m], [], moved)).toEqual([])
  })
})

describe('在原会话处理掉的回执', () => {
  const session = { ...fakeSession({ id: 5, provider: 'codex', state: 'running' }), repo_id: 1 }
  const waiting = (status: 'pending' | 'cancelled' | 'confirmed', close_reason = '', kind: 'decision' | 'permission' | 'attention' = 'decision', preview = '断网提示放顶部还是表格里？') =>
    fakeApproval({ id: 'Q-1', kind, status, close_reason, session_id: 5, repo_id: 1, preview })
  const at = (cursor: number, a: ReturnType<typeof waiting>): Snapshot => ({ ...before, cursor, sessions: [session], approvals: [a] })
  it('回了话、终端里批了命令、答了原生提问都给回执，带 Agent 和内容', () => {
    for (const reason of ['user_replied', 'resolved_elsewhere', 'answered_in_session']) {
      const [r] = handledElsewhere(at(1, waiting('pending')), at(2, waiting('cancelled', reason)))
      expect(r).toMatchObject({ key: 'Q-1', local: true })
      expect(r.message).toBe('已在 Codex 里处理：“断网提示放顶部还是表格里？”')
    }
    expect(handledElsewhere(at(1, waiting('pending', '', 'permission', '')), at(2, waiting('cancelled', 'resolved_elsewhere', 'permission', '')))[0].message).toBe('已在 Codex 里处理：一条命令')
  })
  it('面板里点掉的、超时的、首屏和旧快照都不给', () => {
    expect(handledElsewhere(at(1, waiting('pending')), at(2, waiting('cancelled', 'dismissed')))).toEqual([])
    expect(handledElsewhere(at(1, waiting('pending')), at(2, waiting('cancelled', 'timeout')))).toEqual([])
    expect(handledElsewhere(at(1, waiting('pending')), at(2, waiting('confirmed')))).toEqual([])
    expect(handledElsewhere(null, at(2, waiting('cancelled', 'user_replied')))).toEqual([])
    expect(handledElsewhere(at(1, waiting('cancelled', 'user_replied')), at(2, waiting('cancelled', 'user_replied')))).toEqual([])
  })
})
