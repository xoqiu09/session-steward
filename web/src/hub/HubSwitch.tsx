// 小镇顶部按电脑切换：这台、每台别的电脑（带在线状态）、全部。其他设备还显示推送到中心机的情况。
import { ago } from '../model'
import type { HubDevice, HubStatus } from '../types'
import { deviceScope, type HubScope } from './hub'

/** 推送比这慢就提示“同步慢”：中心机在忙或走了中继，还没到超时。 */
const SLOW_MS = 3000

export function HubSwitch({ scope, onScope, devices, error, now, status }: { scope: HubScope; onScope: (s: HubScope) => void; devices: readonly HubDevice[]; error: string; now: string; status?: HubStatus | null }) {
  const self = devices.find((d) => d.self)?.name || status?.device || ''
  const others = devices.filter((d) => !d.self)
  return (
    <span className="hub-switch" role="group" aria-label="看哪台电脑">
      <button type="button" className={scope === 'here' ? 'on' : ''} aria-pressed={scope === 'here'} onClick={() => onScope('here')}>{self ? `${self}（这台）` : '这台'}</button>
      {others.map((d) => {
        const s = deviceScope(d.id)
        return (
          <button key={d.id} type="button" className={`hub-dev${d.online ? ' is-on' : ''}${scope === s ? ' on' : ''}`} aria-pressed={scope === s} onClick={() => onScope(s)}
            title={d.online ? `${d.name}：在线，只能看` : `${d.name}：离线，显示的是 ${ago(d.received_at, now)}的样子，只能看`}>
            <i aria-hidden />{d.name}{!d.online ? ` · ${ago(d.received_at, now)}` : ''}
          </button>
        )
      })}
      <button type="button" className={scope === 'all' ? 'on' : ''} aria-pressed={scope === 'all'} onClick={() => onScope('all')}>{others.length ? `全部 ${devices.length}` : '全部设备'}</button>
      <PushState status={status} now={now} />
      {scope !== 'here' && error && <span className="hub-err" title={error}>连不上中心机</span>}
    </span>
  )
}

/** 其他设备推送到中心机的情况：失败时写明上次成功是多久前、连续失败几次；慢时写出耗时。 */
function PushState({ status, now }: { status?: HubStatus | null; now: string }) {
  if (status?.role !== 'agent' || !status.last_push_at) return null
  const to = status.url ?? '中心机'
  const took = status.last_push_ms ?? 0
  if (status.last_error) {
    const since = status.last_ok_at ? `上次成功是 ${ago(status.last_ok_at, now)}` : '这次启动后还没有成功过'
    const times = (status.fail_count ?? 0) > 1 ? `，已连续失败 ${status.fail_count} 次` : ''
    return <span className="hub-err" title={`推送到 ${to} 失败：${status.last_error}。${since}${times}。`}>推送失败 · {since}</span>
  }
  if (took >= SLOW_MS) return <span className="hub-slow" title={`推送到 ${to} 成功，但用了 ${(took / 1000).toFixed(1)} 秒：中心机可能在忙，或者两台之间走了中继。`}>同步慢 · {(took / 1000).toFixed(1)} 秒</span>
  return <span className="hub-ok" title={`最近一次推送到 ${to} 用了 ${took} 毫秒`}>已同步 · {ago(status.last_ok_at || status.last_push_at, now)}</span>
}
