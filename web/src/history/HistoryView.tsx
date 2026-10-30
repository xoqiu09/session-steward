// 历史：一年热力图 + 区间合计 + 近 30 天按 Agent 的柱状图；点某天看那天的小结。只读。
import { useEffect, useMemo, useState } from 'react'
import { api } from '../api'
import { AgentBadge } from '../bits'
import { shownNo } from '../hub/ids'
import type { DayDetail, DayStat, HistoryResp, Snapshot } from '../types'
import {
  METRIC_LABEL, changeText, dayKey, fmtNum, heatmapWeeks, levels, metricOf, parseDay, providerBars, rangeSums, streak, tokenTotal, type Metric,
} from './historyModel'

const WEEK = ['周一', '周二', '周三', '周四', '周五', '周六', '周日']
const PROVIDER_COLOR: Record<string, string> = { claude: '#d9774b', codex: '#334055' }
const dayLabel = (s: string) => { const d = parseDay(s); return `${d.getMonth() + 1}/${d.getDate()} ${WEEK[(d.getDay() + 6) % 7]}` }
const hm = (ts: string) => { const d = new Date(ts); return Number.isNaN(d.getTime()) ? '—' : `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}` }

function tip(d: DayStat | undefined, day: string, tokens: boolean) {
  if (!d) return `${dayLabel(day)} · 没有活动`
  const parts = [`对话 ${d.prompts} 轮`, `工具 ${d.tools} 次`]
  if (d.delivered) parts.push(`交付 ${d.delivered}`)
  if (d.accepted) parts.push(`验收 ${d.accepted}`)
  if (d.returned) parts.push(`退回 ${d.returned}`)
  if (tokens && tokenTotal(d.tokens)) parts.push(`${fmtNum(tokenTotal(d.tokens))} token`)
  return `${dayLabel(day)} · ${parts.join(' · ')}`
}

export function HistoryView({ snap, onSelectSession, onSelectItem, onReplayDay }: { snap: Snapshot; onSelectSession: (id: number) => void; onSelectItem: (id: string) => void; onReplayDay?: (day: string) => void }) {
  const [data, setData] = useState<HistoryResp | null>(null)
  const [error, setError] = useState('')
  const [metric, setMetric] = useState<Metric>('work')
  const [picked, setPicked] = useState<string | null>(null)
  useEffect(() => {
    let live = true
    const load = () => api.history().then((h) => {
      if (!live) return
      // 服务端太旧、没有历史接口时会回一个空对象：说明原因，而不是整页空白。
      if (!h || !Array.isArray(h.days) || !h.to) { setError('服务端没有历史接口，请更新并重启 Steward'); return }
      setData(h); setError('')
    }).catch((e) => live && setError(String(e?.message ?? e)))
    load()
    const t = window.setInterval(load, 60_000)
    return () => { live = false; window.clearInterval(t) }
  }, [])
  const byDay = useMemo(() => new Map((data?.days ?? []).map((d) => [d.day, d])), [data])
  if (error) return <div className="history-view"><p className="warn-line">历史读取失败：{error}</p></div>
  if (!data) return <div className="history-view"><p className="muted">正在读取历史…</p></div>
  const to = data.to
  const weeks = heatmapWeeks(to)
  const level = levels(data.days.map((d) => metricOf(d, metric)))
  const sums = rangeSums(data.days, to)
  const lastActive = [...data.days].reverse().find((d) => d.prompts + d.tools > 0)?.day ?? to
  const day = picked ?? lastActive
  const bars = providerBars(data.days, to)
  const barMax = Math.max(1, ...bars.map((b) => b.parts.reduce((n, p) => n + p.value, 0)))
  // 月份标在当月第一周那一列；离上一个标签太近（不到 3 列）就不标，免得挤在一起。
  let lastLabel = -9
  const months = weeks.map((col, i) => {
    const first = col.find(Boolean)
    if (!first) return ''
    const d = parseDay(first)
    const prev = i ? weeks[i - 1].find(Boolean) : null
    if ((prev && parseDay(prev).getMonth() === d.getMonth()) || i - lastLabel < 3) return ''
    lastLabel = i
    return `${d.getMonth() + 1}月`
  })

  return (
    <div className="history-view">
      <header className="history-head">
        <div>
          <span className="eyebrow">历史</span>
          <h1>每天做了什么</h1>
          <p className="muted">从本机记录算出：对话轮数和工具次数来自会话事件，交付、验收、退回来自工作项的状态变化。连续活动 {streak(data.days, to)} 天。</p>
        </div>
        <div className="history-metric" role="group" aria-label="热力图按什么上色">
          {(['work', 'tokens', 'accepted'] as Metric[]).map((m) => (
            <button key={m} type="button" className={metric === m ? 'on' : ''} aria-pressed={metric === m} disabled={m === 'tokens' && !data.tokens_enabled} onClick={() => setMetric(m)}>{METRIC_LABEL[m]}</button>
          ))}
        </div>
      </header>
      {!data.tokens_enabled && (
        <p className="history-note">token 统计没有开启，所以只显示活动和验收。想看每天、每个会话用了多少 token：在 <code>~/.steward/config.json</code> 里加上 <code>"usage_from_transcripts": true</code>，再运行 <code>steward service restart</code>。只读数字，不读对话内容。</p>
      )}
      <div className="history-ranges">
        {sums.map((s) => (
          <div key={s.label} className="history-range">
            <span className="muted">{s.label}</span>
            <strong>{s.active} 天有活动</strong>
            <small>对话 {s.prompts} 轮 · 交付 {s.delivered} · 验收 {s.accepted}{s.returned ? ` · 退回 ${s.returned}` : ''}</small>
            {data.tokens_enabled && <small>{fmtNum(s.tokens)} token</small>}
          </div>
        ))}
      </div>

      <div className={`history-heat metric-${metric}`} role="grid" aria-label={`近一年每天的${METRIC_LABEL[metric]}`}>
        <div className="heat-months" aria-hidden>{months.map((m, i) => <span key={i}>{m}</span>)}</div>
        <div className="heat-body">
          <div className="heat-weekdays" aria-hidden><span>一</span><span /><span>三</span><span /><span>五</span><span /><span /></div>
          {weeks.map((col, i) => (
            <div key={i} className="heat-col" role="row">
              {col.map((d, j) => d
                ? <button key={d} type="button" role="gridcell" className={`heat-cell lv-${level(metricOf(byDay.get(d), metric))}${d === day ? ' is-picked' : ''}`}
                    title={tip(byDay.get(d), d, data.tokens_enabled)} aria-label={tip(byDay.get(d), d, data.tokens_enabled)} onClick={() => setPicked(d)} />
                : <span key={j} className="heat-cell is-empty" />)}
            </div>
          ))}
        </div>
        <div className="heat-legend" aria-hidden>少 {[0, 1, 2, 3, 4].map((l) => <i key={l} className={`heat-cell lv-${l}`} />)} 多</div>
      </div>

      {data.tokens_enabled && (
        <section className="history-bars" aria-label="近 30 天每天各 Agent 的 token">
          <h3>近 30 天 · 每天各 Agent 的 token</h3>
          <div className="bars">
            {bars.map((b) => {
              const total = b.parts.reduce((n, p) => n + p.value, 0)
              return (
                <button key={b.day} type="button" className={`bar${b.day === day ? ' is-picked' : ''}`} title={`${dayLabel(b.day)} · ${fmtNum(total)} token${b.parts.map((p) => ` · ${p.provider} ${fmtNum(p.value)}`).join('')}`} onClick={() => setPicked(b.day)}>
                  <span className="bar-stack" style={{ height: `${(total / barMax) * 100}%` }}>
                    {b.parts.map((p) => <i key={p.provider} style={{ flexGrow: p.value, background: PROVIDER_COLOR[p.provider] ?? '#8a7a9e' }} />)}
                  </span>
                </button>
              )
            })}
          </div>
          <p className="bars-legend">{Object.entries(PROVIDER_COLOR).map(([p, c]) => <span key={p}><i style={{ background: c }} />{p === 'claude' ? 'Claude' : 'Codex'}</span>)}<span><i style={{ background: '#8a7a9e' }} />其他</span></p>
        </section>
      )}

      <DayPanel day={day} stat={byDay.get(day)} snap={snap} tokens={data.tokens_enabled} onSelectSession={onSelectSession} onSelectItem={onSelectItem} onReplay={onReplayDay} />
    </div>
  )
}

function DayPanel({ day, stat, snap, tokens, onSelectSession, onSelectItem, onReplay }: { day: string; stat?: DayStat; snap: Snapshot; tokens: boolean; onSelectSession: (id: number) => void; onSelectItem: (id: string) => void; onReplay?: (day: string) => void }) {
  const [detail, setDetail] = useState<DayDetail | null>(null)
  const [error, setError] = useState('')
  useEffect(() => {
    let live = true
    setDetail(null)
    api.historyDay(day).then((d) => live && setDetail(d)).catch((e) => live && setError(String(e?.message ?? e)))
    return () => { live = false }
  }, [day])
  const repoName = (id: number | null) => (snap.repos ?? []).find((r) => r.id === id)?.name ?? '未关联项目'
  const sessionTitle = (id: number) => (snap.sessions ?? []).find((s) => s.id === id)?.title ?? ''
  const groups = new Map<string, NonNullable<DayDetail>['items']>()
  for (const it of detail?.items ?? []) { const k = repoName(it.repo_id); groups.set(k, [...(groups.get(k) ?? []), it]) }
  const isToday = day === dayKey(new Date())
  return (
    <section className="history-day" aria-label={`${dayLabel(day)} 的小结`}>
      <div className="history-day-head">
        <h2>{dayLabel(day)}{isToday ? '（今天）' : ''}</h2>
        {onReplay && stat && <button type="button" className="btn small" onClick={() => onReplay(day)} title="在小镇里拖时间条看这一天的变化">在小镇回放这一天</button>}
      </div>
      {stat ? (
        <p className="history-day-sum">
          {stat.sessions} 个会话 · 对话 {stat.prompts} 轮 · 工具 {stat.tools} 次{stat.subagents ? ` · 子 Agent ${stat.subagents} 个` : ''} · 交付 {stat.delivered} · 验收 {stat.accepted}
          {stat.returned ? ` · 退回 ${stat.returned}` : ''}{stat.blocked ? ` · 受阻 ${stat.blocked}` : ''}{stat.failed ? ` · 失败 ${stat.failed}` : ''}
          {tokens && tokenTotal(stat.tokens) ? ` · ${fmtNum(tokenTotal(stat.tokens))} token` : ''}
        </p>
      ) : <p className="muted">这一天没有记录到活动。</p>}
      {error && <p className="warn-line">读取失败：{error}</p>}
      {!detail && !error && stat && <p className="muted">正在读取这一天…</p>}
      {detail && (
        <div className="history-day-grid">
          <div>
            <h3>工作项的变化</h3>
            {groups.size === 0 && <p className="muted">这一天没有工作项变过状态。</p>}
            {[...groups.entries()].map(([repo, items]) => (
              <div key={repo} className="history-repo">
                <h4>{repo}</h4>
                <ul>
                  {items.map((it) => (
                    <li key={it.id}>
                      <button type="button" className="linkish" onClick={() => onSelectItem(it.id)}><code>{it.id}</code> {it.title}</button>
                      <span className="history-changes">{it.changes.map((c, i) => { const t = changeText(c); return <span key={i} className={`chg tone-${t.tone}`}>{hm(c.at)} {t.text}</span> })}</span>
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
          <div>
            <h3>在干活的会话</h3>
            {detail.sessions.length === 0 && <p className="muted">这一天没有会话事件。</p>}
            <ul className="history-sessions">
              {detail.sessions.map((s) => (
                <li key={s.id}>
                  <button type="button" onClick={() => onSelectSession(s.id)}>
                    <AgentBadge provider={s.provider} /> <strong>#{shownNo(s.id)}</strong> <span className="ellipsis">{sessionTitle(s.id) || repoName(s.repo_id)}</span>
                    <small className="muted">{hm(s.first)}–{hm(s.last)} · {repoName(s.repo_id)}{s.work_item_id ? ` · ${s.work_item_id}` : ''}</small>
                    <small>对话 {s.prompts} 轮 · 工具 {s.tools} 次{s.tool_failed ? `（失败 ${s.tool_failed}）` : ''}{s.subagents ? ` · 子 Agent ${s.subagents}` : ''}{tokens && tokenTotal(s.tokens) ? ` · ${fmtNum(tokenTotal(s.tokens))} token` : ''}</small>
                  </button>
                </li>
              ))}
            </ul>
          </div>
        </div>
      )}
    </section>
  )
}
