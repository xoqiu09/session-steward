import { useEffect, useState } from 'react'
import type { Session, Snapshot, WorkItem } from '../types'
import { api } from '../api'
import { isRemote } from '../access'
import { AgentBadge, CopyButton } from '../bits'
import { providerLabel, sessionStateLabel, sessionsFor } from '../model'
import { shownNo } from '../hub/ids'
import { HUB_STRIDE } from '../hub/ids'
import { conversationURL, processingSession } from './conversationModel'
import './conversation.css'

type Destination = { key: string; mode: 'app' | 'manual'; url?: string; reason?: string }

export function ConversationReturn({ snap, item, session, preferred }: { snap: Snapshot; item?: WorkItem; session?: Session; preferred?: number }) {
  const [chosen, setChosen] = useState<number | null>(null)
  const [destination, setDestination] = useState<Destination | null>(null)
  const [error, setError] = useState('')
  const candidates = item ? sessionsFor(snap, item.id) : session ? [session] : []
  const selected = candidates.find(s => s.id === chosen) ?? session ?? (item ? processingSession(snap, item, preferred) : null)
  const remote = isRemote() || (selected?.id ?? 0) >= HUB_STRIDE
  const selectedId = selected?.id
  const key = `${selectedId}:${selected?.provider}:${selected?.provider_session_id}:${selected?.client}`
  useEffect(() => {
    if (!selectedId || remote) return
    let current = true
    setError('')
    api.conversation(selectedId).then(result => {
      if (current) setDestination({ ...result, key })
    }).catch(() => { if (current) setError('暂时无法读取原会话入口。') })
    return () => { current = false }
  }, [selectedId, key, remote])
  if (!selected) return <section className="conversation-return" aria-label="回原会话处理"><strong>原会话尚未关联</strong><p>登记执行会话后，就能从这里回去处理。</p></section>
  const ready = destination?.key === key ? destination : null
  const link = ready?.mode === 'app' ? conversationURL(selected, ready.url) : null
  const provider = providerLabel(selected.provider)
  return <section className="conversation-return" aria-label="回原会话处理">
    <div className="conversation-return-head">
      <div><h3>回原会话处理</h3><p>在 Agent 里回复或处理，回到小镇后自动同步最新状态。</p></div>
      {link && !remote ? <a className="btn primary" href={link}>去 {provider} 处理 ↗</a>
        : !remote && !error && !ready ? <button className="btn primary" disabled>正在定位原会话…</button> : null}
    </div>
    <div className="conversation-return-meta">
      <AgentBadge provider={selected.provider} client={selected.client} />
      <span>会话 #{shownNo(selected.id)}</span><span>{sessionStateLabel[selected.state]}</span>
      {candidates.length > 1 && <label>切换会话 <select aria-label="选择处理会话" value={selected.id} onChange={e => setChosen(Number(e.target.value))}>
        {candidates.map(s => <option key={s.id} value={s.id}>{providerLabel(s.provider)} #{shownNo(s.id)} · {sessionStateLabel[s.state]}</option>)}
      </select></label>}
    </div>
    {remote ? <p className="hint">请在来源设备上打开原会话。</p> : <>
      {ready?.mode === 'manual' && <p className="hint">{ready.reason}</p>}
      {ready?.mode === 'app' && !link && <p className="hint">无法确认这条会话入口，可复制恢复命令继续处理。</p>}
      {error && <p className="error" role="status">{error}</p>}
      {(ready?.mode === 'manual' || (ready && !link) || error) && selected.resume_command && <CopyButton text={selected.resume_command} label="复制恢复命令" />}
    </>}
  </section>
}
