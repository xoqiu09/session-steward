import { isRemote } from './access'
import { useEffect, useState } from 'react'
import { ManagedPanel, Unmanaged } from './Managed'
import { HandoffForm, ItemUsageLine, SessionUsageLine } from './P1'
import { AISummaryBox } from './P2'
import { managedFor, managedOfSession } from './live'
import { DecisionCard, MergeCard, PermissionCard } from './Queue'
import { openApprovals } from './model'
import type { ItemStatus, MergeEvidence, Session, SessionUsageDetail, Snapshot } from './types'
import { api } from './api'
import { AgentBadge, CopyButton, ErrorLine, useAction } from './bits'
import { shownNo } from './hub/ids'
import { canUndoAttribution } from './attribution'
import { BriefSection, RelayTimeline } from './BriefSection'
import { FeatureProgress } from './FeatureProgress'
import { HistoryItems } from './HistoryItems'
import { mergeGroups, repoLabel } from './workbench'
import { RunDesk } from './ui/RunDesk'
import { DeliveryReview } from './ui/DeliveryReview'
import { SessionActivity } from './ui/SessionActivity'
import { SessionUsagePanel } from './ui/SessionUsagePanel'
import { BriefReadOnly } from './ui/BriefReadOnly'
import { WorkStatusActions } from './ui/WorkStatusActions'
import { requestsForItem } from './ui/WorkOverview'
import { ConversationReturn } from './ui/ConversationReturn'
import {
  ago, freshnessLabel, itemSignal, itemStatusLabel, mergeStateLabel, nextItemId, providerLabel, repoPrefix, sessionBuckets, sessionName, sessionRepo, sessionSignal, sessionStateLabel, sessionsFor, type SessionScope,
} from './model'

export const outcomeLabel: Record<string, string> = { delivered: '交付', failed: '失败', abandoned: '放弃', handed_off: '转交', historical: '历史关联', attribution_reverted: '已撤销归属', '': '结果待定' }
export const bindingLabel: Record<string, string> = { manual: '人工绑定', tag: '显式标识', inherited: '继承', branch_guess: '分支推断', auto: '自动关联' }

export function ItemDetail({ snap, id, onClose, onSelectSession, onSelectItem = () => {}, preferredSession }: { snap: Snapshot; id: string; onClose: () => void; onSelectSession: (id: number) => void; onSelectItem?: (id: string) => void; preferredSession?: number }) {
  const item = (snap.work_items ?? []).find((w) => w.id === id)
  const act = useAction()
  const [dep, setDep] = useState('')
  const [cond, setCond] = useState<'accepted' | 'merged'>('accepted')
  const [editing, setEditing] = useState(false)
  const [editTitle, setEditTitle] = useState('')
  const [editRepo, setEditRepo] = useState<number | ''>('')
  const remote = isRemote()
  if (!item) return null
  const sessions = sessionsFor(snap, id)
  const ups = (snap.deps ?? []).filter((d) => d.downstream === id)
  const downs = (snap.deps ?? []).filter((d) => d.upstream === id)
  const set = (status: ItemStatus) => act.run(() => api.patchItem(id, { status }))
  const repo = (snap.repos ?? []).find((r) => r.id === item.repo_id)

  return (
    <RunDesk snap={snap} item={item} remote={remote} onClose={onClose} onSelectSession={onSelectSession} conversation={<ConversationReturn key={item.id} snap={snap} item={item} preferred={preferredSession} />} actions={<WorkStatusActions key={item.id} item={item} />} attention={(() => {
        const requests = requestsForItem(snap, item)
        const perms = requests.filter(a => a.kind === 'permission')
        const decisions = requests.filter(a => a.kind === 'decision')
        // Retain every member of the same bound merge, including peer items.
        const merges = mergeGroups(openApprovals(snap).filter(a => a.kind === 'merge')).filter(g => g.members.some(a => requests.some(r => r.id === a.id)))
        return <>
          {merges.length > 0 && <section className="item-requests" aria-label="处理代码合并"><h3>处理代码合并</h3>{merges.map(g => <MergeCard key={g.key} group={g} snap={snap} onSelectItem={onSelectItem} advice={[]} compact />)}</section>}
          {perms.length > 0 && <div className="item-permissions"><h3>等待你处理的权限</h3>{perms.map((a) => <PermissionCard key={a.id} a={a} snap={snap} />)}</div>}
          {decisions.length > 0 && <section className="item-requests" aria-label="等待你回答"><h3>等待你回答</h3>{decisions.map(a => <DecisionCard key={a.id} a={a} snap={snap} />)}</section>}
          {item.automatic_history && <section className="delivery-review" aria-label="自动任务归档"><h3>本轮已自动归档</h3><p>Agent 已回报完成，按例行整理规则收进历史，无需你逐轮验收。可以在这里查看本轮来源；发现问题时可重新开始。</p></section>}
          {item.status === 'review' && item.completion_policy !== 'auto_history' && <DeliveryReview snap={snap} item={item} onSelectSession={onSelectSession} actions={<>
            {remote ? <p className="hint">远程只读，请在本机面板验收。</p> : <div className="row wrap">
              <button className="btn primary" disabled={act.busy} onClick={() => set('done')}>已处理</button>
              <button className="btn" disabled={act.busy} onClick={() => set('in_progress')}>退回修改</button>
            </div>}
            <ErrorLine msg={act.error} />
          </>} />}
        </>
      })()}>
      {item.merge_evidence && <MergeProof evidence={item.merge_evidence} />}
      <AISummaryBox snap={snap} itemId={id} repoId={item.repo_id} />
      {remote ? managedFor(snap, id).length > 0 && <p className="hint">有托管会话正在运行；终端画面和输入只在本机面板提供。</p>
        : managedFor(snap, id).map((m) => <ManagedPanel key={m.id} snap={snap} m={m} session={sessions.find((x) => x.id === m.session_id)} />)}
      <ItemUsageLine snap={snap} id={id} />
      {!remote && <HandoffForm snap={snap} item={item} onLaunched={() => {}} />}
      <FeatureProgress snap={snap} repoId={item.repo_id} itemId={item.id} onSelectSession={onSelectSession} />
      <details className="project-work-details"><summary>完整工作简报与来源</summary>{remote ? <BriefReadOnly snap={snap} item={item} /> : <BriefSection snap={snap} item={item} />}</details>
      <div className="assigned-runners">{sessions.map((s) => <button key={s.id} className="btn small" onClick={() => onSelectSession(s.id)}><AgentBadge provider={s.provider} client={s.client} /> #{shownNo(s.id)} · {sessionSignal(snap, s).label}</button>)}</div>
      {!remote && <button className="btn small" onClick={() => { setEditing(!editing); setEditTitle(item.title); setEditRepo(item.repo_id ?? '') }}>修改标题 / 项目</button>}
      {!remote && editing && <form className="new-item compact" onSubmit={(e) => { e.preventDefault(); act.run(() => api.patchItem(id, { title: editTitle, repo_id: editRepo || 0 }).then(() => setEditing(false))) }}>
        <label>工作标题<input value={editTitle} onChange={(e) => setEditTitle(e.target.value)} required /></label>
        <label>所属项目<select value={editRepo} onChange={(e) => setEditRepo(e.target.value ? Number(e.target.value) : '')}><option value="">未关联</option>{(snap.repos ?? []).map((r) => <option key={r.id} value={r.id}>{repoLabel(snap, r.id)}</option>)}</select></label>
        <button className="btn small primary" disabled={act.busy}>保存工作信息</button>
      </form>}
      <dl className="kv">
        <dt>项目</dt><dd>{repo?.name ?? '未关联'}</dd>
        <dt>分支</dt><dd className="mono">{item.branch || '—'}</dd>
        <dt>合并</dt><dd>{item.needs_merge ? mergeStateLabel[item.merge_state] : '无需合并'}</dd>
        <dt>验收条件</dt><dd className="pre">{item.acceptance || '—'}</dd>
      </dl>
      {!remote && <div className="row wrap">
        {item.status !== 'in_progress' && <button disabled={remote} className="btn small" onClick={() => set('in_progress')}>标为执行中</button>}
        {item.status !== 'blocked' && <button disabled={remote} className="btn small" onClick={() => set('blocked')}>标为阻塞</button>}
        {item.status !== 'review' && item.completion_policy !== 'auto_history' && <button disabled={remote} className="btn small" onClick={() => set('review')}>提交验收</button>}
        {item.status !== 'abandoned' && <button disabled={remote} className="btn small" onClick={() => set('abandoned')}>放弃</button>}
      </div>}
      <p className="hint">会话结束或回复完成都不会自动改变这里的状态，需要人工或 Agent 主动提交交付。</p>

      <h3>依赖</h3>
      {ups.length === 0 && downs.length === 0 && <p className="muted">没有依赖</p>}
      {ups.map((d) => (
        <div key={d.upstream} className="dep-line">
          <span className={d.satisfied ? 'ok' : 'wait'}>{d.satisfied ? '✓' : '…'}</span> 依赖 <span className="pill">{d.upstream}</span>
          <span className="muted">{d.cond === 'merged' ? '需合并' : '需验收'}</span>
          {!remote && <button className="btn tiny" onClick={() => act.run(() => api.removeDep(d.upstream, id))}>移除</button>}
        </div>
      ))}
      {downs.map((d) => (
        <div key={d.downstream} className="dep-line">→ 被 <span className="pill">{d.downstream}</span> 依赖</div>
      ))}
      {!remote && <form className="row" onSubmit={(e) => { e.preventDefault(); if (dep) act.run(() => api.addDep(dep.toUpperCase(), id, cond).then(() => setDep(''))) }}>
        <input value={dep} onChange={(e) => setDep(e.target.value)} placeholder="上游编号，如 QM-012" aria-label="上游编号" list="item-ids" />
        <select value={cond} onChange={(e) => setCond(e.target.value as 'accepted' | 'merged')} aria-label="依赖条件">
          <option value="accepted">上游已处理</option>
          <option value="merged">上游已合并</option>
        </select>
        <button className="btn small" type="submit">添加</button>
      </form>}
      <datalist id="item-ids">{(snap.work_items ?? []).filter((w) => w.id !== id).map((w) => <option key={w.id} value={w.id}>{w.title}</option>)}</datalist>

      {!remote && <RelayTimeline snap={snap} item={item} onSelectSession={onSelectSession} onOutcome={(rid, o) => act.run(() => api.runOutcome(rid, o))} />}
      {sessions.length > 0 && <p className="muted">当前 {sessions.filter((s) => s.state !== 'ended').length} 个活跃会话</p>}
      <ErrorLine msg={act.error} />
    </RunDesk>
  )
}

export function MergeProof({ evidence }: { evidence: MergeEvidence }) {
  const label = { local_git: '本地目标分支已包含这份代码', remote_git: '远端目标分支已包含这份代码', remote_cached: '已有的远端分支记录包含这份代码', github_pr: 'GitHub 已合并记录与提交一致' }[evidence.method]
  const link = evidence.url && /^https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/\d+$/.test(evidence.url) ? evidence.url : undefined
  return <section className="delivery-review" aria-label="合并核对记录"><h3>已合并 · {label}</h3>
    <p>源 {evidence.source_sha.slice(0, 10)} → {evidence.target_ref} · {evidence.target_sha.slice(0, 10)}</p>
    <p className="hint">核对于 {new Date(evidence.checked_at).toLocaleString('zh-CN')}。{link && <a href={link} target="_blank" rel="noreferrer">查看 PR 记录</a>}工作项验收单独保留。</p>
  </section>
}

export function SessionDetail({ snap, id, onClose, onSelectItem, foldEvents = false }: { snap: Snapshot; id: number; onClose: () => void; onSelectItem: (id: string) => void; foldEvents?: boolean }) {
  const s = (snap.sessions ?? []).find((x) => x.id === id)
  const act = useAction()
  const [bind, setBind] = useState('')
  const [events, setEvents] = useState<Record<string, unknown>[]>([])
  const [usage, setUsage] = useState<SessionUsageDetail | null>(null)
  const [creating, setCreating] = useState(false)
  const quiet = sessionBuckets(snap).quiet.some((x) => x.id === id)
  useEffect(() => {
    api.sessionEvents(id).then(setEvents).catch(() => setEvents([]))
    api.sessionUsage(id).then(setUsage).catch(() => setUsage(null))
  }, [id, s?.last_activity_at])
  if (!s) return null
  const name = sessionName(snap, s)
  const signal = sessionSignal(snap, s)
  const attribution = (snap.attributions ?? []).find((a) => a.session_id === s.id && a.status === 'applied' && a.work_item_id === s.work_item_id)
  return (
    <div className="detail">
      <div className="detail-head">
        <AgentBadge provider={s.provider} client={s.client} />
        <span className={`pill ss-${s.state}`}>{sessionStateLabel[s.state]}</span>
        <span className={`pill fr-${s.freshness}`}>{freshnessLabel[s.freshness]}</span>
        <button className="btn small right" onClick={onClose} aria-label="关闭">✕</button>
      </div>
      <h2>{name.title}</h2>
      <ConversationReturn key={s.id} snap={snap} session={s} />
      <p className="hint">会话 #{shownNo(s.id)} · {name.source}{s.title && s.work_item_id ? ` · 原会话标题：${s.title}` : ''}</p>
      <p className={`work-signal signal-${signal.tone}`}><strong>{signal.label}</strong><br />{signal.reason}</p>
      {(() => {
        const perms = openApprovals(snap).filter((a) => a.kind === 'permission' && a.session_id === s.id)
        return perms.map((a) => <PermissionCard key={a.id} a={a} snap={snap} />)
      })()}
      {(() => { const m = managedOfSession(snap, s); return m ? (isRemote() ? <p className="hint">托管会话；终端画面只在本机面板提供。</p> : <ManagedPanel snap={snap} m={m} session={s} />) : <Unmanaged /> })()}
      <SessionUsageLine snap={snap} id={s.id} />
      {!s.work_item_id && <p className="hint">标题来自现有元数据，尚未登记为工作项。目录仅代表启动位置；创建工作项时可以选择实际所属项目。</p>}
      <dl className="kv">
        <dt>会话 ID</dt><dd className="mono">{s.provider_session_id}</dd>
        <dt>目录</dt><dd className="mono">{s.cwd}</dd>
        <dt>分支</dt><dd className="mono">{s.branch || '—'}</dd>
        <dt>版本</dt><dd>{s.version || '—'}</dd>
        <dt>最近活动</dt><dd>{ago(s.last_activity_at, snap.now)}</dd>
        <dt>最近进展</dt><dd>{s.last_progress_at ? ago(s.last_progress_at, snap.now) : '—'}</dd>
        <dt>工作项</dt>
        <dd>{s.work_item_id ? <button className="pill link" onClick={() => onSelectItem(s.work_item_id)}>{s.work_item_id}</button> : '未归属'} {s.binding && <span className="muted">（{bindingLabel[s.binding]}）</span>}</dd>
      </dl>
      {s.freshness === 'stale' && <p className="warn-line">长时间没有收到事件。可能在跑长命令、等待模型，或电脑休眠过；不代表卡死。</p>}
      {s.freshness === 'history' && <p className="hint">这是从本地会话文件发现的历史记录，没有实时状态。</p>}
      {quiet && <p className="hint">已从主画布收起。收到新事件后会重新显示；工作项状态和会话记录保留。</p>}
      {s.worktree_conflict && <p className="warn-line">同一目录有多个会话正在运行或等待权限；若同时修改文件，请留意相互覆盖。</p>}
      <div className="row wrap">
        {s.resume_command && <CopyButton text={s.resume_command} label="复制恢复命令" />}
        <CopyButton text={`cd ${JSON.stringify(s.cwd)}`} label="复制目录" />
      </div>
      <h3>归属</h3>
      {attribution && <div className="attribution-evidence"><p className="hint">{attribution.automatic ? '自动整理依据' : '已确认的归属依据'}：{attribution.plan.reasons.join('；')}</p>{canUndoAttribution(attribution, snap) && <button className="btn small" disabled={isRemote() || act.busy} onClick={() => act.run(() => api.decideAttributions([{ id: attribution.id, fingerprint: attribution.fingerprint, action: 'undo' }]))}>撤销本次关联</button>}</div>}
      {s.suggested_work_item && !s.work_item_id && (
        <div className="row">
          <span>分支名提示可能属于 <span className="pill">{s.suggested_work_item}</span></span>
          <button disabled={isRemote()} className="btn small primary" onClick={() => act.run(() => api.bind(s.id, s.suggested_work_item))}>确认</button>
        </div>
      )}
      {!isRemote() && <form className="row wrap" onSubmit={(e) => { e.preventDefault(); if (bind) act.run(() => api.bind(s.id, bind).then(() => setBind(''))) }}>
        <select value={bind} onChange={(e) => setBind(e.target.value)} aria-label="关联工作项">
          <option value="">选择已有工作项…</option>
          {(snap.work_items ?? []).filter((w) => !['done', 'abandoned'].includes(w.status)).map((w) => <option key={w.id} value={w.id}>{w.id} · {w.title}</option>)}
        </select>
        <button className="btn small" type="submit" disabled={!bind || act.busy}>{s.work_item_id ? '更换关联' : '关联工作项'}</button>
        {s.work_item_id && (
          <select aria-label="结束当前绑定" defaultValue="" onChange={(e) => e.target.value && act.run(() => api.unbind(s.id, e.target.value))}>
            <option value="">结束当前绑定…</option>
            <option value="delivered">交付</option>
            <option value="failed">失败</option>
            <option value="abandoned">放弃</option>
            <option value="handed_off">转交</option>
          </select>
        )}
      </form>}
      {!s.work_item_id && <button disabled={isRemote()} className="btn primary" onClick={() => setCreating(!creating)}>{creating ? '收起创建表单' : '从此会话创建工作项'}</button>}
      {!isRemote() && creating && !s.work_item_id && <NewItem key={s.id} snap={snap} session={s} onCreated={onSelectItem} />}
      <ErrorLine msg={act.error} />
      {/* 桌面模式里默认折叠，需要时再展开。 */}
      <SessionUsagePanel usage={usage} />
      <SessionActivity events={events} now={snap.now} folded={foldEvents} turnUsage={usage?.found ? usage.self.turns : undefined} />
    </div>
  )
}

export function WorkItemsPanel({ snap, items, history = [], repoId, onSelect }: { snap: Snapshot; items: NonNullable<Snapshot['work_items']>; history?: NonNullable<Snapshot['work_items']>; repoId: number | 'all'; onSelect: (id: string) => void }) {
  const [creating, setCreating] = useState(false)
  return <div>
    <div className="row"><strong>工作项 {items.length}</strong><button disabled={isRemote()} className="btn small right" onClick={() => setCreating(!creating)}>{creating ? '收起表单' : '新建工作项'}</button></div>
    {!isRemote() && creating && <NewItem key={repoId} snap={snap} initialRepoId={repoId === 'all' ? undefined : repoId} onCreated={onSelect} />}
    <div className="session-entries">{items.map((w) => {
      const signal = itemSignal(snap, w)
      return <button key={w.id} className="session-entry" onClick={() => onSelect(w.id)}><div className="row"><span className="mono">{w.id}</span><span className={`pill right st-${w.status}`}>{itemStatusLabel[w.status]}</span></div><strong className="entry-title">{w.title}</strong><p className={`entry-reason signal-${signal.tone}`}>{signal.label} · {signal.reason}</p></button>
    })}</div>
    {items.length === 0 && <p className="hint">还没有登记工作项。可从会话创建并关联，也可以直接新建。</p>}
    <HistoryItems snap={snap} items={history} onSelect={onSelect} />
  </div>
}

export function NewItem({ snap, onCreated, session, initialRepoId }: { snap: Snapshot; onCreated: (id: string) => void; session?: Session; initialRepoId?: number }) {
  const repos = snap.repos ?? []
  const [repoId, setRepoId] = useState<number | ''>(session?.repo_id ?? initialRepoId ?? '')
  const [repoPath, setRepoPath] = useState('')
  const repo = repos.find((r) => r.id === repoId)
  const [id, setId] = useState('')
  const [title, setTitle] = useState(session?.title ?? '')
  const [branch, setBranch] = useState(session?.branch ?? '')
  const [acceptance, setAcceptance] = useState('')
  const [needsMerge, setNeedsMerge] = useState(repo?.is_git ?? false)
  const act = useAction()
  const suggested = nextItemId(snap, repoPrefix(repo?.name ?? 'WI'))
  if (isRemote()) return null
  return (
    <form className="new-item" onSubmit={(e) => {
      e.preventDefault()
      const finalId = (id || suggested).toUpperCase()
      act.run(() => api.createItem({ id: finalId, title, repo_id: repoId === '' ? undefined : repoId, repo_path: repoId === '' ? repoPath || undefined : undefined, branch, acceptance, needs_merge: needsMerge, session_id: session?.id })
        .then(() => { setTitle(''); setId(''); setBranch(''); setAcceptance(''); onCreated(finalId) }))
    }}>
      <label>项目
        <select value={repoId} onChange={(e) => setRepoId(e.target.value === '' ? '' : Number(e.target.value))}>
          <option value="">未关联 / 登记其他项目目录</option>
          {repos.map((r) => <option key={r.id} value={r.id}>{repoLabel(snap, r.id)}</option>)}
        </select>
      </label>
      {repoId === '' && <label>项目目录（可选）<input value={repoPath} onChange={(e) => setRepoPath(e.target.value)} placeholder="填写已有项目的完整目录" /></label>}
      <label>编号<input value={id} onChange={(e) => setId(e.target.value)} placeholder={suggested} /></label>
      <label>标题<input value={title} onChange={(e) => setTitle(e.target.value)} required placeholder="行情页断网后显示明确状态并能恢复" /></label>
      <label>分支<input value={branch} onChange={(e) => setBranch(e.target.value)} placeholder={`feat/${(id || suggested).toLowerCase()}-…`} className="mono" /></label>
      <label>验收条件<textarea value={acceptance} onChange={(e) => setAcceptance(e.target.value)} rows={3} placeholder="断网 5 秒内显示离线；恢复后自动重连并补齐数据" /></label>
      <label className="check"><input type="checkbox" checked={needsMerge} onChange={(e) => setNeedsMerge(e.target.checked)} /> 需要合并代码（调研、运维类任务可取消）</label>
      <button className="btn primary" type="submit" disabled={act.busy}>{session ? '创建并关联此会话' : '新建工作项'}</button>
      <ErrorLine msg={act.error} />
      <p className="hint">在会话里输入 #{(id || suggested)}，或让 Agent 运行 <code>steward-hook claim {id || suggested}</code>，会话就会归属到这个工作项。</p>
    </form>
  )
}

export function SessionList({ snap, onSelect, provider, repoId, scope, onScopeChange }: {
  snap: Snapshot; onSelect: (id: number) => void; provider: string; repoId: number | 'all';
  scope: SessionScope; onScopeChange: (scope: SessionScope) => void
}) {
  const buckets = sessionBuckets(snap, provider, repoId)
  const list = buckets[scope]
  const repoName = (id: number | null) => (snap.repos ?? []).find((r) => r.id === id)?.name ?? '—'
  const counts = list.reduce<Record<string, number>>((m, s) => {
    m[s.provider] = (m[s.provider] ?? 0) + 1
    return m
  }, {})
  return (
    <div className="sess-list">
      <div className="row wrap">
        {Object.entries(counts).map(([p, n]) => <span key={p} className="muted">{providerLabel(p)} {n}</span>)}
        <select className="right" value={scope} onChange={(e) => onScopeChange(e.target.value as SessionScope)} aria-label="会话范围">
          <option value="recent">近期活动（{buckets.recent.length}）</option>
          <option value="quiet">已收起（{buckets.quiet.length}）</option>
          <option value="all">全部及历史（{buckets.all.length}）</option>
        </select>
      </div>
      {scope === 'quiet' && <p className="hint">无新事件的运行中会话，以及空闲超过 30 分钟的会话在这里查看。收到新事件后重新显示；有待处理审批的继续保留在主画布。</p>}
      {list.length === 0 && <p className="muted">这个范围内没有会话。</p>}
      <div className="session-entries">
        {list.map((s: Session) => {
          const name = sessionName(snap, s)
          const signal = sessionSignal(snap, s)
          return <button key={s.id} className="session-entry" onClick={() => onSelect(s.id)}>
            <div className="row"><span className="small muted">#{shownNo(s.id)} · {name.id || name.source}</span><span className={`pill right signal-${signal.tone}`}>{signal.label}</span></div>
            <strong className="entry-title">{name.title}</strong>
            <div className="row"><AgentBadge provider={s.provider} client={s.client} /><span className="ellipsis muted" title={s.cwd}>{repoName(sessionRepo(snap, s))}</span><span className="small muted right">{ago(s.last_activity_at, snap.now)}</span></div>
            <p className="entry-reason" title={signal.reason}>{signal.reason}</p>
          </button>
        })}
      </div>
    </div>
  )
}
