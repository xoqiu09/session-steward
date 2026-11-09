import { afterEach, expect, it, vi } from 'vitest'
import type { Repo } from '../types'
import { projectGroups, projectName, projectPath, readRecentProjects, rememberProject } from './projectPickerModel'

const repos: Repo[] = [
  { id: 1, name: 'CLIProxyAPI', common_dir: '/synthetic/Caches/CLIProxyAPI/.git', is_git: true, target_ref: 'main', activity: 'dormant' },
  { id: 2, name: 'QAI', common_dir: '/synthetic/TeamA/QAI/.git', is_git: true, target_ref: 'main', activity: 'active' },
  { id: 3, name: 'QAI', common_dir: '/synthetic/TeamB/QAI/.git', is_git: true, target_ref: 'main', activity: 'quiet' },
  { id: 4, name: '笔记', common_dir: 'dir:/synthetic/notes', is_git: false, target_ref: '', activity: 'active' },
]
afterEach(() => vi.unstubAllGlobals())

it('同名项目可按目录精确区分，名称和目录支持组合查找', () => {
  expect(projectGroups(repos, 'qai TEAMb', []).flatMap(g => g.repos.map(r => r.id))).toEqual([3])
  expect(projectGroups(repos, 'notes', []).flatMap(g => g.repos.map(r => r.id))).toEqual([4])
  expect(projectName(repos, repos[1])).not.toEqual(projectName(repos, repos[2]))
  expect(projectPath(repos[3])).toBe('/synthetic/notes')
  expect(projectGroups(repos, '没有这个项目', [2]).flatMap(g => g.repos)).toEqual([])
})

it('最近使用优先，已消失的项目不出现，其余按已有活跃度分组且不重复', () => {
  const groups = projectGroups(repos, '', [99, 3, 3])
  expect(groups.find(g => g.label === '最近使用')?.repos.map(r => r.id)).toEqual([3])
  expect(groups.find(g => g.label === '活跃项目')?.repos.map(r => r.id).sort()).toEqual([2, 4])
  expect(groups.find(g => g.label === '其他项目')?.repos.map(r => r.id)).toEqual([1])
  expect(groups.flatMap(g => g.repos).map(r => r.id).sort()).toEqual([1, 2, 3, 4])
})

it('最近使用只保留五个有效 ID，存储不可读时仍可打开选择器', () => {
  vi.stubGlobal('localStorage', { getItem: () => '[2,2,-1,"3",null,4,5,6,7,8]' })
  expect(readRecentProjects()).toEqual([2, 4, 5, 6, 7])
  expect(rememberProject([2, 4, 5, 6, 7], 5)).toEqual([5, 2, 4, 6, 7])
  vi.stubGlobal('localStorage', { getItem: () => { throw new Error('blocked') } })
  expect(readRecentProjects()).toEqual([])
})
