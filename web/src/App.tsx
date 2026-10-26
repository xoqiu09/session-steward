import { useEffect, useMemo, useState } from 'react'
import { ReactFlowProvider } from '@xyflow/react'
import { useSnapshot } from './api'
import { Canvas } from './Canvas'
import { Overview } from './Overview'
import { repoLabel } from './workbench'
import { ItemDetail, WorkItemsPanel, SessionDetail, SessionList } from './Panels'
import { Queue } from './Queue'
import { groupByRepo, itemStatusLabel, projectQueueCounts, providerLabel, queueCounts, sessionBuckets, type SessionScope } from './model'
import type { ItemStatus } from './types'
import { AttributionPanel } from './AttributionPanel'
import { scopedAttributions } from './attribution'
import { actorLabel, liveSummary, parseDeepLink, projectActorRows, resolveDeepLink, type Deep } from './live'
import { NewManaged } from './Managed'
import { ReviewPanel } from './P2'
import { isRemote, remoteReadOnlyMessage } from './access'
import { TownView } from './town/TownView'
import { fullPanelHref, kioskHref, parseTownRoute } from './town/route'

type Tab = 'queue' | 'items' | 'sessions' | 'launch' | 'review'
type Sel = { kind: 'item'; id: string } | { kind: 'session'; id: number } | null

export default function App() {
  const { snap, conn } = useSnapshot()
  const [tab, setTab] = useState<Tab>('queue')
  const [queueFocus, setQueueFocus] = useState<'action' | 'review'>('action')
  const [sel, setSel] = useState<Sel>(null)
  const [query, setQuery] = useState('')
  const [showDone, setShowDone] = useState(false)
  const [repoId, setRepoId] = useState<number | 'all'>('all')
  const [provider, setProvider] = useState<string>('all')
  const [route, setRoute] = useState(() => parseTownRoute(window.location.search, window.location.hash))
  const [view, setView] = useState<'overview' | 'town' | 'canvas' | 'list'>(() => (route.town ? 'town' : 'overview'))
  // 桌面模式里点告示栏、验收台时，在抽屉里打开关注队列。
  const [kioskQueue, setKioskQueue] = useState(false)
  const [expandAll, setExpandAll] = useState(false)
  const [sessionScope, setSessionScope] = useState<SessionScope>('recent')
  const [attributionOpen, setAttributionOpen] = useState(false)

  const [deep, setDeep] = useState<Deep>(() => parseDeepLink(window.location.hash))
  useEffect(() => {
    const on = () => {
      setDeep(parseDeepLink(window.location.hash))
      const r = parseTownRoute(window.location.search, window.location.hash)
      if (r.town) setView('town')
      if (r.kiosk) setRoute(r)
    }
    window.addEventListener('hashchange', on)
    return () => window.removeEventListener('hashchange', on)
  }, [])
  // 通知深链：快照到达后跳到对应条目（审批落到其工作项或会话），只消费一次
  useEffect(() => {
    if (!snap || !deep) return
    const target = resolveDeepLink(snap, deep)
    if (target) { setAttributionOpen(false); setSel(target) } else if (deep.kind === 'approval') { setSel(null); setTab('queue') }
    setDeep(null)
    history.replaceState(null, '', window.location.pathname + window.location.search)
  }, [snap, deep])

  const groups = useMemo(() => (snap ? groupByRepo(snap, { query, showDone, repoId, provider }) : []), [snap, query, showDone, repoId, provider])

  if (conn === 'unauthorized') {
    return <div className="center"><h1>Session Steward</h1><p>需要登录。请在终端运行 <code>steward open</code>。</p></div>
  }
  if (!snap) return <div className="center muted">加载中…</div>

  const totalItems = groups.reduce((sum, g) => sum + g.items.length, 0)
  const providers = [...new Set((snap.sessions ?? []).map((s) => s.provider))]
  const counts = queueCounts(snap, repoId, provider)
  const actors = projectActorRows(snap, groups, provider)
  const quietCount = sessionBuckets(snap, provider, repoId).quiet.length
  const attributionRecords = scopedAttributions(snap, repoId, provider)
  const attributionPending = attributionRecords.filter((a) => a.status === 'pending' && !a.plan.historical).length
  const openAttributions = () => { setSel(null); setAttributionOpen(true) }
  const selectItem = (id: string) => { setAttributionOpen(false); setSel({ kind: 'item', id }) }
  const selectSession = (id: number) => { setAttributionOpen(false); setSel({ kind: 'session', id }) }
  const openQueue = (lane: 'action' | 'review') => { setSel(null); setAttributionOpen(false); setTab('queue'); setQueueFocus(lane); setKioskQueue(true) }
  const detail = sel ? (
    sel.kind === 'item' ? (
      <ItemDetail key={sel.id} snap={snap} id={sel.id} onClose={() => setSel(null)} onSelectSession={selectSession} />
    ) : (
      <SessionDetail key={sel.id} snap={snap} id={sel.id} onClose={() => setSel(null)} onSelectItem={selectItem} foldEvents={route.kiosk} />
    )
  ) : null
  const queuePanel = <Queue snap={snap} onSelectItem={selectItem} repoId={repoId} provider={provider} reviewOpen={queueFocus === 'review'} onReviewOpenChange={open => setQueueFocus(open ? 'review' : 'action')} />

  if (route.kiosk) {
    const drawer = sel != null || kioskQueue
    const closeDrawer = () => { setSel(null); setKioskQueue(false) }
    const path = window.location.pathname
    return (
      <div className="app is-kiosk" onKeyDown={(e) => { if (e.key === 'Escape' && drawer) closeDrawer() }}>
        <main className="kiosk-main">
          <TownView snap={snap} conn={conn} repoId={repoId} provider={provider} sel={sel} onSelectItem={selectItem} onSelectSession={selectSession}
            onSelectRepo={(id) => setRepoId(id)} onQueue={openQueue} kiosk rotateMs={route.rotateMs} paused={drawer}
            bar={<span className="kiosk-tools">
              {repoId !== 'all' && <button className="btn small" onClick={() => setRepoId('all')} title="点建筑会只看这个项目">← 全部项目</button>}
              <span className={`conn conn-${conn}`}>{conn === 'live' ? '实时' : conn === 'offline' ? '已断开，重连中' : '连接中'}</span>
              {isRemote() && <span className="remote-tag" title={remoteReadOnlyMessage}>远程只读</span>}
              <a className="btn small" href={fullPanelHref(path, null)} title="回到 Session Steward 完整面板">退出桌面模式</a>
            </span>} />
        </main>
        {drawer && <div className="kiosk-scrim" onClick={closeDrawer} aria-hidden />}
        {drawer && (
          <aside className="side kiosk-drawer" role="dialog" aria-modal="true" aria-label={sel ? '详情' : '关注队列'}>
            <div className="kiosk-drawer-head">
              <strong>{sel ? (sel.kind === 'item' ? `工作项 ${sel.id}` : `会话 #${sel.id}`) : '关注队列'}</strong>
              <a className="btn small" href={fullPanelHref(path, sel)}>在完整面板打开</a>
              <button className="btn small" onClick={closeDrawer} autoFocus>关闭</button>
            </div>
            {isRemote() && <p className="warn-box" role="status">{remoteReadOnlyMessage}</p>}
            {detail ?? <div className="side-body">{queuePanel}</div>}
          </aside>
        )}
      </div>
    )
  }

  return (
    <div className="app">
      <main className="main">
        <header className="toolbar">
          <div className="brand">
            <strong>Session Steward</strong>
            <span className={`conn conn-${conn}`}>{conn === 'live' ? '实时' : conn === 'offline' ? '已断开，重连中' : '连接中'}</span>
          </div>
          <select value={repoId} onChange={(e) => setRepoId(e.target.value === 'all' ? 'all' : Number(e.target.value))} aria-label="项目">
            <option value="all">全部项目</option>
            {(snap.repos ?? []).map((r) => <option key={r.id} value={r.id}>{repoLabel(snap, r.id)}</option>)}
          </select>
          <select value={provider} onChange={(e) => setProvider(e.target.value)} aria-label="Agent">
            <option value="all">全部 Agent</option>
            {providers.map((p) => <option key={p} value={p}>{providerLabel(p)}</option>)}
          </select>
          <input className="search" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="查找 #编号或标题（展开相关依赖）" aria-label="搜索" />
          <label className="check"><input type="checkbox" checked={showDone} onChange={(e) => setShowDone(e.target.checked)} /> 已完成</label>
          <div className="seg" role="group" aria-label="视图">
            <button className={view === 'overview' ? 'on' : ''} onClick={() => setView('overview')}>项目简报</button>
            <button className={view === 'town' ? 'on' : ''} onClick={() => setView('town')}>小镇</button>
            <button className={view === 'canvas' ? 'on' : ''} onClick={() => setView('canvas')}>画布</button>
            <button className={view === 'list' ? 'on' : ''} onClick={() => setView('list')}>列表</button>
          </div>
          {view === 'town' && <a className="btn small" href={kioskHref(window.location.pathname)} title="全屏小镇，适合挂在副屏或手机上；自动轮播项目">桌面模式</a>}
          {view === 'canvas' && <button className="btn small" onClick={() => setExpandAll((v) => !v)}>{expandAll ? '默认折叠' : '全部展开'}</button>}
          {quietCount > 0 && <button className="btn small" onClick={() => { setSel(null); setAttributionOpen(false); setTab('sessions'); setSessionScope('quiet') }}>已收起会话 {quietCount}</button>}
          <button className="btn small" onClick={openAttributions}>近期归属待确认 {attributionPending}</button>
        </header>
        {isRemote() && <p className="warn-box" role="status">{remoteReadOnlyMessage}</p>}
        {(() => {
          const sum = liveSummary(snap, repoId, provider)
          return <div className="live-summary" role="status" aria-label="谁在动">
            <button className={counts.action ? 'is-user' : ''} onClick={() => { setSel(null); setAttributionOpen(false); setTab('queue') }}>审批／决定 <b>{counts.action}</b></button>
            <span className="is-run" title="收到近期活动事件的执行会话数，不是项目数">运行中 <b>{sum.running}</b> 个会话</span>
            <span className={sum.blocked ? 'is-blocked' : ''} title="当前推进中明确受阻的工作项；卡片也可能保留此前的卡点说明">受阻工作 <b>{sum.blocked}</b> 项</span>
            <button title="一段时间没有收到新事件的会话，不等于卡死；点击查看" onClick={() => { setSel(null); setAttributionOpen(false); setTab('sessions'); setSessionScope('quiet') }}>无新活动 <b>{sum.quiet}</b> 个会话</button>
            <span className="live-actors">{actors.recent.map(({ group: g, actor: a }) => <span key={g.key} className={`actor actor-${a}`} title={`${g.name}：近期行动方`}>{g.name} · {actorLabel[a]}</span>)}{actors.quiet.length > 0 && <span className="muted">已收起 {actors.quiet.length} 个无近期活动项目</span>}</span>
            {isRemote() ? <span className="remote-tag" title={remoteReadOnlyMessage}>远程</span>
              : <button className="btn small primary" onClick={() => { setSel(null); setAttributionOpen(false); setTab('launch') }}>＋ 新建会话</button>}
          </div>
        })()}
        <div className={view === 'overview' ? 'workbench-overview overview-hidden' : 'workbench-overview'}>
          <div className="overview-line"><strong>项目推进</strong><span>{totalItems} 个工作项</span><span>{sessionBuckets(snap, provider, repoId).recent.length} 个近期会话</span><button onClick={() => { setSel(null); setAttributionOpen(false); setTab('queue') }}>审批／决定 {counts.action} · 待审阅／验收 {counts.review}</button></div>
          <div className="project-shortcuts">{groups.map((g) => <button key={g.key} disabled={g.repoId == null} className={repoId === g.repoId ? 'on' : ''} onClick={() => { if (g.repoId != null) { setRepoId(g.repoId); setSel(null); setAttributionOpen(false); setTab('queue') } }} title={g.name}><strong>{g.name}</strong><small>工作项 {g.items.length} · 待关联 {g.sessions.length}{projectQueueCounts(snap, g.repoId).action ? ` · 需审批 ${projectQueueCounts(snap, g.repoId).action}` : ''}</small></button>)}</div>
        </div>
        <div className="stage">
          {view === 'town' ? <TownView snap={snap} conn={conn} repoId={repoId} provider={provider} sel={sel} onSelectItem={selectItem} onSelectSession={selectSession}
            onSelectRepo={(id) => setRepoId(id)} onQueue={(lane) => { setSel(null); setAttributionOpen(false); setTab('queue'); setQueueFocus(lane) }} />
            : view === 'overview' ? <Overview snap={snap} groups={groups} onSelectItem={selectItem} onSelectSession={selectSession} onOpenAttribution={openAttributions} pendingCount={counts.action} reviewCount={counts.review} expandQuiet={!!query.trim() || repoId !== 'all'} onQueue={(lane = 'action') => { setSel(null); setAttributionOpen(false); setTab('queue'); setQueueFocus(lane) }} /> : view === 'canvas' ? (
            <ReactFlowProvider>
              <Canvas snap={snap} groups={groups} selected={sel?.kind === 'item' ? sel.id : null} onSelectItem={selectItem} onOpenAttribution={openAttributions} expandAll={expandAll || !!query.trim()} />
            </ReactFlowProvider>
          ) : (
            <ItemTable groups={groups} onSelect={selectItem} />
          )}
        </div>
      </main>
      <aside className="side">
        {attributionOpen ? <AttributionPanel snap={snap} repoId={repoId} provider={provider} onClose={() => setAttributionOpen(false)} onSelectItem={selectItem} /> : detail ?? (
          <>
            <nav className="tabs" role="tablist">
              <button role="tab" aria-selected={tab === 'queue'} className={tab === 'queue' ? 'on' : ''} onClick={() => { setTab('queue'); setQueueFocus('action') }}>关注队列 {counts.action > 0 && <span className="badge" title="需要你审批或决定">{counts.action}</span>}</button>
              <button role="tab" aria-selected={tab === 'items'} className={tab === 'items' ? 'on' : ''} onClick={() => setTab('items')}>工作项</button>
              <button role="tab" aria-selected={tab === 'sessions'} className={tab === 'sessions' ? 'on' : ''} onClick={() => setTab('sessions')}>会话</button>
              {!isRemote() && <button role="tab" aria-selected={tab === 'launch'} className={tab === 'launch' ? 'on' : ''} onClick={() => setTab('launch')}>新建会话</button>}
              <button role="tab" aria-selected={tab === 'review'} className={tab === 'review' ? 'on' : ''} onClick={() => setTab('review')}>复盘</button>
            </nav>
            <div className="side-body">
              {tab === 'queue' && <>{queuePanel}<button className="attribution-summary" onClick={openAttributions}>近期会话待归属 {attributionPending}<small>查看候选依据，按项目批量确认或撤销</small></button></>}
              {tab === 'items' && <WorkItemsPanel snap={snap} items={groups.flatMap((g) => g.items)} history={groups.flatMap(g => g.history ?? [])} repoId={repoId} onSelect={selectItem} />}
              {tab === 'review' && <ReviewPanel />}
              {tab === 'launch' && !isRemote() && <NewManaged snap={snap} initialRepoId={repoId === 'all' ? undefined : repoId} onLaunched={(m) => selectItem(m.work_item_id)} />}
              {tab === 'sessions' && <SessionList snap={snap} onSelect={selectSession} provider={provider} repoId={repoId} scope={sessionScope} onScopeChange={setSessionScope} />}
            </div>
          </>
        )}
      </aside>
    </div>
  )
}

function ItemTable({ groups, onSelect }: { groups: ReturnType<typeof groupByRepo>; onSelect: (id: string) => void }) {
  const [sort, setSort] = useState<'status' | 'updated' | 'id'>('status')
  const order: Record<ItemStatus, number> = { blocked: 0, review: 1, in_progress: 2, todo: 3, done: 4, abandoned: 5 }
  const rows = groups.flatMap((g) => g.items.map((w) => ({ w, repo: g.name })))
  rows.sort((a, b) =>
    sort === 'status' ? order[a.w.status] - order[b.w.status] || b.w.updated_at.localeCompare(a.w.updated_at)
      : sort === 'updated' ? b.w.updated_at.localeCompare(a.w.updated_at) : a.w.id.localeCompare(b.w.id))
  return (
    <div className="item-table">
      <div className="row">
        <span className="muted">{rows.length} 项</span>
        <select value={sort} onChange={(e) => setSort(e.target.value as typeof sort)} aria-label="排序">
          <option value="status">按状态</option>
          <option value="updated">按更新时间</option>
          <option value="id">按编号</option>
        </select>
      </div>
      <table>
        <thead><tr><th>编号</th><th>标题</th><th>项目</th><th>状态</th><th>Agent</th><th>依赖</th></tr></thead>
        <tbody>
          {rows.map(({ w, repo }) => (
            <tr key={w.id} onClick={() => onSelect(w.id)} tabIndex={0} onKeyDown={(e) => e.key === 'Enter' && onSelect(w.id)}>
              <td className="mono">{w.id}</td>
              <td>{w.title}</td>
              <td>{repo}</td>
              <td><span className={`pill st-${w.status}`}>{itemStatusLabel[w.status]}</span></td>
              <td>{w.agents.map(providerLabel).join(' · ') || '—'}</td>
              <td className="muted">{w.ready ? '' : `等 ${w.waiting.join(', ')}`}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
