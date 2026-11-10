// 直播展示视图（?view=town&live=1）：给 OBS 浏览器源推流用。只读、已脱敏、没有任何可点的东西。
// 不走 PanelApp：不请求面板接口、不连 SSE、不写浏览器存储。
import { useEffect, useMemo, useState } from 'react'
import type { LiveNote } from '../api'
import type { Snapshot } from '../types'
import { buildTown } from '../town/townModel'
import { townSlice } from '../town/TownView'
import { hideInactive } from '../town/activity'
import { TownArtProvider, requestedTheme } from '../town/appearance'
import { setSceneStill } from '../town/TownScene'
import { LiveStage } from './LiveStage'
import { createLiveFeed, type LiveFeedState } from './feed'
import { diffLiveEvents, emptyBubbles, nextBubbleAt, pushBubbles, stepBubbles, type BubbleState, type LiveEvent } from './events'
import { liveScrub } from './scrub'
import './live.css'

/** 三项说明都为空时显示的默认说明。 */
export const LIVE_DEFAULT_NOTE = '安静工作中，休息时回复留言'

export type LiveLayout = 'portrait' | 'landscape'

/** 说明卡：字段为空的那一行不显示；三项全空时显示默认说明。 */
export function noteLines(note: LiveNote | null): { label: string; text: string }[] {
  const lines = [
    { label: '正在', text: note?.doing?.trim() ?? '' },
    { label: '最近思考', text: note?.thinking?.trim() ?? '' },
    { label: '交流方式', text: note?.contact?.trim() ?? '' },
  ].filter((l) => l.text)
  return lines
}

/** 卡片下方的自动说明：只用数量。 */
export function countLine(working: number): string {
  return `每栋房子是一个项目，小人是正在干活的 AI 助手 · 现在 ${working} 位在工作`
}

/** 纯展示：给定数据画一帧。会再脱敏一次快照，不渲染任何可交互元素。 */
export function LiveScreen({ snap, note, stale, bubble, layout }: { snap: Snapshot | null; note: LiveNote | null; stale: boolean; bubble: LiveEvent | null; layout: LiveLayout }) {
  setSceneStill(true)
  const safe = useMemo(() => (snap ? liveScrub(snap) : null), [snap])
  const model = useMemo(() => (safe ? buildTown(townSlice(hideInactive(safe, 'all').snap, 'all', 'all'), safe.now) : null), [safe])
  const lines = noteLines(note)
  const theme = requestedTheme(typeof window === 'undefined' ? '' : window.location?.search ?? '') ?? 'original'
  return (
    <TownArtProvider theme={theme}>
      <div className={`live-view is-${layout}`} data-town-theme={theme}>
        <section className="live-card" aria-label="直播说明">
          {lines.length ? lines.map((l) => <p key={l.label} className="live-line"><b>{l.label}：</b>{l.text}</p>)
            : <p className="live-line is-default">{LIVE_DEFAULT_NOTE}</p>}
        </section>
        <p className="live-count">{countLine(model?.counts.working ?? 0)}</p>
        {stale && <p className="live-stale" role="status">状态待更新</p>}
        <div className={`town-view live-town${theme === 'storybook' ? ' is-storybook' : theme === 'miniature' ? ' is-miniature' : ''}`}>
          {safe && model ? <LiveStage model={model} snap={safe} bubble={bubble} initialAspect={layout === 'portrait' ? 1.25 : 1.78} />
            : <p className="live-loading">小镇加载中…</p>}
          <ul className="live-legend" aria-label="图例">
            <li><i className="lg-building" />建筑 = 项目</li>
            <li><i className="lg-char" />小人 = 一位 AI 助手</li>
          </ul>
        </div>
      </div>
    </TownArtProvider>
  )
}

function useLayout(): LiveLayout {
  const get = (): LiveLayout => (typeof window === 'undefined' || window.innerHeight >= window.innerWidth ? 'portrait' : 'landscape')
  const [layout, setLayout] = useState(get)
  useEffect(() => {
    const on = () => setLayout(get())
    on()
    window.addEventListener('resize', on)
    return () => window.removeEventListener('resize', on)
  }, [])
  return layout
}

/** 数据与气泡：轮询两个只读接口，比较相邻快照生成气泡；首次加载不出气泡。 */
export function useLiveView() {
  const [feed, setFeed] = useState<LiveFeedState>({ snap: null, note: null, stale: false })
  const [bubbles, setBubbles] = useState<BubbleState>(emptyBubbles)
  useEffect(() => {
    const f = createLiveFeed({
      onState: setFeed,
      onSnapshot: (prev, next) => {
        const events = diffLiveEvents(prev, next)
        if (events.length) setBubbles((b) => pushBubbles(b, events, Date.now()))
      },
    })
    f.start()
    return () => f.stop()
  }, [])
  const due = nextBubbleAt(bubbles)
  useEffect(() => {
    if (due == null) return
    const t = window.setTimeout(() => setBubbles((b) => stepBubbles(b, Date.now())), Math.max(0, due - Date.now()) + 20)
    return () => window.clearTimeout(t)
  }, [due])
  return { ...feed, bubble: bubbles.shown }
}

export function LiveView() {
  setSceneStill(true)
  const { snap, note, stale, bubble } = useLiveView()
  const layout = useLayout()
  useEffect(() => { document.title = '工作小镇 · 直播' }, [])
  return <LiveScreen snap={snap} note={note} stale={stale} bubble={bubble} layout={layout} />
}
