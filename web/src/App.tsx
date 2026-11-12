import { useEffect, useMemo, useRef, useState } from 'react'
import { ReactFlowProvider } from '@xyflow/react'
import { useSnapshot } from './api'
import { Canvas } from './Canvas'
import { Overview } from './Overview'
import { ItemDetail, WorkItemsPanel, SessionDetail, SessionList } from './Panels'
import { Queue } from './Queue'
import { groupByRepo, providerLabel, queueCounts, sessionBuckets, type SessionScope } from './model'
import type { Snapshot } from './types'
import { AttributionPanel } from './AttributionPanel'
import { scopedAttributions } from './attribution'
import { actorLabel, liveSummary, parseDeepLink, projectActorRows, resolveDeepLink, type Deep } from './live'
import { NewManaged } from './Managed'
import { ReviewPanel } from './P2'
import { isRemote, remoteReadOnlyMessage } from './access'
import { HistoryView } from './history/HistoryView'
import { useHub, remoteDeviceOf } from './hub/hub'
import { HubSwitch } from './hub/HubSwitch'
import { TownView } from './town/TownView'
import { TodayView } from './today/TodayView'
import { ProjectsPanel, type ProjectScope } from './ProjectsPanel'
import { attentionSummary, summaryText } from './today/todayModel'
import { fullPanelHref, kioskHref, parseTownRoute } from './town/route'
import { shownNo } from './hub/ids'
import { DispatchDesk } from './dispatch/DispatchDesk'
import { HooksSettings } from './HooksSettings'
import { useProjectMenu } from './ui/ProjectMenu'
import { NoticeBar } from './ui/NoticeBar'
import { useHookCoverage } from './ui/setup'
import { requestRoom } from './town/roomRequest'
import { inactiveRepo } from './town/activity'
import { panelScope, type PanelView } from './panelScope'
import { panelViewHref, usePanelNavigation } from './panelNavigation'
import { ConnectionState } from './ui/ConnectionState'
import { ProjectPicker } from './ui/ProjectPicker'
import { LiveView } from './live/LiveView'
import { LiveSettings } from './live/LiveSettings'
import { WorkItemList } from './ui/WorkItemList'
import { ActionFeedback } from './ui/ActionFeedback'
import { PanelToolsDialog } from './ui/PanelToolsDialog'

type Tab = 'queue' | 'items' | 'sessions' | 'launch' | 'review'
type Sel = { kind: 'item'; id: string } | { kind: 'session'; id: number } | null

export default function App() {
	// 直播展示只读脱敏接口，不进 PanelApp（不请求面板接口、不连 SSE）。
	if (parseTownRoute(window.location.search, '').live) return <LiveView />
	// 原型的 ?view=native 已并入派活台。
	const view = new URLSearchParams(window.location.search).get('view')
	return view === 'dispatch' || view === 'native' ? <DispatchDesk /> : <PanelApp />
}

function PanelApp() {
  const { snap, conn, reload } = useSnapshot()
  const [retrying, setRetrying] = useState(false)
  const retry = async () => { setRetrying(true); try { await reload() } finally { setRetrying(false) } }
  // 多设备：“全部设备”时小镇画合并视图；点到别台电脑上的东西只提示去那台处理。
  const hub = useHub()
  const [hubNotice, setHubNotice] = useState('')
  useEffect(() => { if (!hubNotice) return; const t = window.setTimeout(() => setHubNotice(''), 4000); return () => window.clearTimeout(t) }, [hubNotice])
  const townItem = (id: string) => { const d = hub.merged && remoteDeviceOf(hub.merged, 'item', id); if (d) setHubNotice(d); else selectItem(id) }
  const townSession = (id: number) => { const d = hub.merged && remoteDeviceOf(hub.merged, 'session', id); if (d) setHubNotice(d); else selectSession(id) }
  const hubSwitch = hub.enabled ? <HubSwitch scope={hub.scope} onScope={hub.setScope} merged={hub.merged} error={hub.error} now={snap?.now ?? new Date().toISOString()} status={hub.status} /> : null
  // 小镇切换设备范围时不再整个重建：镜头和已排好的地块保留，“回到刚才的位置”能把范围一起切回来。
  const townScope = { scope: hub.scope, onScope: hub.enabled ? hub.setScope : undefined, selfDevice: hub.status?.device }
  const hubToast = hubNotice ? <div className="hub-toast" role="status">这是「{hubNotice}」上的工作：小镇里只能看，审批、验收和详情请到那台电脑上处理。</div> : null
  const [tab, setTab] = useState<Tab>('queue')
  const [queueFocus, setQueueFocus] = useState<'action' | 'review'>('action')
  const [sel, setSel] = useState<Sel>(null)
  const [query, setQuery] = useState('')
  const [showDone, setShowDone] = useState(false)
  const [repoId, setRepoId] = useState<number | 'all'>('all')
  const [provider, setProvider] = useState<string>('all')
  // 画布仍可用 ?view=canvas 打开；页面、地址和浏览器前进后退使用同一个导航状态。
  const { view, route, navigate, consumeDeepLink } = usePanelNavigation()
  const scope = panelScope(view, repoId, provider, query, showDone)
  const openTown = () => navigate('town')
  // 从历史日历点“回放这一天”：切到小镇并打开时间条。
  const [replayDay, setReplayDay] = useState<string | undefined>(undefined)
  // 桌面模式里点告示栏、验收台时，在抽屉里打开关注队列。
  const [kioskQueue, setKioskQueue] = useState(false)
  const [expandAll, setExpandAll] = useState(false)
  const [sessionScope, setSessionScope] = useState<SessionScope>('recent')
  const [attributionOpen, setAttributionOpen] = useState(false)
  const [projectsOpen, setProjectsOpen] = useState<ProjectScope | null>(null)
  const [projectsFilter, setProjectsFilter] = useState<'all' | 'suspect'>('all')
  // “发现 N 个可能误登记的目录”只提示一次：关掉后，数量变多时才再出现。只存在这个浏览器里。
  const [suspectSeen, setSuspectSeen] = useState(() => { try { return Number(localStorage.getItem('ss.suspect-dirs.seen') || 0) } catch { return 0 } })
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [liveOpen, setLiveOpen] = useState(false)
  const [toolsOpen, setToolsOpen] = useState(false)
  const [workPanelOpen, setWorkPanelOpen] = useState(false)
  const workPanelTrigger = useRef<HTMLButtonElement>(null)
  const workPanelOrigin = useRef<{ element: HTMLElement | null; scrollY: number } | null>(null)
  const [panelNotice, setPanelNotice] = useState<{ id: string; message: string } | null>(null)
  const [scopeNotice, setScopeNotice] = useState('')
  // 每日十分钟已经列出了关注队列的内容：侧栏默认只留详情位置，需要时再展开原来的标签页。
  const [todaySideTabs, setTodaySideTabs] = useState(false)
  const sideRef = useRef<HTMLElement>(null)
  const [sideReveal, setSideReveal] = useState(0)
  const rememberWorkPanelOrigin = () => {
    if (workPanelOpen || sel != null || attributionOpen || typeof document === 'undefined') return
    workPanelOrigin.current = { element: document.activeElement instanceof HTMLElement ? document.activeElement : null, scrollY: window.scrollY }
  }
  const restoreWorkPanelOrigin = () => {
    const origin = workPanelOrigin.current
    workPanelOrigin.current = null
    window.requestAnimationFrame?.(() => {
      const target = origin?.element?.isConnected ? origin.element : workPanelTrigger.current
      target?.focus({ preventScroll: true })
      if (origin && window.matchMedia?.('(max-width: 899px)').matches) window.scrollTo({ top: origin.scrollY, behavior: 'instant' })
    })
  }
  const openSideTab = (next: Tab) => {
    rememberWorkPanelOrigin()
    setTab(next)
    setToolsOpen(false)
    setWorkPanelOpen(true)
    setPanelNotice(null)
    if (view === 'today') setTodaySideTabs(true)
    // On a narrow screen the panel replaces the page; move to its new target.
    if (window.matchMedia?.('(max-width: 899px)').matches) setSideReveal(n => n + 1)
  }
  useEffect(() => {
    if ((!sideReveal && sel == null && !attributionOpen) || !window.matchMedia?.('(max-width: 899px)').matches) return
    const side = sideRef.current
    if (!side) return
    side.scrollIntoView({ block: 'start', behavior: 'auto' })
    side.querySelector<HTMLElement>(sel != null || attributionOpen ? '.work-panel-head button' : '[role="tab"][aria-selected="true"]')?.focus({ preventScroll: true })
  }, [sideReveal, sel?.kind, sel?.id, attributionOpen])

  const [deep, setDeep] = useState<Deep>(() => parseDeepLink(window.location.hash))
  const [notificationSession, setNotificationSession] = useState<number | undefined>(undefined)
  useEffect(() => {
    const on = () => setDeep(parseDeepLink(window.location.hash))
    window.addEventListener('hashchange', on)
    window.addEventListener('popstate', on)
    return () => { window.removeEventListener('hashchange', on); window.removeEventListener('popstate', on) }
  }, [])
  // 桌面模式的详情抽屉是最上层：Esc 只关它，不能穿透到底下的房间、收菜或浮层。
  // 用捕获阶段：点抽屉里的文字后焦点会落到 body，冒泡版的处理收不到。
  const kioskDrawerOpen = route.kiosk && (sel != null || kioskQueue)
  useEffect(() => {
    if (!kioskDrawerOpen) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || document.querySelector('[role="dialog"]:not(.kiosk-drawer)')) return
      e.preventDefault(); e.stopImmediatePropagation()
      setSel(null); setKioskQueue(false)
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [kioskDrawerOpen])
  // 通知深链：快照到达后跳到对应条目（审批落到其工作项或会话），只消费一次
  useEffect(() => {
    if (!snap || !deep) return
    const target = resolveDeepLink(snap, deep)
    setNotificationSession(deep.kind === 'approval' ? (snap.approvals ?? []).find(a => a.id === deep.id)?.session_id ?? undefined : undefined)
    if (target) { setAttributionOpen(false); setSel(target) } else if (deep.kind === 'approval') { setSel(null); openSideTab('queue') }
    setDeep(null)
    consumeDeepLink()
  }, [snap, deep, consumeDeepLink])

  const groups = useMemo(() => (snap ? groupByRepo(snap, scope) : []), [snap, scope.query, scope.showDone, scope.repoId, scope.provider])

  const coverage = useHookCoverage()
  // 项目推进卡片和小镇房子的右键菜单：查看、整理和收起都在这里，危险操作再确认。
  const projectMenu = useProjectMenu({ snap: hub.merged ?? snap ?? null, current: repoId, remote: isRemote(), actions: {
    onFilter: (r) => { setRepoId(r.id); setSel(null); setAttributionOpen(false); openSideTab('queue') },
    onShowAll: () => setRepoId('all'),
    onReview: (r) => { setRepoId(r.id); setSel(null); setAttributionOpen(false); openSideTab('queue'); setQueueFocus('review') },
    onEnterRoom: (r, focus) => {
      // 默认收起的不活跃项目要先选中，地图上才有它的房子。
      if (inactiveRepo(r)) setRepoId(r.id)
      if (view !== 'town' || !route.world) openTown()
      requestRoom(r.id, focus)
    },
  } })
  if (conn === 'unauthorized') {
    return <div className="center"><h1>Session Steward</h1><p>需要登录。请在终端运行 <code>steward open</code>。</p></div>
  }
  if (!snap) return <ConnectionState conn={conn} retrying={retrying} onRetry={() => void retry()} />

  const providers = [...new Set((snap.sessions ?? []).map((s) => s.provider))]
  const counts = queueCounts(snap, scope.repoId, scope.provider)
  const summary = attentionSummary(snap)
  const todayLeft = summary.total
  const todayEntry = <a className="btn small today-entry" href={panelViewHref(window.location.pathname, window.location.search, 'today')} onClick={(e) => { if (!route.kiosk) { e.preventDefault(); navigate('today') } }} title={`每日十分钟 · 要你处理 ${summary.total} 件：${summaryText(summary)}`}>{todayLeft ? `要你处理 ${todayLeft} 件` : '每日十分钟'}</a>
  const actors = projectActorRows(snap, groups, scope.provider)
  const quietCount = sessionBuckets(snap, scope.provider, scope.repoId).quiet.length
  const attributionRecords = scopedAttributions(snap, scope.repoId, scope.provider)
  const attributionPending = attributionRecords.filter((a) => a.status === 'pending' && !a.plan.historical).length
  const openAttributions = () => { rememberWorkPanelOrigin(); setToolsOpen(false); setSel(null); setPanelNotice(null); setAttributionOpen(true) }
  const selectItem = (id: string, notice?: string) => { rememberWorkPanelOrigin(); setAttributionOpen(false); setNotificationSession(undefined); setPanelNotice(notice ? { id, message: notice } : null); setSel({ kind: 'item', id }) }
  const selectSession = (id: number) => { rememberWorkPanelOrigin(); setAttributionOpen(false); setPanelNotice(null); setSel({ kind: 'session', id }) }
  const closeDetail = () => { setSel(null); setPanelNotice(null); if (!workPanelOpen && !attributionOpen) restoreWorkPanelOrigin() }
  const closeWorkPanel = () => { setSel(null); setPanelNotice(null); setAttributionOpen(false); setWorkPanelOpen(false); restoreWorkPanelOrigin() }
  const workPanelVisible = workPanelOpen || sel != null || attributionOpen
  const openQueue = (lane: 'action' | 'review') => { setSel(null); setAttributionOpen(false); openSideTab('queue'); setQueueFocus(lane); setKioskQueue(true) }
  const detail = sel ? (
    sel.kind === 'item' ? (
      <ItemDetail key={sel.id} snap={snap} id={sel.id} onClose={closeDetail} onSelectSession={selectSession} onSelectItem={selectItem} preferredSession={notificationSession} />
    ) : (
      <SessionDetail key={sel.id} snap={snap} id={sel.id} onClose={closeDetail} onSelectItem={selectItem} foldEvents={route.kiosk} />
    )
  ) : null
  const queuePanel = <Queue snap={snap} onSelectItem={selectItem} repoId={scope.repoId} provider={scope.provider} reviewOpen={queueFocus === 'review'} onReviewOpenChange={open => setQueueFocus(open ? 'review' : 'action')} />

  // 这台电脑能从面板启动 Agent 时才给“新建会话”；原因写在“设置”里。
  const canLaunch = (snap.agents?.length ?? 0) > 0 && !snap.managed_unavailable
  const suspectCount = suspectDirectories(snap)
  const dismissSuspect = () => { setSuspectSeen(suspectCount); try { localStorage.setItem('ss.suspect-dirs.seen', String(suspectCount)) } catch { /* 隐私模式：只在本页有效 */ } }
  const projectShortcuts = <span className="pm-shortcuts" role="group" aria-label="项目管理入口">
    <button className="btn small" onClick={() => { setProjectsFilter('all'); setProjectsOpen('active') }}>项目管理</button>
    {!isRemote() && suspectCount >= 5 && suspectCount > suspectSeen && <span className="pm-suspect-hint">
      <button className="btn small" title="没有会话、不是 Git、没有待办的目录，多半是 Agent 顺手进过的；看看要不要移入回收站" onClick={() => { setProjectsFilter('suspect'); setProjectsOpen('active') }}>发现 {suspectCount} 个可能误登记的目录</button>
      <button className="btn small" aria-label="不再提示" title="不再提示（数量变多时再提示）" onClick={dismissSuspect}>×</button>
    </span>}
    {/* 为 0 时不占位置；项目管理里仍能看到三个分类。 */}
    {(snap.archived_projects ?? 0) > 0 && <button className="btn small pm-counter" title="查看和恢复本机已归档的项目" onClick={() => setProjectsOpen('archived')}>已归档 {snap.archived_projects}</button>}
    {(snap.trashed_projects ?? 0) > 0 && <button className="btn small pm-counter" title="查看和恢复本机已删除的项目" onClick={() => setProjectsOpen('trash')}>回收站 {snap.trashed_projects}</button>}
  </span>
  const projectManager = projectsOpen && <ProjectsPanel initialScope={projectsOpen} initialFilter={projectsFilter} device={hub.status?.device} onClose={() => setProjectsOpen(null)} onVisibilityChange={ids => {
    const selectedRepo = sel?.kind === 'item' ? (snap.work_items ?? []).find(item => item.id === sel.id)?.repo_id : sel?.kind === 'session' ? (snap.sessions ?? []).find(session => session.id === sel.id)?.repo_id : null
    if (selectedRepo != null && ids.includes(selectedRepo)) closeDetail()
    if (repoId !== 'all' && ids.includes(repoId)) { setRepoId('all'); setScopeNotice('当前项目已收起，已为你显示全部项目。可在项目管理中恢复。') }
  }} />
  const settings = settingsOpen && <HooksSettings onClose={() => setSettingsOpen(false)} />
  const sum = liveSummary(snap, scope.repoId, scope.provider)
  const filterCount = Number(provider !== 'all') + Number(scope.textFilters && !!query.trim()) + Number(scope.textFilters && showDone)
  const changeView = (next: PanelView) => navigate(next)
  const connectionNotice = conn === 'offline' && <div className="connection-notice" role="status"><span><strong>连接已中断</strong> · 保留 {new Date(snap.now).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })} 的记录，正在重连。</span><button className="btn small" disabled={retrying} onClick={() => void retry()}>{retrying ? '正在重试…' : '重试'}</button></div>
  const sessionShortcuts = <>
    {quietCount > 0 && <button className="btn small" onClick={() => { setSel(null); setAttributionOpen(false); openSideTab('sessions'); setSessionScope('quiet') }}>已收起会话 {quietCount}</button>}
    {attributionPending > 0 && <button className="btn small" onClick={openAttributions}>近期归属待确认 {attributionPending}</button>}
  </>

  if (route.kiosk) {
    const drawer = sel != null || kioskQueue
    const closeDrawer = () => { setSel(null); setKioskQueue(false) }
    const path = window.location.pathname
    return (
      <div className="app is-kiosk">
        <main className="kiosk-main">
          {connectionNotice}
          {hubToast}
          <TownView coverage={coverage} world={route.world} snap={hub.merged ?? snap} conn={conn} repoId={repoId} provider={provider} sel={sel} onSelectItem={townItem} onSelectSession={townSession}
            onSelectRepo={(id) => setRepoId(id)} onAllRepos={() => setRepoId('all')} onQueue={openQueue} kiosk rotateMs={route.rotateMs} paused={drawer} noReplay={hub.scope === 'all'} {...townScope}
            bar={<span className="kiosk-tools">
              {hubSwitch}
              {projectShortcuts}
              {todayEntry}
              <span className={`conn conn-${conn}`}>{conn === 'live' ? '实时' : conn === 'offline' ? '已断开，重连中' : '连接中'}</span>
              {isRemote() && <span className="remote-tag" title={remoteReadOnlyMessage}>远程只读</span>}
              <a className="btn small" href={fullPanelHref(path, null)} title="回到 Session Steward 完整面板">退出桌面模式</a>
            </span>} />
        </main>
        {projectManager}{projectMenu}<NoticeBar snap={snap} coverage={coverage} />
        {settings}
        {drawer && <div className="kiosk-scrim" onClick={closeDrawer} aria-hidden />}
        {drawer && (
          <aside className="side kiosk-drawer" role="dialog" aria-modal="true" aria-label={sel ? '详情' : '关注队列'}>
            <div className="kiosk-drawer-head">
              <strong>{sel ? (sel.kind === 'item' ? `工作项 ${sel.id}` : `会话 #${shownNo(Number(sel.id))}`) : '关注队列'}</strong>
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
    <div className={`app quiet-chrome${view === 'town' ? ' is-town' : ''}${!workPanelVisible ? ' is-panel-collapsed' : ''}`} data-panel-detail={sel != null || attributionOpen} data-work-panel-open={workPanelVisible}>
      <main className="main">
        <header className="toolbar">
          <div className="brand">
            <strong>Session Steward</strong>
            <span className={`conn conn-${conn}`}>{conn === 'live' ? '实时' : conn === 'offline' ? '已断开，重连中' : '连接中'}</span>
          </div>
          <nav className="seg" aria-label="视图">
            {([['today','每日十分钟'], ['overview','项目简报'], ['town','小镇'], ['list','列表'], ['history','历史']] as const).map(([key,label]) => <button key={key} className={view === key ? 'on' : ''} aria-current={view === key ? 'page' : undefined} onClick={() => navigate(key)}>{label}</button>)}
            {view === 'canvas' && <button className="on" aria-current="page">画布</button>}
          </nav>
          <select className="view-select" value={view} onChange={e => changeView(e.target.value as PanelView)} aria-label="页面">
            <option value="today">每日十分钟</option><option value="overview">项目简报</option><option value="town">小镇</option><option value="list">列表</option><option value="history">历史</option>{view === 'canvas' && <option value="canvas">画布</option>}
          </select>
          {scope.global ? <span className="panel-scope" aria-label="当前范围">本机全部项目</span> : <ProjectPicker className="project-select" repos={snap.repos ?? []} value={repoId} includeAll onChange={value => { setRepoId(value); setScopeNotice('') }} />}
          {!scope.global && <details className="panel-filters" data-shortcut-layer onKeyDown={event => {
            if (event.key !== 'Escape') return
            event.preventDefault(); event.stopPropagation(); event.currentTarget.open = false
            event.currentTarget.querySelector('summary')?.focus()
          }}>
            <summary>筛选{filterCount > 0 && <span className="badge">{filterCount}</span>}</summary>
            <div className="panel-filter-fields">
              <label>Agent<select value={provider} onChange={e => setProvider(e.target.value)} aria-label="Agent"><option value="all">全部 Agent</option>{providers.map(p => <option key={p} value={p}>{providerLabel(p)}</option>)}</select></label>
              {scope.textFilters && <><input className="search" value={query} onChange={e => setQuery(e.target.value)} placeholder="查找编号或标题" aria-label="搜索" />
                <label className="check"><input type="checkbox" checked={showDone} onChange={e => setShowDone(e.target.checked)} /> 已完成</label></>}
            </div>
          </details>}
          <div className="toolbar-actions">
            <button ref={workPanelTrigger} className={`btn small panel-toggle${workPanelVisible ? ' is-open' : ''}`} aria-expanded={workPanelVisible} aria-controls={workPanelVisible ? 'work-panel' : undefined} onClick={() => workPanelVisible ? closeWorkPanel() : openSideTab(tab)}>{workPanelVisible ? '收起面板' : '工作面板'}</button>
            {view === 'town' && !isRemote() && <button className="btn small" aria-haspopup="dialog" onClick={() => setLiveOpen(true)} title="小镇放映角与直播预览">放映角</button>}
            <button className="btn small tools-trigger" aria-haspopup="dialog" aria-expanded={toolsOpen} onClick={() => setToolsOpen(true)}>工具 <span aria-hidden="true">⌄</span></button>
          </div>
        </header>
        {connectionNotice}
        {isRemote() && <p className="warn-box" role="status">{remoteReadOnlyMessage}</p>}
        {scopeNotice && <div className="scope-notice"><ActionFeedback>{scopeNotice}</ActionFeedback><button className="btn small" onClick={() => setScopeNotice('')} aria-label="收起项目范围提示">关闭</button></div>}
        <div className="stage">
          {view === 'town' && hubToast}
          {view === 'town' ? <TownView coverage={coverage} world={route.world} snap={hub.merged ?? snap} conn={conn} repoId={repoId} provider={provider} sel={sel} onSelectItem={townItem} onSelectSession={townSession} replayDay={replayDay}
            noReplay={hub.scope === 'all'} {...townScope} bar={<>{hubSwitch}{todayEntry}</>}
            onSelectRepo={(id) => setRepoId(id)} onAllRepos={() => setRepoId('all')} onQueue={(lane) => { setSel(null); setAttributionOpen(false); openSideTab('queue'); setQueueFocus(lane) }} />
            : view === 'today' ? <TodayView snap={snap} onSelectItem={selectItem} onOpenTown={openTown} device={hub.enabled ? hub.status?.device ?? '' : undefined} />
            : view === 'overview' ? <Overview coverage={coverage} snap={snap} groups={groups} onSelectItem={selectItem} onSelectSession={selectSession} onOpenAttribution={openAttributions} pendingCount={counts.action} reviewCount={counts.review} expandQuiet={!!query.trim() || repoId !== 'all'} onQueue={(lane = 'action') => { setSel(null); setAttributionOpen(false); openSideTab('queue'); setQueueFocus(lane) }} /> : view === 'canvas' ? (
            <ReactFlowProvider>
              <Canvas snap={snap} groups={groups} selected={sel?.kind === 'item' ? sel.id : null} onSelectItem={selectItem} onOpenAttribution={openAttributions} expandAll={expandAll || !!query.trim()} />
            </ReactFlowProvider>
          ) : view === 'history' ? <HistoryView snap={snap} onSelectSession={selectSession} onSelectItem={selectItem} onReplayDay={(d) => { setReplayDay(d); openTown() }} /> : (
            <WorkItemList groups={groups} onSelect={selectItem} filtered={!!query.trim() || repoId !== 'all' || provider !== 'all' || showDone}
              onClearFilters={() => { setQuery(''); setRepoId('all'); setProvider('all'); setShowDone(false) }} onOpenWorkItems={() => openSideTab('items')} />
          )}
        </div>
      </main>
      {workPanelVisible && <aside className="side" id="work-panel" ref={sideRef} aria-label="工作面板">
        <div className="work-panel-head"><strong>{sel ? '工作详情' : attributionOpen ? '会话归属' : '工作面板'}</strong><button className="btn small" onClick={closeWorkPanel}>返回{view === 'town' ? '小镇' : view === 'list' ? '列表' : view === 'history' ? '历史' : view === 'today' ? '每日十分钟' : '项目简报'}</button></div>
        {panelNotice && sel?.kind === 'item' && panelNotice.id === sel.id && <div className="work-panel-feedback"><ActionFeedback>{panelNotice.message}</ActionFeedback></div>}
        {attributionOpen ? <AttributionPanel snap={snap} repoId={scope.repoId} provider={scope.provider} onClose={() => { setAttributionOpen(false); if (!workPanelOpen) restoreWorkPanelOrigin() }} onSelectItem={selectItem} /> : detail ?? (view === 'today' && !todaySideTabs ? (
          <div className="side-body today-side">
            <p>点任意一行的标题或“详情”，完整的交付、简报和来源会在这里打开。</p>
            <button className="btn small" onClick={() => openSideTab(tab)}>显示关注队列、工作项和会话</button>
          </div>
        ) : (
          <>
            <nav className="tabs" role="tablist">
              <button role="tab" aria-selected={tab === 'queue'} className={tab === 'queue' ? 'on' : ''} onClick={() => { openSideTab('queue'); setQueueFocus('action') }}>关注队列 {counts.action > 0 && <span className="badge" title="需要你审批或决定">{counts.action}</span>}</button>
              <button role="tab" aria-selected={tab === 'items'} className={tab === 'items' ? 'on' : ''} onClick={() => openSideTab('items')}>工作项</button>
              <button role="tab" aria-selected={tab === 'sessions'} className={tab === 'sessions' ? 'on' : ''} onClick={() => openSideTab('sessions')}>会话</button>
              {!isRemote() && canLaunch && <button role="tab" aria-selected={tab === 'launch'} className={tab === 'launch' ? 'on' : ''} onClick={() => openSideTab('launch')}>新建会话</button>}
              <button role="tab" aria-selected={tab === 'review'} className={tab === 'review' ? 'on' : ''} onClick={() => openSideTab('review')}>复盘</button>
            </nav>
            <div className="side-body">
              {tab === 'queue' && <>{queuePanel}<button className="attribution-summary" onClick={openAttributions}>近期会话待归属 {attributionPending}<small>查看候选依据，按项目批量确认或撤销</small></button></>}
              {tab === 'items' && <WorkItemsPanel snap={snap} items={groups.flatMap((g) => g.items)} history={groups.flatMap(g => g.history ?? [])} repoId={scope.repoId} onSelect={selectItem} />}
              {tab === 'review' && <ReviewPanel />}
              {tab === 'launch' && !isRemote() && canLaunch && <NewManaged snap={snap} initialRepoId={scope.repoId === 'all' ? undefined : scope.repoId} onLaunched={(m, notice) => selectItem(m.work_item_id, notice)} />}
              {tab === 'sessions' && <SessionList snap={snap} onSelect={selectSession} provider={scope.provider} repoId={scope.repoId} scope={sessionScope} onScopeChange={setSessionScope} />}
            </div>
          </>
        ))}
      </aside>}
      {toolsOpen && <PanelToolsDialog onClose={() => setToolsOpen(false)}>
        <section className="panel-tool-actions" aria-label="管理与展示" onClick={event => { if ((event.target as HTMLElement).closest('button,a')) setToolsOpen(false) }}>
          <div className="panel-tool-section"><h3>项目</h3>{projectShortcuts}</div>
          <div className="panel-tool-section"><h3>工作记录</h3>{sessionShortcuts}
            {!isRemote() && canLaunch && <button className="btn small" onClick={() => { closeDetail(); setAttributionOpen(false); openSideTab('launch') }}>＋ 新建会话</button>}
            {view === 'canvas' && <button className="btn small" onClick={() => setExpandAll(v => !v)}>{expandAll ? '默认折叠' : '全部展开'}</button>}
          </div>
          {view === 'town' && <div className="panel-tool-section"><h3>小镇展示</h3>
            <a className="btn small" href={kioskHref(window.location.pathname, route.world)}>桌面模式</a>
            {!isRemote() && <button className="btn small" onClick={() => setLiveOpen(true)}>直播</button>}
          </div>}
          <div className="panel-tool-section"><h3>接入与隐私</h3><button className="btn small" onClick={() => setSettingsOpen(true)}>设置</button></div>
        </section>
        <details className="panel-tool-stats"><summary>运行近况 <span>会话、审批与受阻详情</span></summary>
          <p className="muted">记录更新于 {new Date(snap.now).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}。会话活动、交付和用户验收分别记录。</p>
          <div className="live-summary" role="status" aria-label="谁在动">
            <button className={counts.action ? 'is-user' : ''} onClick={() => { setToolsOpen(false); closeDetail(); setAttributionOpen(false); openSideTab('queue') }}>审批／决定 <b>{counts.action}</b></button>
            <span className="is-run">运行中 <b>{sum.running}</b> 个会话</span>
            <span>受阻工作 <b>{sum.blocked}</b> 项</span>
            <button onClick={() => { setToolsOpen(false); closeDetail(); setAttributionOpen(false); openSideTab('sessions'); setSessionScope('quiet') }}>无新活动 <b>{sum.quiet}</b> 个会话</button>
          </div>
          <ul className="panel-recent-projects">{actors.recent.slice(0,3).map(({group,actor}) => <li key={group.key}><strong>{group.name}</strong><span>{actorLabel[actor]}</span></li>)}</ul>
          {actors.recent.length > 3 && <details className="panel-more-projects"><summary>其余 {actors.recent.length - 3} 个项目</summary><ul className="panel-recent-projects">{actors.recent.slice(3).map(({group,actor}) => <li key={group.key}><strong>{group.name}</strong><span>{actorLabel[actor]}</span></li>)}</ul></details>}
          {actors.quiet.length > 0 && <p className="muted">另有 {actors.quiet.length} 个项目暂无近期活动。</p>}
        </details>
      </PanelToolsDialog>}
      {projectManager}{projectMenu}<NoticeBar snap={snap} coverage={coverage} />
      {settings}
      {liveOpen && !isRemote() && <LiveSettings onClose={() => setLiveOpen(false)} />}
    </div>
  )
}

/** 快照里可能是误登记的目录：不是 Git、从没有会话或请求、没有未完成工作、功能登记和结构资料。与项目管理里的筛选同一口径。 */
export function suspectDirectories(snap: Snapshot): number {
  const busy = new Set<number>()
  for (const w of snap.work_items ?? []) if (w.repo_id != null && !['done', 'abandoned'].includes(w.status)) busy.add(w.repo_id)
  for (const f of snap.features ?? []) busy.add(f.repo_id)
  for (const st of snap.structures ?? []) busy.add(st.repo_id)
  for (const a of snap.approvals ?? []) if (a.repo_id != null && a.status === 'pending') busy.add(a.repo_id)
  return (snap.repos ?? []).filter((r) => !r.is_git && !r.last_activity_at && !busy.has(r.id) && !r.device).length
}

