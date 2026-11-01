import { useCallback, useEffect, useRef, useState } from 'react'
import './dispatch.css'
import {
  canHandoff, canResume, canStart, desktopHref, eventText, taskLabel, townHref,
  type DispatchDeskState, type DispatchPending, type DispatchTask,
} from './dispatchModel'

class DeskError extends Error { constructor(public status: number, message: string) { super(message) } }

async function req<T>(path: string, body?: object): Promise<T> {
  const r = await fetch(path, {
    method: body ? 'POST' : 'GET', credentials: 'same-origin',
    headers: body ? { 'Content-Type': 'application/json', 'X-Steward': '1' } : {},
    ...(body ? { body: JSON.stringify(body) } : {}),
  })
  let data: { error?: string } = {}
  try { data = await r.json() } catch { /* 非 JSON 时只看状态码 */ }
  if (!r.ok) throw new DeskError(r.status, data.error || '暂时连不上派活台')
  return data as T
}

const newKey = () => (globalThis.crypto?.randomUUID?.() ?? `k_${Date.now()}_${Math.random().toString(36).slice(2)}`).replace(/[^a-zA-Z0-9_-]/g, '')
function stored(key: string) { try { return sessionStorage.getItem(key) || '' } catch { return '' } }
function remember(key: string, v: string) { try { sessionStorage.setItem(key, v) } catch { /* 只在本页有效 */ } }
const clock = (at: string) => new Date(at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })

export function ApprovalCard({ p, disabled, onDecide }: { p: DispatchPending; disabled: boolean; onDecide: (d: 'allow' | 'deny') => void }) {
  return <section className="dd-card dd-approval" aria-label="等你决定的操作">
    <p className="dd-eyebrow">等你决定</p>
    <h3>Codex 想执行一项操作</h3>
    <pre>{p.details}</pre>
    <p className="muted">只对这一次请求有效，不会变成以后都允许。命令只在这里临时显示，不保存。</p>
    <div className="dd-actions">
      {p.approvable && <button className="btn primary" disabled={disabled} onClick={() => onDecide('allow')}>仅允许这一次</button>}
      <button className="btn" disabled={disabled} onClick={() => onDecide('deny')}>拒绝</button>
    </div>
    {!p.approvable && <p className="muted">这类请求派活台只能拒绝，要允许请回 Codex 里看完整内容。</p>}
  </section>
}

export function TaskSummary({ t, host }: { t: DispatchTask; host: string }) {
  const label = taskLabel(t)
  return <section className={`dd-result tone-${label.tone}`} aria-label="这件任务的状态">
    <p className="dd-eyebrow">{t.repo_name} · {t.work_item_id}</p>
    <h2>{t.title}</h2>
    <p className="dd-status" role="status">{label.text}</p>
    {t.delivery_summary && <p>{t.delivery_summary}<small className="muted"> · Agent 自述</small></p>}
    {t.work_status === 'review' && <p className="muted">Agent 说做完了，不等于验收通过。符不符合要求，由你在小镇里确认。</p>}
    {t.last_error && <p className="dd-alert" role="alert">{t.last_error}</p>}
    <dl>
      <div><dt>执行电脑</dt><dd>{host}</dd></div>
      <div><dt>分支</dt><dd className="dd-mono">{t.branch}</dd></div>
      <div><dt>目录</dt><dd className="dd-mono">{t.worktree}</dd></div>
    </dl>
  </section>
}

export function DispatchDesk() {
  const [client] = useState(() => { const v = stored('ss.dispatch.client') || newKey(); remember('ss.dispatch.client', v); return v })
  const [desk, setDesk] = useState<DispatchDeskState | null>(null)
  const [detail, setDetail] = useState<DispatchTask | null>(null)
  const [selected, setSelected] = useState(() => new URLSearchParams(window.location.search).get('task') || '')
  const [fatal, setFatal] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [creating, setCreating] = useState(false)
  const [managing, setManaging] = useState(false)
  const deskRef = useRef<DispatchDeskState | null>(null)

  const refresh = useCallback(async () => {
    try {
      let d = await req<DispatchDeskState>('/api/dispatch')
      const left = Date.parse(d.lease_until) - Date.now()
      // 没人控制或者自己的租约快到期时自动续上；别人正在控制时不抢，等用户点“接过来”。
      if ((!d.owner || left <= 0) || (d.owner === client && left < 45000)) d = await req<DispatchDeskState>('/api/dispatch/acquire', { client })
      deskRef.current = d
      setDesk(d)
      setFatal('')
    } catch (e) {
      const err = e as DeskError
      if (err.status === 503 || err.status === 403 || err.status === 401) setFatal(err.message)
      else setError(err.message)
    }
  }, [client])

  useEffect(() => {
    let active = true
    void refresh()
    const timer = window.setInterval(() => { if (active) void refresh() }, 1500)
    return () => { active = false; window.clearInterval(timer) }
  }, [refresh])

  useEffect(() => {
    if (!selected) { setDetail(null); return }
    let active = true
    const load = () => req<DispatchTask>(`/api/dispatch/tasks/${encodeURIComponent(selected)}`).then((t) => { if (active) setDetail(t) }).catch(() => { /* 列表里还在就继续轮询 */ })
    void load()
    const timer = window.setInterval(load, 1500)
    return () => { active = false; window.clearInterval(timer) }
  }, [selected])

  const pick = (id: string) => {
    setSelected(id); setCreating(false); setError('')
    history.replaceState(null, '', `${window.location.pathname}?view=dispatch${id ? `&task=${encodeURIComponent(id)}` : ''}`)
  }
  const owns = !!desk && desk.owner === client && Date.parse(desk.lease_until) > Date.now()
  const epoch = () => deskRef.current?.epoch ?? 0

  async function act(path: string, body: object): Promise<DispatchTask | null> {
    setBusy(true); setError('')
    try {
      const t = await req<DispatchTask>(path, { client, epoch: epoch(), ...body })
      setDetail(t)
      void refresh()
      return t
    } catch (e) { setError((e as Error).message); void refresh(); return null }
    finally { setBusy(false) }
  }
  async function takeOver() {
    setBusy(true); setError('')
    try { const d = await req<DispatchDeskState>('/api/dispatch/acquire', { client, force: true }); deskRef.current = d; setDesk(d) }
    catch (e) { setError((e as Error).message) }
    finally { setBusy(false) }
  }

  if (fatal) return <main className="dispatch-desk"><DeskHeader /><div className="dd-card dd-blocked" role="alert"><h2>派活台打不开</h2><p>{fatal}</p></div></main>
  if (!desk) return <main className="dispatch-desk"><DeskHeader /><p role="status">正在连接派活台…</p></main>

  const other = !!desk.owner && desk.owner !== client && Date.parse(desk.lease_until) > Date.now()
  const task = detail && detail.id === selected ? detail : desk.tasks.find((t) => t.id === selected) ?? null
  return <main className="dispatch-desk">
    <DeskHeader />
    <div className="dd-intro">
      <p className="dd-eyebrow">SESSION STEWARD · 派活台</p>
      <h1>任务在 {desk.host} 上执行</h1>
      <p className="muted">{desk.codex_version || 'Codex'} · 用这台电脑上你自己的 Codex 设置。关掉页面任务照常跑，回来能看到进展。</p>
      <p className={`dd-control${other ? ' is-other' : ''}`}>
        {owns ? '这个页面正在控制' : other ? '另一个页面正在控制，这里只能看' : '正在取得控制…'}
        {other && <button className="btn small" disabled={busy} onClick={() => void takeOver()}>接过来</button>}
      </p>
    </div>
    {error && <div className="dd-alert" role="alert">{error}</div>}
    <div className="dd-grid">
      <aside className="dd-list" aria-label="任务列表">
        <div className="dd-list-head"><h2>任务</h2><button className="btn small primary" onClick={() => { pick(''); setCreating(true) }}>交代新任务</button></div>
        {desk.tasks.length === 0 && <p className="muted">还没有派过任务。</p>}
        <ul>
          {desk.tasks.map((t) => {
            const l = taskLabel(t)
            return <li key={t.id}><button className={`dd-task${t.id === selected ? ' is-selected' : ''}`} onClick={() => pick(t.id)}>
              <span className={`dd-dot tone-${l.tone}`} aria-hidden /><span className="dd-task-title">{t.title}</span>
              <span className="dd-task-meta">{t.repo_name} · {l.text}</span>
            </button></li>
          })}
        </ul>
        <section className="dd-projects">
          <div className="dd-list-head"><h3>可派活的项目</h3><button className="btn small" onClick={() => setManaging((v) => !v)}>{managing ? '完成' : '管理'}</button></div>
          {desk.projects.length === 0 && <p className="muted">还没有。先加一个项目，才能在它里面派活。</p>}
          {!managing && <p className="muted">{desk.projects.map((p) => p.name).join('、')}</p>}
          {managing && <ProjectManager desk={desk} onChange={(d) => { deskRef.current = d; setDesk(d) }} onError={setError} />}
        </section>
      </aside>
      <section className="dd-main">
        {creating || !task
          ? <NewTask desk={desk} disabled={busy || !owns} onCreate={async (b) => { const t = await act('/api/dispatch/tasks', b); if (t) pick(t.id); return !!t }} />
          : <TaskPanel t={task} desk={desk} busy={busy} owns={owns} act={act} />}
      </section>
    </div>
  </main>
}

function DeskHeader() {
  return <header className="dd-header"><a href="/?view=town&world=1">← 小镇</a><span>只在这台电脑上可用</span></header>
}

function NewTask({ desk, disabled, onCreate }: { desk: DispatchDeskState; disabled: boolean; onCreate: (b: object) => Promise<boolean> }) {
  const [repo, setRepo] = useState(0)
  const [title, setTitle] = useState('')
  const [prompt, setPrompt] = useState('')
  const [op, setOp] = useState(newKey)
  const repoId = repo || desk.projects[0]?.repo_id || 0
  return <form className="dd-card" onSubmit={async (e) => {
    e.preventDefault()
    // 同一次提交用同一个 operation：网络重试不会建两件任务。
    if (await onCreate({ operation: op, repo_id: repoId, title, prompt })) { setTitle(''); setPrompt(''); setOp(newKey()) }
  }}>
    <h2>交代新任务</h2>
    {desk.projects.length === 0 ? <p>先在左边“可派活的项目”里加一个项目。</p> : <>
      <label>在哪个项目<select value={repoId} onChange={(e) => setRepo(Number(e.target.value))}>{desk.projects.map((p) => <option key={p.repo_id} value={p.repo_id}>{p.name}</option>)}</select></label>
      <label>这件事叫什么<input value={title} onChange={(e) => setTitle(e.target.value)} maxLength={200} required placeholder="例如：修好设置页的保存按钮" /></label>
      <label>希望 Codex 做什么<textarea value={prompt} onChange={(e) => setPrompt(e.target.value)} maxLength={16000} required rows={6} placeholder="说清目标和边界。每件任务会新开一个分支和工作目录，不动你正在用的目录。" /></label>
      <div className="dd-actions"><button className="btn primary" disabled={disabled || !repoId}>在 {desk.host} 执行</button></div>
    </>}
  </form>
}

function TaskPanel({ t, desk, busy, owns, act }: { t: DispatchTask; desk: DispatchDeskState; busy: boolean; owns: boolean; act: (path: string, body: object) => Promise<DispatchTask | null> }) {
  const [prompt, setPrompt] = useState('')
  const [op, setOp] = useState(newKey)
  const base = `/api/dispatch/tasks/${encodeURIComponent(t.id)}`
  const off = busy || !owns
  return <>
    <TaskSummary t={t} host={desk.host} />
    {t.pending.map((p) => <ApprovalCard key={p.id} p={p} disabled={off} onDecide={(decision) => void act(`${base}/decide`, { approval: p.id, fingerprint: p.fingerprint, decision })} />)}
    {!t.desktop_handoff && <form className="dd-card" onSubmit={async (e) => { e.preventDefault(); if (await act(`${base}/start`, { operation: op, prompt })) { setPrompt(''); setOp(newKey()) } }}>
      <h3>交代下一步</h3>
      <label className="dd-hidden-label">下一步做什么<textarea value={prompt} onChange={(e) => setPrompt(e.target.value)} maxLength={16000} required rows={4} placeholder="在同一条 Codex 会话里接着做。" /></label>
      <div className="dd-actions">
        <button className="btn primary" disabled={off || !canStart(t)}>在 {desk.host} 执行</button>
        <button type="button" className="btn" disabled={off || !t.turn_id} onClick={() => void act(`${base}/interrupt`, {})}>停止本轮</button>
        {canResume(t) && <button type="button" className="btn" disabled={off} onClick={() => void act(`${base}/resume`, {})}>恢复同一条会话</button>}
      </div>
      <p className="muted">停止只中断这一轮，不算做完。{canResume(t) && '“恢复”只是重新连上原会话，不会重跑上一轮。'}</p>
    </form>}
    <section className="dd-card">
      <h3>最近发生的事</h3>
      <ol className="dd-events">{(t.events ?? []).slice(0, 12).map((e, i) => <li key={i}><span>{eventText(e)}</span><time>{clock(e.at)}</time></li>)}</ol>
      <p className="muted">只记发生了什么和时间；对话、命令和输出留在 Codex 里。</p>
    </section>
    <section className="dd-card dd-handoff">
      <h3>回电脑接着做</h3>
      <div className="dd-actions">
        <a className="btn" href={townHref(t.work_item_id)}>去小镇看这栋房子</a>
        {desk.desktop_handoff_enabled && !t.desktop_handoff && <button className="btn" disabled={off || !canHandoff(t)} onClick={() => void act(`${base}/handoff`, {})}>回电脑接着做</button>}
      </div>
      {!desk.desktop_handoff_enabled && <p className="muted">桌面 App 接手还在核对。</p>}
      {desk.desktop_handoff_enabled && !t.desktop_handoff && <p className="muted">等这一轮结束（或先停止），派活台放开这条会话，再在这台电脑的 Codex 桌面 App 里打开。</p>}
      {t.desktop_handoff && <>
        <p>派活台已放开这条会话，不会再往里写。</p>
        <a className="btn primary" href={desktopHref(t.thread_id)}>在 Codex 桌面 App 打开</a>
        <p className="muted">之后在 App 里继续，进展照常回到小镇这件工作上。</p>
      </>}
    </section>
  </>
}

function ProjectManager({ desk, onChange, onError }: { desk: DispatchDeskState; onChange: (d: DispatchDeskState) => void; onError: (m: string) => void }) {
  const [all, setAll] = useState<{ id: number; name: string; is_git: boolean; archived_at: string }[]>([])
  const [pick, setPick] = useState(0)
  useEffect(() => { req<typeof all>('/api/projects').then(setAll).catch((e) => onError((e as Error).message)) }, [onError])
  const added = new Set(desk.projects.map((p) => p.repo_id))
  const candidates = all.filter((p) => p.is_git && !p.archived_at && !added.has(p.id))
  const set = async (repo_id: number, allowed: boolean) => {
    try { onChange(await req<DispatchDeskState>('/api/dispatch/projects', { repo_id, allowed })) } catch (e) { onError((e as Error).message) }
  }
  return <div className="dd-manage">
    <ul>{desk.projects.map((p) => <li key={p.repo_id}><span>{p.name}</span><button className="btn small" onClick={() => void set(p.repo_id, false)}>移除</button></li>)}</ul>
    {candidates.length > 0 && <div className="dd-add">
      <select aria-label="选择要加入的项目" value={pick || candidates[0].id} onChange={(e) => setPick(Number(e.target.value))}>{candidates.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</select>
      <button className="btn small" onClick={() => void set(pick || candidates[0].id, true)}>加入</button>
    </div>}
    <p className="muted">只有这里加入的项目能派活。移除不影响已经开始的任务。</p>
  </div>
}
