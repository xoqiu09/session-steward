import type { ReactNode } from 'react'
import type { Snapshot, WorkItem } from '../types'
import { ago } from '../model'
import { reviewGuide } from './runDeskModel'

// 待验收卡片：先说 Agent 交付了什么、东西在哪、按什么判断，再给通过 / 退回。
// 交付说明是 Agent 自述，不是测试或你的验收结论。
export function DeliveryReview({ snap, item, onSelectSession, actions }: { snap: Snapshot; item: WorkItem; onSelectSession: (id: number) => void; actions: ReactNode }) {
  const g = reviewGuide(snap, item)
  return (
    <section className="delivery-review" aria-label="交付验收">
      <h3>这项交付待你验收</h3>
      <dl className="review-facts">
        <dt>Agent 说交付了</dt>
        <dd>
          {g.said ? <>{g.said.text}<small className="muted"> · Agent 自述{g.said.sessionId != null ? `，会话 #${g.said.sessionId}` : ''}，{ago(g.said.at, snap.now)}</small></>
            : <span className="muted">Agent 没有写交付说明。可以点下面的会话，复制恢复命令回去问它做了什么。</span>}
        </dd>
        {g.progress && <><dt>做到哪</dt><dd>{g.progress}</dd></>}
        <dt>东西在哪</dt>
        <dd>{g.branch ? <>分支 <code>{g.branch}</code></> : <span className="muted">没有回报分支或提交</span>}</dd>
        <dt>验收标准</dt>
        <dd>{g.acceptance ? <span className="pre">{g.acceptance}</span> : <span className="muted">没有写验收条件：按你当初的要求判断是否满意。</span>}</dd>
      </dl>
      <ol className="review-steps">
        <li>读上面的交付说明，对照验收标准。</li>
        <li>需要时去看效果：切到上面的分支，或打开对应的会话问 Agent{g.sessionIds.length ? <>（{g.sessionIds.map((id, i) => <span key={id}>{i ? '、' : ''}<button type="button" className="linkish" onClick={() => onSelectSession(id)}>#{id}</button></span>)}）</> : null}。</li>
        <li>满意点“验收通过”，这项就算完成；不满意点“退回修改”，它回到执行中，Agent 下次接着改。</li>
      </ol>
      <p className="hint">验收不会批准工具、合并代码或发布，只改这项工作的状态。</p>
      {actions}
    </section>
  )
}
