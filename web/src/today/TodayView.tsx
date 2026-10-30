import { useMemo, useState } from 'react'
import type { MergePayload, Snapshot } from '../types'
import { api } from '../api'
import { isRemote, remoteReadOnlyMessage } from '../access'
import { AgentBadge, CopyButton, ErrorLine, useAction } from '../bits'
import { ago, providerLabel } from '../model'
import { MergeCard } from '../Queue'
import { WorkStatusActions } from '../ui/WorkStatusActions'
import { managementLabel } from '../workManagement'
import { buildToday, type DecideRow, type Grade, type ReviewRow, type StuckRow } from './todayModel'
import './today.css'

// 上次点“都看过了”的时间只存在这台浏览器里：只用来标“新”，不影响任何状态。
const SEEN_KEY = 'steward.today.seen'
function readSeen(): string {
  try { return localStorage.getItem(SEEN_KEY) ?? '' } catch { return '' }
}
function writeSeen(at: string) {
  try { localStorage.setItem(SEEN_KEY, at) } catch { /* 无痕窗口等：不记也能用 */ }
}

function clock(ts: string, now: string): string {
  if (!ts) return ''
  const d = new Date(ts)
  const today = new Date(now).toDateString() === d.toDateString()
  const yesterday = new Date(Date.parse(now) - 86_400_000).toDateString() === d.toDateString()
  const hm = d.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false })
  return today ? `今天 ${hm}` : yesterday ? `昨天 ${hm}` : `${d.getMonth() + 1} 月 ${d.getDate()} 日 ${hm}`
}

function waited(ts: string, now: string): string {
  const a = ago(ts, now)
  return a === '刚刚' ? '不到 1 分钟' : a.replace(/前$/, '')
}

export function TodayView({ snap, onSelectItem, onOpenTown, device }: { snap: Snapshot; onSelectItem: (id: string) => void; onOpenTown: () => void; device?: string }) {
  const [seen, setSeen] = useState(readSeen)
  const t = useMemo(() => buildToday(snap, seen), [snap, seen])
  const ok = t.review.filter((r) => r.grade === 'ok').length
  const userNext = t.stuck.filter((s) => s.tone === 'user').length
  const stuckItems = new Set(t.stuck.map(row => row.item.id)).size
  const empty = !t.decide.length && !t.review.length && !t.stuck.length
  const markSeen = () => { writeSeen(snap.now); setSeen(snap.now) }
  return (
    <div className="today">
      <div className="today-inner">
        <header className="today-head">
          <div>
            <h1>每日十分钟</h1>
            <p className="muted">{seen ? `上次看过：${clock(seen, snap.now)} · 之后的新交付标了“新”` : '第一次打开：看完点“都看过了”，下次就能看出哪些是新的'}</p>
          </div>
          <div className="today-head-acts">
            <button className="btn" type="button" onClick={onOpenTown}>打开小镇</button>
            <button className="btn primary" type="button" onClick={markSeen}>都看过了</button>
          </div>
        </header>
        {device != null && <p className="today-note">这一页只列本机{device ? `（${device}）` : ''}的工作。其他电脑上的，请在那台电脑上打开“每日十分钟”处理。</p>}
        {isRemote() && <p className="today-note">{remoteReadOnlyMessage}</p>}

        <nav className="today-stats" aria-label="四件事">
          <a href="#today-decide"><span>要你决定</span><b className="is-decide">{t.decide.length}</b><small>{t.decide.length ? 'Agent 停着等你' : '没有'}</small></a>
          <a href="#today-review"><span>做完了，等你验收</span><b className="is-review">{t.review.length}</b><small>{t.review.length ? `有可核对证据的 ${ok} 件` : '没有'}</small></a>
          <a href="#today-stuck"><span>卡住了</span><b className="is-stuck">{stuckItems}</b><small>{userNext ? `${userNext} 件下一步在你` : t.stuck.length ? '在等上游或外部' : '没有'}</small></a>
          <a href="#today-quiet"><span>正在做</span><b className="is-run">{t.running.length}</b><small>不用管</small></a>
        </nav>

        {empty && <section className="today-empty"><h2>没有要你处理的事</h2><p className="muted">没有等你决定的请求，没有等你验收的交付，也没有卡住的工作。</p></section>}

        {t.decide.length > 0 && <section id="today-decide" className="today-card">
          <h2><i className="dot is-decide" />要你决定 <small>{t.decide.length} · Agent 停着等你，先处理这里</small></h2>
          {t.decide.map((d) => <DecideLine key={d.key} d={d} snap={snap} onSelectItem={onSelectItem} />)}
        </section>}

        {t.review.length > 0 && <section id="today-review" className="today-card">
          <h2><i className="dot is-review" />做完了，等你验收 <small>{t.review.length} · 有可核对证据的排在前面</small></h2>
          {t.review.map((r) => <ReviewLine key={r.item.id} r={r} snap={snap} onSelectItem={onSelectItem} />)}
        </section>}

        {t.stuck.length > 0 && <section id="today-stuck" className="today-card">
          <h2><i className="dot is-stuck" />卡住了 <small>{stuckItems} 项 · 卡点、信息缺口、下一步</small></h2>
          {t.stuck.map((s) => <StuckLine key={`${s.item.id}:${s.label}`} s={s} snap={snap} onSelectItem={onSelectItem} />)}
        </section>}

        {t.managed.length > 0 && <details className="today-managed"><summary>已转交或暂停提醒 {t.managed.length} 件 · 展开管理 / 恢复</summary>
          {t.managed.map(w => <div key={w.id} className="today-row"><div className="today-body">
            <Title id={w.id} title={w.title} onSelectItem={onSelectItem} tag={<span className="tag is-muted">{managementLabel(w)}</span>} />
            {w.management?.note && <p>{w.management.note}</p>}
            <span className="today-meta">你的记录 · {ago(w.management?.at || w.updated_at, snap.now)}</span>
          </div><div className="today-acts"><WorkStatusActions item={w} /><button className="btn" onClick={() => onSelectItem(w.id)}>看详情</button></div></div>)}
        </details>}

        <section id="today-quiet" className="today-quiet">
          <details><summary>正在顺利进行 {t.running.length} 件</summary>
            <ul>{t.running.map((w) => <li key={w.id}><button type="button" className="linkish" onClick={() => onSelectItem(w.id)}><span className="mono">{w.id}</span> {w.title}</button></li>)}</ul>
          </details>
          <details><summary>{seen ? '上次看过以来' : '最近一天'}验收过 {t.acceptedSince.length} 件</summary>
            <ul>{t.acceptedSince.map((w) => <li key={w.id}><button type="button" className="linkish" onClick={() => onSelectItem(w.id)}><span className="mono">{w.id}</span> {w.title}</button></li>)}</ul>
          </details>
          <p>另有 {t.unregistered} 个会话没有登记任务，不算进上面的数字。</p>
        </section>
      </div>
    </div>
  )
}

function Title({ id, title, onSelectItem, tag }: { id?: string; title: string; onSelectItem: (id: string) => void; tag?: React.ReactNode }) {
  return <div className="today-title">
    {id && <span className="mono muted">{id}</span>}
    {id ? <button type="button" className="linkish strong" onClick={() => onSelectItem(id)}>{title}</button> : <b>{title}</b>}
    {tag}
  </div>
}

function DecideLine({ d, snap, onSelectItem }: { d: DecideRow; snap: Snapshot; onSelectItem: (id: string) => void }) {
  const act = useAction()
  const remote = isRemote()
  const item = d.kind === 'handoff' ? d.item : d.itemId ? snap.work_items?.find((w) => w.id === d.itemId) : undefined
  if (d.kind === 'permission' || d.kind === 'decision') {
    const a = d.approval
    const s = snap.sessions?.find((x) => x.id === a.session_id)
    const left = a.deadline ? Math.max(0, Math.round((Date.parse(a.deadline) - Date.parse(snap.now)) / 60000)) : null
    return <div className="today-row">
      <div className="today-body">
        <Title id={item?.id} title={item?.title || (d.kind === 'permission' ? `${s ? providerLabel(s.provider) : 'Agent'} 想运行一条命令` : 'Agent 提了一个问题')} onSelectItem={onSelectItem}
          tag={<span className="tag is-decide">{d.kind === 'permission' ? '工具权限' : 'Agent 提问'}</span>} />
        {d.kind === 'permission' ? <code className="today-cmd">{a.preview || a.tool_name || '权限请求'}</code> : <p>{a.preview}</p>}
        <span className="today-meta">{s && <AgentBadge provider={s.provider} />} {d.repo} · 等了 {waited(a.created_at, snap.now)}{d.kind === 'permission' && left != null ? `，再过 ${left} 分钟交回原会话审批` : ''}</span>
        <ErrorLine msg={act.error} />
      </div>
      <div className="today-acts">
        {d.kind === 'permission' && a.handleable && <>
          <button className="btn" type="button" disabled={remote || act.busy} onClick={() => act.run(() => api.decide(a.id, a.fingerprint, 'deny'))}>拒绝</button>
          <button className="btn primary" type="button" disabled={remote || act.busy} onClick={() => act.run(() => api.decide(a.id, a.fingerprint, 'allow'))}>允许这一次</button>
        </>}
        {d.kind === 'permission' && !a.handleable && <>
          <span className="muted small">只能回原界面批准</span>
          <button className="btn" type="button" disabled={remote || act.busy} onClick={() => act.run(() => api.dismiss(a.id, 'handled_elsewhere'))}>已处理</button>
        </>}
        {d.kind === 'decision' && <>
          {s?.resume_command && <CopyButton text={s.resume_command} label="复制恢复命令，回原会话回答" />}
          <button className="btn" type="button" disabled={remote || act.busy} onClick={() => act.run(() => api.dismiss(a.id, 'resolved'))}>已回答</button>
        </>}
      </div>
    </div>
  }
  if (d.kind === 'merge') {
    const p = d.group.primary.payload as unknown as MergePayload
    return <div className="today-row">
      <div className="today-body">
        <Title id={item?.id} title={item?.title || '合并请求'} onSelectItem={onSelectItem} tag={<span className="tag is-decide">合并审批</span>} />
        <span className="today-meta">{d.repo} · 等了 {waited(d.at, snap.now)}{d.group.workItemIds.length > 1 ? ` · 涉及 ${d.group.workItemIds.length} 个工作项` : ''}</span>
        <details className="today-merge"><summary><span className="mono">{p.source_ref} → {p.target_ref}</span> · {p.ahead} 个提交 <span className="muted">展开看提交并批准</span></summary>
          <MergeCard group={d.group} snap={snap} onSelectItem={onSelectItem} advice={[]} /></details>
      </div>
    </div>
  }
  return <div className="today-row">
    <div className="today-body">
      <Title id={d.item.id} title={d.item.title} onSelectItem={onSelectItem} tag={<span className="tag is-decide">交给你了</span>} />
      {d.blocker && <p><span className="muted">卡在：</span>{d.blocker}</p>}
      <p><span className="muted">需要你：</span>{d.need}</p>
      <span className="today-meta">{d.repo} · Agent 自述 · {ago(d.at, snap.now)}</span>
    </div>
    <div className="today-acts"><WorkStatusActions item={d.item} /><button className="btn" type="button" onClick={() => onSelectItem(d.item.id)}>看详情</button></div>
  </div>
}

const gradeTag: Record<Grade, [string, string]> = {
  ok: ['有可核对的证据', 'is-ok'],
  missing: ['缺证据', 'is-warn'],
  failed: ['有验证失败', 'is-bad'],
}

function ReviewLine({ r, snap, onSelectItem }: { r: ReviewRow; snap: Snapshot; onSelectItem: (id: string) => void }) {
  const act = useAction()
  const remote = isRemote()
  const set = (status: 'done' | 'in_progress') => act.run(() => api.patchItem(r.item.id, { status }))
  const [label, cls] = gradeTag[r.grade]
  return <div className="today-row">
    <div className="today-body">
      <Title id={r.item.id} title={r.item.title} onSelectItem={onSelectItem} tag={<>{r.fresh && <span className="tag is-new">新</span>}<span className={`tag ${cls}`}>{label}</span></>} />
      <p><span className="muted">Agent 说：</span>{r.said?.text || <span className="muted">交付时没有写结论</span>}</p>
      <div className="today-evidence"><span className="muted small">证据</span>
        {r.evidence.length ? r.evidence.map((e, i) => <span key={i} className={`chip is-${e.tone}`} title={e.detail || undefined}>{e.label}</span>)
          : <span className="small is-warn-text">没附验证结果，也没有分支或合并记录，只有 Agent 自述</span>}
      </div>
      {r.merge && <details className="today-merge"><summary><span className="tag is-decide">合并待你批准</span> <span className="mono">{(r.merge.primary.payload as unknown as MergePayload).source_ref} → {(r.merge.primary.payload as unknown as MergePayload).target_ref}</span> <span className="muted">展开看提交并批准；批准合并和验收分开记录</span></summary>
        <MergeCard group={r.merge} snap={snap} onSelectItem={onSelectItem} advice={[]} /></details>}
      <span className="today-meta">{r.repo} · {r.item.agents.map(providerLabel).join(' · ') || 'Agent'} · {clock(r.at, snap.now)} 交付</span>
      <ErrorLine msg={act.error} />
    </div>
    {remote ? <div className="today-acts"><span className="muted small">远程只读</span></div> : <div className="today-acts">
      <WorkStatusActions item={r.item} />
      <button className="btn" type="button" onClick={() => onSelectItem(r.item.id)}>详情</button>
      <button className={r.grade === 'failed' ? 'btn primary' : 'btn'} type="button" disabled={act.busy} onClick={() => set('in_progress')}>退回</button>
      <button className={r.grade === 'failed' ? 'btn' : 'btn primary'} type="button" disabled={act.busy} onClick={() => set('done')}>验收</button>
    </div>}
  </div>
}

function StuckLine({ s, snap, onSelectItem }: { s: StuckRow; snap: Snapshot; onSelectItem: (id: string) => void }) {
  return <div className="today-row">
    <div className="today-body">
      <Title id={s.item.id} title={s.item.title} onSelectItem={onSelectItem} tag={<span className={`tag is-${s.tone}`}>{s.label}</span>} />
      <p><span className="muted">{s.label === '没有信号' ? '信息缺口：' : '卡在：'}</span>{s.reason}{s.upstreamInReview && <> <a href="#today-review">{s.upstreamInReview} 就在上面等你验收</a></>}</p>
      {s.next && <p><span className="muted">下一步：</span>{s.next}</p>}
      <span className="today-meta">{s.repo} · {ago(s.at, snap.now)}</span>
    </div>
    <div className="today-acts"><WorkStatusActions item={s.item} /><button className="btn" type="button" onClick={() => onSelectItem(s.item.id)}>看详情</button></div>
  </div>
}
