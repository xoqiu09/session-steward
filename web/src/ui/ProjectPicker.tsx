import { useEffect, useId, useLayoutEffect, useRef, useState, type KeyboardEvent } from 'react'
import type { Repo } from '../types'
import { projectGroups, projectName, projectPath, readRecentProjects, rememberProject, RECENT_PROJECTS_KEY } from './projectPickerModel'
import './projectPicker.css'

type Value = number | 'all'
type Props = {
  repos: Repo[]
  value: Value | null
  onChange: (value: Value) => void
  includeAll?: boolean
  className?: string
}

/** 首页筛选和新建会话共用；搜索与最近使用只保存在当前 App／浏览器。 */
export function ProjectPicker({ repos, value, onChange, includeAll = false, className = '' }: Props) {
  const [open, setOpen] = useState(false)
  const [recent, setRecent] = useState(readRecentProjects)
  const trigger = useRef<HTMLButtonElement>(null)
  const restoreFocus = useRef(false)
  const selected = repos.find(r => r.id === value)
  const text = value === 'all' && includeAll ? '全部项目' : selected ? projectName(repos, selected) : '请选择项目'
  useEffect(() => {
    if (!open && restoreFocus.current) { restoreFocus.current = false; trigger.current?.focus({ preventScroll: true }) }
  }, [open])
  const close = () => { restoreFocus.current = true; setOpen(false) }
  const choose = (next: Value) => {
    if (typeof next === 'number') {
      const ids = rememberProject(recent, next)
      setRecent(ids)
      try { localStorage.setItem(RECENT_PROJECTS_KEY, JSON.stringify(ids)) } catch { /* 私密模式仍可选择。 */ }
    }
    onChange(next); close()
  }
  return <div className={`project-picker ${className}`}>
    <button ref={trigger} type="button" className="project-picker-trigger" aria-label={`项目：${text}`} aria-haspopup="dialog" aria-expanded={open}
      title={selected ? projectPath(selected) : text} onClick={() => setOpen(true)}
      onKeyDown={e => { if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); setOpen(true) } }}>
      <span>{text}</span><span aria-hidden="true">⌄</span>
    </button>
    {open && <ProjectChoices repos={repos} value={value} includeAll={includeAll} recent={recent} onChoose={choose} onClose={close} />}
  </div>
}

function ProjectChoices({ repos, value, includeAll, recent, onChoose, onClose }: Pick<Props, 'repos' | 'value' | 'includeAll'> & {
  recent: number[]; onChoose: (value: Value) => void; onClose: () => void
}) {
  const dialog = useRef<HTMLDialogElement>(null)
  const search = useRef<HTMLInputElement>(null)
  const id = useId()
  const [query, setQuery] = useState('')
  const groups = projectGroups(repos, query, recent)
  const showAll = includeAll && (!query.trim() || '全部项目'.includes(query.trim()))
  const options: Value[] = [...(showAll ? ['all' as const] : []), ...groups.flatMap(group => group.repos.map(r => r.id))]
  const [active, setActive] = useState(() => Math.max(0, options.indexOf(value ?? 'all')))
  const activeIndex = Math.min(active, Math.max(0, options.length - 1))
  useLayoutEffect(() => {
    const node = dialog.current!
    node.showModal(); search.current?.focus()
    return () => node.close()
  }, [])
  useEffect(() => { document.getElementById(`${id}-option-${activeIndex}`)?.scrollIntoView({ block: 'nearest' }) }, [id, activeIndex, query])
  const keys = (e: KeyboardEvent<HTMLInputElement>) => {
    if ((e.key === 'ArrowDown' || e.key === 'ArrowUp') && options.length) {
      e.preventDefault(); setActive((activeIndex + (e.key === 'ArrowDown' ? 1 : -1) + options.length) % options.length)
    } else if (e.key === 'Enter') {
      e.preventDefault()
      if (options[activeIndex] != null) onChoose(options[activeIndex])
    }
  }
  const option = (next: Value, index: number, repo?: Repo) => <button type="button" role="option" id={`${id}-option-${index}`} key={next}
    aria-selected={next === value} tabIndex={-1} className={`project-picker-option${index === activeIndex ? ' is-active' : ''}`}
    onPointerMove={() => setActive(index)} onClick={() => onChoose(next)}>
    <span><strong>{repo?.name ?? '全部项目'}</strong><small>{repo ? projectPath(repo) : '查看本机所有项目'}</small></span>
    {next === value && <span className="project-picker-check" aria-label="已选择">✓</span>}
  </button>
  let offset = showAll ? 1 : 0
  return <dialog ref={dialog} className="project-picker-dialog" aria-labelledby={`${id}-title`} onCancel={e => { e.preventDefault(); onClose() }}
    onClick={e => { if (e.target !== e.currentTarget) return; const r = e.currentTarget.getBoundingClientRect(); if (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom) onClose() }}>
    <div className="project-picker-head"><h2 id={`${id}-title`}>选择项目</h2><button type="button" className="btn small" onClick={onClose} aria-label="关闭项目选择">×</button></div>
    <div className="project-picker-search">
      <input ref={search} role="combobox" aria-label="搜索项目" aria-autocomplete="list" aria-expanded="true" aria-controls={`${id}-list`}
        aria-activedescendant={options.length ? `${id}-option-${activeIndex}` : undefined} placeholder="搜索项目名或目录" value={query}
        onChange={e => { setQuery(e.target.value); setActive(0) }} onKeyDown={keys} />
      {query && <button type="button" className="btn small" onClick={() => { setQuery(''); setActive(0); search.current?.focus() }}>清空</button>}
    </div>
    <p className="project-picker-count" role="status">{query.trim() ? `找到 ${options.length} 项` : `${repos.length} 个项目 · 输入名称或目录快速查找`}</p>
    <div className="project-picker-options" role="listbox" aria-label="可选项目" id={`${id}-list`}>
      {showAll && option('all', 0)}
      {groups.map(group => {
        const start = offset; offset += group.repos.length
        return <div role="group" aria-label={group.label} key={group.label}><div className="project-picker-group">{group.label}</div>
          {group.repos.map((repo, i) => option(repo.id, start + i, repo))}</div>
      })}
      {options.length === 0 && <p className="project-picker-empty">没有找到匹配的项目，试试更短的名称或目录。</p>}
    </div>
    <p className="project-picker-help">↑ ↓ 选择 · Enter 确认 · Esc 取消</p>
  </dialog>
}
