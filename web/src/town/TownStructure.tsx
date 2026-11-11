import { useEffect, useId, useRef, useState, type KeyboardEvent } from 'react'
import { STRUCTURE_BASIS, STRUCTURE_OBJECTS, STRUCTURE_PAGES, type StructurePage } from './structureContent'
import './townStructure.css'
import { ProjectRoomDialog, type ProjectRoomContext } from './ProjectRoomDialog'
import { hasNativeModal } from '../ui/modalLayers'

function Arrow({ branch = false }: { branch?: boolean }) {
  return <svg className={branch ? 'structure-branch-arrow' : 'structure-arrow'} width="28" height="28" viewBox="0 0 28 28" aria-hidden="true">
    <path d="M3 14h20m-6-6 6 6-6 6" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
}

function StructureDiagram({ page }: { page: StructurePage }) {
  return <figure className={`structure-diagram is-${page.id}`} aria-label={`${page.label}关系图`}>
    <ol className="structure-chain">
      {page.nodes.map((node, index) => {
        const edge = page.edges.find(e => e.from === node.id && page.nodes.some(n => n.id === e.to))
        return <li key={node.id} className="structure-step">
          <span className="structure-step-no" aria-hidden="true">{String(index + 1).padStart(2, '0')}</span>
          <h4>{node.title}</h4><small>{node.caption}</small><p>{node.text}</p>
          {edge && <span className="structure-connection"><Arrow /><span>{edge.label}</span></span>}
        </li>
      })}
    </ol>
    {page.readers && <>
      <figcaption className="structure-fork-label">同一份管理状态，分别被读取 <span>实线：常规读取 · 虚线：有条件读取</span></figcaption>
      <ul className="structure-readers">
        {page.readers.map(node => {
          const edge = page.edges.find(e => e.to === node.id)!
          return <li key={node.id} className={edge.conditional ? 'is-conditional' : undefined}>
            <div className="structure-reader-link"><Arrow branch /><span>{edge.label}</span></div>
            <h4>{node.title}</h4><small>{node.caption}</small><p>{node.text}</p>
          </li>
        })}
      </ul>
    </>}
  </figure>
}

/** 内置、只读的 SS 样本。没有快照、API、文件读取或业务操作依赖。 */
function SSStructureSample({ onClose }: { onClose: () => void }) {
  const [tab, setTab] = useState(STRUCTURE_PAGES[0].id)
  const page = STRUCTURE_PAGES.find(p => p.id === tab)!
  const id = useId()
  const panel = useRef<HTMLElement>(null)
  const close = useRef<HTMLButtonElement>(null)
  useEffect(() => { close.current?.focus({ preventScroll: true }) }, [])
  useEffect(() => {
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (hasNativeModal()) return
      if (e.key === 'Escape') { e.preventDefault(); e.stopImmediatePropagation(); onClose(); return }
      if (e.key !== 'Tab') return
      const items = [...(panel.current?.querySelectorAll<HTMLElement>('button:not([disabled]):not([tabindex="-1"]), summary') ?? [])]
      const first = items[0], last = items[items.length - 1]
      if (e.shiftKey && (document.activeElement === first || !panel.current?.contains(document.activeElement))) { e.preventDefault(); last?.focus() }
      else if (!e.shiftKey && (document.activeElement === last || !panel.current?.contains(document.activeElement))) { e.preventDefault(); first?.focus() }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [onClose])
  const tabKeys = (e: KeyboardEvent<HTMLButtonElement>, index: number) => {
    const next = e.key === 'ArrowRight' ? (index + 1) % STRUCTURE_PAGES.length : e.key === 'ArrowLeft' ? (index + STRUCTURE_PAGES.length - 1) % STRUCTURE_PAGES.length : e.key === 'Home' ? 0 : e.key === 'End' ? STRUCTURE_PAGES.length - 1 : -1
    if (next < 0) return
    e.preventDefault(); setTab(STRUCTURE_PAGES[next].id)
    panel.current?.querySelectorAll<HTMLButtonElement>('[role="tab"]')[next]?.focus()
  }
  return <div className="town-structure-scrim town-world-ui" onPointerDown={e => e.stopPropagation()} onClick={e => e.stopPropagation()}>
    <aside ref={panel} className="town-guide town-structure" role="dialog" aria-modal="true" aria-labelledby={`${id}-title`} lang="zh-CN">
      <header className="structure-header">
        <div><p className="structure-eyebrow">小镇里的项目说明</p><h2 id={`${id}-title`}>Session Steward 结构说明 <span>· 首版样本</span></h2></div>
        <button ref={close} type="button" onClick={onClose} aria-label="关闭结构说明" title="关闭（Esc）">关闭 <kbd>Esc</kbd></button>
      </header>
      <div className="structure-meta"><span>整理于 {STRUCTURE_BASIS.date}</span><span>依据 {STRUCTURE_BASIS.commit}</span><span>{STRUCTURE_BASIS.category}</span></div>
      <p className="structure-scope">这是 SS 自身的固定样本，选择其他房屋也不会切换内容。</p>
      <div className="structure-tabs" role="tablist" aria-label="结构说明内容">
        {STRUCTURE_PAGES.map((p, i) => <button key={p.id} type="button" role="tab" id={`${id}-tab-${p.id}`} aria-controls={`${id}-panel-${p.id}`} aria-selected={tab === p.id} tabIndex={tab === p.id ? 0 : -1} onKeyDown={e => tabKeys(e, i)} onClick={() => setTab(p.id)}>{p.label}</button>)}
      </div>
      <div key={page.id} className="structure-page" role="tabpanel" id={`${id}-panel-${page.id}`} aria-labelledby={`${id}-tab-${page.id}`}>
        <h3>{page.title}</h3><p className="structure-lead">{page.lead}</p>
        <StructureDiagram page={page} />
        {page.id === 'overview' && <section className="structure-objects" aria-label="四个核心对象">
          <h3>四个对象，把“事情”和“会话”连起来</h3>
          <p className="structure-object-relation">WorkItem ← Run → Session；Approval 关联需要决定的工作项或会话。</p>
          <dl>{STRUCTURE_OBJECTS.map(object => <div key={object.name}><dt>{object.name}<span>{object.label}</span></dt><dd>{object.text}</dd></div>)}</dl>
        </section>}
        <div className="structure-notes">{page.notes.map(note => <section key={note.title}><h4>{note.title}</h4><p>{note.text}</p></section>)}</div>
        <details className="structure-evidence"><summary>查看源码依据 <span>{page.evidence.length} 处 · {STRUCTURE_BASIS.commit}</span></summary>
          <p>以下位置对应整理时的源码版本。路径为仓库内相对位置，仅作核对线索。</p>
          <ul>{page.evidence.map(ref => <li key={`${ref.path}:${ref.line}`}><code>{ref.path}:{ref.line}</code><span>{ref.explains}</span></li>)}</ul>
        </details>
      </div>
    </aside>
  </div>
}

/** The toolbar retains the SS teaching sample; room entries read their own project. */
export function TownStructure({ onClose, project }: { onClose: () => void; project?: ProjectRoomContext }) {
  return project ? <ProjectRoomDialog project={project} onClose={onClose} /> : <SSStructureSample onClose={onClose} />
}
