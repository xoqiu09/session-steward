import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Background, Handle, MarkerType, Position, ReactFlow, useReactFlow, type Edge, type Node, type NodeProps } from '@xyflow/react'
import '@xyflow/react/dist/style.css'
import type { Session, Snapshot, WorkItem } from './types'
import { type Group, ago, itemStatusLabel, itemSignal, projectQueueCounts, sessionRepo, sessionsFor, type Signal } from './model'
import { AgentBadge } from './bits'
import { attemptSummary, progressView, sourceTag } from './brief'
import { canvasLayout, canvasReadingViewport, CARD_W, CARD_H, CANVAS_ZOOM, type CanvasProject } from './canvasLayout'
import './canvas.css'

type ItemData = { item: WorkItem; sessions: Session[]; signal: Signal; progress: ReturnType<typeof progressView>; attempts: string; now: string; selected: boolean; onSelect: (id: string) => void }
type HeadData = { group: Group; collapsed: boolean; toggle: (key: string) => void; counts: Record<string, number>; actions: number; running: number; onAttribution: () => void }

function ItemNode({ data }: NodeProps<Node<ItemData>>) {
  const { item, sessions, signal, progress, now, selected } = data
  return (
    <div className={`card st-${item.status} ${selected ? 'sel' : ''} ${item.ready ? '' : 'waiting'}`}
      onClick={() => data.onSelect(item.id)} role="button" tabIndex={0} aria-label={`${item.id} ${item.title}`}
      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); data.onSelect(item.id) } }}>
      <Handle type="target" position={Position.Left} />
      <div className="card-top"><span className="card-id">{item.id}</span><span className={`pill st-${item.status}`}>{itemStatusLabel[item.status]}</span></div>
      <div className="card-title" title={item.title}>{item.title}</div>
      <div className={`card-signal signal-${signal.tone}`} title={signal.reason}><strong>{signal.label}</strong> · {signal.reason}</div>
      <div className={`card-progress ${progress.empty ? 'no-report' : ''}`} title={progress.text}>{progress.text}</div>
      {progress.field && <div className="card-src">
        <span className={`src ${sourceTag(progress.field).cls}`}>{sourceTag(progress.field).mark} {sourceTag(progress.field).label}</span>
        <span>{ago(progress.field.at, now)}</span>
        {progress.stale && <span className="stale" title="这条回报之后仍有较多新活动，内容可能已过期">⏱ 可能过期</span>}
      </div>}
      <div className="card-foot">
        {sessions.length ? sessions.slice(0, 2).map((s) => <span className="runner" key={s.id} title={s.title || s.provider_session_id}><AgentBadge provider={s.provider} /><small>#{s.id}</small></span>) : <span className="muted">待分配 Agent</span>}
        {sessions.length > 2 && <small>+{sessions.length - 2}</small>}
        <small className="muted">{data.attempts}</small>
        <span className="card-time">{ago(sessions[0]?.last_activity_at || item.updated_at, now)}</span>
      </div>
      <Handle type="source" position={Position.Right} />
    </div>
  )
}

function HeaderNode({ data }: NodeProps<Node<HeadData>>) {
  const { group, collapsed, counts, actions, running } = data
  return <div className="canvas-project-head">
    <button className="canvas-project-toggle nodrag nopan" onClick={() => data.toggle(group.key)} aria-expanded={!collapsed} aria-label={`${collapsed ? '展开' : '收起'}项目 ${group.name}`}>
      <span aria-hidden="true">{collapsed ? '▸' : '▾'}</span><strong title={group.name}>{group.name}</strong>
      <span className="canvas-project-total">{group.items.length} 项工作</span>
    </button>
    <div className="canvas-project-meta">
      {running > 0 && <span className="canvas-run">运行中 {running}</span>}
      {actions > 0 && <span className="canvas-action">待决定 {actions}</span>}
      {counts.review > 0 && <span className="canvas-review">待验收 {counts.review}</span>}
      {counts.blocked > 0 && <span className="canvas-blocked">受阻 {counts.blocked}</span>}
      {running === 0 && actions === 0 && !counts.review && !counts.blocked && <span>{group.items.length ? '展开查看工作与依赖' : '暂无工作项'}</span>}
      {group.sessions.length > 0 && <button className="canvas-attribution nodrag nopan" onClick={data.onAttribution}>待归属会话 {group.sessions.length}</button>}
    </div>
  </div>
}
function GroupBox() { return <div className="canvas-project-box" /> }
const nodeTypes = { item: ItemNode, head: HeaderNode, box: GroupBox }

export function Canvas(props: { snap: Snapshot; groups: Group[]; selected: string | null; onSelectItem: (id: string) => void; onOpenAttribution: () => void; expandAll: boolean }) {
  const { snap, groups, selected, expandAll } = props
  const rf = useReactFlow()
  const surface = useRef<HTMLDivElement>(null)
  const [width, setWidth] = useState(0)
  const [ready, setReady] = useState(false)
  const [zoom, setZoom] = useState(CANVAS_ZOOM)
  const [focusKey, setFocusKey] = useState('')
  const [showDependencies, setShowDependencies] = useState(true)
  const [toggled, setToggled] = useState<Record<string, boolean>>({})
  const seeded = useRef<string | null>(null)
  const pendingProject = useRef<string | null>(null)
  const lastSelection = useRef<string | null>(null)
  // Stable project positions are more useful here than reordering the map on each activity event.
  const layoutGroups = useMemo(() => [...groups].sort((a, b) => a.name.localeCompare(b.name, 'zh-CN', { numeric: true }) || a.key.localeCompare(b.key)), [groups])
  const collapsed = useMemo(() => new Set(groups.filter(g => g.key in toggled ? toggled[g.key] : !expandAll && !g.items.some(w => w.status !== 'todo')).map(g => g.key)), [groups, toggled, expandAll])
  const toggle = useCallback((key: string) => {
    pendingProject.current = key
    setFocusKey(key)
    setToggled(previous => {
      const g = groups.find(g => g.key === key)
      const current = key in previous ? previous[key] : !expandAll && !g?.items.some(w => w.status !== 'todo')
      return { ...previous, [key]: !current }
    })
  }, [groups, expandAll])
  useEffect(() => {
    const element = surface.current
    if (!element) return
    const measure = () => setWidth(Math.round(element.getBoundingClientRect().width))
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(element)
    return () => observer.disconnect()
  }, [])
  const projects = useMemo(() => canvasLayout(layoutGroups, snap.deps ?? [], width || 900, collapsed), [layoutGroups, snap.deps, width, collapsed])
  const membership = groups.map(g => g.key).sort().join('|')
  const read = useCallback((rect?: { x: number; y: number }) => {
    if (rect) void rf.setViewport(canvasReadingViewport(rect, width), { duration: 200 })
  }, [rf, width])
  useEffect(() => {
    if (!ready || width <= 0 || !projects.length || seeded.current === membership) return
    seeded.current = membership
    read(projects[0])
  }, [ready, width, projects, membership, read])
  useEffect(() => {
    if (!pendingProject.current) return
    read(projects.find(p => p.group.key === pendingProject.current))
    pendingProject.current = null
  }, [projects, read])

  const { nodes, edges } = useMemo(() => {
    const nodes: Node[] = [], edges: Edge[] = []
    const running = new Map<number | null, number>()
    for (const s of snap.sessions ?? []) if (s.freshness === 'live' && s.state === 'running') {
      const repo = sessionRepo(snap, s); running.set(repo, (running.get(repo) ?? 0) + 1)
    }
    for (const p of projects) {
      const g = p.group, counts: Record<string, number> = {}
      for (const w of g.items) counts[w.status] = (counts[w.status] ?? 0) + 1
      nodes.push({ id: `box:${g.key}`, type: 'box', position: { x: p.x, y: p.y }, data: {}, style: { width: p.width, height: p.height, zIndex: -1 }, draggable: false, selectable: false })
      nodes.push({ id: `head:${g.key}`, type: 'head', position: { x: p.x + 16, y: p.y + 12 }, style: { width: p.width - 32 }, data: { group: g, collapsed: p.collapsed, toggle, counts, actions: projectQueueCounts(snap, g.repoId).action, running: running.get(g.repoId) ?? 0, onAttribution: props.onOpenAttribution }, draggable: false, selectable: false })
      for (const { item, x, y } of p.cards) nodes.push({
        id: item.id, type: 'item', position: { x, y }, style: { width: CARD_W, height: CARD_H }, draggable: false,
        data: { item, sessions: sessionsFor(snap, item.id).filter(s => s.data_source === 'live' && s.state !== 'ended'), signal: itemSignal(snap, item), progress: progressView(snap, item), attempts: attemptSummary(snap, item.id), now: snap.now, selected: selected === item.id, onSelect: props.onSelectItem },
      })
    }
    const visible = new Set(nodes.map(n => n.id))
    for (const d of snap.deps ?? []) if (visible.has(d.upstream) && visible.has(d.downstream)) edges.push({
      id: `${d.upstream}->${d.downstream}`, source: d.upstream, target: d.downstream, animated: false,
      label: d.cond === 'merged' ? '需合并' : undefined, className: d.satisfied ? 'edge-ok' : 'edge-wait', markerEnd: { type: MarkerType.ArrowClosed },
    })
    return { nodes, edges }
  }, [projects, snap, selected, toggle, props.onSelectItem, props.onOpenAttribution])
  const chosenProject: CanvasProject | undefined = projects.find(p => p.group.key === focusKey)
  const selectedCard = projects.flatMap(p => p.cards).find(c => c.item.id === selected)
  useEffect(() => {
    if (!selected) { lastSelection.current = null; return }
    const key = `${selected}:${width}`
    if (!selectedCard || lastSelection.current === key) return
    lastSelection.current = key
    read(selectedCard)
  }, [selected, selectedCard, width, read])
  const projectChange = (key: string) => { setFocusKey(key); read(projects.find(p => p.group.key === key)) }
  return <section className="work-canvas" aria-label="项目工作画布">
    <header className="canvas-toolbar">
      <div className="canvas-heading"><h2>工作画布</h2><span>{groups.length} 个项目 · {groups.reduce((n, g) => n + g.items.length, 0)} 项工作</span></div>
      <div className="canvas-tools">
        <select aria-label="定位画布项目" value={chosenProject ? focusKey : ''} onChange={e => projectChange(e.target.value)}>
          <option value="" disabled>跳转到项目…</option>{projects.map(p => <option key={p.group.key} value={p.group.key}>{p.group.name}</option>)}
        </select>
        <button className="btn small" onClick={() => read(chosenProject ?? projects[0])} disabled={!projects.length}>适合阅读</button>
        <button className="btn small" onClick={() => { void rf.fitView({ padding: 0.12, maxZoom: 1, duration: 200 }) }} disabled={!projects.length}>全景</button>
        <button className="btn small" onClick={() => read(selectedCard)} disabled={!selectedCard}>定位选中</button>
      </div>
    </header>
    <div className="canvas-surface" ref={surface}>
      {groups.length ? <ReactFlow nodes={nodes} edges={showDependencies ? edges : []} nodeTypes={nodeTypes}
        defaultViewport={{ x: 24, y: 20, zoom: CANVAS_ZOOM }} minZoom={0.15} maxZoom={1.5}
        onInit={() => setReady(true)} onViewportChange={v => setZoom(v.zoom)} nodesConnectable={false} onlyRenderVisibleElements
        proOptions={{ hideAttribution: true }}>
        <Background gap={24} size={1} color="#d5d9d1" />
      </ReactFlow> : <div className="empty"><p>当前筛选下没有工作项或活跃会话。</p><p className="muted">调整顶部筛选，或新建工作项后查看。</p></div>}
      <div className="canvas-bottom-tools">
        <div className="canvas-zoom" role="group" aria-label="画布缩放">
          <button aria-label="缩小画布" title="缩小" onClick={() => { void rf.zoomOut({ duration: 150 }) }}>−</button>
          <output aria-label="当前画布缩放">{Math.round(zoom * 100)}%</output>
          <button aria-label="放大画布" title="放大" onClick={() => { void rf.zoomIn({ duration: 150 }) }}>＋</button>
        </div>
        <label className="canvas-dependencies"><input type="checkbox" checked={showDependencies} onChange={e => setShowDependencies(e.target.checked)} />显示依赖{edges.length ? ` ${edges.length}` : ''}</label>
      </div>
    </div>
    <p className={`canvas-caption ${zoom < 0.65 ? 'canvas-overview-hint' : ''}`} role="status">{zoom < 0.65 ? '当前为全景。用“跳转到项目”或“适合阅读”看清任务内容。' : '拖动空白移动 · 滚轮缩放 · 点卡片查看详情；连线表示任务依赖。'}</p>
  </section>
}
