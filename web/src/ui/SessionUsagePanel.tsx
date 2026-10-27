// 会话详情里的“消耗”：会话自身和子 Agent 的 token，按模型拆开。只有开启用量统计时才显示。
import type { SessionUsageDetail, Tokens } from '../types'
import { fmtNum, tokenTotal } from '../history/historyModel'

const parts = (t: Tokens) => `输入 ${fmtNum(t.input)} · 输出 ${fmtNum(t.output)} · 缓存读 ${fmtNum(t.cache_read)} · 缓存写 ${fmtNum(t.cache_write)}`
const hm = (ts: string) => { const d = new Date(ts); return Number.isNaN(d.getTime()) ? '' : `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}` }

export function SessionUsagePanel({ usage }: { usage: SessionUsageDetail | null }) {
  if (!usage?.enabled || !usage.found) return null
  const models = Object.entries(usage.self.models).sort((a, b) => tokenTotal(b[1]) - tokenTotal(a[1]))
  const subTotal = tokenTotal(usage.with_subagents) - tokenTotal(usage.self.total)
  return (
    <section className="session-usage" aria-label="消耗">
      <h3>消耗 <small className="muted">只读本地记录里的数字</small></h3>
      <p className="usage-total"><strong>{fmtNum(tokenTotal(usage.with_subagents))}</strong> token{usage.subagents.length ? <small className="muted">（会话 {fmtNum(tokenTotal(usage.self.total))} + 子 Agent {fmtNum(subTotal)}）</small> : null}</p>
      <p className="muted usage-parts">{parts(usage.self.total)}</p>
      {models.length > 1 && <ul className="usage-models">{models.map(([m, t]) => <li key={m}><code>{m}</code> {fmtNum(tokenTotal(t))}</li>)}</ul>}
      {usage.subagents.length > 0 && (
        <>
          <h4>子 Agent · {usage.subagents.length} 个</h4>
          <ul className="usage-subagents">
            {usage.subagents.map((s) => (
              <li key={s.id}>
                <span className={`sub-state ${s.finished ? 'done' : 'running'}`}>{s.finished ? '✓ 完成' : '… 进行中'}</span>
                <span className="sub-type">{s.type || '子 Agent'}</span>
                <span className="sub-desc" title={s.description}>{s.description}</span>
                <small className="muted">{hm(s.start)}{s.end ? `–${hm(s.end)}` : ''} · {fmtNum(tokenTotal(s.total))}</small>
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  )
}
