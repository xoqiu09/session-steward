import { isRemote } from './access'
import type { FeatureContribution, ProjectFeature, Snapshot } from './types'
import { api } from './api'
import { AgentBadge, ErrorLine, useAction } from './bits'
import { ago, providerLabel } from './model'
import { shortText } from './stage'
import { shownNo } from './hub/ids'

const implementation: Record<string, string> = { unknown: '实现待回报', not_started: '未开始', implementing: '实现中', implemented: '已实现 · Agent 回报', conflict: '实现回报待对齐' }
const validation: Record<string, string> = { unknown: '验证待回报', not_verified: '尚未验证', validating: '验证中', passed: 'Agent 回报验证通过', failed: 'Agent 回报验证失败', conflict: '多候选，验证待对齐' }

export function featureOwner(snap: Snapshot, p: FeatureContribution) {
  if (p.next_owner === 'agent') return `${providerLabel(p.provider)} #${shownNo(p.session_id)}`
  if (p.next_owner === 'user') return '你'
  if (p.next_owner === 'external') return '外部依赖方'
  if (p.next_owner === 'claude' || p.next_owner === 'codex') return `${providerLabel(p.next_owner)}（具体会话待指定）`
  return '负责人待回报'
}

export function FeatureProgress({ snap, repoId, itemId, onSelectItem, onSelectSession }: {
  snap: Snapshot; repoId: number | null; itemId?: string; onSelectItem?: (id: string) => void; onSelectSession?: (id: number) => void
}) {
  const features = (snap.features ?? []).filter(f => f.repo_id === repoId)
  const scopeKnown = features.length > 0 && features.every(f => ['documented', 'confirmed'].includes(f.scope_status))
  const urgency = (f: ProjectFeature) => f.conflict ? 100 : f.contributions.some(p => featureOwner(snap, p) === '你') ? 90 : f.validation === 'failed' ? 80 : f.implementation === 'implementing' ? 78 : f.validation === 'validating' ? 76 : f.contributions.some(p => p.blocker) ? 70 : f.implementation === 'unknown' ? 60 : ['unknown', 'not_verified', 'validating'].includes(f.validation) ? 50 : f.implementation === 'not_started' ? 40 : 0
  const ranked = [...features].sort((a, b) => urgency(b) - urgency(a) || a.title.localeCompare(b.title))
  const relevant = itemId ? ranked.filter(f => f.work_item_ids.includes(itemId)) : ranked.slice(0, 3)
  const rest = ranked.filter(f => !relevant.includes(f))
  const counts = { implemented: features.filter(f => f.implementation === 'implemented' && !f.conflict).length, passed: features.filter(f => f.validation === 'passed' && !f.conflict).length, accepted: features.filter(f => f.accepted).length }
  const rows = (items: ProjectFeature[]) => <ul className="core-feature-list">{items.map(f => <FeatureRow key={f.id} snap={snap} feature={f} onSelectItem={onSelectItem} onSelectSession={onSelectSession} />)}</ul>
  return <section className="core-features" aria-label="核心功能实现进度">
    <div className="core-feature-heading"><h3>核心功能实现进度</h3><span className="muted">项目级 · 同功能只计一次</span></div>
    {scopeKnown ? <><div className="core-feature-counts"><span>已实现 <b>{counts.implemented}/{features.length}</b></span><span>Agent 报验证通过 <b>{counts.passed}/{features.length}</b></span><span>你已验收 <b>{counts.accepted}/{features.length}</b></span></div><div className="core-feature-track" role="img" aria-label={features.map(f => `${f.title}：${implementation[f.implementation] || '待回报'}`).join('；')}>{features.map(f => <span key={f.id} className={`is-${f.implementation}`} title={`${f.title}：${implementation[f.implementation] || '待回报'}`} />)}</div></> : <p className="muted">{features.length ? '核心功能范围仍有待确认项，暂不计算比例。' : '还没有核心功能清单，等待执行 Agent 按已有需求回报。'}</p>}
    {features.length > 0 && <p className="core-feature-note">按已有需求登记，每格是一项功能，不代表工作量。实现与验证均为 Agent 回报，独立校验尚未接入；验收由你确认。</p>}
    {relevant.length > 0 ? rows(relevant) : itemId && features.length > 0 ? <p className="muted">本工作项关联的功能待 Agent 回报；其他功能可在下方展开。</p> : null}
    {rest.length > 0 && <details><summary>其余 {rest.length} 项核心功能</summary>{rows(rest)}</details>}
  </section>
}

function FeatureRow({ snap, feature: f, onSelectItem, onSelectSession }: { snap: Snapshot; feature: ProjectFeature; onSelectItem?: (id: string) => void; onSelectSession?: (id: number) => void }) {
  const act = useAction()
  const active = f.contributions.filter(p => p.active)
  const latest = f.contributions[0]
  const shown = active.length ? f.contributions.filter(p => p.active || (!!f.candidate && p.candidate === f.candidate && (p.validation === 'failed' || !!p.blocker))) : latest ? f.contributions.filter(p => p.candidate === latest.candidate) : []
  return <li className="core-feature-row">
    <div className="core-feature-title"><strong>{f.title}</strong><span className={`core-feature-status is-${f.implementation}`}>{implementation[f.implementation] || '实现待回报'}</span></div>
    <p className={`core-feature-validation ${f.validation === 'failed' ? 'err-text' : ''}`}>{validation[f.validation] || '验证待回报'} · {f.accepted ? '你已验收此候选' : '尚未验收此候选'}{f.stale ? ' · 回报已超过一天，当前情况待同步' : ''}</p>
    {f.conflict && <p className="core-feature-blocker">会话候选或实现回报不一致，请执行 Agent 对齐；不合并成已完成。</p>}
    {!['documented', 'confirmed'].includes(f.scope_status) && <p className="core-feature-blocker">功能范围为 Agent 提议，依据尚待确认。</p>}
    {shown.map(p => <div className="core-feature-contribution" key={p.run_id}>
      {shown.length > 1 && <div className="core-feature-who"><AgentBadge provider={p.provider} /> <span>#{shownNo(p.session_id)} · {p.validation ? validation[p.validation] : implementation[p.implementation || 'unknown']}</span></div>}
      {p.blocker && <p className="core-feature-blocker"><b>卡点</b> {p.blocker}</p>}
      {!p.blocker && <p className="muted">卡点：{p.blocker === undefined ? '尚未回报' : '本次未报告阻塞'}</p>}
      <p><b>下一步 · {featureOwner(snap, p)}</b> {featureOwner(snap, p).startsWith('已回应') ? '已收到同一会话回应，等待新安排。' : shortText(p.next || '具体安排待回报', 140)}</p>
      <small className="muted">{providerLabel(p.provider)} #{shownNo(p.session_id)} · {p.active ? '本次执行' : '最近执行已结束'} · 最后回报 {ago(p.at, snap.now)}</small>
    </div>)}
    <details className="core-feature-source"><summary>验证依据、来源与功能验收</summary>
      <p>范围依据：{f.scope_basis} · {f.scope_status === 'confirmed' ? '你已确认范围' : f.scope_status === 'documented' ? 'Agent 按已有需求登记' : 'Agent 提议'}</p>
      {!isRemote() && f.scope_status === 'proposed' && <button className="btn small" disabled={isRemote() || act.busy} onClick={() => act.run(() => api.confirmFeatureScope(f.repo_id, f.id, f.revision))}>确认此功能属于项目范围</button>}
      <p>验收条件：{f.acceptance || '尚未回报'}</p>
      <p className="mono">候选：{f.candidate || '未指定或多候选待对齐'}</p>
      {f.contributions.map(p => <div key={p.run_id} className="core-feature-evidence"><p>{providerLabel(p.provider)} #{shownNo(p.session_id)} · {p.work_item_id} · 候选 {p.candidate || '待回报'}</p><p>实现：{implementation[p.implementation || 'unknown']} · {p.implementation_at ? ago(p.implementation_at, snap.now) : '未回报'}</p><p>{validation[p.validation || 'unknown']}：{p.evidence || '未回报验证依据'} · {p.validation_at ? ago(p.validation_at, snap.now) : '未回报'}</p>{onSelectSession && <button className="btn tiny" onClick={() => onSelectSession(p.session_id)}>会话 #{shownNo(p.session_id)}</button>}</div>)}
      {onSelectItem && f.work_item_ids.map(id => <button className="btn tiny" key={id} onClick={() => onSelectItem(id)}>工作项 {id}</button>)}
      {!isRemote() && !f.accepted && f.implementation === 'implemented' && !f.conflict && f.validation !== 'failed' && f.candidate && <button className="btn small" disabled={isRemote() || act.busy} onClick={() => act.run(() => api.acceptFeature(f.repo_id, f.id, f.candidate, f.revision, 'accepted'))}>确认此功能符合要求</button>}
      {f.accepted && <><p>用户验收：{f.accepted_at ? ago(f.accepted_at, snap.now) : ''}；不代表已合并或部署。</p>{!isRemote() && <button className="btn small" disabled={act.busy} onClick={() => act.run(() => api.acceptFeature(f.repo_id, f.id, f.candidate, f.revision, 'changes_requested'))}>退回此功能修改</button>}</>}
      <ErrorLine msg={act.error} />
    </details>
  </li>
}
