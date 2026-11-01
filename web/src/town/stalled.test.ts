import { describe, expect, it } from 'vitest'
import type { Brief, BriefField, Snapshot, WorkItem } from '../types'
import { fakeItem, fakeSession } from './fixtures'
import { STALL_MS, stalledItems, stalledKey } from './stalled'

const NOW = Date.parse('2026-10-29T08:00:00Z')
const ago = (ms: number) => new Date(NOW - ms).toISOString()
const MIN = 60_000, HOUR = 3600_000, DAY = 24 * HOUR

const field = (text: string): BriefField => ({ entry_id: 0, text, kind: 'agent', source: 'report', session_id: null, at: ago(HOUR) })
const brief = (owner: string, next: string, at: string): Brief =>
  ({ fields: { next_owner: field(owner), next: field(next) }, tool_events_since: 0, last_event_at: at, stale: false })
const item = (p: Partial<WorkItem> & Pick<WorkItem, 'id'>): WorkItem =>
  fakeItem({ title: '合成工作', status: 'in_progress', repo_id: 1, updated_at: ago(HOUR), ...p })
const snap = (work_items: WorkItem[], sessions: Snapshot['sessions'] = []): Snapshot => ({ cursor: 1, now: new Date(NOW).toISOString(),
  repos: [{ id: 1, name: '合成花园', common_dir: '', is_git: true, target_ref: 'main' }], work_items, sessions, runs: [], deps: [], approvals: [] })
const ids = (s: Snapshot) => stalledItems(s, NOW).map((x) => x.item.id)

describe('停在你手上的工作', () => {
  it('未满 30 分钟不算，满 30 分钟算', () => {
    expect(ids(snap([item({ id: 'S-1', updated_at: ago(STALL_MS - MIN) })]))).toEqual([])
    expect(ids(snap([item({ id: 'S-1', updated_at: ago(STALL_MS) })]))).toEqual(['S-1'])
  })
  it('关联会话最近有动静时以最新时间为准', () => {
    const w = item({ id: 'S-1', updated_at: ago(2 * HOUR) })
    expect(ids(snap([w], [fakeSession({ id: 1, provider: 'claude', state: 'idle', work_item_id: 'S-1', last_activity_at: ago(10 * MIN) })]))).toEqual([])
  })
  it('有 running 或 waiting_permission 会话不算', () => {
    const w = item({ id: 'S-1' })
    expect(ids(snap([w], [fakeSession({ id: 1, provider: 'claude', state: 'running', work_item_id: 'S-1', last_activity_at: ago(HOUR) })]))).toEqual([])
    expect(ids(snap([w], [fakeSession({ id: 2, provider: 'codex', state: 'waiting_permission', work_item_id: 'S-1', last_activity_at: ago(HOUR) })]))).toEqual([])
  })
  it('下一步归 agent/claude/codex/external 不算；user、unknown、空算', () => {
    const at = ago(HOUR)
    for (const owner of ['agent', 'claude', 'codex', 'external']) expect(ids(snap([item({ id: 'S-1', brief: brief(owner, '', at) })]))).toEqual([])
    for (const owner of ['user', 'unknown', '']) expect(ids(snap([item({ id: 'S-1', brief: brief(owner, '', at) })]))).toEqual(['S-1'])
  })
  it('review、done、abandoned、暂停提醒和自动历史不算', () => {
    expect(ids(snap([
      item({ id: 'S-R', status: 'review' }), item({ id: 'S-D', status: 'done' }), item({ id: 'S-A', status: 'abandoned' }),
      item({ id: 'S-P', management: { state: 'paused' } as WorkItem['management'] }), item({ id: 'S-H', completion_policy: 'auto_history' }),
      item({ id: 'S-T', status: 'todo' }), item({ id: 'S-B', status: 'blocked' }),
    ])).sort()).toEqual(['S-B', 'S-T'])
  })
  it('超过 7 天没动静视为搁置，不提醒', () => {
    expect(ids(snap([item({ id: 'S-1', updated_at: ago(8 * DAY) })]))).toEqual([])
  })
  it('按停滞时长从长到短排序，并给出说明', () => {
    const s = snap([item({ id: 'S-1', updated_at: ago(45 * MIN) }), item({ id: 'S-2', updated_at: ago(3 * DAY), brief: brief('user', '确认配色', ago(2 * HOUR)) })],
      [fakeSession({ id: 1, provider: 'claude', state: 'idle', work_item_id: 'S-2', last_activity_at: ago(3 * DAY) })])
    const got = stalledItems(s, NOW)
    expect(got.map((x) => x.item.id)).toEqual(['S-2', 'S-1'])
    expect(got[0]).toMatchObject({ repoName: '合成花园', idleMs: 2 * HOUR, next: '确认配色', nextOwner: 'user', reason: 'Agent 停了 2 小时，下一步该你：确认配色' })
    expect(got[1].reason).toBe('没人在推，已经 45 分钟没动静')
  })
  it('同一段停滞键稳定，有新动静后键变化', () => {
    const w = item({ id: 'S-1', updated_at: ago(HOUR) })
    const a = stalledItems(snap([w]), NOW)[0], b = stalledItems(snap([w]), NOW + 10 * MIN)[0]
    expect(stalledKey(a)).toBe(stalledKey(b))
    const c = stalledItems(snap([{ ...w, updated_at: ago(40 * MIN) }]), NOW)[0]
    expect(stalledKey(c)).not.toBe(stalledKey(a))
  })
})
