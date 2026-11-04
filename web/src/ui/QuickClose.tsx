import { useState } from 'react'
import { api } from '../api'
import { isRemote } from '../access'
import { ErrorLine, useAction } from '../bits'
import type { WorkItem } from '../types'
import { deliveredAt, STALE_REVIEW_MS } from '../workManagement'

// 卡片上统一的收起方式。每一种都要再点一次确认；这些都是你本人的选择，不会由 Agent 代做。
type Close = 'accepted' | 'paused' | 'abandoned'
const closes: Record<Close, { label: string; confirm: string; help: string }> = {
  accepted: { label: '已处理', confirm: '确认已处理', help: '你确认这件事已经处理完，收进已处理；交付与来源记录保留。' },
  paused: { label: '暂停提醒', confirm: '确认暂停', help: '保留进度，收起日常催办；随时可以在详情里继续处理。' },
  abandoned: { label: '不再跟进', confirm: '确认不再跟进', help: '标为放弃，退出所有待办列表；记录保留，之后仍可重新打开。' },
}

export function QuickClose({ item, only }: { item: WorkItem; only?: Close[] }) {
  const [pending, setPending] = useState<Close | null>(null)
  const act = useAction()
  if (isRemote() || item.status === 'done' || item.status === 'abandoned') return null
  const shown = (only ?? (Object.keys(closes) as Close[])).filter(c => c !== 'paused' || item.management?.state !== 'paused')
  const apply = (c: Close) => act.run(async () => {
    await api.patchItem(item.id, c === 'abandoned' ? { status: 'abandoned' } : { management: { state: c, owner: '', note: '' } })
    setPending(null)
  })
  return <div className="quick-close" role="group" aria-label={`收起 ${item.id}`}>
    {pending ? <>
      <span className="hint">{closes[pending].help}</span>
      <button type="button" className="btn small primary" disabled={act.busy} onClick={() => apply(pending)}>{act.busy ? '保存中…' : closes[pending].confirm}</button>
      <button type="button" className="btn small" disabled={act.busy} onClick={() => { setPending(null); act.setError('') }}>取消</button>
    </> : shown.map(c => <button key={c} type="button" className="btn small" title={closes[c].help} onClick={() => setPending(c)}>{closes[c].label}</button>)}
    <ErrorLine msg={act.error} />
  </div>
}

/** 交付超过 7 天还没处理的待验收。 */
export function staleDeliveries(items: readonly WorkItem[], now: string): WorkItem[] {
  const n = Date.parse(now) || Date.now()
  return items.filter(w => w.status === 'review' && w.management?.state !== 'paused' && n - (Date.parse(deliveredAt(w)) || n) >= STALE_REVIEW_MS)
}

/** 一次把超过 7 天的待验收都暂停提醒：确认一次，逐项提交；进度和记录都保留。 */
export function PauseStale({ items }: { items: readonly WorkItem[] }) {
  const [asking, setAsking] = useState(false)
  const act = useAction()
  if (isRemote() || items.length === 0) return null
  return <div className="pause-stale" role="group" aria-label="超过 7 天的待验收">
    {asking ? <>
      <span className="hint">把 {items.length} 件超过 7 天的待验收都暂停提醒？进度和交付记录保留，随时可以继续处理。</span>
      <button type="button" className="btn small primary" disabled={act.busy} onClick={() => act.run(async () => {
        for (const w of items) await api.patchItem(w.id, { management: { state: 'paused', owner: '', note: '交付超过 7 天，批量暂停提醒' } })
        setAsking(false)
      })}>{act.busy ? '保存中…' : '确认暂停'}</button>
      <button type="button" className="btn small" disabled={act.busy} onClick={() => setAsking(false)}>取消</button>
    </> : <><span className="hint">其中 {items.length} 件交付已超过 7 天。</span><button type="button" className="btn small" onClick={() => setAsking(true)}>全部暂停提醒</button></>}
    <ErrorLine msg={act.error} />
  </div>
}

