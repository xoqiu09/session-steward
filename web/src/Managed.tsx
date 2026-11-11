import { useEffect, useRef, useState } from 'react'
import type { ManagedSession, Session, Snapshot } from './types'
import { api, ApiError } from './api'
import { AgentBadge, CopyButton, ErrorLine, useAction } from './bits'
import { ago, providerLabel } from './model'
import { managedStateLabel } from './live'
import { shownNo } from './hub/ids'
import { ProjectPicker } from './ui/ProjectPicker'
import { projectPath } from './ui/projectPickerModel'
import { ActionFeedback } from './ui/ActionFeedback'

// 新建托管会话：只能选服务配置里的 Agent，不能提交命令。
export function NewManaged({ snap, initialRepoId, onLaunched }: { snap: Snapshot; initialRepoId?: number; onLaunched: (m: ManagedSession, notice?: string) => void }) {
  const repos = (snap.repos ?? []).filter((r) => r.is_git)
  const agents = snap.agents ?? []
  const [repo, setRepo] = useState<number | null>(initialRepoId ?? null)
  const [agent, setAgent] = useState(agents[0] ?? '')
  const [title, setTitle] = useState('')
  const act = useAction()
  const launchGate = useRef(false)
  const [created, setCreated] = useState('')
  const selected = repos.find(r => r.id === repo)
  const validAgent = agents.includes(agent)
  // 从顶部切换项目范围时同步上下文；全局入口始终让用户明确选项目。
  useEffect(() => { if (!launchGate.current) setRepo(initialRepoId ?? null) }, [initialRepoId])
  if (snap.managed_unavailable) return <p className="hint">{snap.managed_unavailable}</p>
  if (!agents.length) return <p className="hint">本机服务未找到 tmux，暂时不能从面板启动托管会话；已有会话照常显示。</p>
  if (!repos.length) return <p className="hint">还没有已登记的 Git 项目。先在项目中运行一次 Agent，或让 Agent 用 begin 登记。</p>
  return <form className="new-item compact managed-new" aria-label="新建托管会话" aria-busy={act.busy} onSubmit={(e) => {
    e.preventDefault()
    if (launchGate.current || !selected || !validAgent || !title.trim()) return
    launchGate.current = true
    setCreated('')
    const input = { repo_id: selected.id, agent, title: title.trim() }
    return act.run(async () => {
      const m = await api.launchManaged(input)
      const notice = `已创建 ${m.work_item_id} · ${input.title} 的 ${providerLabel(input.agent)} 会话（${selected.name}）；执行状态请看会话画面。`
      setCreated(notice); setTitle('')
      onLaunched(m, notice)
    }).finally(() => { launchGate.current = false })
  }}>
    <fieldset className="workflow-fields" disabled={act.busy}>
    <div>项目<ProjectPicker repos={repos} value={selected?.id ?? null} onChange={next => { if (!launchGate.current && typeof next === 'number') setRepo(next) }} /></div>
    <label>Agent<select value={agent} onChange={(e) => { if (!launchGate.current) setAgent(e.target.value) }}>{agents.map((a) => <option key={a} value={a}>{providerLabel(a)}</option>)}</select></label>
    <label>任务标题<input value={title} onChange={(e) => { if (!launchGate.current) setTitle(e.target.value) }} required maxLength={200} placeholder="这次要做什么" /></label>
    <div className="managed-target" role="status">{selected ? <><strong>将在 {selected.name} 启动 · {providerLabel(agent)}</strong><code>{projectPath(selected)}</code></> : '请先选择这次工作的项目。'}</div>
    <p className="hint">在独立 worktree 和新分支 steward/… 中启动，自动登记工作项。启动后在 Agent 自己的界面里交代任务，或开启“接管输入”。</p>
    <button className="btn small primary" disabled={act.busy || !selected || !validAgent || !title.trim()}>{act.busy ? '启动中…' : '启动托管会话'}</button>
    </fieldset>
    {act.error && <ActionFeedback tone="error">创建会话未获确认，填写内容已保留。请先核对会话列表再决定是否重试。{act.error}</ActionFeedback>}
    {created && <ActionFeedback>{created}</ActionFeedback>}
  </form>
}

type Screen = { text: string; state: ManagedSession['state']; takeover: boolean; at: string }

export function useTerminal(id: string, enabled: boolean) {
  const [screen, setScreen] = useState<Screen | null>(null)
  const [conn, setConn] = useState<'connecting' | 'live' | 'offline'>('connecting')
  useEffect(() => {
    setScreen(null)
    setConn('connecting')
    if (!enabled || typeof EventSource === 'undefined') return
    const es = new EventSource(`/api/managed/${encodeURIComponent(id)}/terminal`)
    es.onopen = () => setConn('live')
    es.onerror = () => setConn('offline') // 浏览器自动重连；服务重启后仍可接上运行中的 tmux
    es.addEventListener('screen', (e) => { try { setScreen(JSON.parse((e as MessageEvent).data)) } catch { /* 忽略损坏帧 */ } })
    return () => es.close()
  }, [id, enabled])
  return { screen, conn }
}

export function ManagedPanel({ snap, m, session }: { snap: Snapshot; m: ManagedSession; session?: Session }) {
  const active = m.state === 'running' || m.state === 'starting'
  const { screen, conn } = useTerminal(m.id, active)
  const act = useAction()
  const [input, setInput] = useState('')
  const [inputStatus, setInputStatus] = useState<'ready' | 'sending' | 'sent' | 'text_unknown' | 'enter_unknown'>('ready')
  const inputGate = useRef<'ready' | 'sending' | 'check'>('ready')
  const needsInputCheck = inputStatus === 'text_unknown' || inputStatus === 'enter_unknown'
  const [dirty, setDirty] = useState<string[] | null>(null)
  const pre = useRef<HTMLPreElement>(null)
  // Snapshot is the authority for input permission; an older screen frame must not override it.
  const takeover = m.takeover
  // The service accepts text OR a key, so this is two acknowledged operations,
  // not one atomic command. Never offer an ordinary resend after an unknown result.
  const sendInput = () => {
    if (!input || act.busy || inputGate.current !== 'ready') return
    const draft = input
    inputGate.current = 'sending'; setInputStatus('sending')
    return act.run(async () => {
      let phase: 'text' | 'enter' = 'text'
      try {
        await api.sendInput(m.id, { text: draft })
        // This text is already in the terminal. It must not remain a retryable draft.
        setInput(current => current === draft ? '' : current)
        phase = 'enter'
        await api.sendInput(m.id, { key: 'Enter' })
        inputGate.current = 'ready'; setInputStatus('sent')
      } catch (error) {
        inputGate.current = 'check'; setInputStatus(phase === 'text' ? 'text_unknown' : 'enter_unknown')
        throw error
      }
    })
  }
  useEffect(() => { if (pre.current) pre.current.scrollTop = pre.current.scrollHeight }, [screen?.text])
  const archive = (force: boolean) => act.run(async () => {
    try {
      await api.archiveManaged(m.id, force)
      setDirty(null)
    } catch (e) {
      if (e instanceof ApiError && Array.isArray(e.data.dirty)) { setDirty(e.data.dirty as string[]); return }
      throw e
    }
  })
  return <section className="managed" aria-label={`托管会话 ${m.id}`}>
    <div className="managed-head">
      <span className="pill managed-tag">托管</span>
      <AgentBadge provider={m.agent} />
      <span className={`pill ms-${m.state}`}>{managedStateLabel[m.state]}</span>
      {active && <span className={`conn conn-${conn}`}>{conn === 'live' ? '画面实时' : conn === 'offline' ? '重连中' : '连接中'}</span>}
      <span className="muted right">{ago(m.created_at, snap.now)}启动</span>
    </div>
    <dl className="kv">
      <dt>分支</dt><dd className="mono">{m.branch}</dd>
      <dt>目录</dt><dd className="mono">{m.worktree}</dd>
      <dt>hooks</dt><dd>{session ? `已关联会话 #${shownNo(session.id)}` : m.session_id ? `会话 #${shownNo(m.session_id)}` : (snap.agent_info ?? []).find((a) => a.name === m.agent)?.hooks === false ? '该 Agent 不发 hooks 事件，只有终端画面；进展需看画面或手动更新简报' : '尚未收到该目录的 hooks 事件'}</dd>
      {m.exit_code != null && <><dt>退出码</dt><dd>{m.exit_code}</dd></>}
    </dl>
    {m.error && <p className="warn-line">{m.error}</p>}
    {active ? <>
      <pre ref={pre} className="terminal" aria-label="终端画面（只读）" aria-live="off" tabIndex={0}>{screen ? screen.text.replace(/\s+$/, '') || '（空白画面）' : '正在连接终端…'}</pre>
      <p className="hint">画面每半秒刷新；{takeover ? '已接管输入，输入会写入审计（只记长度，不记内容）。' : '默认只读，不会向会话发送任何按键。'}</p>
      <div className="row wrap">
        <label className="check"><input type="checkbox" checked={takeover} disabled={act.busy} onChange={(e) => act.run(() => api.takeover(m.id, e.target.checked))} /> 接管输入</label>
        <button className="btn small" disabled={act.busy} onClick={() => { if (window.confirm('停止会结束该 tmux 会话中的 Agent 进程。工作项状态不变，worktree 保留。继续？')) act.run(() => api.stopManaged(m.id)) }}>停止会话</button>
      </div>
      {takeover && <>
        <form className="row terminal-input" aria-label="向托管会话发送输入" onSubmit={(e) => { e.preventDefault(); return sendInput() }}>
          <input value={input} readOnly={act.busy || needsInputCheck} onChange={(e) => {
            if (act.busy || inputGate.current !== 'ready') return
            setInput(e.target.value); if (inputStatus === 'sent') setInputStatus('ready')
          }} placeholder="输入后回车发送到终端" aria-label="终端输入" maxLength={4096} />
          <button className="btn small primary" disabled={act.busy || needsInputCheck || !input}>{inputStatus === 'sending' ? '发送中…' : '发送'}</button>
          {(['Escape', 'C-c', 'Up', 'Down', 'Enter'] as const).map((k) => <button type="button" key={k} className="btn tiny" disabled={act.busy || needsInputCheck && k === 'Enter'} onClick={() => act.run(() => api.sendInput(m.id, { key: k }))}>{k === 'C-c' ? 'Ctrl-C' : k === 'Escape' ? 'Esc' : k === 'Up' ? '↑' : k === 'Down' ? '↓' : '回车'}</button>)}
        </form>
        {inputStatus === 'sent' && <p className="hint" role="status">文字和回车已送到终端；执行结果请看上方画面。</p>}
        {needsInputCheck && <div className="warn-line" role="status">
          <p>{inputStatus === 'enter_unknown' ? '文字已写入终端，但回车是否生效还未确认。' : '尚未确认文字是否写入终端。'}请先核对上方终端画面，不要重复发送整段内容。</p>
          <p>确认仍未提交时，可以在核对后单独点“回车”。继续输入会清空这次待核对内容。</p>
          <div className="row wrap">{input && <CopyButton text={input} label="复制待核对内容" />}
            <button type="button" className="btn small" disabled={act.busy} onClick={() => {
              if (act.busy || inputGate.current !== 'check') return
              setInput(''); inputGate.current = 'ready'; setInputStatus('ready'); act.setError('')
            }}>我已核对终端，继续输入</button>
          </div>
        </div>}
      </>}
    </> : m.state !== 'archived' && <div className="managed-ended">
      <p className="hint">会话已不在运行。退出或停止不代表工作完成；分支 {m.branch} 与提交保留。归档只移除 worktree 目录。</p>
      {dirty ? <div className="warn-line"><p>worktree 有 {dirty.length} 处未提交改动，归档会丢弃它们：</p><pre className="preview">{dirty.slice(0, 10).join('\n')}{dirty.length > 10 ? '\n…' : ''}</pre>
        <div className="row"><button className="btn small danger" disabled={act.busy} onClick={() => archive(true)}>确认丢弃改动并归档</button><button className="btn small" onClick={() => setDirty(null)}>取消</button></div></div>
        : <button className="btn small" disabled={act.busy} onClick={() => archive(false)}>归档（移除 worktree）</button>}
    </div>}
    <ErrorLine msg={act.error} />
  </section>
}

export function Unmanaged() {
  return <p className="hint unmanaged">未托管，无画面：这个会话不是从面板启动的，Steward 只能看到 hooks 事件，不能显示或操作它的终端。</p>
}
