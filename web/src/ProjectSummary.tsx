import type { Snapshot, WorkItem } from './types'
import { ago } from './model'
import { projectSummary, type ProjectFact } from './projectSummaryModel'
import { shortText } from './stage'

function labels(f: ProjectFact) { return [...new Set(f.sources.map(s => s.label))].join('、') }

export function ProjectSummary({ snap, items, repoId, onSelectItem }: { snap: Snapshot; items: WorkItem[]; repoId: number | null; onSelectItem: (id: string) => void }) {
  const summary = projectSummary(snap, items, repoId)
  const represented = new Set<string>()
  const shown = summary.blockers.filter(f => {
    const keys = f.sources.map(s => s.sessionId == null ? `work/${s.itemId}` : `session/${s.sessionId}`)
    const keep = keys.some(k => !represented.has(k))
    if (keep) keys.forEach(k => represented.add(k))
    return keep
  })
  const more = summary.blockers.filter(f => !shown.includes(f))
  const blockerRows = (facts: ProjectFact[]) => <ul aria-label="独立卡点与来源">{facts.map(f => <li key={f.key} title={f.text}><span>{shortText(f.text, 60)}</span><small>{labels(f)}{f.sources[0].at ? ` · ${ago(f.sources[0].at, snap.now)}` : ''}{f.sources.some(s => !s.observed) ? ' · 回报' : ''}</small></li>)}</ul>
  return <div className="project-digest">
    <dl className="project-summary" aria-label="项目进展、卡点与下一步">
      <div className="digest-progress"><dt>进展</dt><dd title={summary.progressText}>{summary.progressPrefix}{summary.unreported > 0 ? '此前回报：' : ''}{shortText(summary.progressText, 110)}{summary.progress && <small className="muted">{labels(summary.progress)} · {ago(summary.progress.sources[0].at, snap.now)} · 回报</small>}{summary.unreported > 0 && <small className="muted">另有 {summary.unreported} 个近期会话尚未回报</small>}</dd></div>
      <div className={summary.blockers.length ? 'digest-blocked' : ''}><dt>卡点</dt><dd>{summary.blockers.length ? <>{blockerRows(shown)}{more.length > 0 && <details className="more-blockers"><summary>其余 {more.length} 条卡点 · 全部保留</summary>{blockerRows(more)}</details>}</> : <span className="muted" title="卡点信息来自 Agent 回报；未填写不表示系统发现故障，也不代表已确认没有阻塞。">{summary.blockerEmpty}</span>}</dd></div>
      <div className="digest-next"><dt>下一步</dt><dd>{summary.actors.length ? <ul>{summary.actors.map(([owner, facts]) => <li key={owner}><strong>{owner}</strong><span title={facts[0].text}>{shortText(facts[0].text, 65)}</span><small>{facts[0].sources.some(s => !s.observed) ? '最近回报' : '当前状态'} · {ago(facts[0].sources[0].at, snap.now)}{facts.length > 1 ? ` · 另有 ${facts.length - 1} 条安排，见来源` : ''}</small></li>)}</ul> : <span className="muted">负责人及具体安排待回报</span>}</dd></div>
    </dl>
    <details className="digest-sources"><summary>摘要来源与全部安排</summary><p className="hint">从已有回报整理，未生成 AI 摘要；各会话的卡点与下一步分别保留。</p>{summary.sources.map((f, i) => <div className="digest-source" key={`${i}/${f.key}`}><p>{f.owner && <b>{f.owner} · </b>}{f.text}</p>{f.sources.map((s,j) => <small key={j}>{s.observed ? '服务观察' : 'Agent／用户回报'} · {s.label} · {s.itemId}{s.feature ? ` · ${s.feature}` : ''} · {ago(s.at, snap.now)} <button className="link" onClick={() => onSelectItem(s.itemId)}>查看依据</button></small>)}</div>)}</details>
  </div>
}
