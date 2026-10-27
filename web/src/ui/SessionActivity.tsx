// 会话详情里的“最近活动”：按轮次显示，每轮一行摘要，展开看这一轮用了哪些工具、请求了什么。原始 hook 记录收在最后。
import { ago } from '../model'
import { endLabel, eventTurns, type RawEvent, type Step } from './eventTurns'
import { clock } from './runDeskModel'
import { fmtNum, tokenTotal } from '../history/historyModel'
import type { TurnUsage } from '../types'

const MARK: Record<Step['tone'], string> = { ok: '✓', fail: '✗', running: '…', ask: '?', info: '·' }

/** 每轮的 token：本地记录里那条消息的时间和 hook 收到的时间差几秒，90 秒内算同一轮。 */
function tokensFor(start: string, usage?: readonly TurnUsage[]): number | null {
  if (!usage?.length) return null
  const t = Date.parse(start)
  let best: TurnUsage | null = null
  for (const u of usage) if (Math.abs(Date.parse(u.start) - t) <= 90_000 && (!best || Math.abs(Date.parse(u.start) - t) < Math.abs(Date.parse(best.start) - t))) best = u
  return best ? tokenTotal(best) : null
}

export function SessionActivity({ events, now, folded = false, turnUsage }: { events: readonly RawEvent[]; now: string; folded?: boolean; turnUsage?: readonly TurnUsage[] }) {
  const recent = events.slice(0, 60)
  const turns = eventTurns(recent)
  const raw = (
    <details className="activity-raw">
      <summary>原始记录 {recent.length} 条（排查用）</summary>
      <ol className="events">
        {recent.map((e) => (
          <li key={String(e.event_id)}>
            <span className="muted">{ago(String(e.occurred_at), now)}</span> <code>{String(e.kind)}</code>{' '}
            <span className="ellipsis">{String(e.preview ?? e.reason ?? e.text ?? '')}</span>
          </li>
        ))}
      </ol>
    </details>
  )
  const body = turns.length === 0 ? <p className="muted">还没有收到这个会话的事件。</p> : (
    <ol className="activity-turns">
      {turns.map((t, i) => {
        const toolSum = t.tools.length ? `用了 ${t.tools.reduce((n, x) => n + x.count, 0)} 次工具（${t.tools.slice(0, 3).map((x) => `${x.name} ${x.count}`).join('、')}${t.tools.length > 3 ? ' 等' : ''}）` : '没有用工具'
        const state = t.end ? endLabel[t.end] : i === 0 ? '进行中' : '没有收到结束信号'
        const tok = tokensFor(t.start, turnUsage)
        return (
          <li key={t.key} className={`activity-turn${t.end ? '' : ' is-open'}${t.end === 'stop_failure' || t.failed ? ' has-fail' : ''}`}>
            <details open={i === 0}>
              <summary>
                <span className="activity-when" title={t.start}>{ago(t.start, now)}</span>
                <span className="activity-opener">{t.opener}</span>
                <span className="activity-meta">{toolSum}{t.failed ? ` · 失败 ${t.failed}` : ''}{tok ? ` · ${fmtNum(tok)} token` : ''} · {state}</span>
              </summary>
              {t.steps.length > 0 && <ol className="activity-steps">
                {t.steps.map((s) => (
                  <li key={s.key} className={`tone-${s.tone}`}>
                    <span className="activity-time">{clock(s.at).slice(-5)}</span>
                    <span className="activity-mark" aria-hidden>{MARK[s.tone]}</span>
                    <span className="activity-label">{s.label}</span>
                    {s.detail && <code className="activity-detail" title={s.detail}>{s.detail}</code>}
                  </li>
                ))}
              </ol>}
            </details>
          </li>
        )
      })}
    </ol>
  )
  return folded
    ? <details className="events-fold"><summary>最近活动 <small className="muted">{turns.length} 轮</small></summary>{body}{raw}</details>
    : <section className="session-activity" aria-label="最近活动"><h3>最近活动 <small className="muted">按轮次 · 最近 {turns.length} 轮</small></h3>{body}{raw}</section>
}
