import { useState } from 'react'
import type { BriefField, BriefKey, Snapshot, WorkItem } from './types'
import { type Group, ago, itemSignal, itemStatusLabel, providerLabel, sessionsFor } from './model'
import { field, legacyBrief, progressView } from './brief'
import { AgentBadge } from './bits'
import { StageBand } from './StageBand'
import { currentReporters, handoffAnswered, nextOwner, ownerLabel, primaryItem, shortText, stages } from './stage'
import { BriefStamp } from './BriefStamp'
import { SessionBriefs } from './SessionBriefs'
import { FeatureProgress } from './FeatureProgress'
import { HistoryItems } from './HistoryItems'
import { ProjectSummary } from './ProjectSummary'
import { orderedProjects } from './projectActivity'

const needsAction = (s: ReturnType<typeof itemSignal>) => s.label !== '需关注' && ['warn', 'danger', 'review'].includes(s.tone)

function latestContent(w: WorkItem) {
  return [field(w, 'summary')?.at || '', field(w, 'stage')?.at || '', field(w, 'progress')?.at || '', w.updated_at].sort().at(-1) || ''
}

export function Overview({ snap, groups, onSelectItem, onSelectSession, onOpenAttribution, onQueue, pendingCount, reviewCount = 0, expandQuiet = false }: {
  snap: Snapshot; groups: Group[]; onSelectItem: (id: string) => void; onSelectSession?: (id: number) => void; onOpenAttribution: () => void; onQueue: (lane?: 'action' | 'review') => void; pendingCount: number; reviewCount?: number; expandQuiet?: boolean
}) {
  const [focus, setFocus] = useState(false)
  const projects = orderedProjects(snap, groups)
  const filtered = projects.filter(p => !focus || p.counts.action || p.counts.review)
  const current = filtered.filter(p => !p.quiet || focus || expandQuiet)
  const quiet = filtered.filter(p => p.quiet && !focus && !expandQuiet)
  const archivedOnly = groups.filter(g => g.items.length === 0).flatMap(g => g.history ?? [])
  const loose = groups.reduce((n, g) => n + g.sessions.length, 0)
  const missing = projects.flatMap(p => p.group.items).filter((w) => progressView(snap, w).empty && w.status !== 'todo').length
  const renderProject = (p: typeof projects[number]) => {
      const g = p.group
      const items = [...g.items].sort((a, b) => Number(needsAction(itemSignal(snap, b))) - Number(needsAction(itemSignal(snap, a))) || latestContent(b).localeCompare(latestContent(a)))
      const counts = p.counts
      return <section className="overview-project" key={g.key} aria-label={`${g.name} 项目简报`}>
        <div className="overview-project-head"><h2>{g.name}</h2>{counts.action > 0 && <span className="project-action-count">审批／决定 {counts.action}</span>}</div>
        <p className="project-activity"><strong>{counts.action ? '待审批／决定' : p.running ? `运行中 · ${p.running} 个会话` : p.quiet ? '近期无活动' : '24 小时内有活动'}</strong><span>{p.lastActivityAt ? `最近活动 ${ago(new Date(p.lastActivityAt).toISOString(), snap.now)}` : '活动时间未知'}</span>{p.lastReportAt > 0 && <span>最近回报 {ago(new Date(p.lastReportAt).toISOString(), snap.now)}</span>}</p>
        <ProjectSummary snap={snap} items={items} repoId={g.repoId} onSelectItem={onSelectItem} />
        <details className="project-feature-details"><summary>核心功能 · {(snap.features ?? []).filter(f => f.repo_id === g.repoId).length} 项</summary><FeatureProgress snap={snap} repoId={g.repoId} onSelectItem={onSelectItem} onSelectSession={onSelectSession} /></details>
        <details className="project-work-details"><summary>工作项与会话 · {items.length} 项 · 审批与接力详情</summary><div className="brief-task-grid">{items.map((w) => <TaskBrief key={w.id} snap={snap} item={w} onSelect={() => onSelectItem(w.id)} onSelectSession={onSelectSession} />)}</div></details>
        <HistoryItems snap={snap} items={g.history ?? []} onSelect={onSelectItem} />
      </section>
  }
  return <div className="project-briefs">
    <div className="briefs-heading">
      <div><span className="eyebrow">项目简报</span><h1>做到哪 · 卡在哪 · 谁接着做</h1><p>审批请求和正在运行的项目优先，其余按最近活动排序；超过 24 小时无活动的项目默认收起。</p></div>
      <div className="brief-queue-links"><button className={`btn ${pendingCount ? 'primary' : ''}`} onClick={() => onQueue('action')}>审批／决定 {pendingCount}</button><button className="btn" onClick={() => onQueue('review')}>待审阅／验收 {reviewCount}</button></div>
    </div>
    <div className="briefs-filters"><label><input type="checkbox" checked={focus} onChange={(e) => setFocus(e.target.checked)} /> 只看需我处理的项目</label><span className="muted">显示 {current.length} 个项目{quiet.length > 0 ? ` · 已收起 ${quiet.length} 个` : ''}</span></div>
    <div className="overview-projects" aria-label="当前项目">{current.map(renderProject)}</div>
    {quiet.length > 0 && <details className="quiet-projects"><summary>近期无活动 · {quiet.length} 个项目 · 待审阅／验收 {quiet.reduce((n,p) => n + p.counts.review, 0)}</summary><p className="hint">最近 24 小时没有新活动，旧回报和待验收仍保留。展开可查看；有新活动或正式审批请求时会自动回到上方。</p><div className="overview-projects">{quiet.map(renderProject)}</div></details>}
    {focus && filtered.length === 0 && <div className="overview-empty">当前筛选范围没有需要你处理的工作项。未归属会话的审批仍可在右侧关注队列处理。</div>}
    {!focus && projects.length > 0 && current.length === 0 && <p className="overview-empty">当前没有近期活动的项目，可以展开上方项目查看旧回报和待验收。</p>}
    {projects.length === 0 && (archivedOnly.length ? <p className="overview-empty">当前没有需要推进的工作；已归档记录可在下方历史中查看。</p> : <div className="overview-empty"><h2>先让一个真实任务回报进展</h2><p>会话已发现，但还没有可展示的工作项。用下面的接入指令让 Agent 明确项目和任务，之后在阶段节点更新简报。</p></div>)}
    <HistoryItems snap={snap} items={archivedOnly} onSelect={onSelectItem} />
    <div className="overview-inbox"><div><strong>{loose ? `${loose} 个近期会话尚未归属` : '近期会话已整理'}{missing > 0 ? ` · ${missing} 项暂无内容回报` : ''}</strong><p>无活动的历史记录收在“会话”中。标题和目录是归属线索，内容简报由 Agent 回报或由你补充。</p></div><button className="btn small" onClick={onOpenAttribution}>整理会话归属</button></div>
    <ReportingHelp />
  </div>
}

function TaskBrief({ snap, item: original, onSelect, onSelectSession }: { snap: Snapshot; item: WorkItem; onSelect: () => void; onSelectSession?: (id: number) => void }) {
  const item = primaryItem(snap, original)
  const participants = currentReporters(snap, original)
  const parallel = participants.length > 1
  const history = (snap.sessions ?? []).filter((s) => !participants.some((x) => x.id === s.id) && ['progress', 'summary', 'stage'].some((key) => original.brief?.by_session?.[String(s.id)]?.fields[key as BriefKey]?.text))
  const p = progressView(snap, item)
  const goal = field(item, 'goal')
  const summary = field(item, 'summary')
  const blocker = field(item, 'blocker')
  const blockerText = blocker?.text || (!item.ready ? `等待上游工作项 ${item.waiting.join('、') || '就绪'}，依赖满足后才能继续。` : item.status === 'blocked' ? '工作项已标记阻塞，具体原因待 Agent 回报。' : '')
  const next = field(item, 'next')
  const signal = itemSignal(snap, item)
  const linked = sessionsFor(snap, item.id)
  const active = linked.filter((s) => s.data_source === 'live' && s.freshness === 'live' && s.state !== 'ended')
  const providers = [...new Set((active.length ? active : linked).map((s) => s.provider))]
  const reporter = p.field?.session_id == null ? undefined : (snap.sessions ?? []).find((s) => s.id === p.field!.session_id)
  const headline = summary && (!p.field || summary.at >= p.field.at) ? summary : p.field
  const missing = !headline
  const detailFields: [BriefKey, string, BriefField | undefined][] = [['goal', '目标', goal], ['summary', '结论', summary], ['progress', '进展', p.field], ['blocker', '卡点', blocker], ['next', '下一步', next], ['stage', '阶段', field(item, 'stage')], ['next_owner', '负责人', field(item, 'next_owner')]]
  return <article className={`task-brief st-${item.status}`} aria-label={`${item.id} 工作简报`}>
    <div className="task-brief-top"><span className="card-id">{item.id}</span><span className={`pill st-${item.status}`} title={`工作项状态：${itemStatusLabel[item.status]}`}>{['待你决定', '待你接手'].includes(signal.label) ? signal.label : itemStatusLabel[item.status]}</span></div>
    <h3>{item.title}</h3>
    <div className="task-runners">{providers.length ? providers.map((provider) => <AgentBadge key={provider} provider={provider} />) : <span className="muted">{reporter ? `最近回报：${providerLabel(reporter.provider)}` : '执行者待关联'}</span>}<small className="muted">{active.length ? `${active.length} 个执行会话` : linked.length ? `已关联 ${linked.length} 个会话 · 暂无新活动` : '暂无活跃执行会话'}</small></div>
    <StageBand item={item} parallel={parallel} />
    {parallel ? <><SessionBriefs snap={snap} item={original} sessions={participants} onSelect={onSelectSession} />{(!item.ready || item.status === 'blocked' || blocker?.kind === 'user') && <p className="brief-blocker">工作项卡点：{blockerText}</p>}</> : <>
    <p className={`brief-headline ${missing ? 'muted' : ''}`} title={headline?.text}>{headline ? legacyBrief(headline) ? '这条回报使用旧格式，需执行 Agent 更新；原文保留在详情中。' : shortText(headline.text) : item.brief?.fields.progress?.flagged ? p.text : linked.length ? '已找到会话，尚未收到业务进展。当前阶段无法判断，无需重复登记。' : '还没有工作回报，暂时无法判断进展。'}</p>
    {headline && <div className="brief-provenance"><BriefStamp snap={snap} value={headline} />{p.stale && <span className="stale">可能过期</span>}</div>}
    {blockerText ? <div className="brief-blocker"><span>卡点</span><div title={blockerText}>{shortText(blockerText, 80)}</div></div> : <div className="brief-no-blocker">卡点：{missing ? '信息不足，尚不能判断' : '当前未报告阻塞'}</div>}
    <div className="brief-next"><span>下一步</span><div><strong className="next-owner">{nextOwner(snap, item)}</strong><p title={handoffAnswered(item) ? undefined : next?.text}>{handoffAnswered(item) ? '已收到同一会话的回应；等待执行 Agent 回报新的安排。' : next ? shortText(next.text, 90) : item.status === 'review' ? '核对交付物和验收条件' : linked.length && missing ? '打开原聊天恢复工作；新回报会自动更新到这里。' : '执行 Agent 还没有说明下一步'}</p></div></div>
    </>}
    {needsAction(signal) && !(['待你接手', '待你决定'].includes(signal.label) && signal.reason.trim() === next?.text.trim()) && <div className={`brief-action signal-${signal.tone}`}><strong>{signal.label}</strong><span>{signal.reason}</span></div>}
    {!needsAction(signal) && <div className="brief-human-action">审批：当前没有待处理请求{nextOwner(snap, item) === '你' ? '；下一步需你操作' : ''}</div>}
    <details className="brief-details"><summary>完整回报与来源</summary>{detailFields.map(([key, label, value]) => value ? <div className="brief-detail-field" key={key}><strong>{label}</strong><p>{key === 'stage' ? stages.find((s) => s.key === value.text)?.label || '阶段待同步' : key === 'next_owner' ? ownerLabel(snap, value) : value.text}</p><BriefStamp snap={snap} value={value} /></div> : null)}{missing && <p className="muted">未收到内容时保持未知，不根据消息数或运行时长推算完成度。</p>}</details>
    {history.length > 0 && <details className="brief-details"><summary>历史和已收起会话的回报 {history.length}</summary><SessionBriefs snap={snap} item={original} sessions={history} onSelect={onSelectSession} historical /></details>}
    <button className="btn small task-detail-open" onClick={onSelect} aria-label={`${item.id} ${item.title}`}>会话、审批与验收 →</button>
  </article>
}

function ReportingHelp() {
  const [copied, setCopied] = useState(false)
  const text = '请把本次实际项目工作接入本机 Session Steward。在用户允许工具调用时，用 "$HOME/.steward/bin/steward-hook" begin --title "本次任务标题" --project "实际项目绝对路径" --goal "目标" --progress "目前进展" 登记一次；已有归属则用 report --summary "一句话结论" --stage "unknown" --next-owner "agent" --progress "…" --blocker "…" --next "谁接下来做什么"。stage 按事实选 planning/implementing/validating/unknown，next-owner 选 agent/claude/codex/user/external/unknown，交付用 deliver。阶段与负责人随实质进展、需要帮助或交付时更新，没有卡点用空字符串清除。仅回报本任务简短内容，区分自述、测试和验收，不复制对话或密钥。会话无法自动定位时用 --session 和 --provider 指定；服务不可用时停止回报，不影响原任务。'
  return <details className="reporting-help"><summary>让 Agent 开始回报进展</summary><p>已接入 hooks 的新会话可收到简短的回报说明。已有会话可以复制下面这段；Agent 按说明回报后，内容才会出现在简报里。</p><pre>{text}</pre><button className="btn small" onClick={() => navigator.clipboard.writeText(text).then(() => setCopied(true)).catch(() => setCopied(false))}>{copied ? '已复制' : '复制给当前 Agent'}</button></details>
}
