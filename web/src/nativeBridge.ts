import type { Snapshot } from './types'

interface DesktopWindow extends Window {
  webkit?: { messageHandlers?: { stewardSnapshot?: { postMessage: (value: unknown) => void } } }
}

/** Only the fields used by the native reminder. Conversation bodies and credentials are excluded. */
export function nativeSnapshot(snap: Snapshot, reset: boolean) {
  return {
    cursor: snap.cursor, reset,
    repos: (snap.repos ?? []).map(r => ({ id: r.id, name: r.name })),
    work_items: (snap.work_items ?? []).map(w => ({
      id: w.id, title: w.title, repo_id: w.repo_id, status: w.status, updated_at: w.updated_at,
      automatic_history: w.automatic_history, management: w.management ? { state: w.management.state } : undefined,
      brief: w.brief ? { input_resolved_at: w.brief.input_resolved_at, fields: { next_owner: w.brief.fields.next_owner ? { text: w.brief.fields.next_owner.text, at: w.brief.fields.next_owner.at } : undefined } } : undefined,
    })),
    approvals: (snap.approvals ?? []).map(a => ({ id: a.id, status: a.status, kind: a.kind, handleable: a.handleable,
      work_item_id: a.work_item_id, repo_id: a.repo_id, created_at: a.created_at, payload: { stale: a.payload?.stale } })),
    sessions: (snap.sessions ?? []).map(s => ({ id: s.id, state: s.state })),
  }
}

export function publishNativeSnapshot(snap: Snapshot, reset = false) {
  if (typeof window === 'undefined') return
  try {
    ;(window as DesktopWindow).webkit?.messageHandlers?.stewardSnapshot?.postMessage(nativeSnapshot(snap, reset))
  } catch { /* Native delivery is optional; it must not mark a successful web read as offline. */ }
}
