import { isRemote, remoteReadOnlyMessage } from './access'
import { useState } from 'react'
import type { BriefKey, Snapshot, WorkItem } from './types'
import { api } from './api'
import { AgentBadge, ErrorLine, useAction } from './bits'
import { ago } from './model'
import { bindingLabel, outcomeLabel } from './Panels'
import { attemptsOf, briefKeys, briefLabel, relation, reportCommand, sourceDetail, sourceTag } from './brief'
import { shownNo } from './hub/ids'

// 简报：每条带来源、时间、出处；缺失就显示缺失。纠错操作可撤销（最近一次）。
export function BriefSection({ snap, item }: { snap: Snapshot; item: WorkItem }) {
  const act = useAction()
  const [editing, setEditing] = useState<BriefKey | null>(null)
  const [draft, setDraft] = useState('')
  const [undo, setUndo] = useState<{ field: BriefKey; entry: number; label: string } | null>(null)
  const [copied, setCopied] = useState(false)
  const readOnly = isRemote()
  const readOnlyHintId = `brief-read-only-${item.id}`
  const b = item.brief
  const edit = (field: BriefKey, action: 'set' | 'confirm' | 'flag', entry_id?: number, text?: string) =>
    act.run(() => api.editBrief(item.id, { field, action, entry_id, text }).then((r) => {
      setUndo({ field, entry: r.entry_id, label: { set: '已保存', confirm: '已确认', flag: '已标记有误' }[action] })
      setEditing(null)
    }))
  const copy = () => navigator.clipboard?.writeText(reportCommand(item.id)).then(() => { setCopied(true); window.setTimeout(() => setCopied(false), 2000) }).catch(() => {})
  const anyContent = briefKeys.some((k) => b?.fields?.[k]?.text)

  return (
    <section className="brief" aria-label="工作简报">
      <h3>工作简报 <small className="muted">每条都有来源与时间；缺失就显示缺失</small></h3>
      {readOnly && <p id={readOnlyHintId} className="hint">{remoteReadOnlyMessage}</p>}
      {b?.stale && <div className="warn-box">⏱ 最近进展回报之后，又有 {b.tool_events_since} 次工具调用{b.last_event_at ? `（最后 ${ago(b.last_event_at, snap.now)}）` : ''}，内容可能已过期。</div>}
      {!anyContent && <div className="empty-box">
        暂无内容回报。不会根据工具调用、Stop 或空闲时长生成进展。
        <div className="row wrap"><button className="btn small" onClick={copy}>{copied ? '已复制' : '复制“请回报进展”指令'}</button></div>
      </div>}
      {briefKeys.map((k) => {
        const f = b?.fields?.[k]
        const live = f && !f.flagged && f.text
        return (
          <div key={k} className={`brief-field ${live ? '' : 'missing'}`}>
            <div className="lab">{briefLabel[k]}</div>
            {editing === k ? (
              <form onSubmit={(e) => { e.preventDefault(); edit(k, 'set', f?.entry_id, draft) }}>
                <textarea rows={3} value={draft} onChange={(e) => setDraft(e.target.value)} maxLength={280} aria-label={`编辑${briefLabel[k]}`} autoFocus />
                <p className="hint">保存后标记为“你填写”。之后 Agent 的新回报不会覆盖它，只作为“新回报待对照”显示。留空保存表示清除。</p>
                <div className="row"><button className="btn small primary" disabled={isRemote() || act.busy}>保存</button><button type="button" className="btn small" onClick={() => setEditing(null)}>取消</button></div>
              </form>
            ) : live ? <>
              <div className="txt">{f.text}</div>
              <div className="meta">
                <span className={`src ${sourceTag(f).cls}`}>{sourceTag(f).mark} {sourceTag(f).label}</span>
                <span>{ago(f.at, snap.now)}</span><span>· {sourceDetail(f)}</span>
              </div>
              <div className="meta">
                {f.kind === 'agent' && <button className="link" disabled={readOnly || act.busy} aria-describedby={readOnly ? readOnlyHintId : undefined} onClick={() => edit(k, 'confirm', f.entry_id)}>确认无误</button>}
                <button disabled={isRemote()} className="link" onClick={() => { setDraft(f.text); setEditing(k) }}>更正</button>
                {f.kind === 'agent' && <button className="link" disabled={readOnly || act.busy} aria-describedby={readOnly ? readOnlyHintId : undefined} onClick={() => edit(k, 'flag', f.entry_id)}>标记有误</button>}
              </div>
              {f.pending && <div className="pending">
                <span className="src agent">✎ 新回报待对照</span> {f.pending.text} <small className="muted">{ago(f.pending.at, snap.now)} · {sourceDetail(f.pending)}</small>
                <div className="meta"><button className="link" disabled={readOnly || act.busy} aria-describedby={readOnly ? readOnlyHintId : undefined} onClick={() => edit(k, 'confirm', f.pending!.entry_id)}>采用这条</button></div>
              </div>}
            </> : <>
              <div className="txt">{f?.flagged ? '回报已被标记有误，等待新的回报' : `暂无${briefLabel[k]}回报`}</div>
              <div className="meta"><button disabled={isRemote()} className="link" onClick={() => { setDraft(''); setEditing(k) }}>由我补充</button></div>
            </>}
          </div>
        )
      })}
      {undo && <div className="undo-line">{briefLabel[undo.field]}：{undo.label}
        <button disabled={isRemote()} className="link" onClick={() => act.run(() => api.editBrief(item.id, { field: undo.field, action: 'undo', entry_id: undo.entry }).then(() => setUndo(null)))}>撤销</button></div>}
      <ErrorLine msg={act.error} />
    </section>
  )
}

export function RelayTimeline({ snap, item, onSelectSession, onOutcome }: { snap: Snapshot; item: WorkItem; onSelectSession: (id: number) => void; onOutcome: (runId: number, outcome: string) => void }) {
  const attempts = attemptsOf(snap, item.id)
  const sessions = new Map((snap.sessions ?? []).map((s) => [s.id, s]))
  const total = new Set(attempts.flatMap((a) => a.runs.map((r) => r.session_id))).size
  return (
    <section aria-label="执行接力">
      <h3>执行接力 <small className="muted">{attempts.length} 次尝试 · {total} 个会话</small></h3>
      {attempts.length === 0 && <p className="muted">还没有执行会话。Agent 运行 <code>steward-hook claim {item.id}</code>、在会话里提到 #{item.id}，或在归属面板确认后会出现在这里。</p>}
      <div className="timeline">
        {attempts.map((a, i) => (
          <div key={a.attempt} className={`attempt ${i === 0 ? 'current' : ''}`}>
            <b>第 {a.attempt} 次尝试</b> {a.runs.length > 1 && <small className="muted">{a.runs.length} 个会话</small>}
            {a.runs.map((r, j) => {
              const s = sessions.get(r.session_id)
              return (
                <div key={r.id}>
                  {j > 0 && <div className="relay">{relation(a.runs[j - 1], r) === 'relay' ? '↓ 接力（上一会话已结束）' : '∥ 并行'}</div>}
                  <button className="sess-row" onClick={() => onSelectSession(r.session_id)}>
                    <AgentBadge provider={r.provider} client={s?.client} />
                    <span>#{shownNo(r.session_id)}{s?.title ? ` · ${s.title}` : ''}<br />
                      <small className="muted">{bindingLabel[r.binding] ?? r.binding} · {ago(r.started_at, snap.now)}开始{r.ended_at ? ` · ${ago(r.ended_at, snap.now)}结束` : ''}</small></span>
                    <span className="pill">{r.ended_at ? (outcomeLabel[r.outcome] ?? r.outcome) : '进行中'}</span>
                  </button>
                  {r.ended_at && !r.outcome && (
                    <select disabled={isRemote()} className="outcome" aria-label={`补记会话 #${shownNo(r.session_id)} 的结果`} defaultValue="" onChange={(e) => e.target.value && onOutcome(r.id, e.target.value)}>
                      <option value="">补记结果…</option>
                      <option value="delivered">交付</option>
                      <option value="failed">失败</option>
                      <option value="abandoned">放弃</option>
                      <option value="handed_off">转交</option>
                    </select>
                  )}
                </div>
              )
            })}
          </div>
        ))}
      </div>
      {attempts.length > 0 && <p className="hint">会话结束与尝试结果分开记录；Stop 只表示本轮停下，不代表工作项完成。</p>}
    </section>
  )
}
