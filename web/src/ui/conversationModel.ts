import type { Session, Snapshot, WorkItem } from '../types'
import { sessionsFor } from '../model'
import { requestsForItem } from './WorkOverview'
import { reviewGuide } from './runDeskModel'

/** Desktop links are navigation only, and must match the selected provider and conversation. */
export function conversationURL(session: Session, value?: string): string | null {
  if (!value || session.client !== 'desktop') return null
  try {
    const url = new URL(value)
    if (url.username || url.password || url.port || url.hash) return null
    if (session.provider === 'codex' && url.protocol === 'codex:' && url.hostname === 'threads' && !url.search
      && url.pathname.toLowerCase() === `/${session.provider_session_id.toLowerCase()}`
      && /^\/[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(url.pathname)) return value
    if (session.provider === 'claude' && url.protocol === 'claude:' && [...url.searchParams].length === 1) {
      const id = url.searchParams.get('session')
      if (url.hostname === 'code' && url.pathname === '/continue' && /^local_[A-Za-z0-9_-]{1,64}$/.test(id ?? '')) return value
      if (url.hostname === 'resume' && !url.pathname && id === session.provider_session_id && /^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(id)) return value
    }
  } catch { /* An invalid link is shown as a manual recovery option. */ }
  return null
}

/** Prefer the exact request or delivery owner; never choose another project's busy agent. */
export function processingSession(snap: Snapshot, item: WorkItem, preferred?: number): Session | null {
  const sessions = sessionsFor(snap, item.id)
  const matching = (id?: number | null) => sessions.find(s => s.id === id) ?? null
  if (preferred != null && matching(preferred)) return matching(preferred)
  const request = requestsForItem(snap, item).filter(a => a.session_id != null)
    .sort((a, b) => b.created_at.localeCompare(a.created_at)).find(a => matching(a.session_id))
  if (request) return matching(request.session_id)
  const owner = item.brief?.fields.next_owner
  if (owner?.text === 'user' && matching(owner.session_id)) return matching(owner.session_id)
  if (item.status === 'review') {
    const delivered = reviewGuide(snap, item).session
    if (delivered && matching(delivered.id)) return delivered
  }
  return [...sessions].sort((a, b) => {
    const waiting = (s: Session) => s.state === 'waiting_permission' ? 2 : s.state === 'running' ? 1 : 0
    return waiting(b) - waiting(a) || b.last_activity_at.localeCompare(a.last_activity_at)
  })[0] ?? null
}
