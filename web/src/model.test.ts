import { describe, expect, it } from 'vitest'
import { queueCount } from './Queue'
import { groupByRepo, layers, matches, nextItemId, relatedIds, repoPrefix, sessionBuckets, sessionName, sessionSignal, itemSignal, sessionRepo, approvalRepo, projectAttention } from './model'
import type { Approval, Dep, Session, Snapshot, WorkItem } from './types'

const item = (id: string, over: Partial<WorkItem> = {}): WorkItem => ({
  id, repo_id: 1, title: id, status: 'todo', acceptance: '', branch: '', merge_state: 'not_ready', needs_merge: true,
  created_at: '', updated_at: '', ready: true, waiting: [], agents: [], ...over,
})
const dep = (u: string, d: string): Dep => ({ upstream: u, downstream: d, cond: 'accepted', satisfied: false })
const session = (id: number, over: Partial<Session> = {}): Session => ({
  id, host_id: 'h', provider: 'codex', provider_session_id: `session-${id}`, client: 'desktop', version: '',
  cwd: '/repo', worktree: '/repo', branch: '', repo_id: 1, state: 'idle', state_reason: '', data_source: 'live', freshness: 'live',
  suggested_work_item: '', first_seen_at: '2026-10-18T00:00:00Z', last_activity_at: '2026-10-18T00:55:00Z',
  last_progress_at: '', work_item_id: '', binding: '', worktree_conflict: false, resume_command: '', ...over,
})
const sessionSnapshot = (sessions: Session[], over: Partial<Snapshot> = {}): Snapshot => ({
  cursor: 1, now: '2026-10-18T01:00:00Z', repos: [], sessions, work_items: [], deps: [], runs: [], approvals: [], ...over,
})

describe('layers', () => {
  it('按最长上游路径分层', () => {
    const items = ['A', 'B', 'C', 'D'].map((x) => item(x))
    const l = layers(items, [dep('A', 'B'), dep('B', 'C'), dep('A', 'C')])
    expect(l.get('A')).toBe(0)
    expect(l.get('B')).toBe(1)
    expect(l.get('C')).toBe(2)
    expect(l.get('D')).toBe(0)
  })
})

describe('search', () => {
  it('匹配 #编号和标题', () => {
    expect(matches(item('QM-014', { title: '行情页断网' }), '#qm-014')).toBe(true)
    expect(matches(item('QM-014', { title: '行情页断网' }), '断网')).toBe(true)
    expect(matches(item('QM-014'), 'XX')).toBe(false)
  })
  it('展开相关依赖子图', () => {
    const r = relatedIds([dep('A', 'B'), dep('B', 'C'), dep('X', 'Y')], new Set(['B']))
    expect([...r].sort()).toEqual(['A', 'B', 'C'])
  })
})

describe('groupByRepo', () => {
  const snap: Snapshot = {
    cursor: 1, now: '2026-10-18T00:00:00Z',
    repos: [{ id: 1, name: 'quant', common_dir: '', is_git: true, target_ref: 'main' }, { id: 2, name: 'web', common_dir: '', is_git: true, target_ref: 'main' }],
    work_items: [item('Q-1', { status: 'in_progress', agents: ['codex'] }), item('Q-2', { status: 'done' }), item('W-1', { repo_id: 2 })],
    deps: [], runs: [], approvals: [],
    sessions: [],
  }
  it('默认隐藏已完成，有活跃事项的项目排前', () => {
    const g = groupByRepo(snap, { query: '', showDone: false, repoId: 'all', provider: 'all' })
    expect(g[0].name).toBe('quant')
    expect(g[0].items.map((w) => w.id)).toEqual(['Q-1'])
  })
  it('按 Agent 过滤', () => {
    const g = groupByRepo(snap, { query: '', showDone: true, repoId: 'all', provider: 'codex' })
    expect(g.flatMap((x) => x.items).map((w) => w.id)).toEqual(['Q-1'])
  })
})

describe('ids', () => {
  it('生成下一个编号', () => {
    const s = { work_items: [item('QUA-009'), item('QUA-010'), item('WEB-1')] } as Snapshot
    expect(nextItemId(s, 'qua')).toBe('QUA-011')
    expect(repoPrefix('docs-site')).toBe('DOC')
    expect(repoPrefix('3d')).toBe('WD')
  })
})

describe('无活动会话的展示', () => {
  it('收起长时间无活动和空闲满 30 分钟的会话，保留近期与有新事件的运行会话', () => {
    const snap = sessionSnapshot([
      session(1, { last_activity_at: '2026-10-18T00:30:01Z' }),
      session(2, { last_activity_at: '2026-10-18T00:30:00Z' }),
      session(3, { state: 'running', freshness: 'stale' }),
      session(4, { state: 'running', last_activity_at: '2026-10-18T00:00:00Z' }),
      session(5, { state: 'ended' }),
      session(6, { data_source: 'history', freshness: 'history', state: 'unknown' }),
    ])
    const result = sessionBuckets(snap)
    expect(result.recent.map((s) => s.id)).toEqual([1, 4])
    expect(result.quiet.map((s) => s.id)).toEqual([2, 3])
    expect(result.all).toHaveLength(6)
  })
  it('待处理审批阻止收起；过期请求不能让会话一直挂在画布', () => {
    const approval = { session_id: 1, kind: 'permission', status: 'pending' } as Approval
    const snap = sessionSnapshot([session(1, { state: 'waiting_permission', freshness: 'stale' })], { approvals: [approval] })
    expect(sessionBuckets(snap).recent.map((s) => s.id)).toEqual([1])
    snap.approvals = [{ ...approval, status: 'decided' }]
    expect(sessionBuckets(snap).recent.map((s) => s.id)).toEqual([1])
    snap.approvals = [{ ...approval, status: 'expired' }]
    expect(sessionBuckets(snap).quiet.map((s) => s.id)).toEqual([1])
  })
  it('新事件让已收起会话重新出现，不改变工作项状态', () => {
    const task = item('QM-014', { status: 'in_progress' })
    const old = session(1, { work_item_id: task.id, state: 'running', freshness: 'stale' })
    const snap = sessionSnapshot([old], { work_items: [task] })
    expect(sessionBuckets(snap).quiet).toHaveLength(1)
    expect(groupByRepo(snap, { query: '', showDone: false, provider: 'all', repoId: 'all' })[0].items).toEqual([task])
    snap.sessions = [{ ...old, freshness: 'live', last_activity_at: snap.now }]
    expect(sessionBuckets(snap).quiet).toHaveLength(0)
    expect(sessionBuckets(snap).recent).toHaveLength(1)
    expect(task.status).toBe('in_progress')
    expect(old.freshness).toBe('stale')
  })
  it('主画布排除无活动的未归属会话；项目和 Agent 筛选仍生效', () => {
    const snap = sessionSnapshot([
      session(1, { freshness: 'stale' }),
      session(2, { provider: 'claude', repo_id: 2 }),
      session(3),
    ])
    const groups = groupByRepo(snap, { query: '', showDone: false, provider: 'codex', repoId: 1 })
    expect(groups.flatMap((g) => g.sessions).map((s) => s.id)).toEqual([3])
    expect(sessionBuckets(snap, 'codex', 1).quiet.map((s) => s.id)).toEqual([1])
    expect(sessionBuckets(snap, 'claude', 1).all).toHaveLength(0)
  })
})

describe('会话与工作内容对应', () => {
  it('优先采用正式工作项标题，再采用标题索引，目录名不冒充工作内容', () => {
    const s = session(1, { title: '补充课程图片', branch: 'feat/images' })
    const snap = sessionSnapshot([s], { work_items: [item('WEB-001', { title: '课程图片交付' })] })
    expect(sessionName(snap, s)).toMatchObject({ title: '补充课程图片', source: '会话标题', id: '' })
    expect(sessionName(snap, { ...s, work_item_id: 'WEB-001' })).toMatchObject({ title: '课程图片交付', source: '工作项', id: 'WEB-001' })
    expect(sessionName(snap, { ...s, title: '', branch: 'main' }).title).toBe('工作内容待登记')
    expect(sessionName(snap, { ...s, title: '' }).source).toBe('分支线索')
    expect(s.work_item_id).toBe('')
  })
  it('只有真实待处理权限显示审批状态，过期状态明确等待新事件', () => {
    const s = session(1, { state: 'waiting_permission' })
    const snap = sessionSnapshot([s])
    expect(sessionSignal(snap, s).label).toBe('等待新状态')
    snap.approvals = [{ kind: 'permission', status: 'pending', session_id: 1, handleable: true, preview: '需要批准检查命令' } as Approval]
    expect(sessionSignal(snap, s)).toMatchObject({ label: '待你批准', reason: '需要批准检查命令' })
  })
  it('工作卡明确显示上游、决策和验收原因，而不是仅显示执行状态', () => {
    const w = item('WEB-001', { ready: false, waiting: ['API-001'] })
    const snap = sessionSnapshot([session(1, { work_item_id: w.id })], { work_items: [w] })
    expect(itemSignal(snap, w)).toMatchObject({ label: '等上游', reason: '等待 API-001' })
    snap.approvals = [{ kind: 'decision', status: 'pending', session_id: 1, preview: '采用哪个验收方案？' } as Approval]
    expect(itemSignal(snap, w)).toMatchObject({ label: '待你决定', reason: '采用哪个验收方案？' })
    snap.approvals = []
    expect(itemSignal(snap, { ...w, ready: true, status: 'review' }).label).toBe('待你验收')
  })
  it('可搜索未归属会话的标题，不需要先人为创建工作项', () => {
    const snap = sessionSnapshot([session(1, { title: '改进会话审批流程' }), session(2, { title: '补充上传图片' })])
    const groups = groupByRepo(snap, { query: '审批流程', provider: 'all', repoId: 'all', showDone: false })
    expect(groups.flatMap((g) => g.sessions).map((s) => s.id)).toEqual([1])
  })
})

describe('启动目录与实际工作项目', () => {
  it('关联后按工作项项目归类，包括待审批请求', () => {
    const s = session(1, { work_item_id: 'WEB-001', repo_id: 1 })
    const snap = sessionSnapshot([s], { work_items: [item('WEB-001', { repo_id: 2 })] })
    expect(sessionRepo(snap, s)).toBe(2)
    expect(sessionBuckets(snap, 'all', 2).recent.map((x) => x.id)).toEqual([1])
    expect(approvalRepo(snap, { session_id: 1, repo_id: null, work_item_id: null } as Approval)).toBe(2)
  })
})

describe('项目需要处理的事项', () => {
  it('包含依赖等待，并将工作项上的审批按真实项目统计', () => {
    const snap = sessionSnapshot([session(1, { work_item_id: 'WEB-001', repo_id: 1 })], { work_items: [item('WEB-001', { repo_id: 2 }), item('WEB-002', { repo_id: 2, ready: false, waiting: ['WEB-001'] })], approvals: [{ kind: 'decision', status: 'pending', session_id: 1, repo_id: null, work_item_id: null } as Approval] })
    expect(projectAttention(snap, 2)).toBe(2)
    expect(projectAttention(snap, 1)).toBe(0)
  })
})

it('需要用户验收的项目优先于长期无活动的执行中项目', () => {
  const snap = sessionSnapshot([], { repos: [{ id: 1, name: 'Old', common_dir: '/old/.git', is_git: true, target_ref: 'main' }, { id: 2, name: 'Review', common_dir: '/review/.git', is_git: true, target_ref: 'main' }], work_items: [item('OLD-001', { status: 'in_progress', repo_id: 1 }), item('NEW-001', { status: 'review', repo_id: 2 })] })
  expect(groupByRepo(snap, { query: '', showDone: false, provider: 'all', repoId: 'all' }).map((g) => g.repoId)).toEqual([2, 1])
})


describe('低置信提醒与真实待处理分开', () => {
 it('问句提醒不抬高待处理计数，也不让旧空闲会话一直挂着', () => {
  const a = { id: 'q', session_id: 1, kind: 'attention', status: 'pending', repo_id: 1 } as Approval
  const snap = sessionSnapshot([session(1, { last_activity_at: '2026-10-18T00:00:00Z' })], { approvals: [a] })
  expect(queueCount(snap)).toBe(0)
  expect(projectAttention(snap, 1)).toBe(0)
  expect(sessionBuckets(snap).quiet.map((s) => s.id)).toEqual([1])
  snap.approvals = [{ ...a, kind: 'permission' }]
  expect(queueCount(snap)).toBe(1)
  expect(sessionBuckets(snap).recent.map((s) => s.id)).toEqual([1])
 })
})
