// 小镇时间条：选一天、拖到某个时刻，或按“播放”每 0.7 秒前进 10 分钟。回放时只能看。
import { useEffect } from 'react'

export interface ReplayPos { day: string; minute: number }

const pad = (n: number) => String(n).padStart(2, '0')
export const minuteLabel = (m: number) => `${pad(Math.floor(m / 60))}:${pad(m % 60)}`
const todayKey = () => { const d = new Date(); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` }

/** 回放位置换成接口要的 ISO 时间（本机时区的那一刻）。 */
export function replayISO(p: ReplayPos): string {
  const [y, mo, d] = p.day.split('-').map(Number)
  return new Date(y, mo - 1, d, Math.floor(p.minute / 60), p.minute % 60).toISOString()
}

/** 今天最多只能拖到现在。 */
export function maxMinute(day: string): number {
  if (day !== todayKey()) return 24 * 60 - 5
  const n = new Date()
  return Math.max(0, Math.floor((n.getHours() * 60 + n.getMinutes()) / 5) * 5)
}

/** 进入回放的默认位置：给了日期就从那天 9 点开始，否则从一小时前开始。 */
export function startPos(day?: string): ReplayPos {
  if (day && day !== todayKey()) return { day, minute: 9 * 60 }
  return { day: todayKey(), minute: Math.max(0, maxMinute(todayKey()) - 60) }
}

export function ReplayBar({ pos, playing, loading, onChange, onPlay, onExit }: {
  pos: ReplayPos; playing: boolean; loading: boolean
  onChange: (p: ReplayPos) => void; onPlay: (on: boolean) => void; onExit: () => void
}) {
  const max = maxMinute(pos.day)
  useEffect(() => {
    if (!playing) return
    const t = window.setInterval(() => {
      if (pos.minute >= max) { onPlay(false); return }
      onChange({ ...pos, minute: Math.min(max, pos.minute + 10) })
    }, 700)
    return () => window.clearInterval(t)
  }, [playing, pos, max])
  return (
    <div className="town-replay" role="group" aria-label="小镇回放" onPointerDown={(e) => e.stopPropagation()}>
      <strong className="town-replay-label">回放 {pos.day.slice(5).replace('-', '/')} {minuteLabel(pos.minute)}{loading ? ' …' : ''}</strong>
      <input type="date" value={pos.day} max={todayKey()} aria-label="回放日期"
        onChange={(e) => e.target.value && onChange({ day: e.target.value, minute: Math.min(pos.minute, maxMinute(e.target.value)) })} />
      <button type="button" onClick={() => onChange({ ...pos, minute: Math.max(0, pos.minute - 30) })} aria-label="往前 30 分钟">−30分</button>
      <input type="range" min={0} max={max} step={5} value={Math.min(pos.minute, max)} aria-label="回放时刻"
        onChange={(e) => onChange({ ...pos, minute: Number(e.target.value) })} />
      <button type="button" onClick={() => onChange({ ...pos, minute: Math.min(max, pos.minute + 30) })} aria-label="往后 30 分钟">+30分</button>
      <button type="button" className="town-replay-play" onClick={() => onPlay(!playing)}>{playing ? '暂停' : '播放'}</button>
      <button type="button" onClick={onExit}>回到现在</button>
    </div>
  )
}
