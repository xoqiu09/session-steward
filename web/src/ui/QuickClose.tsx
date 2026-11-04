import { useState } from 'react'
import { api } from '../api'
import { isRemote } from '../access'
import { ErrorLine, useAction } from '../bits'
import type { WorkItem } from '../types'

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
