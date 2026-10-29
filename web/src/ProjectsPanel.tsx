import { useCallback, useEffect, useRef, useState } from 'react'
import { api } from './api'
import { isRemote } from './access'
import { ErrorLine, useAction } from './bits'
import { ago } from './model'
import type { MergeSyncStatus, ProjectInfo } from './types'
import './projects.css'

export type ProjectScope = 'active' | 'archived' | 'trash'
type ProjectAction = 'archive' | 'unarchive' | 'trash' | 'restore'
const scopeNames: Record<ProjectScope, string> = { active: '使用中', archived: '已归档', trash: '回收站' }
const actionNames: Record<ProjectAction, string> = { archive: '归档', unarchive: '恢复到使用中', trash: '移入回收站', restore: '恢复到原分类' }
const projectScope = (p: ProjectInfo): ProjectScope => p.trashed_at ? 'trash' : p.archived_at ? 'archived' : 'active'
const projectPath = (p: ProjectInfo) => p.common_dir.replace(/\/\.git$/, '').replace(/^dir:/, '')
const dateLabel = (at: string) => Number.isNaN(Date.parse(at)) ? '时间待核对' : new Date(at).toLocaleString('zh-CN')

export function ProjectsPanel({ onClose, initialScope = 'active', device }: { onClose: () => void; initialScope?: ProjectScope; device?: string }) {
  const dialog = useRef<HTMLDialogElement>(null)
  const [projects, setProjects] = useState<ProjectInfo[] | null>(null)
  const [statuses, setStatuses] = useState<MergeSyncStatus[]>([])
  const [error, setError] = useState('')
  const live = useRef(true)
  const request = useRef(0)
  const load = useCallback(async () => {
    const id = ++request.current
    const [p, s] = await Promise.allSettled([api.projects(), api.mergeSync()])
    if (!live.current || id !== request.current) return
    if (p.status === 'fulfilled') { setProjects(p.value); setError('') }
    else { setError(p.reason instanceof Error ? p.reason.message : String(p.reason)); throw p.reason }
    if (s.status === 'fulfilled') setStatuses(s.value)
  }, [])
  useEffect(() => {
    live.current = true
    dialog.current?.showModal()
    const refresh = () => { load().catch(() => { /* Keep the last readable list and show the load error. */ }) }
    refresh()
    const timer = window.setInterval(refresh, 15_000)
    window.addEventListener('focus', refresh)
    window.addEventListener('steward:changed', refresh)
    return () => {
      live.current = false; ++request.current; window.clearInterval(timer)
      window.removeEventListener('focus', refresh)
      window.removeEventListener('steward:changed', refresh)
    }
  }, [load])
  return <dialog className="project-manager" ref={dialog} aria-label="项目管理" onCancel={onClose} onClose={onClose}>
    <div className="pm-heading"><div><span className="pm-eyebrow">{device ? `这台电脑 · ${device}` : '这台电脑的项目'}</span><h1>项目管理</h1><p>暂时不用的归档，放弃的移入回收站。都可以找回来。</p></div><button className="btn" onClick={onClose} autoFocus>关闭</button></div>
    <ErrorLine msg={error} />
    {projects ? <ProjectManager projects={projects} statuses={statuses} readOnly={isRemote()} initialScope={initialScope}
      onArchive={async (ids, archived) => { await api.archiveProjects(ids, archived); await load() }}
      onTrash={async (ids, trashed) => { await api.trashProjects(ids, trashed); await load() }}
      onSync={async () => { await api.scanMerges(); await load() }} /> : <p role="status">正在读取项目…</p>}
  </dialog>
}

export function ProjectManager({ projects, statuses, readOnly = false, initialScope = 'active', onArchive, onTrash, onSync }: {
  projects: ProjectInfo[]; statuses: MergeSyncStatus[]; readOnly?: boolean; initialScope?: ProjectScope
  onArchive: (ids: number[], archived: boolean) => Promise<unknown>
  onTrash: (ids: number[], trashed: boolean) => Promise<unknown>; onSync: () => Promise<unknown>
}) {
  const act = useAction()
  const [mode, setMode] = useState<ProjectScope>(initialScope)
  const [query, setQuery] = useState('')
  const [selected, setSelected] = useState<Set<number>>(new Set())
  const [confirm, setConfirm] = useState<{ kind: ProjectAction; projects: ProjectInfo[] } | null>(null)
  const [notice, setNotice] = useState('')
  const confirmRef = useRef<HTMLDivElement>(null)
  const cancelRef = useRef<HTMLButtonElement>(null)
  useEffect(() => {
    if (confirm) { confirmRef.current?.scrollIntoView({ block: 'nearest' }); cancelRef.current?.focus() }
  }, [confirm])
  const counts: Record<ProjectScope, number> = { active: 0, archived: 0, trash: 0 }
  for (const p of projects) counts[projectScope(p)]++
  const visible = projects.filter(p => projectScope(p) === mode && `${p.name} ${p.common_dir}`.toLowerCase().includes(query.trim().toLowerCase()))
  const chosen = visible.filter(p => selected.has(p.id))
  const syncs = new Map(statuses.map(s => [s.repo_id, s]))
  const locked = act.busy || confirm !== null
  const clear = () => { setSelected(new Set()); setConfirm(null); setNotice(''); act.setError('') }
  const prepare = (kind: ProjectAction, targets = chosen) => {
    if (readOnly || locked || targets.length === 0) return
    act.setError(''); setNotice(''); setConfirm({ kind, projects: [...targets] })
  }
  const apply = () => {
    if (!confirm || act.busy || readOnly) return
    const pending = confirm
    act.run(async () => {
      const ids = pending.projects.map(p => p.id)
      if (pending.kind === 'trash' || pending.kind === 'restore') await onTrash(ids, pending.kind === 'trash')
      else await onArchive(ids, pending.kind === 'archive')
      clear(); setNotice(`已${actionNames[pending.kind]} ${ids.length} 个项目。${pending.kind === 'trash' ? '可以在回收站恢复。' : ''}`)
    })
  }
  return <>
    {readOnly && <p className="warn-box">请在项目所在的电脑上管理。归档和移除状态会随多设备摘要同步。</p>}
    <div className="pm-scopes" role="group" aria-label="项目范围">
      {(['active', 'archived', 'trash'] as const).map(scope => <button key={scope} aria-pressed={mode === scope} disabled={locked} className={mode === scope ? 'on' : ''} onClick={() => { setMode(scope); clear() }}><span>{scopeNames[scope]} {counts[scope]}</span><small>{scope === 'active' ? '显示在小镇与待办中' : scope === 'archived' ? '暂时收起，随时继续' : '已移除，可恢复到原分类'}</small></button>)}
    </div>
    <div className="pm-tools"><input type="search" aria-label="搜索项目" placeholder={`在${scopeNames[mode]}中搜索项目名或目录`} value={query} disabled={locked} onChange={e => { setQuery(e.target.value); clear() }} /><span className="muted">{query ? `找到 ${visible.length} 个项目` : `${visible.length} 个项目`}</span></div>
    <p className="pm-explanation">{mode === 'trash' ? '回收站中的项目已从小镇和待办移除。恢复后回到删除前的分类，保留时间不设自动清理。' : mode === 'archived' ? '归档项目已从小镇和待办收起。在这里恢复，也可以选中后移入回收站。' : '勾选一个或多个项目，就能一起归档或删除。每一行右侧也可以单独操作。'}</p>
    <div className="pm-list" aria-label={`${scopeNames[mode]}项目`}>
      {visible.length > 0 && <label className="pm-select-all"><input type="checkbox" disabled={readOnly || locked} checked={chosen.length === visible.length} ref={el => { if (el) el.indeterminate = chosen.length > 0 && chosen.length < visible.length }} onChange={e => setSelected(new Set(e.target.checked ? visible.map(p => p.id) : []))} />全选当前显示的 {visible.length} 个项目</label>}
      {visible.map(p => { const sync = syncs.get(p.id); return <article className={`pm-project ${selected.has(p.id) ? 'is-selected' : ''}`} key={p.id}>
        <label className="pm-project-choice"><input type="checkbox" aria-label={`选择项目 ${p.name} ${p.common_dir}`} disabled={readOnly || locked} checked={selected.has(p.id)} onChange={e => setSelected(previous => { const next = new Set(previous); if (e.target.checked) next.add(p.id); else next.delete(p.id); return next })} />
          <span><strong>{p.name}</strong><small className="pm-path">{projectPath(p)}</small><small>{p.open_items} 项未完成 · {p.sessions} 个会话{p.pending > 0 ? ` · 待批准 ${p.pending}` : ''}{p.running > 0 ? ` · 会话状态显示运行中 ${p.running}` : ''}</small>
            {mode === 'archived' && <small>归档于 {dateLabel(p.archived_at)}</small>}
            {mode === 'trash' && <small>移除于 {dateLabel(p.trashed_at!)} · 恢复至{p.trashed_from_archive ? '已归档' : '使用中'}</small>}
          </span>
        </label>
        <div className="pm-row-actions" aria-label={`${p.name} 的项目操作`}>
          {mode === 'trash' ? <button className="btn small" disabled={readOnly || locked} onClick={() => prepare('restore', [p])}>恢复</button> : <><button className="btn small" disabled={readOnly || locked} onClick={() => prepare(mode === 'archived' ? 'unarchive' : 'archive', [p])}>{mode === 'archived' ? '恢复' : '归档'}</button><button className="btn small danger" disabled={readOnly || locked} onClick={() => prepare('trash', [p])}>删除</button></>}
        </div>
        {sync && mode === 'active' && <details className="pm-project-sync"><summary>外部合并核对</summary><ProjectSyncLine sync={sync} /></details>}
      </article> })}
      {visible.length === 0 && <div className="pm-empty"><strong>{query ? '没有匹配的项目' : mode === 'trash' ? '回收站是空的' : mode === 'archived' ? '还没有归档项目' : '这里暂时没有项目'}</strong><p>{query ? '试试项目名的一部分，或搜索目录。' : mode === 'active' ? '可以切换到“已归档”或“回收站”找回。' : mode === 'archived' ? '使用中项目旁的“归档”按钮会把项目收在这里。' : '删除的项目会出现在这里，随时可以恢复。'}</p></div>}
    </div>
    <div className="pm-footer">
      <ErrorLine msg={act.error} /><p className="pm-notice" role="status">{notice}</p>
      {confirm ? <div ref={confirmRef} className={`pm-confirm ${confirm.kind === 'trash' ? 'is-trash' : ''}`} role="region" aria-label="确认项目操作">
        <h2>{actionNames[confirm.kind]}这 {confirm.projects.length} 个项目？</h2>
        <ul>{confirm.projects.map(p => <li key={p.id}><strong>{p.name}</strong><small>{projectPath(p)}{confirm.kind === 'restore' ? ` · 恢复至${p.trashed_from_archive ? '已归档' : '使用中'}` : ''}</small></li>)}</ul>
        <p>{confirm.kind === 'trash' ? '将从小镇、待办和多设备地图中移除，可在回收站恢复。' : confirm.kind === 'archive' ? '将从小镇、待办和多设备地图中收起，可在已归档中恢复。' : '恢复后会回到对应的项目分类。'}</p>
        {confirm.projects.some(p => p.pending || p.running) && <p className="pm-warning">其中有待批准请求或状态显示运行中的会话。此操作只管理显示，不会停止执行或替你处理审批。</p>}
        <p className="hint">代码目录、会话、用量历史和验收记录都会保留。</p>
        <div className="pm-confirm-actions"><button ref={cancelRef} className="btn" disabled={act.busy} onClick={() => { setConfirm(null); act.setError('') }}>取消</button><button className={`btn ${confirm.kind === 'trash' ? 'danger' : 'primary'}`} disabled={act.busy || readOnly} onClick={apply}>{act.busy ? '处理中…' : `确认${actionNames[confirm.kind]}`}</button></div>
      </div> : <div className="pm-batch"><span>已选择 <b>{chosen.length}</b> 个项目</span><div>{chosen.length > 0 && <button className="btn small" onClick={clear}>取消选择</button>}{mode === 'trash' ? <button className="btn primary" disabled={readOnly || act.busy || chosen.length === 0} onClick={() => prepare('restore')}>恢复所选项目</button> : <><button className="btn" disabled={readOnly || act.busy || chosen.length === 0} onClick={() => prepare(mode === 'archived' ? 'unarchive' : 'archive')}>{mode === 'archived' ? '恢复所选项目' : '归档所选项目'}</button><button className="btn danger" disabled={readOnly || act.busy || chosen.length === 0} onClick={() => prepare('trash')}>删除所选项目</button></>}</div></div>}
      {!confirm && <p className="pm-preserve">只管理小镇内的项目显示，代码目录和历史记录都会保留。</p>}
    </div>
    <details className="pm-sync-tools"><summary>外部合并核对</summary><p className="hint">待合并项目每分钟核对远端。只记录合并事实，验收由你决定。</p><button className="btn small" disabled={readOnly || locked} onClick={() => act.run(async () => { await onSync(); setNotice('核对已结束，请查看各项目的结果；无法确认的会保留原状态。') })}>{act.busy ? '处理中…' : '立即核对外部合并'}</button></details>
  </>
}

export function ProjectSyncLine({ sync }: { sync: MergeSyncStatus }) {
  if (sync.state === 'idle') return <small className="muted">外部合并：当前没有待核对的合并</small>
  if (sync.state === 'missing') return <small className="muted">外部合并：原项目目录已失效，历史记录保留；可自行归档</small>
  return <small className={sync.error ? 'pm-sync-error' : 'muted'}>外部合并：{sync.checked_at && <time dateTime={sync.checked_at} title={new Date(sync.checked_at).toLocaleString('zh-CN')}>{ago(sync.checked_at, new Date().toISOString())}核对 · </time>}{sync.error || `${sync.remote || '本地'} / ${sync.target_ref}`}{sync.account ? ` · 使用账号 ${sync.account}` : ''}{sync.pr_note ? `；${sync.pr_note}` : ''}</small>
}
