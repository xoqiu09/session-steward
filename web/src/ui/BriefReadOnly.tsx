import type { Snapshot, WorkItem } from '../types'
import { ago } from '../model'
import { briefKeys, briefLabel, sourceDetail, sourceTag } from '../brief'

// 远程只读模式下的简报：只展示字段、来源与时间，不渲染任何纠错入口。
export function BriefReadOnly({ snap, item }: { snap: Snapshot; item: WorkItem }) {
  const b = item.brief
  return (
    <dl className="rd-brief">
      {briefKeys.map((k) => {
        const f = b?.fields?.[k]
        const live = f && !f.flagged && f.text
        return (
          <div key={k}>
            <dt>{briefLabel[k]}</dt>
            {live ? <dd>
              <p>{f.text}</p>
              <small>{sourceTag(f).mark} {sourceTag(f).label} · {ago(f.at, snap.now)} · {sourceDetail(f)}</small>
              {f.pending && <div className="rd-note"><p>另有新回报待比对：{f.pending.text}</p><small>{sourceDetail(f.pending)} · {ago(f.pending.at, snap.now)}</small></div>}
            </dd> : <dd className="rd-missing">{f?.flagged ? '回报已被标记有误，等待新的回报' : `暂无${briefLabel[k]}回报`}</dd>}
          </div>
        )
      })}
    </dl>
  )
}
