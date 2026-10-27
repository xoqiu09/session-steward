// 小镇视图：用 SS 的实时快照画工作小镇。只读；点选对象复用 SS 原有的工作项/会话详情与审批入口。
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode, type TouchEvent } from 'react'
import type { Conn } from '../api'
import type { Repo, Run, Snapshot } from '../types'
import { groupByRepo, scopedAttention, sessionBuckets } from '../model'
import { queueLanes } from '../workbench'
import { orderedProjects } from '../projectActivity'
import { resolveDeepLink } from '../live'
import TownScene, { type LayoutName, type Selection } from './TownScene'
import { WorldStage } from './WorldScene'
import { ReplayBar, minuteLabel, replayISO, startPos, type ReplayPos } from './ReplayBar'
import { api } from '../api'
import { planWorld } from './clusters'
import { relaysOf } from './relays'
import type { BuildingView } from './townModel'
import { buildTown, type Highlight, type TownModel } from './townModel'
import { acceptSnapshot } from './feed'
import { clampPage, needsYou, pageBuildings, pageOfCharacter } from './paging'
import { DEFAULT_ROTATE_S } from './route'
import './town.css'
import './townView.css'

type Sel = { kind: 'item'; id: string } | { kind: 'session'; id: number } | null

const CHIPS: { key: Highlight; label: string }[] = [
  { key: 'working', label: '工作中' },
  { key: 'waiting', label: '等你决定' },
  { key: 'failed', label: '失败' },
  { key: 'review', label: '待验收' },
  { key: 'stale', label: '状态待更新' },
]

const DAY = 24 * 3600_000
const MAX_FAILED = 4

const clock = new Intl.DateTimeFormat('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false })
const hm = (iso: string) => (iso ? clock.format(new Date(iso)) : '—')

const SKIP_OUTCOMES = new Set(['historical', 'attribution_reverted'])

// 只把“现在”的东西放进小镇：近期会话、当前工作项、未结束的运行、近一天的失败、每个待验收项最近一次运行。
// 告示栏只放 SS 关注队列里“需你处理”的请求（与顶部“审批／决定”同一口径）。
export function townSlice(snap: Snapshot, repoId: number | 'all', provider: string): Snapshot {
  const groups = groupByRepo(snap, { query: '', showDone: false, repoId, provider })
  const sessions = sessionBuckets(snap, provider, repoId).recent
  const items = groups.flatMap(g => g.items)
  const itemIds = new Set(items.map(w => w.id))
  const sessionIds = new Set(sessions.map(s => s.id))
  const repoIds = new Set<number>()
  for (const p of orderedProjects(snap, groups, provider)) if (p.group.repoId != null) repoIds.add(p.group.repoId)
  for (const s of sessions) if (s.repo_id != null) repoIds.add(s.repo_id)
  const order = [...repoIds]
  const repos = order.map(id => (snap.repos ?? []).find(r => r.id === id)).filter((r): r is Repo => !!r)
  const now = Date.parse(snap.now)
  const runs = snap.runs ?? []
  const open = runs.filter(r => !r.ended_at && sessionIds.has(r.session_id))
  const failed = runs.filter(r => r.ended_at && /^(failed|error)/i.test(r.outcome) && itemIds.has(r.work_item_id) && now - Date.parse(r.ended_at) < DAY)
    .sort((a, b) => b.ended_at.localeCompare(a.ended_at)).slice(0, MAX_FAILED)
  // SS 里 Agent 交付体现为工作项进入 review，而不是 run.outcome；验收台按工作项取它最近一次已结束的运行。
  const reviewIds = new Set(items.filter(w => w.status === 'review').map(w => w.id))
  const delivered = new Map<string, Run>()
  for (const r of runs) {
    if (!r.ended_at || SKIP_OUTCOMES.has(r.outcome) || !reviewIds.has(r.work_item_id)) continue
    const prev = delivered.get(r.work_item_id)
    if (!prev || r.ended_at > prev.ended_at) delivered.set(r.work_item_id, r)
  }
  const lanes = queueLanes(scopedAttention(snap, repoId, provider), snap.now)
  const action = [...lanes.permission, ...lanes.decision, ...lanes.merge.map(g => g.primary)]
  return {
    ...snap,
    repos,
    sessions,
    work_items: items,
    runs: [...open, ...failed, ...delivered.values()],
    approvals: action,
    deps: (snap.deps ?? []).filter(d => itemIds.has(d.upstream) && itemIds.has(d.downstream)),
    relays: relaysOf(snap, now).filter((r) => repoIds.has(r.repoId)),
  }
}

function signature(model: TownModel): Map<string, string> {
  const out = new Map<string, string>()
  for (const b of model.buildings) {
    for (const c of b.characters) out.set(c.key, `${c.status}|${c.item?.status ?? ''}`)
    for (const p of b.parcels) out.set(p.key, p.phase)
  }
  return out
}

// 和上一版相比状态变了或新出现的对象，闪一下。
function useChanged(model: TownModel | null): ReadonlySet<string> {
  const prev = useRef<Map<string, string> | null>(null)
  const [changed, setChanged] = useState<ReadonlySet<string>>(new Set())
  useEffect(() => {
    if (!model) return
    const sig = signature(model)
    const before = prev.current
    prev.current = sig
    if (!before) return
    setChanged(new Set([...sig].filter(([k, v]) => before.get(k) !== v).map(([k]) => k)))
    const t = window.setTimeout(() => setChanged(new Set()), 2600)
    return () => window.clearTimeout(t)
  }, [model])
  return changed
}

/** 手机竖屏宽度以下换成一栋一页的竖版小镇。 */
export const PORTRAIT_QUERY = '(max-width: 640px)'

function useMedia(query: string): boolean {
  const get = () => typeof window !== 'undefined' && !!window.matchMedia?.(query).matches
  const [match, setMatch] = useState(get)
  useEffect(() => {
    const mq = window.matchMedia?.(query)
    if (!mq) return
    const on = () => setMatch(mq.matches)
    on()
    mq.addEventListener('change', on)
    return () => mq.removeEventListener('change', on)
  }, [query])
  return match
}

const PER_PAGE: Record<LayoutName, number> = { wide: 3, portrait: 1 }

export function TownView({ snap, conn, repoId, provider, sel, onSelectItem, onSelectSession, onSelectRepo, onQueue, kiosk = false, rotateMs = DEFAULT_ROTATE_S * 1000, paused = false, layout, bar, world = false, replayDay, noReplay = false }: {
  snap: Snapshot
  conn: Conn
  repoId: number | 'all'
  provider: string
  sel: Sel
  onSelectItem: (id: string) => void
  onSelectSession: (id: number) => void
  onSelectRepo: (id: number) => void
  onQueue: (lane: 'action' | 'review') => void
  /** 桌面模式：自动轮播项目页。 */
  kiosk?: boolean
  rotateMs?: number
  /** 详情抽屉打开时暂停轮播。 */
  paused?: boolean
  /** 不传时按窗口宽度自动选择。 */
  layout?: LayoutName
  /** 状态条右侧的附加内容（桌面模式的连接状态、退出入口）。 */
  bar?: ReactNode
  /** 预览：大地图世界，替代宽屏的分页（竖屏仍分页）。 */
  world?: boolean
  /** 从历史日历点“回放这一天”进来时的日期。 */
  replayDay?: string
  /** 看“全部设备”时不能回放（回放只有本机的记录）。 */
  noReplay?: boolean
}) {
  // 旧快照（慢请求迟到）不覆盖新画面；同一版重复到达不重画。
  // cursor 只在数据库被替换时才会变小，那时服务端时间是新的，按重置接受。
  const [shown, setShown] = useState<Snapshot>(snap)
  useEffect(() => {
    setShown(prev => acceptSnapshot(prev, snap, snap.cursor < prev.cursor && Date.parse(snap.now) > Date.parse(prev.now)).snap)
  }, [snap])
  const [clientNow, setClientNow] = useState(() => new Date().toISOString())
  useEffect(() => {
    const t = window.setInterval(() => setClientNow(new Date().toISOString()), 30_000)
    return () => window.clearInterval(t)
  }, [])
  // 回放：时间条选一个过去的时刻，向服务端要那一刻的快照来画。拿到之前先沿用上一张。
  const [replay, setReplay] = useState<ReplayPos | null>(() => (replayDay ? startPos(replayDay) : null))
  const [playing, setPlaying] = useState(false)
  const [replaySnap, setReplaySnap] = useState<Snapshot | null>(null)
  const [replayLoading, setReplayLoading] = useState(false)
  useEffect(() => { if (replayDay) { setReplay(startPos(replayDay)); setPlaying(false) } }, [replayDay])
  useEffect(() => {
    if (!replay) { setReplaySnap(null); return }
    let live = true
    setReplayLoading(true)
    const t = window.setTimeout(() => {
      api.snapshotAt(replayISO(replay)).then((s) => live && setReplaySnap(s)).catch(() => {}).finally(() => live && setReplayLoading(false))
    }, 150)
    return () => { live = false; window.clearTimeout(t) }
  }, [replay?.day, replay?.minute])
  const view = replay && replaySnap ? replaySnap : shown
  const [highlight, setHighlight] = useState<Highlight | null>(null)
  const slice = useMemo(() => townSlice(view, repoId, provider), [view, repoId, provider])
  const model = useMemo(() => buildTown(slice, replay && replaySnap ? replaySnap.now : clientNow), [slice, clientNow, replay, replaySnap])
  const changed = useChanged(model)
  const offline = conn === 'offline'

  const narrow = useMedia(PORTRAIT_QUERY)
  const shape: LayoutName = layout ?? (narrow ? 'portrait' : 'wide')
  const asWorld = world && shape === 'wide'
  const urgent = useCallback((b: BuildingView) => needsYou(b, model.pendingApprovals), [model])
  // 村庄与野外按完整快照里近 7 天的活动和关联来分；只在快照变化时重算，位置才稳定。
  const plan = useMemo(() => planWorld(model.buildings.filter((b) => b.repo).map((b) => b.repo!), shown, Date.parse(shown.now) || Date.now()), [model, shown])
  const pages = useMemo(() => pageBuildings(model.buildings, PER_PAGE[shape], (b) => needsYou(b, model.pendingApprovals)), [model, shape])
  const [pageRaw, setPage] = useState(0)
  const page = clampPage(pageRaw, pages.length)
  const turn = (step: number) => setPage(((page + step) % pages.length + pages.length) % pages.length)
  const rotating = kiosk && !paused && pages.length > 1 && !asWorld
  useEffect(() => {
    if (!rotating) return
    const t = window.setTimeout(() => setPage((p) => (clampPage(p, pages.length) + 1) % pages.length), rotateMs)
    return () => window.clearTimeout(t)
  }, [rotating, page, pages.length, rotateMs])
  // 从深链或列表选中一个会话时，翻到它所在的那页。
  const selKey = sel?.kind === 'session' ? `session-${sel.id}` : ''
  useEffect(() => {
    if (!selKey) return
    const i = pageOfCharacter(pages, selKey)
    if (i >= 0) setPage(i)
  }, [selKey])
  const swipe = useRef<{ x: number; y: number } | null>(null)
  const onTouchStart = (e: TouchEvent) => { const t = e.touches[0]; swipe.current = t ? { x: t.clientX, y: t.clientY } : null }
  const onTouchEnd = (e: TouchEvent) => {
    const a = swipe.current, t = e.changedTouches[0]
    swipe.current = null
    if (!a || !t || pages.length < 2) return
    const dx = t.clientX - a.x, dy = t.clientY - a.y
    if (Math.abs(dx) > 50 && Math.abs(dx) > Math.abs(dy) * 1.5) turn(dx < 0 ? 1 : -1)
  }

  const selected: Selection | null = sel?.kind === 'session' ? { kind: 'character', key: `session-${sel.id}` } : null
  const onSelect = (s: Selection) => {
    if (s.kind === 'character') onSelectSession(Number(s.key.replace('session-', '')))
    else if (s.kind === 'building') { const id = Number(s.key.replace('repo-', '')); if (Number.isFinite(id)) onSelectRepo(id) }
    else if (s.kind === 'review-desk') onQueue('review')
    else if (s.kind === 'item') onSelectItem(s.key)
    else if (s.kind === 'approval') {
      const t = resolveDeepLink(shown, { kind: 'approval', id: s.key })
      if (t?.kind === 'item') onSelectItem(t.id)
      else if (t?.kind === 'session') onSelectSession(t.id)
      else onQueue('action')
    } else if (s.kind === 'parcel') {
      const run = (shown.runs ?? []).find(r => `run-${r.id}` === s.key)
      if (run?.work_item_id) onSelectItem(run.work_item_id)
      else if (run) onSelectSession(run.session_id)
    }
  }

  const pinned = pages.length > 1 ? pages[0].filter((b) => pages.every((pg) => pg.includes(b))).length : 0
  return (
    <div className={`town-view${offline ? ' is-offline' : ''}${kiosk ? ' is-kiosk' : ''}`}>
      <div className="town-bar">
        <nav className="town-chips" aria-label="按状态高亮">
          {CHIPS.map(c => (
            <button key={c.key} type="button" className={`town-chip is-${c.key}${highlight === c.key ? ' is-on' : ''}`} aria-pressed={highlight === c.key}
              onClick={() => setHighlight(highlight === c.key ? null : c.key)}>
              <i aria-hidden />{offline && c.key === 'working' ? '断线前工作中' : c.label}<b>{model.counts[c.key]}</b>
            </button>
          ))}
        </nav>
        {!asWorld && pages.length > 1 && (
          <div className="town-pager" role="group" aria-label={`项目分页，第 ${page + 1} 页，共 ${pages.length} 页`}
            title={`共 ${model.buildings.length} 个项目${pinned ? `；${pinned} 个等你处理的项目固定在每页` : ''}${rotating ? `；每 ${Math.round(rotateMs / 1000)} 秒自动翻页` : ''}`}>
            <button type="button" className="town-page-btn" aria-label="上一页" onClick={() => turn(-1)}>‹</button>
            <span className="town-dots">
              {pages.map((_, i) => <button key={i} type="button" className={`town-dot${i === page ? ' is-on' : ''}`} aria-label={`第 ${i + 1} 页`} aria-current={i === page ? 'page' : undefined} onClick={() => setPage(i)} />)}
            </span>
            <button type="button" className="town-page-btn" aria-label="下一页" onClick={() => turn(1)}>›</button>
            <span className="town-page-label">{page + 1}/{pages.length} · {model.buildings.length} 个项目</span>
            {rotating && <i key={page} className="town-page-timer" style={{ animationDuration: `${rotateMs}ms` }} aria-hidden />}
          </div>
        )}
        <span className="town-meta" title="小镇只画当前的会话、工作项和运行；完整记录在列表与项目简报里">
          快照 #{shown.cursor} · {hm(shown.now)}
        </span>
        {!replay && !noReplay && <button type="button" className="town-replay-open" onClick={() => { setReplay(startPos()); setPlaying(false) }} title="拖到过去某个时刻，看当时小镇的样子">回放</button>}
        {bar}
      </div>
      <div className="town-diorama" onTouchStart={onTouchStart} onTouchEnd={onTouchEnd}>
        {replay && <ReplayBar pos={replay} playing={playing} loading={replayLoading} onChange={setReplay} onPlay={setPlaying} onExit={() => { setReplay(null); setPlaying(false) }} />}
        {replay && <div className="town-replay-banner" role="status">回放中：画面是 {replay.day.slice(5).replace('-', '/')} {minuteLabel(replay.minute)} 的样子，只能看；点开的详情是现在的状态</div>}
        {offline && <div className="town-offline" role="status"><strong>状态待更新</strong><span>连接中断，画面停在 {hm(shown.now)}，不代表 Agent 仍在工作。</span></div>}
        {!offline && model.buildings.length === 0 && <div className="town-empty" role="status">
          <strong>这台电脑还没有工作记录</strong>
          <span>数据只存在本机的 ~/.steward，不会随代码同步到别的电脑。先用演示数据看看，或运行 steward install 后让 Claude Code / Codex 干活，项目和小人就会出现在这里。</span>
        </div>}
        {asWorld
          ? <WorldStage model={model} needsYou={urgent} selected={selected} highlight={highlight} onSelect={onSelect} changed={changed} offline={offline}
              kiosk={kiosk} rotateMs={rotateMs} paused={paused} focusKey={selKey} plan={plan} replaying={!!replay || noReplay} />
          : <TownScene model={model} buildings={pages[page]} layout={shape} selected={selected} highlight={highlight} onSelect={onSelect} changed={changed} offline={offline} />}
        <ul className="town-legend" aria-label="图例">
          <li><i className="lg-building" />建筑 = 项目</li>
          <li><i className="lg-char" />角色 = 一个会话</li>
          <li><i className="lg-parcel" />包裹 = 一次运行</li>
          <li><i className="lg-board" />告示栏 = 等你决定</li>
        </ul>
      </div>
    </div>
  )
}
