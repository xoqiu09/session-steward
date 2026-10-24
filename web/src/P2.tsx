import { useEffect, useState } from 'react'
import type { AgentReview, AISummary, Review, Snapshot } from './types'
import { api } from './api'
import { ErrorLine, useAction } from './bits'
import { ago, providerLabel } from './model'
import { isRemote } from './access'
export { isRemote } from './access'

const pct = (n: number, d: number) => (d ? `${Math.round((n / d) * 100)}%` : '—')

// 复盘只展示计数和比例，并说明口径；不对 Agent 打分。
export function ReviewRow({ a }: { a: AgentReview }) {
  return <tr>
    <th scope="row">{providerLabel(a.provider)}</th>
    <td>{a.runs}</td>
    <td>{a.delivered}</td>
    <td>{a.accepted} <small className="muted">({pct(a.accepted, a.delivered)})</small></td>
    <td>{a.reopened} <small className="muted">({pct(a.reopened, a.delivered)})</small></td>
    <td>{a.open_pending}</td>
    <td>{a.abandoned}</td>
    <td>{a.handed_off}</td>
    <td>{a.checks_pass + a.checks_fail ? `${a.checks_pass} / ${a.checks_pass + a.checks_fail}` : '—'}</td>
  </tr>
}

export function ReviewTable({ review }: { review: Review }) {
  if (!review.agents.length) return <p className="hint">最近 {review.days} 天没有执行记录。</p>
  return <div className="review-wrap">
    <table className="review">
      <caption>最近 {review.days} 天开始的执行记录，按 Agent 汇总</caption>
      <thead><tr><th scope="col">Agent</th><th scope="col">执行</th><th scope="col">交付</th><th scope="col">已验收</th><th scope="col">交付后重开</th><th scope="col">待验收</th><th scope="col">放弃</th><th scope="col">交接出去</th><th scope="col">检查门通过</th></tr></thead>
      <tbody>{review.agents.map((a) => <ReviewRow key={a.provider} a={a} />)}</tbody>
    </table>
    <p className="hint">口径：“交付”是 Agent 提交过 deliver；“已验收”只计你标为完成的工作项；“检查门”是服务实际运行检查的结果。同一工作项有多个执行时分别计入。数字反映记录，不代表能力评分；样本少时比例意义有限。</p>
  </div>
}

export function ReviewPanel() {
  const [days, setDays] = useState(30)
  const [review, setReview] = useState<Review | null>(null)
  const [error, setError] = useState('')
  useEffect(() => {
    let live = true
    api.review(days).then((r) => { if (live) { setReview(r); setError('') } }).catch((e) => live && setError(String(e.message ?? e)))
    return () => { live = false }
  }, [days])
  return <section className="review-panel" aria-label="Agent 复盘">
    <div className="row"><h3>Agent 复盘</h3>
      <label>范围<select value={days} onChange={(e) => setDays(Number(e.target.value))}>{[7, 30, 90].map((d) => <option key={d} value={d}>最近 {d} 天</option>)}</select></label>
    </div>
    {review ? <ReviewTable review={review} /> : !error && <p className="muted">加载中…</p>}
    <ErrorLine msg={error} />
  </section>
}

// AI 摘要：始终标注“AI 推断”，与 Agent 自述、测试和用户验收区分；不替代简报。
export function SummaryView({ s, now }: { s: AISummary; now: string }) {
  return <div className="ai-summary">
    <span className="src src-ai">AI 推断</span> {s.text}
    <small className="muted"> · {ago(s.created_at, now)}生成；简报与功能状态为 Agent 自述，Git 元数据来自本机仓库{s.current ? '' : '；材料已更新，可能过期'}</small>
  </div>
}

export function AISummaryBox({ snap, itemId, repoId }: { snap: Snapshot; itemId: string; repoId: number | null }) {
  const enabled = repoId != null && (snap.summary_repos ?? []).includes(repoId)
  const [s, setS] = useState<AISummary | null>(null)
  const act = useAction()
  useEffect(() => {
    if (!enabled) return
    let live = true
    api.summary(itemId).then((r) => live && setS(r.summary)).catch(() => {})
    return () => { live = false }
  }, [itemId, enabled, snap.cursor])
  if (!enabled) return null
  const current = s?.work_item_id === itemId ? s : null
  return <div className="ai-summary-box">
    {current ? <SummaryView s={current} now={snap.now} /> : <p className="hint">还没有 AI 摘要。</p>}
    {!isRemote() && <button className="btn tiny" disabled={act.busy} onClick={() => act.run(() => api.generateSummary(itemId).then((r) => setS(r.summary)))}>{act.busy ? '生成中…' : s ? '重新生成' : '生成 AI 摘要'}</button>}
    <ErrorLine msg={act.error} />
  </div>
}
