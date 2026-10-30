import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import type { Approval, BriefField, FeatureContribution, ProjectFeature, Session, Snapshot, WorkItem } from '../types'
import { buildToday } from './todayModel'
import { TodayView } from './TodayView'
import { itemSignal, reportedHandoffs } from '../model'
import { liveSummary } from '../live'

// 合成数据：编出来的项目和工作，不来自任何真实项目。
const NOW = '2026-10-28T10:00:00Z'
const t = (min: number) => new Date(Date.parse(NOW) - min * 60_000).toISOString()
const bf = (text: string, min: number, extra: Partial<BriefField> = {}): BriefField => ({ entry_id: min, text, kind: 'agent', source: 'report', session_id: 1, at: t(min), ...extra })
const item = (id: string, title: string, extra: Partial<WorkItem> = {}): WorkItem => ({
  id, repo_id: 1, title, status: 'in_progress', acceptance: '', branch: '', merge_state: 'none', needs_merge: false,
  created_at: t(600), updated_at: t(30), ready: true, waiting: [], agents: ['claude'], ...extra,
})
const brief = (fields: Partial<Record<string, BriefField>>, extra: Partial<NonNullable<WorkItem['brief']>> = {}) => ({ fields, tool_events_since: 0, last_event_at: t(5), stale: false, ...extra })
const contribution = (work_item_id: string, extra: Partial<FeatureContribution>): FeatureContribution => ({
  id: 'f', candidate: 'c1', session_id: 1, run_id: 1, work_item_id, provider: 'claude', at: t(40), active: true, ...extra,
})
const feature = (id: string, title: string, contributions: FeatureContribution[]): ProjectFeature => ({
  repo_id: 1, id, title, acceptance: '', scope_basis: '', scope_status: 'documented', scope_version: '', candidate: 'c1', revision: 'r1',
  implementation: 'implemented', validation: 'passed', conflict: false, stale: false, accepted: false, work_item_ids: contributions.map((c) => c.work_item_id), contributions,
})
const session = (id: number, extra: Partial<Session>) => ({ id, provider: 'claude', data_source: 'live', freshness: 'live', state: 'running', work_item_id: '', last_activity_at: t(1), resume_command: 'claude --resume syn', ...extra }) as Session

const snap: Snapshot = {
  cursor: 1, now: NOW,
  repos: [{ id: 1, name: '博客迁移', common_dir: '', is_git: true, target_ref: 'main' }],
  work_items: [
    item('BLOG-3', '迁移旧文章里的图片', { status: 'review', branch: 'steward/blog-3', brief: brief({ summary: bf('37 篇文章的图片都搬到了新存储', 50, { source: 'deliver' }) }, { last_delivered_at: t(50) }) }),
    item('DASH-2', '首页加载太慢', { status: 'review', brief: brief({ summary: bf('首页快多了', 20, { source: 'deliver' }) }, { last_delivered_at: t(20) }) }),
    item('BOOK-9', '负数金额显示错误', { status: 'review', brief: brief({ progress: bf('已修复', 10, { source: 'deliver' }) }, { last_delivered_at: t(10) }) }),
    item('BLOG-5', '评论系统', { ready: false, waiting: ['BLOG-3'] }),
    item('DASH-4', '接入支付回调', { status: 'blocked', brief: brief({ blocker: bf('沙箱账号还没批下来', 2880), next: bf('申请测试账号', 2880) }) }),
    item('BOOK-1', '整理分类', { brief: brief({ progress: bf('在改分类表', 400) }, { stale: true }) }),
    item('BOOK-2', '导出 CSV', { brief: brief({ progress: bf('写好导出', 5) }) }),
    item('BOOK-8', '发布测试版', {}),
    item('BLOG-4', '旧链接跳转', { brief: brief({ next_owner: bf('user', 120), next: bf('决定旧链接要不要做 301 跳转', 120) }) }),
    item('OLD-1', '昨天验收的', { status: 'done', updated_at: t(120) }),
    item('BLOG-6', '还没开工的标签页', { status: 'todo', ready: false, waiting: ['BLOG-3'] }),
  ],
  features: [
    feature('img', '图片迁移', [contribution('BLOG-3', { validation: 'passed', evidence: 'go test ./... 42/42' })]),
    feature('neg', '负数显示', [contribution('BOOK-9', { validation: 'failed', evidence: '11/12，1 项失败' })]),
  ],
  sessions: [session(1, { work_item_id: 'BOOK-8' }), session(2, {}), session(3, { state: 'ended' })],
  approvals: [{ id: 'A1', kind: 'permission', status: 'pending', session_id: 1, work_item_id: 'BOOK-8', repo_id: 1, fingerprint: 'fp', tool_name: 'Bash', preview: 'npm publish --tag beta', decision: '', handleable: true, payload: {}, close_reason: '', deadline: t(-3), created_at: t(12), decided_at: '', delivered_at: '', confirmed_at: '', closed_at: '' } as Approval,
    { id: 'M1', kind: 'merge', status: 'pending', session_id: null, work_item_id: 'BLOG-3', repo_id: 1, fingerprint: 'm', tool_name: '', preview: '', decision: '', handleable: true,
      payload: { repo_id: 1, source_ref: 'steward/blog-3', source_head_sha: 'a1', target_ref: 'main', target_base_sha: 'b2', ahead: 2, diffstat: '' }, close_reason: '', deadline: '', created_at: t(45), decided_at: '', delivered_at: '', confirmed_at: '', closed_at: '' } as Approval],
  deps: [], runs: [],
}

describe('每日十分钟的四件事', () => {
  const today = buildToday(snap, '')
  it('要你决定：权限请求和 Agent 交给你的下一步', () => {
    expect(today.decide.map((d) => d.kind)).toEqual(['permission', 'handoff'])
    const h = today.decide.find((d) => d.kind === 'handoff')
    expect(h?.kind === 'handoff' && h.need).toBe('决定旧链接要不要做 301 跳转')
  })
  it('待验收按证据排：有通过的验证在前，只有自述居中，验证失败在后', () => {
    expect(today.review.map((r) => [r.item.id, r.grade])).toEqual([['BLOG-3', 'ok'], ['DASH-2', 'missing'], ['BOOK-9', 'failed']])
    expect(today.review[0].evidence.map((e) => e.label)).toEqual(['图片迁移：验证通过', '分支 steward/blog-3'])
    expect(today.review[0].said?.text).toBe('37 篇文章的图片都搬到了新存储')
  })
  it('合并审批挂在对应的验收行上，不在要你决定里重复列', () => {
    expect(today.review[0].merge?.primary.id).toBe('M1')
    expect(today.decide.some((d) => d.kind === 'merge')).toBe(false)
  })
  it('分支本身不算证据', () => {
    expect(buildToday({ ...snap, features: [] }, '').review.find((r) => r.item.id === 'BLOG-3')?.grade).toBe('missing')
  })
  it('卡住了：写明卡点，等的上游正在等你验收时指过去', () => {
    const byId = Object.fromEntries(today.stuck.map((s) => [s.item.id, s]))
    expect(Object.keys(byId).sort()).toEqual(['BLOG-5', 'BOOK-1', 'DASH-4'])
    expect(byId['BLOG-5'].upstreamInReview).toBe('BLOG-3')
    expect(byId['DASH-4'].reason).toBe('沙箱账号还没批下来')
    expect(byId['DASH-4'].next).toBe('申请测试账号')
    expect(byId['BOOK-1'].label).toBe('很久没回报进展')
    expect(byId['BLOG-6']).toBeUndefined()
  })
  it('其余不用管的只给数：进行中、最近验收过、没登记任务的会话', () => {
    expect(today.running.map((w) => w.id)).toEqual(['BOOK-2'])
    expect(today.acceptedSince.map((w) => w.id)).toEqual(['OLD-1'])
    expect(today.unregistered).toBe(1)
  })
  it('看过以后只有之后的交付标“新”', () => {
    const fresh = buildToday(snap, t(30)).review.filter((r) => r.fresh).map((r) => r.item.id)
    expect(fresh.sort()).toEqual(['BOOK-9', 'DASH-2'])
  })
})

describe('用户管理日常提醒', () => {
  it('keeps paused/delegated work out of stuck, running, review and advisory counts, with a restore section', () => {
    const changed: Snapshot = { ...snap, work_items: snap.work_items!.map(w => ['DASH-4', 'BLOG-4', 'DASH-2', 'BOOK-2'].includes(w.id) ? { ...w, management: { state: 'delegated', owner: '合成接手人', note: '已交给另一个会话', at: NOW } } : w) }
    const t = buildToday(changed, '')
    expect(t.stuck.some(s => s.item.id === 'DASH-4')).toBe(false)
    expect(t.review.some(s => s.item.id === 'DASH-2')).toBe(false)
    expect(t.running.some(w => w.id === 'BOOK-2')).toBe(false)
    expect(t.decide.some(d => d.kind === 'handoff' && d.item.id === 'BLOG-4')).toBe(false)
    expect(t.managed).toHaveLength(4)
    expect(liveSummary(changed).blocked).toBe(liveSummary(snap).blocked - 1)
    const w = changed.work_items!.find(w => w.id === 'BLOG-4')!
    expect(reportedHandoffs(changed, w)).toEqual([])
    expect(itemSignal(changed, w).label).toBe('已转交给 合成接手人')
    const html = renderToStaticMarkup(<TodayView snap={changed} onSelectItem={() => {}} onOpenTown={() => {}} />)
    expect(html).toContain('已转交或暂停提醒 4 件')
    expect(html).toContain('展开管理 / 恢复')
    expect(html).toContain('管理状态 DASH-4')
  })
  it('preserves formal permission and merge requests on paused work', () => {
    const changed: Snapshot = { ...snap, work_items: snap.work_items!.map(w => ({ ...w, management: { state: 'paused', at: NOW } })) }
    const t = buildToday(changed, '')
    expect(t.decide.map(d => d.kind)).toEqual(['permission', 'merge'])
    expect(t.stuck).toHaveLength(0)
    expect(t.review).toHaveLength(0)
    expect(itemSignal(changed, changed.work_items!.find(w => w.id === 'BOOK-8')!).label).toBe('待你批准')
  })
  it('acceptance keeps old blockers out of the active queues without losing history data', () => {
    const changed: Snapshot = { ...snap, work_items: snap.work_items!.map(w => w.id === 'DASH-4' ? { ...w, status: 'done', management: { state: 'accepted', at: NOW } } : w) }
    const t = buildToday(changed, '')
    expect(t.stuck.some(s => s.item.id === 'DASH-4')).toBe(false)
    expect(t.acceptedSince.some(w => w.id === 'DASH-4')).toBe(true)
    expect(changed.work_items!.find(w => w.id === 'DASH-4')!.brief?.fields.blocker?.text).toBe('沙箱账号还没批下来')
  })
})

describe('TodayView', () => {
  it('每件交付旁边直接能标记已处理和退回，证据和 Agent 说的分开写', () => {
    const html = renderToStaticMarkup(<TodayView snap={snap} onSelectItem={() => {}} onOpenTown={() => {}} />)
    expect(html).toContain('要你决定')
    expect(html).toContain('有交付，等你处理')
    expect(html).not.toContain('做完了，等你验收')
    expect(html).toContain('npm publish --tag beta')
    expect(html).toContain('允许这一次')
    expect((html.match(/>已处理</g) ?? []).length).toBe(3)
    expect(html).toContain('Agent 说：')
    expect(html).toContain('有验证失败')
    expect(html).toContain('只有 Agent 自述')
    expect(html).toContain('BLOG-3 就在上面等你处理')
    expect(html).toContain('合并待你批准')
    expect(html).toContain('批准合并')
    expect(html).not.toContain('没有要你处理的事')
  })
  it('没事的时候直接说没事', () => {
    const quiet = { ...snap, work_items: [], approvals: [], features: [] }
    expect(renderToStaticMarkup(<TodayView snap={quiet} onSelectItem={() => {}} onOpenTown={() => {}} />)).toContain('没有要你处理的事')
  })
  it('多设备时写明这一页只列本机', () => {
    expect(renderToStaticMarkup(<TodayView snap={snap} onSelectItem={() => {}} onOpenTown={() => {}} device="Mac Studio" />)).toContain('这一页只列本机（Mac Studio）的工作')
  })
})
