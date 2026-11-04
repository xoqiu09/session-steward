// 安静、沉睡的项目默认不上地图：只收起显示，不改归档、工作状态或验收。
// 服务端没给活跃度（旧快照、其他设备）时按活跃处理；正在看的那个项目始终保留。
import type { Repo, Snapshot } from '../types'

export const inactiveRepo = (r: Pick<Repo, 'activity'>) => r.activity === 'quiet' || r.activity === 'dormant'

export function hideInactive(snap: Snapshot, keep: number | 'all'): { snap: Snapshot; hidden: number } {
  const hidden = new Set((snap.repos ?? []).filter((r) => inactiveRepo(r) && r.id !== keep).map((r) => r.id))
  if (hidden.size === 0) return { snap, hidden: 0 }
  const shown = (id: number | null | undefined) => id == null || !hidden.has(id)
  const items = (snap.work_items ?? []).filter((w) => shown(w.repo_id))
  const itemIds = new Set(items.map((w) => w.id))
  const sessions = (snap.sessions ?? []).filter((s) => shown(s.repo_id))
  const sessionIds = new Set(sessions.map((s) => s.id))
  return {
    hidden: hidden.size,
    snap: {
      ...snap,
      repos: (snap.repos ?? []).filter((r) => !hidden.has(r.id)),
      work_items: items,
      sessions,
      runs: (snap.runs ?? []).filter((r) => itemIds.has(r.work_item_id) || sessionIds.has(r.session_id)),
      approvals: (snap.approvals ?? []).filter((a) => shown(a.repo_id) && (!a.work_item_id || itemIds.has(a.work_item_id))),
    },
  }
}
