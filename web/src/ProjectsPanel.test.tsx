import { renderToStaticMarkup } from 'react-dom/server'
import { expect, it } from 'vitest'
import { ProjectManager, ProjectSyncLine } from './ProjectsPanel'
import { MergeProof } from './Panels'
import type { ProjectInfo } from './types'

const projects: ProjectInfo[] = [
  { id: 1, name: 'Demo', common_dir: '/synthetic/first/.git', is_git: true, target_ref: 'main', archived_at: '', open_items: 2, sessions: 3, running: 1, pending: 1 },
  { id: 2, name: 'Demo', common_dir: '/synthetic/second/.git', is_git: true, target_ref: 'main', archived_at: '', open_items: 0, sessions: 1, running: 0, pending: 0 },
  { id: 3, name: 'Archived', common_dir: '/synthetic/archive/.git', is_git: true, target_ref: 'main', archived_at: '2026-10-28T01:00:00Z', open_items: 4, sessions: 5, running: 0, pending: 0 },
]
const noop = async () => {}
it('projects with the same name have distinct selectable paths and archives have a restore scope', () => {
  const html = renderToStaticMarkup(<ProjectManager projects={projects} statuses={[]} onArchive={noop} onSync={noop} />)
  expect(html).toContain('选择项目 Demo /synthetic/first/.git')
  expect(html).toContain('选择项目 Demo /synthetic/second/.git')
  expect(html).toContain('已归档 1')
  expect(html).toContain('待批准 1')
  expect(html).toContain('归档所选项目')
  expect(html).not.toContain('选择项目 Archived')
  expect(html).not.toContain('删除代码')
})
it('remote viewers cannot archive or trigger remote scans', () => {
  const html = renderToStaticMarkup(<ProjectManager projects={projects} statuses={[]} readOnly onArchive={noop} onSync={noop} />)
  expect(html).toContain('请在项目所在的电脑上管理')
  expect(html).toMatch(/disabled=""[^>]*>立即核对外部合并/)
  expect(html).toMatch(/disabled=""[^>]*>归档所选项目/)
})
it('failed remote checks are visible and never presented as successful', () => {
  const html = renderToStaticMarkup(<ProjectManager projects={projects} statuses={[{ repo_id: 1, target_ref: 'main', remote: 'origin', target_sha: '', checked_at: '2026-10-28T01:00:00Z', error: '远端访问失败' }]} onArchive={noop} onSync={noop} />)
  expect(html).toContain('远端访问失败')
  expect(html).not.toContain('同步成功')
})
it('merge proof shows the source of confirmation while keeping acceptance separate', () => {
  const html = renderToStaticMarkup(<MergeProof evidence={{ source_sha: '1234567890abc', target_sha: 'abcdef1234567', target_ref: 'main', method: 'github_pr', url: 'https://github.com/synthetic/project/pull/1', checked_at: '2026-10-28T01:00:00Z' }} />)
  expect(html).toContain('GitHub 已合并记录与提交一致')
  expect(html).toContain('工作项验收单独保留')
  expect(html).toContain('https://github.com/synthetic/project/pull/1')
})

it('retired errors and missing project paths are not presented as current connection failures', () => {
  const base = { repo_id: 1, target_ref: 'main', remote: 'origin', target_sha: '', checked_at: '2026-10-28T01:00:00Z', error: '旧失败' }
  const idle = renderToStaticMarkup(<ProjectSyncLine sync={{ ...base, state: 'idle' }} />)
  expect(idle).toContain('当前没有待核对的合并')
  expect(idle).not.toContain('旧失败')
  const missing = renderToStaticMarkup(<ProjectSyncLine sync={{ ...base, state: 'missing' }} />)
  expect(missing).toContain('原项目目录已失效，历史记录保留')
  expect(missing).not.toContain('旧失败')
  const failed = renderToStaticMarkup(<ProjectSyncLine sync={{ ...base, state: 'failed', account: 'fixture-account' }} />)
  expect(failed).toContain('旧失败')
  expect(failed).toContain('2026-10-28T01:00:00Z')
  expect(failed).toContain('使用账号 fixture-account')
})
