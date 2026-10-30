import { isRemote } from './access'
import { useState } from 'react'
import type { Attribution, AttributionDecision, Snapshot } from './types'
import { api } from './api'
import { AgentBadge, ErrorLine, useAction } from './bits'
import { shownNo } from './hub/ids'
import { ago } from './model'
import { attributionChoice, attributionRequest, canUndoAttribution, clusterAttributions, clusterRequests, clusterTitle, scopedAttributions, type AttributionCluster, type AttributionDraft } from './attribution'

export function AttributionPanel({ snap, repoId, provider, onClose, onSelectItem }: {
  snap: Snapshot; repoId: number | 'all'; provider: string; onClose: () => void; onSelectItem: (id: string) => void
}) {
  const [mode, setMode] = useState<'live' | 'history' | 'records'>('live')
  const [grouped, setGrouped] = useState(true)
  const [selected, setSelected] = useState<Record<string, boolean>>({})
  const [drafts, setDrafts] = useState<Record<string, AttributionDraft>>({})
  const [bulkRepo, setBulkRepo] = useState(0)
  const act = useAction()
  const records = scopedAttributions(snap, repoId, provider)
  const pending = records.filter((a) => a.status === 'pending')
  const live = pending.filter((a) => !a.plan.historical)
  const history = pending.filter((a) => a.plan.historical)
  const list = mode === 'live' ? live : mode === 'history' ? history : records.filter((a) => ['applied', 'undone', 'dismissed'].includes(a.status))
  const chosen = list.filter((a) => selected[a.id] && a.status === 'pending')
  const requests = chosen.flatMap((a) => attributionRequest(a, drafts[a.id], bulkRepo) ?? [])
  const ready = list.filter((a) => attributionRequest(a, drafts[a.id], bulkRepo))
  const apply = () => act.run(() => api.decideAttributions(requests).then(() => setSelected({})))
  const dismiss = () => act.run(() => api.decideAttributions(chosen.map((a) => ({ id: a.id, fingerprint: a.fingerprint, action: 'dismiss' }))).then(() => setSelected({})))
  const update = (id: string, patch: AttributionDraft) => setDrafts((old) => ({ ...old, [id]: { ...old[id], ...patch } }))
  return <div className="detail attribution-panel">
    <div className="detail-head"><h2>会话归属</h2><button className="btn small right" onClick={onClose} aria-label="关闭归属面板">✕</button></div>
    <p className="hint">确定的已自动整理；这里只确认模糊匹配。人工归属保持优先。自动与批量操作都保留依据和撤销记录。</p>
    <div className="row wrap"><button className="btn small" disabled={isRemote() || act.busy} onClick={() => act.run(() => api.reconcileAttributions())}>立即整理</button><span className="small muted">已自动整理 {records.filter((a) => a.status === 'applied' && a.automatic).length}</span></div>
    <select aria-label="归属查看范围" value={mode} onChange={(e) => { setMode(e.target.value as typeof mode); setSelected({}) }}>
      <option value="live">近期会话待确认（{live.length}）</option><option value="history">历史会话待确认（{history.length}）</option><option value="records">整理记录</option>
    </select>
    {mode !== 'records' && <div className="seg" role="group" aria-label="显示方式">
      <button className={grouped ? 'on' : ''} onClick={() => setGrouped(true)}>按线索分组</button>
      <button className={grouped ? '' : 'on'} onClick={() => setGrouped(false)}>逐条</button>
    </div>}
    {mode !== 'records' && grouped && <ClusterList snap={snap} records={list} busy={act.busy}
      onApply={(reqs) => act.run(() => api.decideAttributions(reqs))} onItem={onSelectItem} />}
    {mode !== 'records' && !grouped && <div className="attribution-batch">
      <label>项目不明项统一归入（可选）<select aria-label="项目不明项统一归入" value={bulkRepo} onChange={(e) => setBulkRepo(Number(e.target.value))}><option value={0}>使用每项自己的项目</option>{(snap.repos ?? []).map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}</select></label>
      <div className="row wrap"><button className="btn small" onClick={() => setSelected(Object.fromEntries(ready.map((a) => [a.id, true])))}>全选可确认（{ready.length}）</button><button className="btn small" onClick={() => setSelected({})}>清空选择</button></div>
      <div className="row wrap"><button className="btn small primary" disabled={isRemote() || act.busy || requests.length === 0 || requests.length !== chosen.length} onClick={apply}>确认选中（{chosen.length}）</button><button className="btn small" disabled={isRemote() || act.busy || chosen.length === 0} onClick={dismiss}>暂不关联选中</button></div>
      {chosen.length > requests.length && <p className="hint">还有 {chosen.length - requests.length} 项需要选择所属项目或关联目标。</p>}
    </div>}
    <ErrorLine msg={act.error} />
    {list.length === 0 && <p className="muted">这个范围没有待处理记录。</p>}
    {(mode === 'records' || !grouped) && <div className="session-entries">{list.map((a) => <AttributionEntry key={a.id} a={a} snap={snap} draft={drafts[a.id]} bulkRepo={bulkRepo} selected={!!selected[a.id]} busy={act.busy}
      onSelect={(checked) => setSelected((old) => ({ ...old, [a.id]: checked }))} onDraft={(patch) => update(a.id, patch)} onItem={onSelectItem}
      onUndo={() => act.run(() => api.decideAttributions([{ id: a.id, fingerprint: a.fingerprint, action: 'undo' }]))} />)}</div>}
    <p className="hint">没有标题或可识别分支的会话保留在“会话”中，等待新的线索。历史记录经确认后只登记历史执行关系，不显示为正在运行。</p>
  </div>
}

function AttributionEntry({ a, snap, draft, bulkRepo, selected, busy, onSelect, onDraft, onItem, onUndo }: {
  a: Attribution; snap: Snapshot; draft?: AttributionDraft; bulkRepo: number; selected: boolean; busy: boolean;
  onSelect: (checked: boolean) => void; onDraft: (patch: AttributionDraft) => void; onItem: (id: string) => void; onUndo: () => void
}) {
  const s = (snap.sessions ?? []).find((s) => s.id === a.session_id)
  const choice = attributionChoice(a, draft, bulkRepo)
  const item = (snap.work_items ?? []).find((w) => w.id === a.work_item_id)
  const pending = a.status === 'pending'
  const repoName = (id: number) => (snap.repos ?? []).find((r) => r.id === id)?.name || '项目待确认'
  return <div className="q-card attribution-entry">
    <div className="row">{pending && <input type="checkbox" aria-label={`选择会话 #${shownNo(a.session_id)}`} checked={selected} disabled={busy} onChange={(e) => onSelect(e.target.checked)} />}{s && <AgentBadge provider={s.provider} client={s.client} />}<span className="small muted">会话 #{shownNo(a.session_id)}</span><span className="small muted right">{ago(a.created_at, snap.now)}</span></div>
    <strong className="entry-title">{s?.title || a.plan.title || '工作内容待登记'}</strong>
    <p className="hint">{a.plan.reasons.join('；')}</p>
    {s?.branch && <p className="hint mono">分支：{s.branch}</p>}
    {pending ? <div className="attribution-fields">
      <label>关联目标<select aria-label={`会话 #${shownNo(a.session_id)} 关联目标`} value={choice.target} onChange={(e) => onDraft({ target: e.target.value })}>
        {a.plan.candidates.length > 1 && <option value="">多个候选，请选择…</option>}<option value="new">新建工作项</option>
        {a.plan.candidates.map((c) => <option key={c.work_item_id} value={c.work_item_id}>{c.work_item_id} · {repoName(c.repo_id)} · {c.title}</option>)}
      </select></label>
      {choice.target === 'new' && <><label>所属项目<select aria-label={`会话 #${shownNo(a.session_id)} 所属项目`} value={choice.repoId} onChange={(e) => onDraft({ repoId: Number(e.target.value) })}><option value={0}>请选择所属项目…</option>{(snap.repos ?? []).map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}</select></label><label>工作标题<input aria-label={`会话 #${shownNo(a.session_id)} 工作标题`} value={choice.title} onChange={(e) => onDraft({ title: e.target.value })} /></label></>}
      {choice.target && choice.target !== 'new' && <p className="hint">将关联已有工作项，保持该工作项的所属项目。</p>}
    </div> : <div>
      <p className="hint">{a.status === 'applied' ? `${a.automatic ? '自动' : '已确认'}${a.created_item ? '创建并关联' : '关联'} · ${repoName(a.plan.repo_id)}` : a.status === 'undone' ? '已撤销，不会重复自动关联' : '已暂不关联，线索未变时不再提示'}</p>
      {a.work_item_id && <button className="pill link" onClick={() => onItem(a.work_item_id)}>{a.work_item_id} · {item?.title}</button>}
      {canUndoAttribution(a, snap) && <button className="btn small" disabled={isRemote() || busy} onClick={onUndo}>撤销本次关联</button>}
    </div>}
  </div>
}

const clusterBadge: Record<AttributionCluster['kind'], string> = { target: '高把握', branch: '同分支', title: '标题相近', choose: '需要选择', unclear: '线索不足', history: '历史' }

function ClusterList({ snap, records, busy, onApply, onItem }: {
  snap: Snapshot; records: Attribution[]; busy: boolean; onApply: (reqs: AttributionDecision[]) => void; onItem: (id: string) => void
}) {
  const clusters = clusterAttributions(snap, records)
  if (!clusters.length) return null
  return <div className="clusters">{clusters.map((c) => <ClusterCard key={c.key} c={c} snap={snap} busy={busy} onApply={onApply} onItem={onItem} />)}</div>
}

function ClusterCard({ c, snap, busy, onApply, onItem }: {
  c: AttributionCluster; snap: Snapshot; busy: boolean; onApply: (reqs: AttributionDecision[]) => void; onItem: (id: string) => void
}) {
  const [target, setTarget] = useState(c.target)
  const [repoId, setRepoId] = useState(c.repoId)
  const [title, setTitle] = useState(clusterTitle(snap, c))
  const [skip, setSkip] = useState<Set<string>>(new Set())
  const sessions = new Map((snap.sessions ?? []).map((s) => [s.id, s]))
  const repoName = (id: number) => (snap.repos ?? []).find((r) => r.id === id)?.name ?? '项目不明'
  const cands = c.records[0]?.plan.candidates ?? []
  const reqs = clusterRequests(c, { target, repoId, title }, skip)
  const n = c.records.length - skip.size
  const dismiss = () => onApply(c.records.filter((a) => !skip.has(a.id)).map((a) => ({ id: a.id, fingerprint: a.fingerprint, action: 'dismiss' })))

  if (c.kind === 'history') {
    const by = new Map<string, number>()
    for (const a of c.records) {
      const k = repoName(a.plan.repo_id || sessions.get(a.session_id)?.repo_id || 0)
      by.set(k, (by.get(k) ?? 0) + 1)
    }
    return <div className={`cluster k-${c.kind}`}>
      <h4><span className="pill">{clusterBadge[c.kind]}</span>{c.label}<span className="right muted">{c.records.length} 个会话</span></h4>
      <p className="hint">{[...by.entries()].map(([k, v]) => `${k} ${v}`).join(' · ')}</p>
      <p className="hint">历史会话不会显示为运行中。暂不关联后，线索未变时不再提示；需要登记执行关系时切到“逐条”。</p>
      <div className="row"><button className="btn small" disabled={isRemote() || busy} onClick={dismiss}>全部暂不关联（{c.records.length}）</button></div>
    </div>
  }
  return <div className={`cluster k-${c.kind}`}>
    <h4><span className="pill">{clusterBadge[c.kind]}</span>{c.label}<span className="right muted">{c.records.length} 个会话</span></h4>
    <p className="hint">线索：<span className="mono">{c.clue || '—'}</span>{c.repoId ? ` · ${repoName(c.repoId)}` : ''}</p>
    {c.records.map((a) => {
      const s = sessions.get(a.session_id)
      return <label key={a.id} className="cl-sess">
        <input type="checkbox" checked={!skip.has(a.id)} disabled={busy} aria-label={`包含会话 #${shownNo(a.session_id)}`}
          onChange={(e) => setSkip((old) => { const n = new Set(old); if (e.target.checked) n.delete(a.id); else n.add(a.id); return n })} />
        {s && <AgentBadge provider={s.provider} client={s.client} />}
        <span>#{shownNo(a.session_id)} {s?.title || '（无标题）'}</span>
        <small className="muted right">{ago(s?.last_activity_at || a.created_at, snap.now)}</small>
      </label>
    })}
    <div className="attribution-fields">
      <label>整组关联到<select aria-label="整组关联目标" value={target} onChange={(e) => setTarget(e.target.value)}>
        {(c.kind === 'choose' || !target) && <option value="">请选择…</option>}
        <option value="new">新建一个工作项（整组共用）</option>
        {(cands.length ? cands : c.target && c.target !== 'new' ? [{ work_item_id: c.target, title: (snap.work_items ?? []).find((w) => w.id === c.target)?.title ?? '' }] : [])
          .map((x) => <option key={x.work_item_id} value={x.work_item_id}>{x.work_item_id} · {x.title}</option>)}
      </select></label>
      {target === 'new' && <>
        <label>所属项目<select aria-label="整组所属项目" value={repoId} onChange={(e) => setRepoId(Number(e.target.value))}><option value={0}>请选择所属项目…</option>{(snap.repos ?? []).map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}</select></label>
        <label>工作标题<input aria-label="整组工作标题" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="这组会话在做的事" /></label>
      </>}
    </div>
    {target && target !== 'new' && <p className="hint">关联到已有工作项 <button className="pill link" onClick={() => onItem(target)}>{target}</button>，保持其所属项目。</p>}
    <div className="row wrap">
      <button className="btn small primary" disabled={isRemote() || busy || !reqs} onClick={() => reqs && onApply(reqs)}>{target === 'new' ? `新建并关联 ${n} 个会话` : `关联 ${n} 个会话`}</button>
      <button className="btn small" disabled={isRemote() || busy || n === 0} onClick={dismiss}>暂不关联</button>
    </div>
  </div>
}
