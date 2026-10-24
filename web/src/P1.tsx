import { useState } from 'react'
import type { Approval, MergeJob, Snapshot, Tokens, WorkItem } from './types'
import { api } from './api'
import { ErrorLine, useAction } from './bits'
import { ago, providerLabel } from './model'
import { isRemote } from './access'

export const jobStateLabel: Record<MergeJob['state'], string> = {
  queued: '排队中', running: '检查中', passed: '检查通过，正在合并', failed: '检查未通过', merged: '已合并到本地目标分支', aborted: '已中止，未合并',
}

export const latestJob = (snap: Snapshot, approvalId: string) => (snap.merge_jobs ?? []).find((j) => j.approval_id === approvalId)

// 检查门：只在仓库配置了检查命令时提供；结果来自服务实际运行的命令，不是 Agent 自述。
export function MergeGate({ snap, a }: { snap: Snapshot; a: Approval }) {
  const act = useAction()
  const job = latestJob(snap, a.id)
  const configured = a.repo_id != null && (snap.checked_repos ?? []).includes(a.repo_id)
  const busy = job && ['queued', 'running', 'passed'].includes(job.state)
  if (!configured && !job) return <p className="hint">该仓库未配置检查命令，不能自动合并；可复制合并指令手动执行。</p>
  return <div className="merge-gate">
    {job && <div className={`gate gate-${job.state}`}>
      <strong>检查门：{jobStateLabel[job.state]}</strong> <small className="muted">{ago(job.updated_at, snap.now)}</small>
      {job.error && <p className="warn-line">{job.error}</p>}
      {(job.checks ?? []).map((c, i) => <details key={i} open={c.exit_code !== 0}>
        <summary><span className={c.exit_code === 0 ? 'ok' : 'wait'}>{c.exit_code === 0 ? '✓' : '✗'}</span> <code>{c.argv.join(' ')}</code> · 退出码 {c.exit_code} · {c.seconds.toFixed(1)}s</summary>
        {c.tail && <pre className="preview">{c.tail}</pre>}
      </details>)}
      {job.state === 'merged' && <p className="hint">本地目标分支已更新；“已合并”以 Git 扫描为准。推送远程仍需你决定。</p>}
    </div>}
    {!isRemote() && configured && a.status === 'decided' && !busy && <button className="btn small primary" disabled={act.busy} onClick={() => act.run(() => api.checkedMerge(a.id))}>{job ? '重新运行检查并合并' : '运行检查并合并'}</button>}
    <ErrorLine msg={act.error} />
  </div>
}

const fmt = (n: number) => n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}k` : String(n)
export function TokenLine({ t }: { t: Tokens }) {
  return <span className="tokens">输入 {fmt(t.input)} · 输出 {fmt(t.output)}{t.cache_read ? ` · 缓存读 ${fmt(t.cache_read)}` : ''}{t.cache_write ? ` · 缓存写 ${fmt(t.cache_write)}` : ''}</span>
}

export function ItemUsageLine({ snap, id }: { snap: Snapshot; id: string }) {
  const u = (snap.item_usage ?? []).find((x) => x.work_item_id === id)
  if (!u) return null
  return <p className="usage-line"><b>用量</b> <TokenLine t={u} /> <small className="muted">（{u.sessions} 个会话，来自本机 transcript 的计数{u.shared ? `；其中 ${u.shared} 个会话也做过其他工作项，用量会重复计入` : ''}）</small></p>
}

export function SessionUsageLine({ snap, id }: { snap: Snapshot; id: number }) {
  const u = (snap.session_usage ?? []).find((x) => x.session_id === id)
  if (!u) return null
  return <p className="usage-line"><b>用量</b> <TokenLine t={u} /> <small className="muted">{ago(u.updated_at, snap.now)}更新</small></p>
}

// 跨 Agent 交接：预览交接包，确认后在新 worktree 中启动接手 Agent。来源会话不会被停止。
export function HandoffForm({ snap, item, onLaunched }: { snap: Snapshot; item: WorkItem; onLaunched: (sessionWorkItem: string) => void }) {
  const agents = snap.agent_info ?? []
  const current = new Set(item.agents)
  const [to, setTo] = useState(agents.find((a) => !current.has(a.provider))?.name ?? agents[0]?.name ?? '')
  const [note, setNote] = useState('')
  const [preview, setPreview] = useState<{package: string; source_sha: string; itemId: string} | null>(null)
  const act = useAction()
  const visiblePreview = preview?.itemId === item.id ? preview : null
  if (!agents.length || item.repo_id == null || ['done', 'abandoned'].includes(item.status)) return null
  return <details className="handoff">
    <summary>交接给其他 Agent</summary>
    <p className="hint">根据简报、功能清单和 Git 记录生成交接包（不含对话正文），在新的 worktree 中从当前分支启动接手 Agent。上一位会话不会被停止，未提交改动不会带过去。</p>
    <div className="row wrap">
      <label>接手<select value={to} onChange={(e) => { setTo(e.target.value); setPreview(null) }}>{agents.map((a) => <option key={a.name} value={a.name}>{providerLabel(a.provider)}{a.name !== a.provider ? ` (${a.name})` : ''}{a.hooks ? '' : ' · 无 hooks'}</option>)}</select></label>
      <label className="grow">补充说明<input value={note} onChange={(e) => { setNote(e.target.value); setPreview(null) }} maxLength={2000} placeholder="可选：给接手方的提醒" /></label>
    </div>
    <div className="row">
      <button className="btn small" disabled={act.busy || !to} onClick={() => act.run(() => api.handoffPreview(item.id, { to_agent: to, note }).then((r) => setPreview({...r, itemId:item.id})))}>预览交接包</button>
      {visiblePreview != null && <button className="btn small primary" disabled={act.busy} onClick={() => act.run(() => api.handoff(item.id, { to_agent: to, note, source_sha: visiblePreview.source_sha }).then((r) => { setPreview(null); onLaunched(r.managed.work_item_id) }))}>确认交接并启动</button>}
    </div>
    {visiblePreview != null && <pre className="preview handoff-preview">{visiblePreview.package}</pre>}
    <ErrorLine msg={act.error} />
  </details>
}
