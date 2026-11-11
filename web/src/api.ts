import { useEffect, useRef, useState } from 'react'
import { isRemote, remoteReadOnlyMessage } from './access'
import type { ResidentId } from './town/residents'
import type { AISummary, AttributionDecision, BriefEdit, DayDetail, Handoff, HistoryResp, HubStatus, ManagedSession, MergeJob, MergeSyncStatus, ProjectInfo, ProjectStructure, ProjectStructureDocument, Review, Worktree, SessionUsageDetail, Snapshot } from './types'
import { snapshotRefresher } from './snapshotRefresh'
import { publishNativeSnapshot } from './nativeBridge'
import { snapshotStream } from './snapshotStream'
import type { UnbindTarget } from './sessionBinding'

export class ApiError extends Error {
  status: number
  data: Record<string, unknown>
  constructor(status: number, message: string, data: Record<string, unknown> = {}) {
    super(message)
    this.status = status
    this.data = data
  }
}

async function call<T>(method: string, path: string, body?: unknown, signal?: AbortSignal): Promise<T> {
  if (isRemote() && method !== 'GET' && method !== 'HEAD') {
    throw new ApiError(403, remoteReadOnlyMessage)
  }
  const res = await fetch(path, {
    method,
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json', 'X-Steward': '1' },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal,
  })
  const text = await res.text()
  let data: unknown = {}
  if (text) {
    try {
      data = JSON.parse(text)
    } catch {
      // 非 JSON 响应（代理错误页、纯文本错误、回落的 HTML 等）：保留状态码，正文作为错误信息
      throw new ApiError(res.status, text.trim() || res.statusText)
    }
  }
  if (!res.ok) {
    const obj = data !== null && typeof data === 'object' ? (data as Record<string, unknown>) : {}
    throw new ApiError(res.status, typeof obj.error === 'string' && obj.error ? obj.error : res.statusText || `HTTP ${res.status}`, obj)
  }
  if (method !== 'GET' && method !== 'HEAD' && typeof window !== 'undefined') window.dispatchEvent(new Event('steward:changed'))
  return data as T
}

/** 直播展示画面上方的说明卡（每项最多 80 个字）。 */
export type LiveStyle = 'cozy-night' | 'storybook-day' | 'ai-studio'
export type LivePresentation = 'companion' | 'town'
export type LiveGesture = 'pat' | 'walk' | 'home'
export interface LiveCompanionAction { id: string; kind: LiveGesture; at: string; resident?: ResidentId }
export interface LiveResidents { resident: ResidentId; mode: 'auto' | 'fixed'; interval_seconds: 60 | 120 | 300; anchor: string }
export interface LiveNote { doing: string; thinking: string; contact: string; style?: LiveStyle; presentation?: LivePresentation; companion?: LiveCompanionAction; resident_control?: LiveResidents; updated_at: string }

export interface HookCoverage { provider: string; version: string; installed: string[]; missing: string[]; skipped: string[]; reason?: string; read_error?: boolean; untrusted?: number }

// Bound snapshot reads so a stalled connection can expose a useful retry state.
async function readSnapshot(): Promise<Snapshot> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 10_000)
  try { return await call<Snapshot>('GET', '/api/snapshot', undefined, controller.signal) }
  catch (error) { if (controller.signal.aborted) throw new ApiError(0, '连接本机服务超时'); throw error }
  finally { clearTimeout(timer) }
}

export const api = {
  hookCoverage: () => call<HookCoverage[]>('GET', '/api/hooks/status'),
  saveProjectStructure: (repo: number, document: ProjectStructureDocument, base_revision: string) => call<{ structure: ProjectStructure }>('PUT', `/api/projects/${repo}/structure`, { document, base_revision }),
  projects: () => call<ProjectInfo[]>('GET', '/api/projects'),
  archiveProjects: (ids: number[], archived: boolean) => call('POST', '/api/projects/archive', { ids, archived }),
  trashProjects: (ids: number[], trashed: boolean) => call('POST', '/api/projects/trash', { ids, trashed }),
  keepArchived: (ids: number[]) => call('POST', '/api/projects/keep-archived', { ids }),
  worktrees: (repo: number) => call<{ worktrees: Worktree[]; trash_available: boolean }>('GET', `/api/projects/${repo}/worktrees`),
  removeWorktree: (repo: number, path: string) => call('POST', `/api/projects/${repo}/worktrees/remove`, { path }),
  mergeSync: () => call<MergeSyncStatus[]>('GET', '/api/merge-sync'),
  confirmFeatureScope: (repo: number, id: string, revision: string) => call('POST', `/api/features/${repo}/${encodeURIComponent(id)}/confirm-scope`, { revision }),
  acceptFeature: (repo: number, id: string, candidate: string, revision: string, decision: 'accepted' | 'changes_requested') => call('POST', `/api/features/${repo}/${encodeURIComponent(id)}/accept`, { candidate, revision, decision }),
  reconcileAttributions: () => call<{ changed: number }>('POST', '/api/attributions/reconcile'),
  decideAttributions: (decisions: AttributionDecision[]) => call('POST', '/api/attributions/decide', { decisions }),
  snapshot: readSnapshot,
  snapshotAt: (at: string) => call<Snapshot>('GET', `/api/snapshot?at=${encodeURIComponent(at)}`),
  hubStatus: () => call<HubStatus>('GET', '/api/hub/status'),
  hubSnapshot: () => call<Snapshot>('GET', '/api/hub/snapshot'),
  sessionEvents: (id: number) => call<Record<string, unknown>[]>('GET', `/api/sessions/${id}/events`),
  sessionUsage: (id: number) => call<SessionUsageDetail>('GET', `/api/sessions/${id}/usage`),
  conversation: (id: number) => call<{ mode: 'app' | 'manual'; provider: string; url?: string; reason?: string }>('GET', `/api/sessions/${id}/conversation`),
  history: (days = 370) => call<HistoryResp>('GET', `/api/history?days=${days}`),
  historyDay: (date: string) => call<DayDetail>('GET', `/api/history/day?date=${encodeURIComponent(date)}`),
  bind: (sid: number, workItemId: string) => call('POST', `/api/sessions/${sid}/bind`, { work_item_id: workItemId }),
  unbind: (sid: number, outcome: string, target: UnbindTarget) => call('POST', `/api/sessions/${sid}/unbind`, { outcome, ...target }),
  createItem: (b: { id: string; title: string; repo_id?: number; repo_path?: string; branch?: string; acceptance?: string; needs_merge?: boolean; session_id?: number }) =>
    call('POST', '/api/work-items', b),
  patchItem: (id: string, b: Record<string, unknown>) => call('PATCH', `/api/work-items/${encodeURIComponent(id)}`, b),
  editBrief: (id: string, b: BriefEdit) => call<{ ok: boolean; entry_id: number }>('POST', `/api/work-items/${encodeURIComponent(id)}/brief`, b),
  addDep: (upstream: string, downstream: string, cond: string) => call('POST', '/api/deps', { upstream, downstream, cond }),
  removeDep: (upstream: string, downstream: string) => call('DELETE', '/api/deps', { upstream, downstream }),
  runOutcome: (id: number, outcome: string) => call('POST', `/api/runs/${id}/outcome`, { outcome }),
  decide: (id: string, fingerprint: string, behavior: 'allow' | 'deny') =>
    call('POST', `/api/approvals/${id}/decide`, { fingerprint, behavior }),
  dismiss: (id: string, reason = 'dismissed') => call('POST', `/api/approvals/${id}/dismiss`, { reason }),
  approveMerge: (id: string, source_head_sha: string, target_base_sha: string) =>
    call('POST', `/api/approvals/${id}/approve-merge`, { source_head_sha, target_base_sha }),
  rejectMerge: (id: string, reason: string) => call('POST', `/api/approvals/${id}/reject-merge`, { reason }),
  mergeInstruction: (id: string) => call<{ text: string }>('POST', `/api/approvals/${id}/merge-instruction`),
  scanMerges: () => call('POST', '/api/scan/merges'),
  dropMerge: (id: string) => call('POST', `/api/approvals/${id}/drop-merge`),
  launchManaged: (b: { repo_id: number; agent: string; title: string }) => call<ManagedSession>('POST', '/api/managed', b),
  stopManaged: (id: string) => call('POST', `/api/managed/${encodeURIComponent(id)}/stop`),
  archiveManaged: (id: string, force = false) => call('POST', `/api/managed/${encodeURIComponent(id)}/archive`, { force }),
  takeover: (id: string, on: boolean) => call('POST', `/api/managed/${encodeURIComponent(id)}/takeover`, { on }),
  sendInput: (id: string, b: { text?: string; key?: string }) => call('POST', `/api/managed/${encodeURIComponent(id)}/input`, b),
  review: (days: number) => call<Review>('GET', `/api/review?days=${days}`),
  summary: (item: string) => call<{ summary: AISummary | null }>('GET', `/api/work-items/${encodeURIComponent(item)}/summary`),
  generateSummary: (item: string) => call<{ summary: AISummary }>('POST', `/api/work-items/${encodeURIComponent(item)}/summary`),
  checkedMerge: (id: string) => call<MergeJob>('POST', `/api/approvals/${encodeURIComponent(id)}/checked-merge`),
  handoffPreview: (item: string, b: { to_agent: string; note?: string }) => call<{ package: string; source_branch: string; source_sha: string }>('POST', `/api/work-items/${encodeURIComponent(item)}/handoff/preview`, b),
  liveNote: () => call<LiveNote>('GET', '/api/live/note'),
  saveLiveNote: (note: Pick<LiveNote, 'doing' | 'thinking' | 'contact' | 'style' | 'presentation'>) => call<LiveNote>('PUT', '/api/live/note', note),
  liveCompanion: (kind: LiveGesture) => call<LiveCompanionAction>('POST', '/api/live/companion', { kind }),
  setLiveResidents: (input: Omit<LiveResidents, 'anchor'>) => call<LiveResidents>('PUT', '/api/live/residents', input),
  liveLink: () => call<{ url: string; view: string }>('GET', '/api/live/link'),
  handoff: (item: string, b: { to_agent: string; note?: string; source_sha?: string }) => call<{ handoff: Handoff; managed: ManagedSession }>('POST', `/api/work-items/${encodeURIComponent(item)}/handoff`, b),
}

export type Conn = 'connecting' | 'live' | 'offline' | 'unauthorized'

// useSnapshot 拉取快照并订阅 SSE。收到变更或 reset 时节流地重新拉取快照；断线后浏览器自动重连并用 Last-Event-ID 续传。
export function useSnapshot() {
  const [snap, setSnap] = useState<Snapshot | null>(null)
  const [conn, setConn] = useState<Conn>('connecting')
  const pending = useRef(false)
  const timer = useRef<number | undefined>(undefined)
  const reader = useRef<ReturnType<typeof snapshotRefresher> | null>(null)
  const stream = useRef<ReturnType<typeof snapshotStream> | null>(null)

  useEffect(() => {
    pending.current = false
    let streamUp = false
    const load = snapshotRefresher(api.snapshot, (s, reset) => {
      setSnap(s)
      publishNativeSnapshot(s, reset)
      if (streamUp) setConn('live')
    }, (e) => setConn(e instanceof ApiError && e.status === 401 ? 'unauthorized' : 'offline'))
    reader.current = load
    const schedule = () => {
      stream.current?.reconnect()
      if (pending.current) return
      pending.current = true
      timer.current = window.setTimeout(async () => {
        pending.current = false
        await load.request()
      }, 150)
    }
    const refresh = () => { stream.current?.reconnect(); window.clearTimeout(timer.current); pending.current = false; void load.request() }
    const visible = () => { if (document.visibilityState === 'visible') refresh() }
    void load.request()
    const events = snapshotStream(() => new EventSource('/api/stream'), {
      open: () => { setConn('live'); streamUp = true; schedule() },
      error: () => { streamUp = false; setConn(c => c === 'unauthorized' ? c : 'offline') },
      change: schedule,
      reset: () => { void load.reset() },
    })
    stream.current = events
    window.addEventListener('focus', refresh)
    window.addEventListener('steward:foreground', refresh)
    window.addEventListener('steward:changed', refresh)
    document.addEventListener('visibilitychange', visible)
    // 本地时间推进（例如“长时间无活动”判断）需要定期刷新
    const tick = window.setInterval(schedule, 30_000)
    return () => {
      load.dispose()
      reader.current = null
      events.dispose()
      stream.current = null
      window.clearInterval(tick)
      window.clearTimeout(timer.current)
      pending.current = false
      window.removeEventListener('focus', refresh)
      window.removeEventListener('steward:foreground', refresh)
      window.removeEventListener('steward:changed', refresh)
      document.removeEventListener('visibilitychange', visible)
    }
  }, [])

  return { snap, conn, reload: () => { stream.current?.reconnect(); return reader.current?.request() ?? Promise.resolve() } }
}
