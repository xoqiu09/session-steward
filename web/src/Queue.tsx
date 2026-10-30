import { isRemote, remoteReadOnlyMessage } from './access'
import type { Approval, MergePayload, Snapshot } from './types'
import { api } from './api'
import { AgentBadge, CopyButton, ErrorLine, useAction } from './bits'
import { field, sourceTag } from './brief'
import { BriefStamp } from './BriefStamp'
import { MergeGate } from './P1'
import { HistoryItems } from './HistoryItems'
import { attentionCount, periodicView, queueLanes, repoLabel, type AdviceGroup, type MergeGroup, type ReviewGroup } from './workbench'
import { ago, approvalRepo, approvalStatusLabel, itemSignal, itemStatusLabel, scopedAttention, sessionName } from './model'
import { shownNo } from './hub/ids'

function sessionOf(s: Snapshot, id: number | null) {
  return id == null ? undefined : (s.sessions ?? []).find((x) => x.id === id)
}
function repoName(s: Snapshot, id: number | null) {
  return repoLabel(s, id)
}

// 每条待处理都说明：目前做到哪、为什么现在要处理、处理后会怎样。
const WHY: Record<Approval['kind'], [string, string]> = {
  permission: ['Agent 正在等这条命令，处于暂停。', '允许只对本次请求生效；以“已确认继续”为准，送达不等于工具已执行成功。'],
  decision: ['Agent 明确提出了问题，等待你的回答。', '复制恢复命令回到该会话回答；回答后此项自动关闭。'],
  merge: ['分支等待合并批准。', '批准绑定当前源和目标提交，分支变化后作废；“已合并”只由 Git 确认。'],
  attention: ['最后一条回复以问句结尾（低置信）。', '不需要回应时忽略即可，不影响工作项状态。'],
}

function Context({ a, snap }: { a: Approval; snap: Snapshot }) {
  const s = sessionOf(snap, a.session_id)
  const item = (snap.work_items ?? []).find((w) => w.id === (a.work_item_id || s?.work_item_id))
  const own = item && s && item.brief?.by_session ? { ...item, brief: item.brief.by_session[String(s.id)] } : item
  const p = own && field(own, 'progress')
  const [why, after] = WHY[a.kind]
  return <div className="q-context">
    {item && <div><b>目前：</b>{p ? <>{p.text} <span className={`src ${sourceTag(p).cls}`}>{sourceTag(p).mark} {sourceTag(p).label}</span> <small className="muted">{ago(p.at, snap.now)}</small></> : <span className="muted">暂无内容回报</span>}</div>}
    <div><b>为什么现在：</b>{why}</div>
    <div className="muted"><b>处理后：</b>{after}</div>
  </div>
}

function WorkName({ a, snap }: { a: Approval; snap: Snapshot }) {
  const s = sessionOf(snap, a.session_id)
  const item = (snap.work_items ?? []).find((w) => w.id === (a.work_item_id || s?.work_item_id))
  return <div className="approval-work"><strong>{item?.title || (s ? sessionName(snap, s).title : '工作内容待登记')}</strong><small className="muted">{item ? item.id : '待关联工作项'}{s ? ` · 会话 #${shownNo(s.id)}` : ''}</small></div>
}

function Section({ title, count, hint, children }: { title: string; count: number; hint?: string; children: React.ReactNode }) {
  if (!count) return null
  return (
    <section className="q-section">
      <h3>
        {title} <span className="count">{count}</span>
      </h3>
      {hint && <p className="hint">{hint}</p>}
      {children}
    </section>
  )
}

function Lifecycle({ a }: { a: Approval }) {
  // 分别显示 已批准 / 已送达 / 已确认继续执行
  const steps: [string, string][] = [
    ['已决定', a.decided_at],
    ['已送达', a.delivered_at],
    ['已确认继续', a.confirmed_at],
  ]
  return (
    <div className="lifecycle">
      {steps.map(([l, t]) => (
        <span key={l} className={t ? 'on' : ''}>{l}</span>
      ))}
    </div>
  )
}

export function PermissionCard({ a, snap }: { a: Approval; snap: Snapshot }) {
  const s = sessionOf(snap, a.session_id)
  const act = useAction()
  const left = a.deadline ? Math.max(0, Math.round((Date.parse(a.deadline) - Date.parse(snap.now)) / 60000)) : null
  const expired = !!a.deadline && Date.parse(a.deadline) <= Date.parse(snap.now)
  return (
    <div className="q-card">
      <div className="q-meta">
        {s && <AgentBadge provider={s.provider} client={s.client} />}
        <span className="muted">{repoName(snap, approvalRepo(snap, a))}</span>
        {s?.work_item_id && <span className="pill">{s.work_item_id}</span>}
        <span className="muted right">{ago(a.created_at, snap.now)}</span>
      </div>
      <WorkName a={a} snap={snap} />
      <Context a={a} snap={snap} />
      <pre className="preview">{a.preview || a.tool_name || '权限请求'}</pre>
      {isRemote() && a.status === 'pending' ? <p className="hint">{remoteReadOnlyMessage}</p> : expired ? <p className="hint">请求已过期，等待状态同步；请回原界面处理。</p> : a.handleable ? (
        a.status === 'pending' ? (
          <div className="row">
            <button className="btn primary" disabled={isRemote() || act.busy} onClick={() => act.run(() => api.decide(a.id, a.fingerprint, 'allow'))}>允许本次</button>
            <button className="btn" disabled={isRemote() || act.busy} onClick={() => act.run(() => api.decide(a.id, a.fingerprint, 'deny'))}>拒绝</button>
            {left != null && <span className="muted">剩 {left} 分钟，超时后回到原界面审批</span>}
          </div>
        ) : (
          <Lifecycle a={a} />
        )
      ) : (
        <div className="row">
          <span className="pill warn">请回原界面处理</span>
          <span className="muted">这个请求没有经过可接管的 hook，只能在 Agent 界面里批准</span>
          <button disabled={isRemote()} className="btn small" onClick={() => act.run(() => api.dismiss(a.id, 'handled_elsewhere'))}>已处理</button>
        </div>
      )}
      {a.status === 'decided' && <p className="hint">面板已作出决定。其他 hook 的拒绝可能优先，以“已确认继续”为准。</p>}
      <ErrorLine msg={act.error} />
    </div>
  )
}

export function DecisionCard({ a, snap }: { a: Approval; snap: Snapshot }) {
  const s = sessionOf(snap, a.session_id)
  const act = useAction()
  const low = a.kind === 'attention'
  return (
    <div className={`q-card ${low ? 'low' : ''}`}>
      <div className="q-meta">
        {s && <AgentBadge provider={s.provider} client={s.client} />}
        <span className="muted">{repoName(snap, approvalRepo(snap, a))}</span>
        {s?.work_item_id && <span className="pill">{s.work_item_id}</span>}
        <span className="muted right">{ago(a.created_at, snap.now)}</span>
      </div>
      <WorkName a={a} snap={snap} />
      <Context a={a} snap={snap} />
      <p className="q-text">{a.preview}</p>
      <div className="row">
        {s?.resume_command && <CopyButton text={s.resume_command} label="复制恢复命令" />}
        {s?.cwd && <CopyButton text={`cd ${JSON.stringify(s.cwd)}`} label="复制目录" />}
        <button disabled={isRemote()} className="btn small" onClick={() => act.run(() => api.dismiss(a.id, low ? 'ignored' : 'resolved'))}>{low ? '忽略' : '已处理'}</button>
      </div>
      <ErrorLine msg={act.error} />
    </div>
  )
}

export function MergeCard({ group, snap, onSelectItem, advice, compact = false }: { group: MergeGroup; snap: Snapshot; onSelectItem: (id: string) => void; advice: AdviceGroup[]; compact?: boolean }) {
  const a = group.primary
  const p = a.payload as unknown as MergePayload
  const item = (snap.work_items ?? []).find((w) => w.id === a.work_item_id)
  const act = useAction()
  return (
    <div className="q-card">
      {!compact && <div className="q-meta">
        <span className="pill">{a.work_item_id}</span>
        <strong className="ellipsis">{item?.title}</strong>
        <span className="muted right">{ago(a.created_at, snap.now)}</span>
      </div>}
      {!compact && <Context a={a} snap={snap} />}
      {compact && <p>请核对本次代码改动，再决定是否合入项目主分支{p.target_ref ? `（${p.target_ref}）` : ''}。</p>}
      {(!compact || group.workItemIds.length > 1) && <div className="merge-members"><strong>本次合并涉及 {group.workItemIds.length} 个工作项</strong>{group.workItemIds.map(id => {
        const w = snap.work_items?.find(w => w.id === id)
        return <button className="btn small" key={id} onClick={() => onSelectItem(id)}>{id} · {w?.title || '工作项'} · {w ? itemStatusLabel[w.status] : '状态待核实'}</button>
      })}<p className="hint">批准只针对下方同一源/目标提交；工作项分别验收。退回会将尚未验收的工作项退回执行中，已验收状态保留。</p></div>}
      {advice.length > 0 && <details><summary>相关进展与需你处理的回报 · {advice.reduce((n,g) => n+g.features.length+g.reported.length,0)} 条</summary>{advice.map(g => <AdvisoryCard key={g.id} group={g} snap={snap} onSelectItem={onSelectItem} />)}</details>}
      <details open={!compact} className="merge-candidate-details"><summary>{compact ? `查看合并信息${typeof p.ahead === 'number' ? ` · ${p.ahead} 个提交` : ''}` : '分支与提交信息'}</summary><div className="mono small">
        {p.source_ref} → {p.target_ref}
        <br />
        {p.ahead} 个提交 · {p.diffstat || '无改动统计'}
        <br />
        源 {p.source_head_sha?.slice(0, 10)} · 目标 {p.target_base_sha?.slice(0, 10)}
      </div></details>
      {group.stale && <p className="warn-line">这组候选已失效，需要先核对最新 {p.target_ref} 并重建候选再审批。</p>}
      {!group.valid && <p className="warn-line">候选信息不完整，等待执行方更新。</p>}
      {!isRemote() && <div className="row">
        {a.status === 'pending' ? (
          <>
            <button className="btn primary" disabled={isRemote() || act.busy || group.stale || !group.valid} onClick={() => act.run(() => api.approveMerge(a.id, p.source_head_sha, p.target_base_sha))}>批准合并</button>
            <button className="btn" disabled={isRemote() || act.busy} onClick={() => act.run(() => api.rejectMerge(a.id, 'rejected'))}>退回</button>
          </>
        ) : (
          <>
            <span className="pill ok">已批准</span>
            {!group.stale && group.valid && <CopyButton text={() => api.mergeInstruction(a.id).then((r) => r.text)} label={p.copied_at ? '再次复制合并指令' : '复制合并指令'} />}
            <span className="muted">{p.copied_at ? '已复制指令，等待 Git 确认合并' : '粘贴到任一会话执行'}</span>
            <button className="btn small" disabled={isRemote() || act.busy} onClick={() => act.run(() => api.rejectMerge(a.id, 'withdrawn'))}>撤回</button>
          </>
        )}
      </div>}
      {isRemote() && <p className="hint">{a.status === 'decided' ? '已批准。' : '待审批。'}{remoteReadOnlyMessage}</p>}
      {a.status === 'decided' && <MergeGate snap={snap} a={a} />}
      {compact && <p className="hint">这里只处理代码合并，工作验收单独记录。</p>}
      <ErrorLine msg={act.error} />
    </div>
  )
}

function AdvisoryCard({ group, snap, onSelectItem }: { group: AdviceGroup; snap: Snapshot; onSelectItem: (id: string) => void }) {
  const w = snap.work_items?.find(w => w.id === group.id)
  const count = group.reported.length + group.features.length
  return <div className="q-card advisory-group">
    <div className="q-meta"><span className="pill">{group.id}</span>{w && <span className="pill">{itemStatusLabel[w.status]}</span>}<span className="muted">{count} 条回报 · 计为 1 组</span></div>
    <strong>{w?.title || '工作回报'}</strong>
    <details open={count === 1}><summary>查看需要你处理的事项 · {count} 条</summary>
      {group.reported.map(h => <div className="advisory-entry" key={`report-${h.owner.entry_id}`}>
        <p><b>{h.session && <AgentBadge provider={h.session.provider} />} 会话 #{h.owner.session_id != null && shownNo(h.owner.session_id)}</b></p>
        {h.summary && <p>{h.summary.text}</p>}{h.blocker && <p className="warn-line">卡点：{h.blocker.text}</p>}<p>需要你：{h.next?.text || '回应这个卡点'}</p>
        <BriefStamp snap={snap} value={h.owner} />{h.session?.resume_command && <CopyButton text={h.session.resume_command} label="复制恢复命令" />}
      </div>)}
      {group.features.map(({feature:f,contribution:p}) => <div className="advisory-entry" key={`${f.repo_id}/${f.id}/${p.run_id}`}>
        <strong>{f.title}</strong><p><AgentBadge provider={p.provider} /> 会话 #{shownNo(p.session_id)}</p>{p.blocker && <p className="warn-line">卡点：{p.blocker}</p>}
        <p>需要你：{p.next || '回应此功能卡点'}</p><small className="muted">Agent 自述 · {ago(p.next_at || p.at,snap.now)}</small>
        {sessionOf(snap,p.session_id)?.resume_command && <CopyButton text={sessionOf(snap,p.session_id)!.resume_command} label="复制恢复命令" />}
      </div>)}
    </details>
    <button className="btn small" onClick={() => onSelectItem(group.id)}>查看工作项与验收</button>
  </div>
}

function ReviewCard({ group, snap, onSelectItem }: { group: ReviewGroup; snap: Snapshot; onSelectItem: (id: string) => void }) {
  const w = group.item ?? snap.work_items?.find(w => w.id === group.id)
  return <div className="review-card">
    <div className="q-meta"><span className="pill">{group.id}</span><span className="muted">{w?.completion_policy === 'auto_history' ? '自动任务需要回应' : w?.status === 'review' ? '待验收' : 'Agent 请你审阅'}</span></div>
    <strong>{w?.title || '工作回报'}</strong>
    {group.advice && <details><summary>查看回报与来源 · {group.advice.reported.length + group.advice.features.length} 条</summary><AdvisoryCard group={group.advice} snap={snap} onSelectItem={onSelectItem} /></details>}
    <button className="btn small" onClick={() => onSelectItem(group.id)}>{w?.completion_policy === 'auto_history' ? '查看问题与来源' : '查看交付与验收'}</button>
  </div>
}

export function Queue({ snap, onSelectItem, repoId = 'all', provider = 'all', reviewOpen = false, onReviewOpenChange }: { snap: Snapshot; onSelectItem: (id: string) => void; repoId?: number | 'all'; provider?: string; reviewOpen?: boolean; onReviewOpenChange?: (open: boolean) => void }) {
  const q = scopedAttention(snap, repoId, provider)
  const lanes = queueLanes(q, snap.now)
  const recent = (snap.approvals ?? []).filter(a => a.status !== 'pending' && a.status !== 'decided').slice(0, 8)
  const byRepo = new Map<string, MergeGroup[]>()
  for (const g of lanes.merge) {
    const name = repoName(snap, g.primary.repo_id)
    byRepo.set(name, [...(byRepo.get(name) ?? []), g])
  }
  return <div className="queue">
    <div className="queue-counts" aria-label="分别统计审批与验收">
      <div className={lanes.counts.action ? 'has-actions' : ''}><strong>{lanes.counts.action}</strong><span>需审批／决定</span></div>
      <div><strong>{lanes.counts.review}</strong><span>待审阅／验收</span></div>
    </div>
    <p className="hint">“需审批／决定”是当前正式请求；“待审阅／验收”是交付或建议，不是故障数。每项工作只计一次，成功的例行整理收进历史。批准合并和验收交付分别记录。</p>
    <section className="action-queue" aria-label="需审批或决定的事项">
      {lanes.counts.action === 0 && <p className="empty-actions">当前没有需要你审批或决定的正式请求。</p>}
      <Section title="工具权限" count={lanes.permission.length} hint="本次请求有效；超时后回原生审批。">
        {lanes.permission.map(a => <PermissionCard key={a.id} a={a} snap={snap} />)}
      </Section>
      <Section title="需要决定" count={lanes.decision.length} hint="Agent 明确提出的问题，需要回原会话回应。">
        {lanes.decision.map(a => <DecisionCard key={a.id} a={a} snap={snap} />)}
      </Section>
      <Section title="合并审批" count={lanes.merge.length} hint="批准绑定当前源和目标提交；批准后仍需执行合并。">
        {[...byRepo.entries()].map(([name, groups]) => <div className="repo-block" key={name}><h4>{name}</h4>{groups.map(g => <MergeCard key={g.key} group={g} snap={snap} onSelectItem={onSelectItem} advice={[]} />)}</div>)}
      </Section>
    </section>
    <details className="review-queue" open={reviewOpen || undefined} onToggle={e => { if (e.currentTarget.open !== reviewOpen) onReviewOpenChange?.(e.currentTarget.open) }} aria-label="普通待审阅与验收">
      <summary>待审阅／验收 <span className="count">{lanes.counts.review} 项工作</span></summary>
      <p className="hint">交付与功能回报集中在这里。下一步写了“你”，不会自动变成工具审批；每个工作项只计一次。</p>
      {lanes.review.length ? lanes.review.map(g => <ReviewCard key={g.id} group={g} snap={snap} onSelectItem={onSelectItem} />) : <p className="hint">当前没有待审阅交付。</p>}
    </details>
    {lanes.counts.tracking > 0 && <details className="followup-queue"><summary>执行进展与待跟进 <span className="count">{lanes.counts.tracking}</span></summary>
      <p className="hint">已经决定的请求、待执行合并和执行方卡点，不计入上方审批数字。</p>
      {lanes.followingPermission.map(a => <PermissionCard key={a.id} a={a} snap={snap} />)}
      {lanes.followingDecision.map(a => <DecisionCard key={a.id} a={a} snap={snap} />)}
      {lanes.followingMerge.map(g => <MergeCard key={g.key} group={g} snap={snap} onSelectItem={onSelectItem} advice={[]} />)}
      {lanes.blocked.map(w => <button key={w.id} className="q-line" onClick={() => onSelectItem(w.id)}><span className="pill">{w.id}</span><span>{w.title}<small className="block-reason">{itemSignal(snap, w).reason}</small></span></button>)}
    </details>}
    <HistoryItems snap={snap} items={periodicView(snap).history.filter(w => (repoId === 'all' || w.repo_id === repoId) && (provider === 'all' || w.agents.includes(provider)))} onSelect={onSelectItem} />
    {q.attention.length > 0 && <details className="low-confidence"><summary>可能需要关注 {q.attention.length} <span className="muted">（低置信，不计入审批）</span></summary>{q.attention.map(a => <DecisionCard key={a.id} a={a} snap={snap} />)}</details>}
    {recent.length > 0 && <details className="recent"><summary>最近处理 {recent.length}</summary>{recent.map(a => <div key={a.id} className="recent-line"><span className="pill muted">{approvalStatusLabel[a.status]}</span><span className="ellipsis">{a.preview || a.work_item_id}</span><span className="muted">{a.close_reason}</span></div>)}</details>}
  </div>
}

export function queueCount(snap: Snapshot, repoId: number | 'all' = 'all', provider = 'all') {
  const q = scopedAttention(snap, repoId, provider)
  return attentionCount(q)
}
