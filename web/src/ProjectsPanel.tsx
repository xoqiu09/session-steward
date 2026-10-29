import { useCallback, useEffect, useRef, useState } from 'react'
import { api } from './api'
import { isRemote } from './access'
import { ErrorLine, useAction } from './bits'
import { ago } from './model'
import type { MergeSyncStatus, ProjectInfo } from './types'
import './projects.css'

export function ProjectsPanel({ onClose }: { onClose: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null)
  const [projects, setProjects] = useState<ProjectInfo[] | null>(null)
  const [statuses, setStatuses] = useState<MergeSyncStatus[]>([])
  const [error, setError] = useState('')
  const live = useRef(true)
  const request = useRef(0)
  const load = useCallback(async () => {
    const id = ++request.current
    try {
      const [p, s] = await Promise.all([api.projects(), api.mergeSync()])
      if (live.current && id === request.current) { setProjects(p); setStatuses(s); setError('') }
    } catch (e) {
      if (live.current && id === request.current) setError(e instanceof Error ? e.message : String(e))
      throw e
    }
  }, [])
  useEffect(() => {
    live.current = true
    dialog.current?.showModal()
    const refresh = () => { load().catch(() => { /* load retains the current request's error */ }) }
    refresh()
    const timer = window.setInterval(refresh, 15_000)
    return () => { live.current = false; ++request.current; window.clearInterval(timer) }
  }, [load])
  return <dialog className="project-manager" ref={dialog} aria-label="管理项目" onCancel={onClose} onClose={onClose}>
    <div className="pm-heading"><div><h1>管理项目</h1><p>勾选这台电脑上暂时不用的项目，归档后可随时恢复。</p></div><button className="btn" onClick={onClose} autoFocus>关闭</button></div>
    <ErrorLine msg={error} />
    {projects ? <ProjectManager projects={projects} statuses={statuses} readOnly={isRemote()}
      onArchive={async (ids, archived) => { await api.archiveProjects(ids, archived); await load() }}
      onSync={async () => { await api.scanMerges(); await load() }} /> : <p role="status">正在读取项目…</p>}
  </dialog>
}

export function ProjectManager({ projects, statuses, readOnly = false, onArchive, onSync }: {
  projects: ProjectInfo[]; statuses: MergeSyncStatus[]; readOnly?: boolean
  onArchive: (ids: number[], archived: boolean) => Promise<unknown>; onSync: () => Promise<unknown>
}) {
  const act = useAction()
  const [mode, setMode] = useState<'active' | 'archived'>('active')
  const [query, setQuery] = useState('')
  const [selected, setSelected] = useState<Set<number>>(new Set())
  const [confirm, setConfirm] = useState(false)
  const [notice, setNotice] = useState('')
  const archived = projects.filter(p => !!p.archived_at)
  const visible = projects.filter(p => (mode === 'archived') === !!p.archived_at && `${p.name} ${p.common_dir}`.toLowerCase().includes(query.toLowerCase()))
  const chosen = visible.filter(p => selected.has(p.id))
  const syncs = new Map(statuses.map(s => [s.repo_id, s]))
  const clear = () => { setSelected(new Set()); setConfirm(false); setNotice('') }
  const apply = () => act.run(async () => {
    const ids = chosen.map(p => p.id)
    await onArchive(ids, mode !== 'archived')
    clear(); setNotice(`已${mode === 'archived' ? '恢复' : '归档'} ${ids.length} 个项目`)
  })
  return <>
    <p className="pm-explanation">归档会从小镇、日常待办、菜单栏计数和多设备地图里收起项目。代码、会话、用量历史和验收记录保留；在“已归档”中恢复后重新显示。归档不会停止正在运行的会话。</p>
    {readOnly && <p className="warn-box">请在项目所在的电脑上管理。归档状态会随多设备摘要同步。</p>}
    <div className="pm-tools"><div className="seg" role="group" aria-label="项目范围">
      <button className={mode === 'active' ? 'on' : ''} disabled={act.busy} onClick={() => { setMode('active'); clear() }}>使用中 {projects.length - archived.length}</button>
      <button className={mode === 'archived' ? 'on' : ''} disabled={act.busy} onClick={() => { setMode('archived'); clear() }}>已归档 {archived.length}</button>
    </div><input aria-label="搜索项目" placeholder="搜索项目名或目录" value={query} disabled={act.busy} onChange={e => { setQuery(e.target.value); clear() }} />
      <button className="btn" disabled={readOnly || act.busy} onClick={() => act.run(async () => { await onSync(); setNotice('核对已结束，请查看各项目的结果；无法确认的会保留原状态。') })}>{act.busy ? '处理中…' : '立即核对外部合并'}</button>
    </div>
    <p className="hint">待合并项目每分钟核对远端。只记录已发生的合并，验收仍由你决定。网络或权限失败会显示原因。</p>
    <div className="pm-list" aria-label={mode === 'archived' ? '已归档项目' : '使用中项目'}>
      {visible.length > 0 && <label className="pm-select-all"><input type="checkbox" disabled={readOnly || act.busy} checked={chosen.length === visible.length} onChange={e => { setConfirm(false); setSelected(new Set(e.target.checked ? visible.map(p => p.id) : [])) }} />全选当前显示的 {visible.length} 个项目</label>}
      {visible.map(p => { const sync = syncs.get(p.id); return <label className={`pm-project ${selected.has(p.id) ? 'is-selected' : ''}`} key={p.id}>
        <input type="checkbox" aria-label={`选择项目 ${p.name} ${p.common_dir}`} disabled={readOnly || act.busy} checked={selected.has(p.id)} onChange={e => { setConfirm(false); setSelected(previous => { const next = new Set(previous); if (e.target.checked) next.add(p.id); else next.delete(p.id); return next }) }} />
        <span><strong>{p.name}</strong><small className="pm-path">{p.common_dir.replace(/\/\.git$/, '').replace(/^dir:/, '')}</small>
          <small>{p.open_items} 项未完成 · {p.sessions} 个会话{p.pending > 0 ? ` · 待批准 ${p.pending}` : ''}{p.running > 0 ? ` · 会话状态显示运行中 ${p.running}` : ''}</small>
          {p.archived_at && <small>归档于 {new Date(p.archived_at).toLocaleString('zh-CN')}</small>}
          {sync && <ProjectSyncLine sync={sync} />}
        </span>
      </label> })}
      {visible.length === 0 && <p className="pm-empty">{query ? '没有匹配的项目' : mode === 'archived' ? '还没有归档项目' : '当前项目都已归档，可切换到“已归档”恢复'}</p>}
    </div>
    <ErrorLine msg={act.error} /><p className="hint" role="status">{notice}</p>
    <div className="pm-footer"><span>已选择 {chosen.length} 个项目</span>{confirm ? <div className="pm-confirm">
      <p>将归档：{chosen.map(p => p.name).join('、')}。{chosen.some(p => p.pending || p.running) ? '其中仍有待批准请求或显示运行中的会话，归档后也会从日常视图收起。' : ''}</p>
      <button className="btn primary" disabled={act.busy || chosen.length === 0} onClick={apply}>确认归档</button><button className="btn" disabled={act.busy} onClick={() => setConfirm(false)}>取消</button>
    </div> : <button className="btn primary" disabled={readOnly || act.busy || chosen.length === 0} onClick={() => mode === 'archived' ? apply() : setConfirm(true)}>{mode === 'archived' ? '恢复所选项目' : '归档所选项目'}</button>}</div>
  </>
}

export function ProjectSyncLine({ sync }: { sync: MergeSyncStatus }) {
  if (sync.state === 'idle') return <small className="muted">外部合并：当前没有待核对的合并</small>
  if (sync.state === 'missing') return <small className="muted">外部合并：原项目目录已失效，历史记录保留；可自行归档</small>
  return <small className={sync.error ? 'pm-sync-error' : 'muted'}>外部合并：{sync.checked_at && <time dateTime={sync.checked_at} title={new Date(sync.checked_at).toLocaleString('zh-CN')}>{ago(sync.checked_at, new Date().toISOString())}核对 · </time>}{sync.error || `${sync.remote || '本地'} / ${sync.target_ref}`}{sync.account ? ` · 使用账号 ${sync.account}` : ''}{sync.pr_note ? `；${sync.pr_note}` : ''}</small>
}
