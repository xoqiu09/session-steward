import type { ReactNode } from 'react'
import type { Snapshot, WorkItem } from '../types'
import { ago, providerLabel } from '../model'
import { CopyButton } from '../bits'
import { shownNo } from '../hub/ids'
import { reviewGuide } from './runDeskModel'
import { ActionFeedback } from './ActionFeedback'

const SOURCE: Record<'session' | 'candidate' | 'item', string> = { session: '交付会话记录', candidate: '候选提交', item: '工作项记录' }

// 待验收卡片：交付了什么、在哪看、回原对话，再给通过 / 退回。
// 交付说明是 Agent 自述，不是测试或你的验收结论；位置只用快照里记下的事实，不解析说明文字。
export function DeliveryReview({ snap, item, onSelectSession, actions, historical = false }: { snap: Snapshot; item: WorkItem; onSelectSession?: (id: number) => void; actions: ReactNode; historical?: boolean }) {
  const g = reviewGuide(snap, item)
  const s = g.session
  return (
    <section className="delivery-review" aria-label={historical ? '上一轮交付记录' : '交付处理'}>
      <h3>{historical ? '上一轮交付记录' : '这项交付待你处理'}</h3>
      <dl className="review-facts">
        <dt>交付了什么</dt>
        <dd>
          {g.said ? <>{g.said.text}<small className="muted">（Agent 自述 · {ago(g.said.at, snap.now)}）</small></>
            : <span className="muted">Agent 没有写交付说明，回原对话问它做了什么。</span>}
          {g.acceptance && <small className="review-acceptance">验收标准：{g.acceptance}</small>}
        </dd>
        <dt>在哪看</dt>
        <dd className="review-line">
          {g.where ? <>
            <span>{g.where.repo && <>{g.where.repo} · </>}{g.where.branch ? <>分支 <code>{g.where.branch}</code></> : '没有记下分支'}{g.where.path && <> · <code>{g.where.path}</code></>}
              <small className="muted">（{SOURCE[g.where.source]}）</small></span>
            {(g.where.path || g.where.branch) && <CopyButton text={g.where.path || g.where.branch} label={g.where.path ? '复制目录' : '复制分支名'} />}
          </> : <span className="muted">没有记下仓库或分支，回原对话问 Agent 放在哪。</span>}
        </dd>
        <dt>交付会话</dt>
        <dd className="review-line">
          {s ? <>
            <span>{onSelectSession ? <button type="button" className="linkish" title="查看小镇里的会话记录" onClick={() => onSelectSession(s.id)}>{providerLabel(s.provider)} 会话 #{shownNo(s.id)}</button> : <>{providerLabel(s.provider)} 会话 #{shownNo(s.id)}</>}{s.cwd && <> · <code>{s.cwd}</code></>}</span>
            {s.resume_command ? <CopyButton text={s.resume_command} label="复制恢复命令" /> : <small className="muted">没有记下恢复命令</small>}
          </> : <span className="muted">没有找到交付会话。</span>}
        </dd>
      </dl>
      {g.mismatch && <p className="review-mismatch" role="note">⚠ 这次交付在 {g.mismatch.delivered}，不在本项目 {g.mismatch.item}</p>}
      {actions}
      <p className="hint">{historical ? '保留的是处理前的交付与来源，便于后续核对。' : '“验收并完成”记录你的工作项验收；验证记录与功能确认分别保留，工具批准、代码合并和发布仍需分别操作。'}</p>
    </section>
  )
}

export interface DeliveryReceipt {
  item: WorkItem
  snapshot: Snapshot
  status: 'done' | 'in_progress'
}

/** Lives outside the review-only row, so a refreshed status cannot erase it. */
export function DeliveryActionReceipt({ receipt, onSelectItem, onSelectSession }: { receipt: DeliveryReceipt; onSelectItem?: (id: string) => void; onSelectSession?: (id: number) => void }) {
  const returned = receipt.status === 'in_progress'
  return <ActionFeedback tone={returned ? 'warning' : 'success'}>
    <strong>{receipt.item.id} · {receipt.item.title}</strong>
    <p>{returned ? '已记录需修改，请回原会话说明要求。' : '已验收并完成此工作项。验证记录、功能确认与代码合并仍分别保留。'}</p>
    {onSelectItem && <button type="button" className="btn small" onClick={() => onSelectItem(receipt.item.id)}>{returned ? '打开详情，回原会话' : '查看这项工作'}</button>}
    <details><summary>查看上一轮交付与来源</summary><DeliveryReview snap={receipt.snapshot} item={receipt.item} onSelectSession={onSelectSession} actions={null} historical /></details>
  </ActionFeedback>
}
