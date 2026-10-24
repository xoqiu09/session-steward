import type { Brief, Snapshot } from './types'
import { projectQueueCounts, queueCounts, type Group } from './model'

export const PROJECT_RECENT_MS = 24 * 60 * 60 * 1000

const timestamp = (value?: string) => {
  const parsed = Date.parse(value || '')
  return Number.isFinite(parsed) ? parsed : 0
}
const reportedAt = (brief: Brief | null | undefined, now: number): number => Math.max(0,
  ...Object.values(brief?.fields ?? {}).filter(f => f && !f.flagged).map(f => timestamp(f?.at)).filter(at => at <= now),
  ...Object.values(brief?.by_session ?? {}).map(b => reportedAt(b, now)))

export function projectActivity(snap: Snapshot, group: Group, provider = 'all') {
  const now = timestamp(snap.now)
  const ids = new Set(group.items.map(w => w.id))
  const looseIds = new Set(group.sessions.map(s => s.id))
  const sessions = (snap.sessions ?? []).filter(s => s.data_source === 'live' && (provider === 'all' || s.provider === provider) && (ids.has(s.work_item_id) || looseIds.has(s.id)))
  const recent = (at: number) => at > 0 && at <= now && now - at < PROJECT_RECENT_MS
  const observed = (at?: string) => timestamp(at) <= now ? timestamp(at) : 0
  const lastReportAt = Math.max(0, ...group.items.map(w => reportedAt(w.brief, now)),
    ...(snap.features ?? []).filter(f => f.repo_id === group.repoId).flatMap(f => f.contributions
      .filter(c => ids.has(c.work_item_id) && (provider === 'all' || c.provider === provider)).map(c => observed(c.at))))
  // updated_at also moves during Git scans and attribution; it is not work activity.
  const lastActivityAt = Math.max(lastReportAt, 0, ...group.items.map(w => observed(w.created_at)),
    ...sessions.map(s => observed(s.last_activity_at)))
  const running = sessions.filter(s => s.freshness === 'live' && recent(timestamp(s.last_activity_at)) && ['running', 'waiting_permission'].includes(s.state)).length
  const counts = group.repoId == null ? projectQueueCounts(snap, null) : queueCounts(snap, group.repoId, provider)
  return { group, counts, running, lastReportAt, lastActivityAt,
    quiet: !counts.action && !running && !group.items.some(w => w.automatic_issue) && !recent(lastActivityAt) }
}

export function orderedProjects(snap: Snapshot, groups: Group[], provider = 'all') {
  return groups.filter(g => g.items.length > 0).map(g => projectActivity(snap, g, provider)).sort((a, b) =>
    Number(b.counts.action > 0) - Number(a.counts.action > 0) || Number(b.running > 0) - Number(a.running > 0) ||
    b.lastActivityAt - a.lastActivityAt || a.group.name.localeCompare(b.group.name) || a.group.key.localeCompare(b.group.key))
}
