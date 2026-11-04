import { useState } from 'react'
import { api } from '../api'
import { isRemote } from '../access'
import { ErrorLine, useAction } from '../bits'
import { ago } from '../model'
import type { Snapshot } from '../types'
import type { HookCoverage } from '../api'
import { setupSteps } from './setup'
import './noticeBar.css'

// 不打开某个页面也该知道的两件事：系统挡住了读取（多半是 macOS 在等授权），以及已归档的项目又有了新活动。
// 只在项目所在的这台电脑上显示；远程浏览不能替这台电脑授权或恢复项目。
type Archived = NonNullable<Snapshot['archived_activity']>[number]
const MAX_ARCHIVED = 3

export function NoticeBar({ snap, coverage = null }: { snap: Snapshot; coverage?: HookCoverage[] | null }) {
  const [hideAccess, setHideAccess] = useState('')
  const [hideSetup, setHideSetup] = useState('')
  if (isRemote()) return null
  const issues = snap.access_issues ?? []
  const archived = snap.archived_activity ?? []
  const accessKey = issues.map(i => i.path).join('|')
  const showAccess = issues.length > 0 && hideAccess !== accessKey
  // 已经有数据的电脑上，接入出了问题（缺事件、Codex 未信任、hooks 被卸掉）也提示；空状态里另有完整清单。
  const setup = (snap.sessions ?? []).length > 0 ? setupSteps(coverage, true).filter((s) => !s.done) : []
  const setupKey = setup.map((s) => s.key).join('|')
  const showSetup = setup.length > 0 && hideSetup !== setupKey
  if (!showAccess && !showSetup && archived.length === 0) return null
  return <div className="notice-bar" role="region" aria-label="需要你知道的事">
    {showAccess && <div className="notice is-warn" role="alert">
      <strong>读取 {issues.map(i => i.path).join('、')} 时被 macOS 挡住了</strong>
      <p>工作目录、合并核对等会超时，不是数据坏了。升级或重新安装后，系统要重新确认 steward 能不能读这些位置。请打开<b>系统设置 → 隐私与安全性 → 文件与文件夹</b>，允许 steward 访问“可移除的宗卷”（文稿、桌面等同理）；屏幕上若有询问框，点“允许”。授权后几分钟内这条提示会自动消失。</p>
      <small>从 {ago(issues[0].since, snap.now)}开始</small>
      <button type="button" className="btn small" onClick={() => setHideAccess(accessKey)}>先收起</button>
    </div>}
    {showSetup && <div className="notice is-warn" role="status">
      <strong>接入还差一步</strong>
      {setup.map((s) => <p key={s.key}>{s.text}{s.command && <> <code>{s.command}</code></>}</p>)}
      <button type="button" className="btn small" onClick={() => setHideSetup(setupKey)}>先收起</button>
    </div>}
    {archived.slice(0, MAX_ARCHIVED).map(a => <ArchivedNotice key={a.repo_id} a={a} now={snap.now} />)}
    {archived.length > MAX_ARCHIVED && <p className="notice-more">另有 {archived.length - MAX_ARCHIVED} 个已归档项目有新活动，可在“项目管理 → 已归档”查看。</p>}
  </div>
}

function ArchivedNotice({ a, now }: { a: Archived; now: string }) {
  const act = useAction()
  const done = () => window.dispatchEvent(new Event('steward:changed'))
  return <div className="notice">
    <strong>已归档的 {a.name} 有新活动</strong>
    <p>{ago(a.last_activity_at, now)}有会话在这个项目里工作。归档的项目不会自动回到小镇和待办，要恢复吗？</p>
    <div className="row wrap">
      <button type="button" className="btn small primary" disabled={act.busy} onClick={() => act.run(async () => { await api.archiveProjects([a.repo_id], false); done() })}>恢复到使用中</button>
      <button type="button" className="btn small" disabled={act.busy} title="这次的活动不再提示，以后再有新活动时再问" onClick={() => act.run(async () => { await api.keepArchived([a.repo_id]); done() })}>继续收起</button>
    </div>
    <ErrorLine msg={act.error} />
  </div>
}
