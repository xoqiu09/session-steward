// 多设备：“这台 / 全部设备”切换。全部设备时每 10 秒向本机服务要合并视图（中心机就地合并，其他设备转问中心机）。
import { useEffect, useState } from 'react'
import { api } from '../api'
import type { HubStatus, Snapshot } from '../types'
import { HUB_STRIDE } from './ids'

export type HubScope = 'here' | 'all'
const SCOPE_KEY = 'ss.hub.scope'

export { HUB_STRIDE }
export function remoteDeviceOf(snap: Snapshot, kind: 'item' | 'session', id: string | number): string | null {
  const devs = snap.devices
  if (!devs?.length) return null
  if (kind === 'item') { const i = String(id).indexOf(':'); return i > 0 ? String(id).slice(0, i) : null }
  const n = Math.floor(Number(id) / HUB_STRIDE)
  return n > 0 ? devs.filter((d) => !d.self)[n - 1]?.name ?? '另一台电脑' : null
}

/** 合并视图里其他设备的项目名后面带上设备名，小镇名牌一眼看出是哪台。
 *  摘要不带审批详情（payload 为 null），补成空对象，按本机快照写的页面才不会读空。 */
export function labelRemote(s: Snapshot): Snapshot {
  const self = s.devices?.find((d) => d.self)?.name
  return {
    ...s,
    repos: (s.repos ?? []).map((r) => (r.device && r.device !== self ? { ...r, name: `${r.name} · ${r.device}` } : r)),
    approvals: (s.approvals ?? []).map((a) => (a.payload ? a : { ...a, payload: {} })),
  }
}

export function useHub() {
  const [status, setStatus] = useState<HubStatus | null>(null)
  const [scope, setScopeState] = useState<HubScope>(() => { try { return localStorage.getItem(SCOPE_KEY) === 'all' ? 'all' : 'here' } catch { return 'here' } })
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
  const active = enabled && scope === 'all'
  useEffect(() => {
    if (!active) { setMerged(null); return }
    let live = true
    const load = () => api.hubSnapshot().then((s) => { if (live) { setMerged(labelRemote(s)); setError('') } }).catch((e) => live && setError(String(e?.message ?? e)))
    load()
    const t = window.setInterval(load, 10_000)
    return () => { live = false; window.clearInterval(t) }
  }, [active])
  const setScope = (s: HubScope) => { setScopeState(s); try { localStorage.setItem(SCOPE_KEY, s) } catch { /* 隐私模式：不记住 */ } }
  return { status, enabled, scope: enabled ? scope : 'here' as HubScope, setScope, merged: active ? merged : null, error: active ? error : '' }
}
