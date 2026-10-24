import { useEffect, useMemo, useState } from 'react'
import { Background, Controls, Handle, MarkerType, Position, ReactFlow, useReactFlow, type Edge, type Node, type NodeProps } from '@xyflow/react'
import '@xyflow/react/dist/style.css'
import type { Session, Snapshot, WorkItem } from './types'
import { type Group, ago, itemStatusLabel, layers, itemSignal, projectAttention, sessionRepo, sessionsFor, type Signal } from './model'
import { AgentBadge } from './bits'
import { attemptSummary, progressView, sourceTag } from './brief'

const CARD_W = 260
const CARD_H = 168
const GAP_X = 50
const GAP_Y = 14
const GROUP_PAD = 16
const HEADER_H = 36
const MAX_ROWS = 3 // 同一层超过这个数量就换到下一列，避免一列过长

type ItemData = { item: WorkItem; sessions: Session[]; signal: Signal; progress: ReturnType<typeof progressView>; attempts: string; now: string; selected: boolean; onSelect: (id: string) => void }
type HeadData = { group: Group; collapsed: boolean; toggle: (k: string) => void; counts: Record<string, number>; actions: number; running: number; missing: number; stale: number; onAttribution: () => void }

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
  const { group, collapsed, counts, actions, running, missing, stale } = data
  return (
    <button className="group-head" onClick={() => data.toggle(group.key)} aria-expanded={!collapsed}>
      <span className="caret">{collapsed ? '▸' : '▾'}</span><strong>{group.name}</strong>
      <span className="muted">工作项 {group.items.length}</span>
      {running > 0 && <span className="pill st-in_progress">Agent 运行 {running}</span>}
      {actions > 0 && <span className="pill warn">待你处理 {actions}</span>}
      {counts.blocked > 0 && <span className="pill st-blocked">阻塞 {counts.blocked}</span>}
      {missing > 0 && <span className="pill muted" title="执行中或待验收但没有进展回报">无回报 {missing}</span>}
      {stale > 0 && <span className="pill warn" title="回报之后仍有较多新活动">可能过期 {stale}</span>}
      {group.sessions.length > 0 && <span className="pill muted link" role="link" tabIndex={0} title="未归属会话不单独占卡，在归属面板按线索批量处理"
        onClick={(e) => { e.stopPropagation(); data.onAttribution() }}
        onKeyDown={(e) => { if (e.key === 'Enter') { e.stopPropagation(); e.preventDefault(); data.onAttribution() } }}>＋{group.sessions.length} 个会话待归属</span>}
    </button>
  )
}

function GroupBox() {
  return <div className="group-box" />
}

// 项目切换时回到可读比例；状态更新保留用户的平移与缩放。适应全图由左下角按钮控制。
function ReadableViewport({ layoutKey }: { layoutKey: string }) {
  const rf = useReactFlow()
  useEffect(() => {
    const t = window.setTimeout(() => rf.setViewport({ x: 24, y: 20, zoom: 0.85 }, { duration: 200 }), 30)
    return () => window.clearTimeout(t)
  }, [layoutKey, rf])
  return null
}

const nodeTypes = { item: ItemNode, head: HeaderNode, box: GroupBox }

export function Canvas(props: {
  snap: Snapshot
  groups: Group[]
  selected: string | null
  onSelectItem: (id: string) => void
  onOpenAttribution: () => void
  expandAll: boolean
}) {
  const { snap, groups, selected, expandAll } = props
  // 默认折叠：没有活跃事项的项目
  const [toggled, setToggled] = useState<Record<string, boolean>>({})
  const isCollapsed = (g: Group) => {
    if (g.key in toggled) return toggled[g.key]
    if (expandAll) return false
    // 只有待开始工作项或只有未归属会话的项目默认折叠；未归属会话在标题行显示数量
    return !g.items.some((w) => w.status !== 'todo')
  }
  const toggle = (k: string) => {
    const g = groups.find((x) => x.key === k)
    const cur = g ? isCollapsed(g) : false
    setToggled((t) => ({ ...t, [k]: !cur }))
  }

  const { nodes, edges } = useMemo(() => {
    const nodes: Node[] = []
    const edges: Edge[] = []
    const deps = snap.deps ?? []
    let y = 0
    for (const g of groups) {
      const collapsed = isCollapsed(g)
      const counts: Record<string, number> = { in_progress: 0, review: 0, blocked: 0 }
      for (const w of g.items) counts[w.status] = (counts[w.status] ?? 0) + 1
      nodes.push({ id: `head:${g.key}`, type: 'head', position: { x: 0, y }, data: { group: g, collapsed, toggle, counts, actions: projectAttention(snap, g.repoId), running: (snap.sessions ?? []).filter((s) => sessionRepo(snap, s) === g.repoId && s.freshness === 'live' && s.state === 'running').length, missing: g.items.filter((w) => ['in_progress', 'review', 'blocked'].includes(w.status) && progressView(snap, w).empty).length, stale: g.items.filter((w) => !!w.brief?.stale).length, onAttribution: props.onOpenAttribution }, draggable: false, selectable: false })
      if (collapsed || g.items.length === 0) {
        y += HEADER_H + 20
        continue
      }
      const top = y + HEADER_H
      const lay = layers(g.items, deps)
      // 每层内按状态排序：执行中、阻塞、待验收优先
      const order: Record<string, number> = { blocked: 0, in_progress: 1, review: 2, todo: 3, done: 4, abandoned: 5 }
      const cols = new Map<number, WorkItem[]>()
      for (const w of g.items) {
        const l = lay.get(w.id) ?? 0
        ;(cols.get(l) ?? cols.set(l, []).get(l)!).push(w)
      }
      let colX = 0
      let maxRows = 0
      const layerKeys = [...cols.keys()].sort((a, b) => a - b)
      for (const l of layerKeys) {
        const list = cols.get(l)!.sort((a, b) => order[a.status] - order[b.status] || a.id.localeCompare(b.id))
        const sub = Math.ceil(list.length / MAX_ROWS)
        list.forEach((w, i) => {
          const c = Math.floor(i / MAX_ROWS)
          const r = i % MAX_ROWS
          const sessions = sessionsFor(snap, w.id).filter((s) => s.data_source === 'live' && s.state !== 'ended')
          nodes.push({
            id: w.id,
            type: 'item',
            position: { x: GROUP_PAD + colX + c * (CARD_W + 16), y: top + GROUP_PAD + r * (CARD_H + GAP_Y) },
            data: { item: w, sessions, signal: itemSignal(snap, w), progress: progressView(snap, w), attempts: attemptSummary(snap, w.id), now: snap.now, selected: selected === w.id, onSelect: props.onSelectItem },
            draggable: false,
          })
        })
        maxRows = Math.max(maxRows, Math.min(list.length, MAX_ROWS))
        colX += sub * (CARD_W + 16) + GAP_X
      }
      const h = Math.max(1, maxRows) * (CARD_H + GAP_Y) + GROUP_PAD * 2
      nodes.unshift({
        id: `box:${g.key}`, type: 'box', position: { x: 0, y: top }, data: {},
        style: { width: Math.max(colX + GROUP_PAD, 620), height: h, zIndex: -1 }, draggable: false, selectable: false,
      })
      y = top + h + 28
    }
    const visible = new Set(nodes.map((n) => n.id))
    for (const d of deps) {
      if (!visible.has(d.upstream) || !visible.has(d.downstream)) continue
      edges.push({
        id: `${d.upstream}->${d.downstream}`,
        source: d.upstream,
        target: d.downstream,
        animated: !d.satisfied,
        label: d.cond === 'merged' ? '需合并' : undefined,
        className: d.satisfied ? 'edge-ok' : 'edge-wait',
        markerEnd: { type: MarkerType.ArrowClosed },
      })
    }
    return { nodes, edges }
  }, [snap, groups, selected, toggled, expandAll])

  if (!groups.length) {
    return (
      <div className="empty">
        <p>还没有工作项或活跃会话。</p>
        <p className="muted">安装 hooks 后打开一个 Claude Code 或 Codex 会话，它会出现在这里；也可以在右侧新建工作项。</p>
      </div>
    )
  }
  return (
    <ReactFlow nodes={nodes} edges={edges} nodeTypes={nodeTypes} defaultViewport={{ x: 24, y: 20, zoom: 0.85 }} fitViewOptions={{ padding: 0.1, maxZoom: 1 }}
      minZoom={0.15} nodesConnectable={false} proOptions={{ hideAttribution: true }}>
      <Background gap={20} size={1} />
      <Controls showInteractive={false} />
      <ReadableViewport layoutKey={groups.map((g) => `${g.key}:${isCollapsed(g)}`).join('|')} />
    </ReactFlow>
  )
}

