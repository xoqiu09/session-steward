import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { ProjectManager, suspectProject } from './ProjectsPanel'
import { suspectDirectories } from './App'
import type { ProjectInfo, Snapshot } from './types'

const project = (id: number, extra: Partial<ProjectInfo> = {}): ProjectInfo => ({
  id, name: `synthetic-${id}`, common_dir: `dir:/synthetic/tasks/${id}`, is_git: false, target_ref: 'main', archived_at: '',
  open_items: 0, sessions: 0, running: 0, pending: 0, features: 0, has_structure: false, activity: 'dormant', ...extra,
})

describe('可能是误登记的目录', () => {
  it('只有没会话、非 Git、没待办、没功能登记和结构资料的才算', () => {
    expect(suspectProject(project(1))).toBe(true)
    for (const extra of [{ sessions: 1 }, { is_git: true }, { open_items: 1 }, { pending: 1 }, { features: 2 }, { has_structure: true }]) {
      expect(suspectProject(project(2, extra))).toBe(false)
    }
  })
  it('项目管理里有单独的筛选和说明，可以全选后移入回收站', () => {
    const html = renderToStaticMarkup(<ProjectManager projects={[project(1), project(2), project(3, { sessions: 4, is_git: true, activity: 'active' })]} statuses={[]} initialFilter="suspect" onArchive={async () => {}} onTrash={async () => {}} onSync={async () => {}} />)
    expect(html).toContain('可能是误登记的目录 2')
    expect(html).toContain('多半是 Agent 执行命令时顺手进过的')
    expect(html).toContain('synthetic-1')
    expect(html).not.toContain('synthetic-3')
  })
  it('顶部提示用快照算出的同一口径', () => {
    const snap = {
      cursor: 1, now: '2026-11-04T00:00:00Z',
      repos: [
        { id: 1, name: 'a', common_dir: 'dir:/x/a', is_git: false, target_ref: 'main' },
        { id: 2, name: 'b', common_dir: 'dir:/x/b', is_git: false, target_ref: 'main', last_activity_at: '2026-11-03T00:00:00Z' },
        { id: 3, name: 'c', common_dir: '/x/c/.git', is_git: true, target_ref: 'main' },
        { id: 4, name: 'd', common_dir: 'dir:/x/d', is_git: false, target_ref: 'main' },
      ],
      features: [{ repo_id: 4 }], structures: [], work_items: [], approvals: [], sessions: [],
    } as unknown as Snapshot
    expect(suspectDirectories(snap)).toBe(1)
  })
})
