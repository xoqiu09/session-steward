import type { Repo } from '../types'

export const RECENT_PROJECTS_KEY = 'ss.projects.recent.v1'

export function projectPath(repo: Repo): string {
  return repo.common_dir.replace(/^dir:/, '').replace(/\/\.git$/, '')
}

export function projectName(repos: Repo[], repo: Repo): string {
  if (repos.filter(r => r.name.toLowerCase() === repo.name.toLowerCase()).length < 2) return repo.name
  return `${repo.name} · ${projectPath(repo).split('/').slice(-3).join('/')}`
}

export function readRecentProjects(): number[] {
  try {
    const ids: unknown = JSON.parse(localStorage.getItem(RECENT_PROJECTS_KEY) ?? '[]')
    return Array.isArray(ids) ? [...new Set(ids.filter((id): id is number => Number.isSafeInteger(id) && id > 0))].slice(0, 5) : []
  } catch { return [] }
}

export function rememberProject(ids: number[], id: number): number[] {
  return [id, ...ids.filter(previous => previous !== id)].slice(0, 5)
}

export function projectGroups(repos: Repo[], query: string, recent: number[]): { label: string; repos: Repo[] }[] {
  const words = query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean)
  const matches = repos.filter(r => words.every(word => `${r.name} ${projectPath(r)}`.toLocaleLowerCase().includes(word)))
  const sorted = [...matches].sort((a, b) =>
    (b.last_activity_at ?? '').localeCompare(a.last_activity_at ?? '') || a.name.localeCompare(b.name) || a.id - b.id)
  if (words.length) return [{ label: '搜索结果', repos: sorted }]
  const recentRepos = [...new Set(recent)].flatMap(id => matches.find(r => r.id === id) ?? [])
  const remaining = sorted.filter(r => !recent.includes(r.id))
  return [
    { label: '最近使用', repos: recentRepos },
    { label: '活跃项目', repos: remaining.filter(r => !r.activity || r.activity === 'active') },
    { label: '其他项目', repos: remaining.filter(r => r.activity && r.activity !== 'active') },
  ].filter(group => group.repos.length > 0)
}
