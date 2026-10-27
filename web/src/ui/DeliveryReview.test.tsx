import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { DeliveryReview } from './DeliveryReview'
import { reviewGuide, runsBySession } from './runDeskModel'
import { fakeItem, fakeRun, fakeSession } from '../town/fixtures'
import type { Snapshot, WorkItem } from '../types'

const now = '2026-10-27T02:00:00Z'
const runs = [
  fakeRun({ id: 1, work_item_id: 'AGE-1', session_id: 80, provider: 'claude', started_at: '2026-10-26T13:00:00Z', ended_at: '2026-10-26T13:10:00Z' }),
  fakeRun({ id: 2, work_item_id: 'AGE-1', session_id: 80, provider: 'claude', started_at: '2026-10-26T14:00:00Z', ended_at: '2026-10-26T14:30:00Z' }),
  fakeRun({ id: 3, work_item_id: 'AGE-1', session_id: 80, provider: 'claude', started_at: '2026-10-26T15:00:00Z' }),
  fakeRun({ id: 4, work_item_id: 'AGE-1', session_id: 81, provider: 'codex', started_at: '2026-10-26T15:00:00Z', ended_at: '2026-10-26T16:00:00Z', outcome: 'handed_off' }),
]
const snap = (item: WorkItem): Snapshot => ({ cursor: 1, now, repos: [], sessions: [], work_items: [item], deps: [], runs, approvals: [] })

describe('运行层级', () => {
  it('同一会话的多段运行合成一行，记下段数和最后结果', () => {
    const g = runsBySession(runs)
    expect(g.map((x) => [x.sessionId, x.runs.length, x.open, x.outcome])).toEqual([[80, 3, true, ''], [81, 1, false, 'handed_off']])
  })
})

const repos = [
  { id: 1, name: 'demo-town', common_dir: '', is_git: true, target_ref: 'main' },
  { id: 2, name: 'demo-panel', common_dir: '', is_git: true, target_ref: 'main' },
]
const brief = (sessionId: number) => ({ fields: { summary: { entry_id: 1, text: '做好了一屏小镇', kind: 'agent' as const, source: 'deliver', session_id: sessionId, at: '2026-10-26T15:30:00Z' } }, tool_events_since: 0, last_event_at: now, stale: false })
const withSessions = (item: WorkItem, sessions: Snapshot['sessions']): Snapshot => ({ ...snap(item), repos, sessions })
const render = (s: Snapshot, item: WorkItem) => renderToStaticMarkup(<DeliveryReview snap={s} item={item} onSelectSession={() => {}} actions={<button>验收通过</button>} />)

describe('待验收卡片', () => {
  const item = fakeItem({ id: 'AGE-1', repo_id: 1, title: '小镇候选', status: 'review', branch: 'claude/old-prototype', acceptance: '一屏看清所有项目', brief: brief(80) })

  it('三行：交付了什么、在哪看、回原对话；位置用交付会话自己的记录', () => {
    const s80 = fakeSession({ id: 80, provider: 'claude', state: 'running', repo_id: 1, branch: 'claude/town-world', worktree: '/work/demo-town-world', cwd: '/work/demo-town-world', resume_command: 'claude --resume demo-80' })
    const html = render(withSessions(item, [s80]), item)
    expect(html).toContain('交付了什么')
    expect(html).toContain('做好了一屏小镇')
    expect(html).toContain('Agent 自述')
    expect(html).toContain('验收标准：一屏看清所有项目')
    expect(html).toContain('demo-town · 分支 <code>claude/town-world</code>')
    expect(html).toContain('/work/demo-town-world')
    expect(html).toContain('交付会话记录')
    expect(html).not.toContain('claude/old-prototype')
    expect(html).toContain('复制目录')
    expect(html).toContain('Claude 会话 #80')
    expect(html).toContain('复制恢复命令')
    expect(html).not.toContain('review-mismatch')
    expect(html).not.toContain('切到上面的分支')
  })

  it('交付会话在别的项目时提示一行', () => {
    const s80 = fakeSession({ id: 80, provider: 'claude', state: 'running', repo_id: 2, branch: 'claude/town-world', cwd: '/work/demo-panel' })
    const g = reviewGuide(withSessions(item, [s80]), item)
    expect(g.mismatch).toEqual({ delivered: 'demo-panel', item: 'demo-town' })
    expect(render(withSessions(item, [s80]), item)).toContain('⚠ 这次交付在 demo-panel，不在本项目 demo-town')
  })

  it('交付会话没记下仓库和分支时退回到工作项分支，并标出来源', () => {
    const s80 = fakeSession({ id: 80, provider: 'claude', state: 'running', repo_id: null, branch: '', cwd: '/home/demo' })
    const html = render(withSessions(item, [s80]), item)
    expect(html).toContain('分支 <code>claude/old-prototype</code>')
    expect(html).toContain('工作项记录')
    expect(html).toContain('复制分支名')
    expect(html).toContain('没有记下恢复命令')
    expect(reviewGuide(withSessions(item, [s80]), item).mismatch).toBeNull()
  })

  it('没有交付说明时按最近一段运行找交付会话', () => {
    const plain = { ...item, brief: undefined }
    expect(reviewGuide(withSessions(plain, [fakeSession({ id: 80, provider: 'claude', state: 'idle' }), fakeSession({ id: 81, provider: 'codex', state: 'ended' })]), plain).session?.id).toBe(81)
  })

  it('什么都没记下时说清楚去哪问', () => {
    const bare = fakeItem({ id: 'AGE-1', repo_id: null, title: '小镇候选', status: 'review' })
    const html = renderToStaticMarkup(<DeliveryReview snap={{ ...snap(bare), runs: [] }} item={bare} onSelectSession={() => {}} actions={null} />)
    expect(html).toContain('Agent 没有写交付说明')
    expect(html).toContain('没有记下仓库或分支')
    expect(html).toContain('没有找到交付会话')
    expect(html).not.toContain('验收标准')
  })
})
