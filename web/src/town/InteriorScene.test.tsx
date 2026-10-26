import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { InteriorScene, benchItems, benchSpot } from './InteriorScene'
import { buildTown } from './townModel'
import { fakeApproval, fakeItem, fakeRun, fakeSession } from './fixtures'
import type { Snapshot } from '../types'

const now = '2026-10-26T06:00:00Z'
const items = [
  ...Array.from({ length: 10 }, (_, i) => fakeItem({ id: `T-${i}`, repo_id: 1, title: `待办 ${i}`, status: 'todo' })),
  fakeItem({ id: 'R-1', repo_id: 1, title: '等你验收', status: 'review' }),
  fakeItem({ id: 'B-1', repo_id: 1, title: '卡住了', status: 'blocked' }),
  fakeItem({ id: 'W-1', repo_id: 1, title: '正在做', status: 'in_progress' }),
  fakeItem({ id: 'D-1', repo_id: 1, title: '做完了', status: 'done' }),
]
const snap: Snapshot = {
  cursor: 1, now, repos: [{ id: 1, name: 'demo-repo', common_dir: '', is_git: true, target_ref: 'main' }],
  sessions: [fakeSession({ id: 7, provider: 'claude', state: 'running', repo_id: 1, work_item_id: 'W-1', last_activity_at: now })],
  work_items: items, deps: [],
  runs: [fakeRun({ id: 1, work_item_id: 'W-1', session_id: 7, provider: 'claude' }), fakeRun({ id: 2, work_item_id: 'R-1', session_id: 7, provider: 'claude', ended_at: now })],
  approvals: [fakeApproval({ id: 'A-1', kind: 'decision', status: 'pending', repo_id: 1, session_id: 7, preview: '选 A 还是 B？' })],
}

describe('项目室内', () => {
  const model = buildTown(snap, now)
  const b = model.buildings[0]

  it('待验收、受阻先上工作台，最多 9 张，已完成不上台，其余计数', () => {
    const { shown, more } = benchItems(b)
    expect(shown.slice(0, 3).map((w) => w.id)).toEqual(['R-1', 'B-1', 'W-1'])
    expect(shown).toHaveLength(9)
    expect(more).toBe(4)
    expect(shown.some((w) => w.id === 'D-1')).toBe(false)
  })

  it('工作台互不重叠', () => {
    const spots = Array.from({ length: 9 }, (_, i) => benchSpot(i))
    for (let i = 0; i < spots.length; i++) for (let j = i + 1; j < spots.length; j++) {
      const a = spots[i], c = spots[j]
      expect(Math.abs(a.gx - c.gx) >= 3 || Math.abs(a.gy - c.gy) >= 1.1).toBe(true)
    }
  })

  it('画出工作台、站在自己台前的会话、白板上的待决定和溢出提示', () => {
    const html = renderToStaticMarkup(<InteriorScene b={b} model={model} selected={null} highlight={null} onSelect={() => {}} />)
    expect(html).toContain('工作项 W-1 正在做')
    expect(html).toContain('Claude #7')
    expect(html).toContain('等你决定 · 1')
    expect(html).toContain('选 A 还是 B？')
    expect(html).toContain('还有 4 项未摆上工作台')
    expect(html).not.toMatch(/允许本次|验收通过|标记完成/)
  })
})
