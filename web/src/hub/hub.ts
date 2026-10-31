// 多设备：按电脑看小镇。“这台”画本机快照；选别的电脑只画那台的部分；“全部”画合并视图，每台电脑一个片区。
// 看别的电脑或全部时每 10 秒向本机服务要合并视图（中心机就地合并，其他设备转问中心机）；
// 看“这台”时每分钟要一次，只为知道有哪几台电脑、在不在线。
import { useEffect, useMemo, useState } from 'react'
import { api } from '../api'
import type { HubStatus, Snapshot } from '../types'
import { HUB_STRIDE } from './ids'

/** 'here' 本机；'all' 全部；'device:<设备编号>' 只看那一台（只能看）。 */
export type HubScope = 'here' | 'all' | `device:${string}`
const SCOPE_KEY = 'ss.hub.scope'
export const deviceScope = (id: string): HubScope => `device:${id}`
export const scopeDevice = (s: HubScope): string | null => (s.startsWith('device:') ? s.slice(7) : null)
function readScope(raw: string | null): HubScope {
  if (raw === 'all') return 'all'
  if (raw?.startsWith('device:') && raw.length > 7) return raw as HubScope
  return 'here'
}

export { HUB_STRIDE }
export function remoteDeviceOf(snap: Snapshot, kind: 'item' | 'session', id: string | number): string | null {
  const devs = snap.devices
  if (!devs?.length) return null
  if (kind === 'item') { const i = String(id).indexOf(':'); return i > 0 ? String(id).slice(0, i) : null }
  const n = Math.floor(Number(id) / HUB_STRIDE)
  return n > 0 ? devs.filter((d) => !d.self)[n - 1]?.name ?? '另一台电脑' : null
}

/** 摘要不带审批详情（payload 为 null），补成空对象，按本机快照写的页面才不会读空。 */
const fillPayload = (s: Snapshot): Snapshot => ({ ...s, approvals: (s.approvals ?? []).map((a) => (a.payload ? a : { ...a, payload: {} })) })

/** 合并视图里其他设备的项目名后面带上设备名，小镇名牌一眼看出是哪台。 */
export function labelRemote(s: Snapshot): Snapshot {
  const self = s.devices?.find((d) => d.self)?.name
  return fillPayload({ ...s, view: 'all', repos: (s.repos ?? []).map((r) => (r.device && r.device !== self ? { ...r, name: `${r.name} · ${r.device}` } : r)) })
}

/** 合并视图里只留一台别的电脑的东西：项目、会话、运行按编号偏移认，工作项、依赖、审批按“设备名:”前缀认。
 *  编号保持合并后的样子，点到时照旧认出是别台电脑上的；设备列表原样保留。找不到这台时返回 null。 */
export function pickDevice(s: Snapshot, deviceId: string): Snapshot | null {
  const others = (s.devices ?? []).filter((d) => !d.self)
  const n = others.findIndex((d) => d.id === deviceId) + 1
  if (!n) return null
  const prefix = `${others[n - 1].name}:`
  const mine = (id: number | null | undefined) => id != null && Math.floor(id / HUB_STRIDE) === n
  const ours = (id: string | null | undefined) => !!id && id.startsWith(prefix)
  return fillPayload({
    ...s,
    view: deviceScope(deviceId),
    repos: (s.repos ?? []).filter((r) => mine(r.id)),
    sessions: (s.sessions ?? []).filter((x) => mine(x.id)),
    work_items: (s.work_items ?? []).filter((w) => ours(w.id)),
    deps: (s.deps ?? []).filter((d) => ours(d.upstream)),
    runs: (s.runs ?? []).filter((r) => mine(r.id)),
    approvals: (s.approvals ?? []).filter((a) => ours(a.id)),
  })
}

/** 按范围给小镇要画的快照：'here' 返回 null（用本机快照），别的电脑只留它那一份，全部给合并视图。 */
export function scopedSnapshot(merged: Snapshot | null, scope: HubScope): Snapshot | null {
  if (!merged || scope === 'here') return null
  const id = scopeDevice(scope)
  return id ? pickDevice(merged, id) : labelRemote(merged)
}

export function useHub() {
  const [status, setStatus] = useState<HubStatus | null>(null)
  const [scope, setScopeState] = useState<HubScope>(() => { try { return readScope(localStorage.getItem(SCOPE_KEY)) } catch { return 'here' } })
  const [merged, setMerged] = useState<Snapshot | null>(null)
  const [error, setError] = useState('')
  useEffect(() => { api.hubStatus().then(setStatus).catch(() => setStatus({ role: '' })) }, [])
  const isAgent = status?.role === 'agent'
  useEffect(() => {
    // 其他设备：跟着推送节奏刷新最近一次推送结果，推不上去时小镇顶部能看到
    if (!isAgent) return
    const t = window.setInterval(() => { api.hubStatus().then(setStatus).catch(() => { /* 本机服务暂时不可用：保留上一次 */ }) }, 15_000)
    return () => window.clearInterval(t)
  }, [isAgent])
  const enabled = !!status?.role
  const active = enabled && scope !== 'here'
  useEffect(() => {
    if (!enabled) { setMerged(null); return }
    let live = true
    const load = () => api.hubSnapshot().then((s) => { if (live) { setMerged(s); setError('') } }).catch((e) => live && setError(String(e?.message ?? e)))
    load()
    const t = window.setInterval(load, active ? 10_000 : 60_000)
    return () => { live = false; window.clearInterval(t) }
  }, [enabled, active])
  const setScope = (s: HubScope) => { setScopeState(s); try { localStorage.setItem(SCOPE_KEY, s) } catch { /* 隐私模式：不记住 */ } }
  // 选了本机自己（例如从中心机记住的范围）就是“这台”；记住的那台电脑已不在列表里时退回“这台”，不画空小镇。
  const devices = merged?.devices ?? []
  const picked = scopeDevice(scope)
  const shown: HubScope = !enabled ? 'here' : picked && devices.length && !devices.some((d) => d.id === picked && !d.self) ? 'here' : scope
  const view = useMemo(() => (enabled ? scopedSnapshot(merged, shown) : null), [enabled, merged, shown])
  return { status, enabled, scope: shown, setScope, devices, merged: view, error: shown !== 'here' ? error : '' }
}
