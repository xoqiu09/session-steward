import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent } from 'react'
import { api } from '../api'
import { ErrorLine, useAction } from '../bits'
import type { Repo, Snapshot } from '../types'
import './projectMenu.css'

// 项目的右键菜单：项目推进卡片和小镇房子共用。元素上标 data-repo-id 即可接入；
// 键盘的菜单键 / Shift+F10 也会触发 contextmenu 事件。归档、移入回收站要再确认，都可以恢复。
export const REPO_ATTR = 'data-repo-id'

export interface ProjectMenuActions {
  onFilter: (repo: Repo) => void
  onShowAll: () => void
  onReview: (repo: Repo) => void
  onEnterRoom: (repo: Repo, focus?: 'organize' | 'housekeeping') => void
}

type Open = { repo: Repo; x: number; y: number; trigger: Element | null; readOnly: boolean }
type Confirm = 'archive' | 'trash'

const projectPath = (r: Repo) => r.common_dir.replace(/\/\.git$/, '').replace(/^dir:/, '')

/** 合并视图、远程浏览、历史回放里只给查看类操作。 */
function readOnlyAt(target: Element, repo: Repo, remote: boolean): boolean {
  return remote || repo.id >= 1_000_000_000 || !!repo.device || target.closest('[data-readonly="true"]') != null || document.querySelector('.town-replay-banner') != null
}

export function useProjectMenu({ snap, current, remote, actions }: { snap: Snapshot | null; current: number | 'all'; remote: boolean; actions: ProjectMenuActions }) {
  const [open, setOpen] = useState<Open | null>(null)
  const repos = useRef(snap?.repos ?? [])
  repos.current = snap?.repos ?? []
  useEffect(() => {
    const onContext = (e: MouseEvent) => {
      const target = (e.target as Element | null)?.closest?.(`[${REPO_ATTR}]`)
      if (!target) return
      const id = Number(target.getAttribute(REPO_ATTR))
      const repo = repos.current.find(r => r.id === id)
      if (!repo) return
      e.preventDefault()
      let { clientX: x, clientY: y } = e
      if (x === 0 && y === 0) { const r = target.getBoundingClientRect(); x = r.left + 12; y = r.bottom - 4 }
      setOpen({ repo, x, y, trigger: target, readOnly: readOnlyAt(target, repo, remote) })
    }
    window.addEventListener('contextmenu', onContext)
    return () => window.removeEventListener('contextmenu', onContext)
  }, [remote])
  const close = () => { const t = open?.trigger; setOpen(null); if (t instanceof HTMLElement || t instanceof SVGElement) t.focus?.({ preventScroll: true }) }
  return open && snap ? <ProjectMenu key={`${open.repo.id}-${open.x}-${open.y}`} {...open} snap={snap} current={current} actions={actions} onClose={close} /> : null
}

export function ProjectMenu({ repo, x, y, readOnly, snap, current, actions, onClose }: Open & { snap: Snapshot; current: number | 'all'; actions: ProjectMenuActions; onClose: () => void }) {
  const menu = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState({ left: x, top: y })
  const [confirm, setConfirm] = useState<Confirm | null>(null)
  const [copied, setCopied] = useState('')
  const act = useAction()
  useLayoutEffect(() => {
    const el = menu.current
    if (!el) return
    const r = el.getBoundingClientRect()
    setPos({ left: Math.max(8, Math.min(x, window.innerWidth - r.width - 8)), top: Math.max(8, Math.min(y, window.innerHeight - r.height - 8)) })
    if (!confirm) el.querySelector<HTMLElement>('[role="menuitem"]:not([disabled])')?.focus()
  }, [x, y, confirm])
  useEffect(() => {
    const away = (e: PointerEvent) => { if (!menu.current?.contains(e.target as Node)) onClose() }
    const esc = (e: globalThis.KeyboardEvent) => { if (e.key === 'Escape') { e.preventDefault(); onClose() } }
    const scroll = () => onClose()
    window.addEventListener('pointerdown', away, true)
    window.addEventListener('keydown', esc)
    window.addEventListener('blur', scroll)
    return () => { window.removeEventListener('pointerdown', away, true); window.removeEventListener('keydown', esc); window.removeEventListener('blur', scroll) }
  }, [onClose])
  const run = (f: () => void) => () => { f(); onClose() }
  const pending = (snap.approvals ?? []).filter(a => a.repo_id === repo.id && a.status === 'pending').length
  const running = (snap.sessions ?? []).filter(s => s.repo_id === repo.id && s.freshness === 'live' && (s.state === 'running' || s.state === 'waiting_permission')).length
  const copy = async () => {
    try { await navigator.clipboard.writeText(projectPath(repo)); setCopied('已复制项目路径'); window.setTimeout(onClose, 700) }
    catch { setCopied('无法写入剪贴板，路径：' + projectPath(repo)) }
  }
  const apply = (kind: Confirm) => act.run(async () => {
    if (kind === 'archive') await api.archiveProjects([repo.id], true)
    else await api.trashProjects([repo.id], true)
    if (current === repo.id) actions.onShowAll()
    window.dispatchEvent(new Event('steward:changed'))
    onClose()
  })
  const keys = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp' && e.key !== 'Home' && e.key !== 'End') return
    e.preventDefault()
    const items = [...(menu.current?.querySelectorAll<HTMLElement>('[role="menuitem"]:not([disabled])') ?? [])]
    const i = items.indexOf(document.activeElement as HTMLElement)
    const next = e.key === 'Home' ? 0 : e.key === 'End' ? items.length - 1 : (i + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length
    items[next]?.focus()
  }
  const item = (label: string, onClick: () => void, opts: { danger?: boolean; disabled?: boolean; hint?: string } = {}) =>
    <button type="button" role="menuitem" className={opts.danger ? 'is-danger' : ''} disabled={opts.disabled} title={opts.hint} onClick={onClick}>{label}</button>
  return <div ref={menu} className="project-menu" role={confirm ? 'dialog' : 'menu'} aria-label={`${repo.name} 的项目操作`} style={pos} onKeyDown={keys} onContextMenu={e => e.preventDefault()}>
    <div className="project-menu-head"><strong>{repo.name}</strong><small>{projectPath(repo)}</small></div>
    {confirm ? <div className="project-menu-confirm">
      <p><b>{confirm === 'archive' ? `归档 ${repo.name}？` : `把 ${repo.name} 移入回收站？`}</b></p>
      <p className="hint">从小镇、待办、通知和多设备地图中收起，可在项目管理的“{confirm === 'archive' ? '已归档' : '回收站'}”恢复。代码目录、会话、用量和验收记录都保留。</p>
      {(pending > 0 || running > 0) && <p className="pm-warning">这个项目有{pending > 0 ? ` ${pending} 个待处理请求` : ''}{running > 0 ? ` ${running} 个运行中的会话` : ''}。收起只改显示，不会停止执行或替你处理请求。</p>}
      <ErrorLine msg={act.error} />
      <div className="row wrap"><button type="button" className="btn small" disabled={act.busy} onClick={() => { setConfirm(null); act.setError('') }} autoFocus>取消</button><button type="button" className={`btn small ${confirm === 'trash' ? 'danger' : 'primary'}`} disabled={act.busy} onClick={() => apply(confirm)}>{act.busy ? '处理中…' : confirm === 'archive' ? '确认归档' : '确认移入回收站'}</button></div>
    </div> : <>
      <div className="project-menu-group" role="group" aria-label="查看">
        {current === repo.id ? item('显示全部项目', run(actions.onShowAll)) : item('只看这个项目', run(() => actions.onFilter(repo)))}
        {item('在小镇里进入房间', run(() => actions.onEnterRoom(repo)), { disabled: !!repo.device, hint: repo.device ? '其他电脑的项目请到那台电脑查看' : undefined })}
        {item('查看待审阅与验收', run(() => actions.onReview(repo)))}
      </div>
      <div className="project-menu-group" role="group" aria-label="整理">
        {item('整理项目结构…', run(() => actions.onEnterRoom(repo, 'organize')), { disabled: readOnly, hint: readOnly ? '只能在项目所在电脑的实时视图里整理' : undefined })}
        {item('管理工作目录…', run(() => actions.onEnterRoom(repo, 'housekeeping')), { disabled: readOnly || !repo.is_git, hint: !repo.is_git ? '不是 Git 仓库，没有工作目录' : readOnly ? '只能在项目所在电脑的实时视图里管理' : undefined })}
        {item(copied || '复制项目路径', copy)}
      </div>
      <div className="project-menu-group" role="group" aria-label="收起">
        {item('归档项目…', () => setConfirm('archive'), { disabled: readOnly })}
        {item('移入回收站…', () => setConfirm('trash'), { danger: true, disabled: readOnly })}
      </div>
      {readOnly && <p className="project-menu-note">当前是只读视图，只提供查看。</p>}
    </>}
  </div>
}
