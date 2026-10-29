import type { ReactNode } from 'react'
import type { Session, Snapshot, WorkItem } from '../types'
import { AgentBadge, CopyButton } from '../bits'
import { ago, itemStatusLabel, providerLabel, sessionStateLabel } from '../model'
import { attemptsOf } from '../brief'
import { StatusChip } from './StatusChip'
import { CommandBlock } from './CommandBlock'
import { WorkOverview } from './WorkOverview'
import { candidateOf, clock, commandsOf, currentRuns, runsBySession, shortSha, staleWriters, timelineOf, type RunState } from './runDeskModel'

const outcomeLabel: Record<string, string> = { delivered: '交付', failed: '失败', abandoned: '放弃', handed_off: '转交', historical: '历史关联', attribution_reverted: '已撤销归属', '': '结果待定' }

const sessionRunState = (s?: Session): RunState =>
  !s ? 'unknown' : s.state === 'running' ? 'running' : s.state === 'waiting_permission' ? 'requested' : s.state === 'error' ? 'failed' : ['idle', 'interrupted', 'ended'].includes(s.state) ? 'neutral' : 'unknown'

function Sha({ sha }: { sha: string }) {
  if (!sha) return <span className="rd-missing">提交未回报</span>
  return <span className="rd-sha"><code title={sha} aria-label={`完整提交 ${sha}`}>{shortSha(sha)}</code><CopyButton text={sha} label="复制完整 SHA" /></span>
}

function Section({ index, title, children, tone }: { index: string; title: string; children: ReactNode; tone?: 'warn' }) {
  return (
    <section className={`rd-section ${tone ? `rd-section-${tone}` : ''}`} aria-label={title}>
      <h3 className="rd-eyebrow"><span>{index}</span> · {title}</h3>
      {children}
    </section>
  )
}

// 工作项运行台：当前 vs 候选 → 旧运行与交接 → 时间线 → 命令/结果。只读展示，写操作由调用方按权限放在 children 中。
export function RunDesk({ snap, item, remote, onClose, onSelectSession, attention, actions, children }: {
  snap: Snapshot; item: WorkItem; remote: boolean; onClose: () => void; onSelectSession: (id: number) => void; attention?: ReactNode; actions?: ReactNode; children?: ReactNode
}) {
  const repo = (snap.repos ?? []).find((r) => r.id === item.repo_id)
  const sessions = new Map((snap.sessions ?? []).map((s) => [s.id, s]))
  const attempts = attemptsOf(snap, item.id)
  const runs = currentRuns(snap, item)
  const currentBySession = new Map(runs.map(r => [r.sessionId, r]))
  const cand = candidateOf(snap, item)
  const writers = staleWriters(snap, item)
  const handoffs = (snap.handoffs ?? []).filter((h) => h.work_item_id === item.id)
  const events = timelineOf(snap, item)
  const commands = commandsOf(snap, item)

  return (
    <div className="run-desk detail">
      <header className="rd-head">
        <div className="rd-head-top">
          <p className="rd-kicker">工作详情</p>
          <div className="rd-head-actions">{actions}<button className="btn small rd-close" onClick={onClose} aria-label="关闭工作详情">✕</button></div>
        </div>
        <h2>{item.title}</h2>
        <p className="rd-sub">
          <code>{item.id}</code> · {repo?.name ?? '未关联项目'}
          <span className={`rd-pill st-${item.status}`}>{item.automatic_history ? '已自动归档' : itemStatusLabel[item.status]}</span>
          <span className="rd-muted">更新 {ago(item.updated_at, snap.now)}</span>
        </p>
      </header>
      {remote && <p className="rd-banner" role="note">远程只读：此页写入口已移除。启动、审批、交接、合并与简报纠错需在本机面板进行。</p>}
      <WorkOverview snap={snap} item={item} />
      {attention}
      {writers.length > 0 && <p className="rd-alert" role="note">交接后仍有 {writers.length} 个原会话可以继续写入。需要排查时展开下方“执行记录”。</p>}
      <details className="rd-inspection"><summary>执行记录 <small>会话、分支、版本、时间线和命令</small></summary>
      <p className="rd-note">这些资料用于核对执行过程；没有记录时不代表工作失败。</p>
      <div className="rd-env" role="group" aria-label="访问权限">
        {remote ? <span className="rd-access rd-access-ro">远程 · 全局只读</span> : <span className="rd-access">本机 · 可操作</span>}
      </div>
      <div className="rd-grid">
        <nav className="rd-nav" aria-label="会话层级">
          <p className="rd-nav-title">运行层级</p>
          <ol className="rd-tree">
            <li className="rd-tree-project">{repo?.name ?? '未关联项目'}</li>
            <li className="rd-tree-item"><code>{item.id}</code> {item.title}</li>
            {attempts.length === 0 && <li className="rd-missing rd-tree-empty">还没有执行会话</li>}
            {attempts.map((a, i) => (
              <li key={a.attempt} className={`rd-tree-attempt ${i === 0 ? 'is-current' : ''}`}>
                <span>尝试 {a.attempt}{i === 0 ? '（当前）' : ''}</span>
                <ol>
                  {runsBySession(a.runs).map((g) => {
                    const s = sessions.get(g.sessionId)
                    const current = currentBySession.get(g.sessionId)
                    const spans = g.runs.map((r) => `${clock(r.started_at)}${r.ended_at ? ` → ${clock(r.ended_at)} ${outcomeLabel[r.outcome] ?? r.outcome}` : ' 起，进行中'}`).join('\n')
                    return (
                      <li key={g.sessionId}>
                        <button className="rd-tree-run" onClick={() => onSelectSession(g.sessionId)} title={`会话 #${g.sessionId} 在这项工作上的 ${g.runs.length} 段运行：\n${spans}`}>
                          <AgentBadge provider={g.provider} />
                          <span>#{g.sessionId}</span>
                          <StatusChip state={current?.state ?? sessionRunState(s)} label={current?.statusLabel ?? (s ? sessionStateLabel[s.state] : '未知')} />
                          {g.runs.length > 1 && <small>{g.runs.length} 段运行</small>}
                          {!g.open && <small>{outcomeLabel[g.outcome] ?? g.outcome}</small>}
                        </button>
                      </li>
                    )
                  })}
                </ol>
              </li>
            ))}
          </ol>
        </nav>

        <div className="rd-main">
          <Section index="01" title="当前运行 vs 候选提交">
            <dl className="rd-facts">
              <div><dt>当前运行</dt><dd>
                {runs.length ? runs.map((r) => (
                  <span key={r.id} className="rd-run">
                    <AgentBadge provider={r.provider} /> {r.label} <StatusChip state={r.state} label={r.statusLabel} /> <small className="rd-muted">{ago(r.since, snap.now)}活动</small>
                  </span>
                )) : <span className="rd-missing">暂无运行中的会话</span>}
              </dd></div>
              <div><dt>候选提交</dt><dd>
                {cand ? <>{cand.ref && <code className="rd-ref">{cand.ref}</code>}<Sha sha={cand.sha} /><small className="rd-muted">来源：{cand.source}</small></> : <span className="rd-missing">暂无候选提交</span>}
              </dd></div>
              {cand?.pending && <div><dt>另一审批候选</dt><dd><code className="rd-ref">{cand.pending.ref}</code><Sha sha={cand.pending.sha} /><small className="rd-muted">来源：另一合并审批；不沿用以上检查结果。目标 {cand.pending.targetRef} · {shortSha(cand.pending.targetSha)}</small></dd></div>}
              {cand?.target && <div><dt>目标基线</dt><dd>
                <code className="rd-ref">{cand.target.ref}</code><Sha sha={cand.target.sha} />
                {cand.target.moved && <StatusChip state="unknown" label="目标已前进，需重建候选" />}
              </dd></div>}
              <div><dt>运行版本</dt><dd><span className="rd-missing">运行版本：待核实。快照未提供面板服务的构建版本，不能据此判断当前运行的是哪个候选。</span></dd></div>
            </dl>
          </Section>

          <Section index="02" title="旧运行与交接" tone={writers.length ? 'warn' : undefined}>
            {writers.map((w) => (
              <div key={w.session.id} className="rd-alert" role="note">
                <strong><span aria-hidden="true">⚠</span> {w.reason}</strong>
                <p>会话 #{w.session.id}（{providerLabel(w.session.provider)}）仍处于“{sessionStateLabel[w.session.state]}”，可继续写入同一仓库。Steward 不会自动停止它{remote ? '' : '；如需停止，请在该 Agent 自己的界面处理'}。</p>
              </div>
            ))}
            {handoffs.length ? <ul className="rd-list">
              {handoffs.map((h) => (
                <li key={h.id}>
                  <StatusChip state={h.state === 'launched' ? 'requested' : h.state === 'failed' ? 'failed' : 'unknown'} label={h.state === 'launched' ? '已启动接手' : h.state === 'failed' ? '失败' : `未知（${h.state}）`} />
                  <span>交接 {providerLabel(h.from_provider)}{h.from_session_id != null ? ` #${h.from_session_id}` : ''} → {h.to_agent}</span>
                  <small className="rd-muted">{h.source_branch} · {ago(h.created_at, snap.now)}</small>
                </li>
              ))}
            </ul> : <p className="rd-missing">暂无交接记录。</p>}
            <p className="rd-note">交接只在新 worktree 启动接手方；上一位会话不会被停止，写入权也不会被撤销。</p>
          </Section>

          <Section index="03" title="时间线">
            {events.length ? <ol className="rd-timeline">
              {events.map((e) => (
                <li key={e.key}>
                  <time dateTime={e.at}>{clock(e.at)}</time>
                  <StatusChip state={e.state} />
                  <div><strong>{e.title}</strong>{e.detail && <small>{e.detail}</small>}</div>
                </li>
              ))}
            </ol> : <p className="rd-missing">暂无审批、检查、托管或交接记录。</p>}
          </Section>

          <Section index="04" title="命令与结果">
            {commands.length ? <ul className="rd-cmds">{commands.map((c) => <CommandBlock key={c.key} c={c} />)}</ul>
              : <p className="rd-missing">暂无命令。检查门结果只来自服务实际运行的命令。</p>}
            <p className="rd-note">只有带退出码的检查才显示成功或失败；复制、发送和命令文本本身都不是执行证据。</p>
          </Section>
        </div>
      </div>
      </details>
      {children && <details className="rd-more"><summary>更多资料与管理 <small>功能验收、完整简报、用量与交接</small></summary><div className="rd-more-body">{children}</div></details>}
    </div>
  )
}
