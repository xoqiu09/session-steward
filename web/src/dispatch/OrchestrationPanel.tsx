import { useCallback, useEffect, useRef, useState } from 'react'
import type { Snapshot, WorkItem } from '../types'

type Mandate = { work_item_id: string; revision: string; expires_at: string; max_turns: number; turns: number; revoked: boolean }
type Delivery = { revision: string; id: string; work_item_id: string; state: string; reason: string; receipt: string }
type Finding = { id: string; work_item_id: string; state: string; fact: string; basis: string; opened_at: string }
export type OrchestrationState = { mode: string; available: boolean; mandates: Mandate[]; deliveries: Delivery[]; findings: Finding[] }
const modeNames: Record<string, string> = { disabled: '停用', observe: '只观察', enabled: '按授权推进' }
const states: Record<string, string> = { queued: '等待送达', waiting_boundary: '等当前这一轮结束', sending: '正在送入', acknowledged: 'Codex 已接纳', retry_wait: '连接失败，稍后重试', held: '暂停送达', uncertain: '结果待核对', cancelled: '已取消' }
const reasons: Record<string, string> = {
  route_unrelated: '原负责人认为与本工作无关，等待核对归属', route_missing_scope: '范围尚不清楚，等待你补充边界', route_missing_evidence: '依据不足，等待核对', revoked: '授权已撤销', expired: '授权已到期', candidate_changed: '候选已变化，旧失败不触发新一轮', candidate_unavailable: '当前候选无法核实，暂不重送旧失败', execution_host_changed: '执行设备身份变化，请核对归属', target_changed: '目标或项目变化，请重新授权', work_closed: '工作已处理', awaiting_review: '等你查看交付', project_not_allowed: '项目已移出可派活范围', dependency_wait: '上游还没满足', approval_wait: '等你决定', handoff_required: '旧会话或分支已有工作，需要先明确交接', existing_worker: '已有其他会话在推进', turn_budget: '本次授权的回合已用完', capacity_wait: '其他任务正在执行', control_or_state_wait: '等你交回控制，或核对原会话', baseline_unavailable: '无法核实工作目录的基线', retry_exhausted: '连接重试次数已用完', input_expired: '要求保存超过一天，请重新交代', user_managed: '工作已暂停或委托', transport_unsent: '尚未发送，稍后重试', restart_after_admission: '重启前的发送结果待核对', execution_unknown: '尚不能确定是否执行', worker_busy: '当前这一轮正在执行', user_closed_unknown: '你结束了核对，执行结果仍未知，后台不会重发', native_accepted: '仅表示输入已接纳，交付仍需你验收', user_control: '你正在控制派活台', needs_reconcile: '重启后的执行待核对', desktop: '已交给桌面 App', uncertain: '上次执行待核对',
}
const key = () => crypto.randomUUID()
async function call<T>(path: string, body?: object): Promise<T> {
  const r = await fetch(path, { method: body ? 'POST' : 'GET', credentials: 'same-origin', headers: { 'Content-Type': 'application/json', 'X-Steward': '1' }, ...(body ? { body: JSON.stringify(body) } : {}) })
  const data = await r.json()
  if (!r.ok) throw new Error(data.error || '暂时无法读取后台推进状态')
  return data as T
}

export function OrchestrationSummary({ state, items, onRevoke, onAcknowledge, onReconcile, pending = false }: { state: OrchestrationState; items: WorkItem[]; onRevoke: (m: Mandate) => void; onAcknowledge: (id: string) => void; onReconcile?: (d: Delivery, action: string) => void; pending?: boolean }) {
  const title = (id: string) => items.find((w) => w.id === id)?.title || id
  return <>
    {!state.available && <p className="dd-alert">这台电脑暂时没有可用的 Codex 执行入口。可以查看，不能在后台执行。</p>}
    {state.mandates.length === 0 && <p className="muted">还没有工作获得后台推进授权。开启模式后也不会自动取得其他项目的权限。</p>}
    <ul className="orch-records">{state.mandates.map((m) => <li key={m.work_item_id}>
      <div><a href={`/?view=town&world=1#item=${encodeURIComponent(m.work_item_id)}`}>{title(m.work_item_id)}</a><small className="muted">{m.revoked ? '授权已撤销' : `已使用 ${m.turns} / ${m.max_turns} 回合 · 到期 ${new Date(m.expires_at).toLocaleString()}`}</small></div>
      {!m.revoked && <button className="btn small" disabled={pending} onClick={() => onRevoke(m)}>撤销授权</button>}
      <ul className="orch-inputs">{state.deliveries.filter((d) => d.work_item_id === m.work_item_id).slice(0, 3).map((d) => <li key={d.id}><span>{states[d.state] || '状态待核对'}</span>{d.reason && <small>{reasons[d.reason] || '需要核对投递记录'}</small>}{d.state === 'uncertain' && onReconcile && <div className="dd-actions"><button className="btn small" disabled={pending} onClick={() => onReconcile(d, 'verify_receipt')}>核对已记录回执</button><button className="btn small" disabled={pending} onClick={() => onReconcile(d, 'close_unknown')}>结束这条输入，不重发</button></div>}</li>)}</ul>
    </li>)}</ul>
    {state.findings.some((f) => f.state === 'open' || f.state === 'acknowledged') && <section aria-label="独立检查发现"><h3>需要核对的进展</h3><p className="muted">只根据现有记录提醒；它不会替你停止任务、批准操作或验收。</p>{state.findings.filter((f) => f.state === 'open' || f.state === 'acknowledged').map((f) => <article className="orch-finding" key={f.id}>
      <a href={`/?view=town&world=1#item=${encodeURIComponent(f.work_item_id)}`}>{title(f.work_item_id)}</a><p>{f.fact}</p><details><summary>查看判断依据</summary><p className="dd-mono">{f.basis}</p><small>{new Date(f.opened_at).toLocaleString()}</small></details>
      {f.state === 'open' ? <button className="btn small" disabled={pending} onClick={() => onAcknowledge(f.id)}>知道了，保留问题</button> : <small className="muted">你已看过，仍待新证据核对</small>}
    </article>)}</section>}
  </>
}

export function OrchestrationPanel() {
  const [state, setState] = useState<OrchestrationState | null>(null)
  const [items, setItems] = useState<WorkItem[]>([])
  const [item, setItem] = useState('')
  const [input, setInput] = useState('')
  const [storeInput, setStoreInput] = useState(false)
  const [turns, setTurns] = useState(10)
  const [minutes, setMinutes] = useState(240)
  const [failures, setFailures] = useState(false)
  const [revision, setRevision] = useState(key)
  const [feedbackKey, setFeedbackKey] = useState(key)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const requestSeq = useRef(0)
  const mounted = useRef(true)
  const refresh = useCallback(async () => {
    const seq = ++requestSeq.current
    try { const [v, snap] = await Promise.all([call<OrchestrationState>('/api/orchestration'), call<Snapshot>('/api/snapshot')]); if (mounted.current && seq === requestSeq.current) { setState(v); setItems(snap.work_items || []) } } catch (e) { if (mounted.current && seq === requestSeq.current) setError((e as Error).message) }
  }, [])
  useEffect(() => { mounted.current = true; void refresh(); const timer = window.setInterval(() => void refresh(), 2500); return () => { mounted.current = false; window.clearInterval(timer) } }, [refresh])
  const action = async (path: string, body: object) => { setBusy(true); setError(''); try { await call(path, body); await refresh(); return true } catch (e) { setError((e as Error).message); return false } finally { setBusy(false) } }
  if (!state) return <section className="dd-card"><h2>后台推进</h2><p role="status">{error || '正在读取…'}</p></section>
  const selectable = items.filter((w) => !['done', 'abandoned', 'review'].includes(w.status))
  const chosen = item || selectable[0]?.id || ''
  const mandate = state.mandates.find((m) => m.work_item_id === chosen && !m.revoked)
  return <section className="dd-card orch-panel" aria-label="后台推进授权">
    <div className="orch-heading"><div><p className="dd-eyebrow">只在这台电脑上</p><h2>把后续交给后台推进</h2></div><span className="badge">{modeNames[state.mode] || '状态未知'}</span></div>
    <p className="muted">为明确的工作授权后，后续要求会回到原负责人；当前这一轮正忙时先排队。工具审批和最终验收仍由你决定。</p>
    <div className="dd-actions" role="group" aria-label="后台推进模式">{Object.entries(modeNames).map(([value, name]) => <button className={`btn small${state.mode === value ? ' primary' : ''}`} aria-pressed={state.mode === value} disabled={busy} key={value} onClick={() => void action('/api/orchestration/mode', { mode: value })}>{name}</button>)}</div>
    {state.mode === 'enabled' && <p className="muted">准备好后，在上方点“交回后台”。你接过来控制时，后台会停止送入新要求。</p>}
    {error && <p className="dd-alert" role="alert">{error}</p>}
    <OrchestrationSummary state={state} items={items} pending={busy} onReconcile={(d, actionName) => { void action(`/api/orchestration/deliveries/${encodeURIComponent(d.id)}/reconcile`, { revision: d.revision, action: actionName }) }} onRevoke={(m) => { void action(`/api/orchestration/mandates/${encodeURIComponent(m.work_item_id)}/revoke`, { revision: m.revision }) }} onAcknowledge={(id) => { void action(`/api/orchestration/findings/${encodeURIComponent(id)}/acknowledge`, {}) }} />
    <details className="orch-grant"><summary>授权一件工作或补充下一步</summary><form onSubmit={async (e) => { e.preventDefault(); if (await action('/api/orchestration/mandates', { work_item_id: chosen, revision, input, store_input: storeInput, max_turns: turns, expires_minutes: minutes, failure_followup: failures })) { setInput(''); setStoreInput(false); setRevision(key()) } }}>
      <fieldset className="orch-fields" disabled={busy}><label>已有工作项<select value={chosen} onChange={(e) => { setItem(e.target.value); setRevision(key()); setFeedbackKey(key()) }} required>{selectable.map((w) => <option key={w.id} value={w.id}>{w.title} · {w.id}</option>)}</select></label>
      <p className="muted">项目需先加入“可派活的项目”，工作项需有验收条件。先沿用这件工作的目标，不自动拆成多名 Agent。</p>
      <label>本次允许它做什么<textarea rows={3} maxLength={4096} required value={input} onChange={(e) => { setInput(e.target.value); setRevision(key()); setFeedbackKey(key()) }} /></label>
      <div className="orch-limits"><label>最多几个回合<input type="number" min={1} max={100} value={turns} onChange={(e) => { setTurns(Number(e.target.value)); setRevision(key()) }} required /></label><label>多少分钟后到期<input type="number" min={1} max={240} value={minutes} onChange={(e) => { setMinutes(Number(e.target.value)); setRevision(key()) }} required /></label></div>
      <label className="orch-checkbox"><input type="checkbox" checked={failures} onChange={(e) => { setFailures(e.target.checked); setRevision(key()) }} />允许本工作项的工具失败观察交回原负责人核对</label>
      <label className="orch-checkbox"><input type="checkbox" checked={storeInput} onChange={(e) => setStoreInput(e.target.checked)} />允许暂存这条要求，送达后清除；未送达最多保存一天</label>
      <div className="dd-actions"><button className="btn primary" disabled={busy || !chosen || !storeInput}>按这些边界授权</button>{mandate && <button type="button" className="btn" disabled={busy || !input.trim() || !storeInput} onClick={async () => { if (await action(`/api/orchestration/mandates/${encodeURIComponent(chosen)}/feedback`, { revision: mandate.revision, source: feedbackKey, input, store_input: storeInput })) { setInput(''); setStoreInput(false); setFeedbackKey(key()) } }}>只补充要求，沿用原授权</button>}</div></fieldset>
    </form></details>
  </section>
}
