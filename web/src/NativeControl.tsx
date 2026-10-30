import { useEffect, useRef, useState } from 'react'
import './native-control.css'

export interface NativeState {
  host: string; workspace: string; title: string; thread_id: string; work_item_id: string; session_id: number; turn_id: string
  status: string; work_status: string; owner: string; epoch: number; desktop_handoff: boolean; lease_until: string; last_error?: string; delivery_summary?: string
  events: { seq: number; kind: string; at: string; turn?: string }[]
  pending: { id: string; fingerprint: string; details: string; turn: string; approvable: boolean }[] | null
}
const statusNames: Record<string, string> = { ready: '还没有开始', starting: '正在交给这台 Mac', running: '正在这台 Mac 执行', idle: '本轮执行已结束', failed: '本轮执行出错', interrupted: '本轮已停止', desktop: '已交给电脑继续', needs_reconcile: '连接待核对', uncertain: '执行状态待核对' }
const eventNames: Record<string, string> = { control_acquired: '取得此项目控制权', turn_requested: '收到任务，准备本机执行', tool_pre: '本机工具开始工作', tool_post: '本机工具执行结束', tool_fail: '本机工具返回失败', agent_delivered: 'Agent 主动交付，等你处理', turn_completed: '本轮结束', turn_interrupted: '本轮已停止', turn_failed: '本轮出错', approval_requested: '有一项操作需要你决定', approval_accept: '决定已送回 Codex，执行结果另记', approval_decline: '已拒绝这次操作', approval_cancel: '请求已失效', desktop_handoff: '已释放小镇写入权', native_thread_resumed: '已恢复原生会话', interrupt_requested: '已请求停止', unsupported_native_request: '此请求需回原生界面处理' }
const id = () => globalThis.crypto?.randomUUID?.() ?? `client_${Date.now()}_${Math.random().toString(36).slice(2)}`
function stored(key: string, fallback: string) { try { return sessionStorage.getItem(key) || fallback } catch { return fallback } }
function remember(key: string, value: string) { try { sessionStorage.setItem(key, value) } catch { /* current-page pairing still works */ } }

export function NativeSummary({ state }: { state: NativeState }) {
  return <section className="nc-result" aria-label="这项工作的状态"><p className="nc-eyebrow">同一个项目 · 同一条会话</p><h2>{state.title || '把一件事交给这台 Mac'}</h2>
    <p className="nc-status" role="status">{state.turn_id ? statusNames[state.status] || '本轮正在执行' : state.work_status === 'review' ? 'Agent 已交付，等你处理' : statusNames[state.status] || '状态待核对'}</p>
    {state.delivery_summary && <p>{state.delivery_summary}<small className="muted"> · Agent 交付自述</small></p>}
    {state.work_status === 'review' && <p>交付已回到小镇。是否已处理、功能是否符合要求，由你另外确认。</p>}
    {state.last_error && <p role="alert">{state.last_error}</p>}
    <dl><div><dt>执行电脑</dt><dd>{state.host}</dd></div><div><dt>项目位置</dt><dd className="nc-path">{state.workspace}</dd></div>{state.work_item_id && <div><dt>小镇工作项</dt><dd>{state.work_item_id}</dd></div>}</dl>
  </section>
}

export function NativeControl() {
  const [client] = useState(() => { const v = stored('ss.native.client', id()); remember('ss.native.client', v); return v })
  const [token, setToken] = useState(() => {
    const p = new URLSearchParams(window.location.hash.slice(1)), v = p.get('control') || stored('ss.native.control', '')
    if (p.has('control')) { history.replaceState(null, '', window.location.pathname + window.location.search); remember('ss.native.control', v) }
    return v
  })
  const [state, setState] = useState<NativeState | null>(null)
  const [pairInput, setPairInput] = useState(''), [title, setTitle] = useState(''), [prompt, setPrompt] = useState('')
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [notice, setNotice] = useState('')
  const current = useRef<NativeState | null>(null)
  async function call(path: string, body?: object, credential = token) {
    const r = await fetch(path, { method: body ? 'POST' : 'GET', headers: { ...(body ? { 'Content-Type': 'application/json', 'X-Steward-Native': '1' } : {}), ...(credential ? { Authorization: `Bearer ${credential}` } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) })
    const data = await r.json()
    if (!r.ok) throw new Error(data.error || '暂时无法连接')
    return data
  }
  useEffect(() => {
    // Possession is required even on loopback. This never retrieves a key.
    if (token) void call('/native/local-pair', {}).catch(() => { /* remote scope never receives a panel cookie */ })
  }, [token])
  useEffect(() => {
    if (!token) return
    let active = true, loading = false
    const refresh = async () => {
      if (loading) return
      loading = true
      try {
        let data = await call('/native/api/state') as NativeState
        if (data.owner === client && !data.desktop_handoff && Date.parse(data.lease_until) - Date.now() < 45000) data = await call('/native/api/acquire', { client })
        if (active) { current.current = data; setState(data) }
      } catch (e) { if (active) setError(String(e).replace(/^Error: /, '')) }
      finally { loading = false }
    }
    void refresh(); const timer = window.setInterval(refresh, 1500)
    return () => { active = false; window.clearInterval(timer) }
  }, [token, client])
  const owns = !!state && state.owner === client && !state.desktop_handoff && Date.parse(state.lease_until) > Date.now()
  async function act(action: string, extra = {}) {
    setBusy(true); setError(''); setNotice('')
    try { const data = await call(`/native/api/${action}`, { client, epoch: current.current?.epoch ?? state?.epoch ?? 0, ...extra }) as NativeState; current.current = data; setState(data); return true }
    catch (e) { setError(String(e).replace(/^Error: /, '')); return false }
    finally { setBusy(false) }
  }
  return <main className="native-control">
    <header className="nc-header"><a href="/?view=town&world=1">← 小镇</a><span>个人非商业原型</span></header>
    <div className="nc-intro"><p className="nc-eyebrow">SESSION STEWARD · 本机任务</p><h1>手机交代，Mac 接着做。</h1><p>任务固定在这台电脑和这个项目。关闭页面后，电脑仍会继续执行。</p></div>
    {error && <div className="nc-error" role="alert"><p>{error}</p>{token && <button className="btn" onClick={() => { remember('ss.native.control', ''); setToken(''); setState(null); current.current = null }}>重新配对连接</button>}</div>}{notice && <p role="status">{notice}</p>}
    {!token ? <form className="nc-card" onSubmit={e => { e.preventDefault(); remember('ss.native.control', pairInput.trim()); setToken(pairInput.trim()); setError('') }}><label>项目配对密钥<input type="password" value={pairInput} onChange={e => setPairInput(e.target.value)} required autoComplete="off" /></label><button className="btn primary">连接这个项目</button></form> : state ? <div className="nc-grid">
      <div><NativeSummary state={state} />
        <section className="nc-card"><div className="nc-card-heading"><h2>交代下一步</h2><span className="muted">{owns ? '由这个页面控制' : state.desktop_handoff ? '电脑原生会话接手中' : '尚未取得控制权'}</span></div>
          {!owns && !state.desktop_handoff && <button className="btn" disabled={busy} onClick={() => void act('acquire')}>接管此项目</button>}
          <form onSubmit={async e => { e.preventDefault(); if (await act('start', { operation: id(), title, prompt })) setPrompt('') }}>
            {!state.thread_id && <label>这件事叫什么<input value={title} onChange={e => setTitle(e.target.value)} maxLength={200} required placeholder="例如：检查演示项目的构建" /></label>}
            <label>希望 Codex 做什么<textarea value={prompt} onChange={e => setPrompt(e.target.value)} maxLength={16000} required rows={5} placeholder="说明目标和边界，代码和工具会在上面的 Mac 项目中执行。" /></label>
            <div className="nc-actions"><button className="btn primary" disabled={busy || !owns || !!state.turn_id || ['uncertain', 'needs_reconcile'].includes(state.status)}>在这台 Mac 执行</button>
              <button type="button" className="btn" disabled={busy || !owns || !state.turn_id} onClick={() => void act('interrupt')}>停止本轮</button></div>
          </form><p className="muted">停止只中断本轮，不代表工作已处理。模型继续使用本机 Codex 的既有配置。</p>
          {state.status === 'needs_reconcile' && !state.turn_id && <button className="btn" disabled={busy || !owns} onClick={() => void act('resume')}>恢复同一条原生会话</button>}
        </section>
        {(state.pending || []).map(p => <section className="nc-card nc-approval" key={p.id}><p className="nc-eyebrow">需要你决定</p><h2>Codex 请求执行一项操作</h2><pre>{p.details}</pre><p className="muted">此决定只对应当前会话、本轮和这一项请求，不授予后续自动批准。</p><div className="nc-actions">{p.approvable && <button className="btn primary" disabled={busy || !owns} onClick={() => void act('decide', { approval: p.id, fingerprint: p.fingerprint, decision: 'allow' })}>仅允许这一次</button>}<button className="btn" disabled={busy || !owns} onClick={() => void act('decide', { approval: p.id, fingerprint: p.fingerprint, decision: 'deny' })}>拒绝这一次</button></div>{!p.approvable && <p>这类请求需回原生界面完整核对，本原型只支持拒绝。</p>}</section>)}
      </div><aside>
        <section className="nc-card"><h2>回电脑继续</h2><p>先释放小镇写入权，再在这台 Mac 打开原来的 Codex 会话。</p><button className="btn" disabled={busy || !owns || !state.thread_id || (!!state.turn_id && state.status !== 'needs_reconcile') || !!state.pending?.length} onClick={() => void act('handoff')}>交给电脑接着做</button>
          {state.desktop_handoff && <><p>已释放写入权，手机不会继续向它发任务。</p><a className="btn" href={`codex://threads/${encodeURIComponent(state.thread_id)}`}>尝试在 Codex 打开</a><p className="muted">官方桌面 App 原位续接尚未验证。CLI 可按原生 ID 恢复，不会新开摘要聊天。</p><code className="nc-command">codex resume {state.thread_id}</code></>}
          <details><summary>会话与能力依据</summary><p>原生会话：<code>{state.thread_id || '尚未创建'}</code></p><p>命令审批仅支持单次决定；文件修改和其他原生交互未完整支持。控制权限制小镇页面，不能锁住你另行打开的所有外部客户端。</p></details>
        </section>
        <section className="nc-card"><h2>最近发生了什么</h2><ol className="nc-events">{(state.events || []).slice(-9).reverse().map(e => <li key={e.seq}><span>{eventNames[e.kind] || '收到原生运行观察'}</span><time>{new Date(e.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</time></li>)}</ol><p className="muted">只展示结构化运行状态；会话正文和工具输出留在 Codex。</p></section>
      </aside></div> : <p role="status">正在连接这台 Mac…</p>}
  </main>
}
