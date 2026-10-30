import type { ReactNode } from 'react'
import type { Snapshot, WorkItem } from '../types'
import { ago, providerLabel } from '../model'
import { CopyButton } from '../bits'
import { shownNo } from '../hub/ids'
import { reviewGuide } from './runDeskModel'

const SOURCE: Record<'session' | 'candidate' | 'item', string> = { session: '交付会话记录', candidate: '候选提交', item: '工作项记录' }

// 待验收卡片：交付了什么、在哪看、回原对话，再给通过 / 退回。
// 交付说明是 Agent 自述，不是测试或你的验收结论；位置只用快照里记下的事实，不解析说明文字。
export function DeliveryReview({ snap, item, onSelectSession, actions }: { snap: Snapshot; item: WorkItem; onSelectSession: (id: number) => void; actions: ReactNode }) {
  const g = reviewGuide(snap, item)
  const s = g.session
  return (
    <section className="delivery-review" aria-label="交付验收">
      <h3>这项交付待你验收</h3>
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
            <span><button type="button" className="linkish" title="查看小镇里的会话记录" onClick={() => onSelectSession(s.id)}>{providerLabel(s.provider)} 会话 #{shownNo(s.id)}</button>{s.cwd && <> · <code>{s.cwd}</code></>}</span>
            {s.resume_command ? <CopyButton text={s.resume_command} label="复制恢复命令" /> : <small className="muted">没有记下恢复命令</small>}
          </> : <span className="muted">没有找到交付会话。</span>}
        </dd>
      </dl>
      {g.mismatch && <p className="review-mismatch" role="note">⚠ 这次交付在 {g.mismatch.delivered}，不在本项目 {g.mismatch.item}</p>}
      {actions}
      <p className="hint">验收只改这项工作的状态，不会批准工具、合并代码或发布。</p>
    </section>
  )
}
