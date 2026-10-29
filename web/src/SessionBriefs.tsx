import type { Session, Snapshot, WorkItem } from './types'
import { AgentBadge } from './bits'
import { BriefStamp } from './BriefStamp'
import { field, legacyBrief } from './brief'
import { handoffAnswered, ownerLabel, reporterItem, shortText, stageView } from './stage'
import { sessionSignal } from './model'
import { shownNo } from './hub/ids'

export function SessionBriefs({ snap, item, sessions, onSelect, historical = false }: { snap: Snapshot; item: WorkItem; sessions: Session[]; onSelect?: (id: number) => void; historical?: boolean }) {
  return <div className="session-briefs" aria-label="按会话分别回报">
    <p className="parallel-explain">{historical ? '此前会话的最后回报，保留来源和时间。' : `${sessions.length} 个近期会话协作；各自的进展与下一步分别显示。`}</p>
    <ol>{sessions.map((session) => <ReporterBrief key={session.id} snap={snap} item={item} session={session} onSelect={onSelect} />)}</ol>
  </div>
}

function ReporterBrief({ snap, item, session, onSelect }: { snap: Snapshot; item: WorkItem; session: Session; onSelect?: (id: number) => void }) {
  const own = reporterItem(item, session)
  const stage = stageView(own)
  const summary = field(own, 'summary')
  const progress = field(own, 'progress')
  const headline = summary && (!progress || summary.at >= progress.at) ? summary : progress
  const blocker = field(own, 'blocker')
  const next = field(own, 'next')
  const signal = sessionSignal(snap, session)
  return <li className="session-brief" aria-label={`会话 #${shownNo(session.id)} 的独立简报`}>
    <div className="session-brief-head"><AgentBadge provider={session.provider} /><button className="link" onClick={() => onSelect?.(session.id)} disabled={!onSelect} title={session.provider_session_id}>会话 #{session.id}</button><strong>{stage.label}</strong></div>
    {session.title && <small className="muted session-brief-title">{session.title}</small>}
    {(session.state === 'ended' || session.freshness === 'stale') && <small className="muted">{session.state === 'ended' ? '会话已结束，保留最后回报' : '长时间无活动，保留最后回报'}</small>}
    <p className={headline ? 'session-brief-summary' : 'muted'} title={headline?.text}>{headline ? legacyBrief(headline) ? '旧格式回报，需该会话更新；不能把命令参数当作业务结论。' : shortText(headline.text, 80) : '此会话尚未回报进展，阶段无法判断。'}</p>
    {headline && legacyBrief(headline) && <details className="brief-details"><summary>查看旧格式原文</summary><p>{headline.text}</p></details>}
    {headline && <BriefStamp snap={snap} value={headline} />}
    {own.brief?.stale && <small className="stale">回报后仍有较多活动，内容可能过期</small>}
    {blocker && <p className="session-blocker">卡点：{shortText(blocker.text, 80)}</p>}
    <p className="session-next"><strong>下一步 · {handoffAnswered(own) ? '已回应，等待 Agent 更新' : ownerLabel(snap, field(own, 'next_owner'))}</strong><span>{handoffAnswered(own) ? '已收到同一会话的回应；原始简报保留在详情中。' : next ? shortText(next.text, 90) : '尚未回报下一步；不会借用另一个会话的安排。'}</span></p>
    {['warn', 'danger'].includes(signal.tone) && signal.label !== '需关注' && <p className="session-request">{signal.label}：{signal.reason}</p>}
    {session.branch && <small className="muted">分支：{session.branch}</small>}
  </li>
}
