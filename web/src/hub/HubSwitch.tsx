// 小镇顶部的“这台 / 全部设备”切换，全部设备时列出每台的在线状态。
import { ago } from '../model'
import type { Snapshot } from '../types'
import type { HubScope } from './hub'

export function HubSwitch({ scope, onScope, merged, error, now }: { scope: HubScope; onScope: (s: HubScope) => void; merged: Snapshot | null; error: string; now: string }) {
  const devs = merged?.devices ?? []
  return (
    <span className="hub-switch" role="group" aria-label="看哪台电脑">
      <button type="button" className={scope === 'here' ? 'on' : ''} aria-pressed={scope === 'here'} onClick={() => onScope('here')}>这台</button>
      <button type="button" className={scope === 'all' ? 'on' : ''} aria-pressed={scope === 'all'} onClick={() => onScope('all')}>全部设备{devs.length ? ` ${devs.length}` : ''}</button>
      {scope === 'all' && error && <span className="hub-err" title={error}>连不上中心机</span>}
      {scope === 'all' && devs.map((d) => (
        <span key={d.id} className={`hub-dev${d.online ? ' is-on' : ''}`} title={d.online ? `${d.name}：在线` : `${d.name}：离线，显示的是 ${ago(d.received_at, now)}的样子`}>
          <i aria-hidden />{d.name}{d.self ? '（本机）' : ''}{!d.online ? ` · ${ago(d.received_at, now)}` : ''}
        </span>
      ))}
    </span>
  )
}
