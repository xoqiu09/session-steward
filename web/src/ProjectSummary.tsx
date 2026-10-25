import type { Snapshot, WorkItem } from './types'
import { ago } from './model'
import { projectSummary, toCheck, type FactSource, type ProjectFact } from './projectSummaryModel'
import { shortText } from './stage'

// The main card shows a bounded number of rows; the rest stay one click away with a count.
export const MAIN_ROWS = 3

function labels(f: ProjectFact) { return [...new Set(f.sources.map(s => s.label))].join('、') }
const when = (s: FactSource, now: string) => s.at ? ago(s.at, now) : '当前状态'
const kindTag = { formal: '正式请求，右侧处理', review: '待审阅，非审批' } as const

export function ProjectSummary({ snap, items, repoId, onSelectItem }: { snap: Snapshot; items: WorkItem[]; repoId: number | null; onSelectItem: (id: string) => void }) {
  const summary = projectSummary(snap, items, repoId)
  // One row per independent source; repeated sources and the overflow stay in the counted fold.
  const represented = new Set<string>()
  const distinct = summary.blockers.filter(f => {
    const keys = f.sources.map(s => s.sessionId == null ? `work/${s.itemId}` : `session/${s.sessionId}`)
    const keep = keys.some(k => !represented.has(k))
    if (keep) keys.forEach(k => represented.add(k))
    return keep
  })
  const shown = distinct.slice(0, MAIN_ROWS)
  const more = summary.blockers.filter(f => !shown.includes(f))
  const moreToCheck = more.filter(toCheck).length
  const open = (f: ProjectFact) => f.sources[0].itemId && <button className="link" onClick={() => onSelectItem(f.sources[0].itemId)} aria-label={`查看卡点来源 ${f.sources[0].itemId}：${shortText(f.text, 30)}`}>查看 {f.sources[0].itemId}</button>
  const blockerRows = (facts: ProjectFact[]) => <ul aria-label="独立卡点与来源">{facts.map(f => <li key={f.key} title={f.text} className={toCheck(f) ? 'to-check' : undefined}>
    {toCheck(f) && <em className="check-tag" title="来源较旧或会话已结束，尚无回报证明已解决">待核查</em>}<span>{shortText(f.text, 60)}</span>
    <small>{labels(f)}{f.sources[0].at ? ` · ${ago(f.sources[0].at, snap.now)}` : ''}{f.sources.some(s => !s.observed) ? ' · 回报' : ' · 服务状态'}{f.sources.length > 1 ? ` · ${f.sources.length} 个来源` : ''} {open(f)}</small></li>)}</ul>
  const actors = summary.actors.filter(([, facts]) => !toCheck(facts[0]))
  const olderPlans = summary.actors.filter(([, facts]) => toCheck(facts[0]))
  const actorRows = (rows: typeof actors) => <ul>{rows.map(([owner, facts]) => <li key={`${owner}/${facts[0].kind ?? ''}/${toCheck(facts[0])}`}>
    <strong>{owner}{facts[0].kind && <span className={`next-kind next-${facts[0].kind}`}> · {kindTag[facts[0].kind]}</span>}{toCheck(facts[0]) && <span className="next-kind"> · 待核查</span>}</strong>
    <span title={facts[0].text}>{shortText(facts[0].text, 65)}</span>
    <small>{facts[0].sources.some(s => !s.observed) ? '最近回报' : '当前状态'}{facts[0].sources[0].at ? ` · ${ago(facts[0].sources[0].at, snap.now)}` : ''}{facts[0].sources[0].sessionId != null && facts[0].sources[0].label !== owner ? ` · 来源 ${facts[0].sources[0].label}` : ''}{facts.length > 1 ? ` · 另有 ${facts.length - 1} 条同类安排，见来源` : ''}</small></li>)}</ul>
  return <div className="project-digest">
    <dl className="project-summary" aria-label="项目进展、卡点与下一步">
      <div className="digest-progress"><dt>进展</dt><dd title={summary.progressText}>{summary.progressPrefix}{summary.unreported > 0 ? '此前回报：' : ''}{shortText(summary.progressText, 110)}{summary.progress && <small className="muted">{labels(summary.progress)} · {ago(summary.progress.sources[0].at, snap.now)} · 回报{toCheck(summary.progress) ? ' · 来源较旧' : ''}</small>}{summary.unreported > 0 && <small className="muted">另有 {summary.unreported} 个近期会话尚未回报</small>}</dd></div>
      <div className={summary.blockers.length ? 'digest-blocked' : ''}><dt>卡点</dt><dd>{summary.blockers.length ? <>{blockerRows(shown)}{more.length > 0 && <details className="more-blockers"><summary>其余 {more.length} 条卡点{moreToCheck ? `（含待核查 ${moreToCheck} 条）` : ''} · 全部保留</summary>{blockerRows(more)}</details>}</> : <span className="muted" title="卡点信息来自 Agent 回报；未填写不表示系统发现故障，也不代表已确认没有阻塞。">{summary.blockerEmpty}</span>}</dd></div>
      <div className="digest-next"><dt>下一步</dt><dd>{actors.length ? actorRows(actors) : <span className="muted">{olderPlans.length ? '近期没有新的安排回报' : '负责人及具体安排待回报'}</span>}{olderPlans.length > 0 && <details className="more-blockers"><summary>待核查的旧安排 {olderPlans.reduce((n, [, f]) => n + f.length, 0)} 条 · 来源较旧或会话已结束</summary>{actorRows(olderPlans)}</details>}</dd></div>
    </dl>
    <details className="digest-sources"><summary>摘要来源与全部安排 · {summary.sources.length} 条</summary><p className="hint">从已有回报整理，未生成 AI 摘要；各会话的卡点与下一步分别保留。“待核查”只表示来源较旧或会话已结束，不表示已解决。</p>{summary.sources.map((f, i) => <div className="digest-source" key={`${i}/${f.key}`}><p>{toCheck(f) && <em className="check-tag">待核查</em>}{f.owner && <b>{f.owner}{f.kind ? ` · ${kindTag[f.kind]}` : ''} · </b>}{f.text}</p>{f.sources.map((s,j) => <small key={j}>{s.observed ? '服务观察' : 'Agent／用户回报'} · {s.label} · {s.itemId}{s.feature ? ` · ${s.feature}` : ''} · {when(s, snap.now)}{s.dated ? ' · 来源较旧或会话已结束' : ''} <button className="link" onClick={() => onSelectItem(s.itemId)}>查看依据</button></small>)}</div>)}</details>
  </div>
}
