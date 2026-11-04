import { useEffect, useRef, useState } from 'react'
import { api } from '../api'
import { isRemote } from '../access'
import { ErrorLine, useAction } from '../bits'
import type { Repo, Worktree } from '../types'

// 房间里直接收起或删除这个项目，以及删除已经不用的 Git 工作目录。
// 归档、移入回收站只改显示，可以恢复；删除工作目录要逐个确认，只移到废纸篓，分支和提交都保留。
type Pending = { kind: 'archive' | 'trash' } | { kind: 'worktree'; path: string }

export function ProjectHousekeeping({ repo, name, initialOpen = false }: { repo: Repo; name: string; initialOpen?: boolean }) {
  const [open, setOpen] = useState(initialOpen)
  const box = useRef<HTMLDetailsElement>(null)
  const [list, setList] = useState<Worktree[] | null>(null)
  const [trash, setTrash] = useState(true)
  const [pending, setPending] = useState<Pending | null>(null)
  const [receipt, setReceipt] = useState('')
  const act = useAction()
  // 从右键菜单直接打开时，读取工作目录并滚到这里。远程视图下组件不渲染，也不读取。
  useEffect(() => { if (initialOpen && !isRemote()) { box.current?.scrollIntoView({ block: 'nearest' }); load() } }, []) // eslint-disable-line react-hooks/exhaustive-deps
  if (isRemote()) return null
  const load = () => act.run(async () => {
    if (!repo.is_git) { setList([]); return }
    const r = await api.worktrees(repo.id)
    setList(r.worktrees); setTrash(r.trash_available)
  })
  const confirm = () => {
    const p = pending
    if (!p) return
    act.run(async () => {
      if (p.kind === 'archive') await api.archiveProjects([repo.id], true)
      else if (p.kind === 'trash') await api.trashProjects([repo.id], true)
      else if (p.kind === 'worktree') await api.removeWorktree(repo.id, p.path)
      setPending(null)
      setReceipt(p.kind === 'archive' ? '已归档，可在“项目管理 → 已归档”恢复。' : p.kind === 'trash' ? '已移入回收站，可在“项目管理 → 回收站”恢复。' : '工作目录已移到废纸篓，分支和提交保留。')
      if (p.kind === 'worktree') { const r = await api.worktrees(repo.id); setList(r.worktrees) }
      window.dispatchEvent(new Event('steward:changed'))
    })
  }
  const others = (list ?? []).filter(w => !w.main)
  return <details ref={box} className="town-room-organize project-housekeeping" open={open} onToggle={e => { setOpen(e.currentTarget.open); if (e.currentTarget.open && !list) load() }}>
    <summary>归档、删除与工作目录</summary>
    <p className="hint">归档和移入回收站只是从小镇、待办和通知里收起 {name}，代码目录、会话和验收记录都保留，可以恢复。</p>
    <div className="row wrap">
      <button type="button" className="btn small" disabled={act.busy || !!pending} onClick={() => setPending({ kind: 'archive' })}>归档这个项目</button>
      <button type="button" className="btn small danger" disabled={act.busy || !!pending} onClick={() => setPending({ kind: 'trash' })}>移入回收站</button>
    </div>
    <h4>Git 工作目录</h4>
    {!repo.is_git ? <p className="hint">这个项目不是 Git 仓库，没有可删除的工作目录。</p>
      : list === null ? <p role="status">正在读取工作目录…</p>
      : others.length === 0 ? <p className="hint">除主目录外没有其他工作目录。主目录不会在这里删除。</p>
      : <ul className="housekeeping-worktrees">{others.map(w => <li key={w.path}>
        <code>{w.path}</code><small>{w.branch ? `分支 ${w.branch}` : '分离提交'} · {w.removable ? '已合并、没有改动、没有会话在运行' : w.reason}</small>
        {w.removable && <button type="button" className="btn small danger" disabled={act.busy || !!pending} onClick={() => setPending({ kind: 'worktree', path: w.path })}>删除工作目录</button>}
      </li>)}</ul>}
    {repo.is_git && list !== null && !trash && <p className="hint">这台电脑上的服务不提供删除工作目录（需要 macOS 15 及以上自带的废纸篓命令）。</p>}
    {pending && <div className="pm-confirm is-trash" role="region" aria-label="确认操作">
      <strong>{pending.kind === 'archive' ? `归档 ${name}？` : pending.kind === 'trash' ? `把 ${name} 移入回收站？` : '删除这个工作目录？'}</strong>
      {pending.kind === 'worktree' && <p><code>{pending.path}</code></p>}
      <p className="hint">{pending.kind === 'worktree' ? '目录会移到废纸篓（可以放回），随后清理 Git 的工作目录记录；分支和提交都保留。提交前会再检查一次是否已合并、有没有改动和正在运行的会话。' : '只改变显示，可以在项目管理里恢复。'}</p>
      <div className="row wrap"><button type="button" className="btn small" disabled={act.busy} onClick={() => { setPending(null); act.setError('') }}>取消</button><button type="button" className="btn small danger" disabled={act.busy} onClick={confirm}>{act.busy ? '处理中…' : '确认'}</button></div>
    </div>}
    <ErrorLine msg={act.error} /><p className="hint" role="status">{receipt}</p>
  </details>
}
