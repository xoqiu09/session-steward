import { useEffect, useState } from 'react'
import type { LiveNote, LiveStyle } from '../api'
import type { TownModel } from '../town/townModel'
import type { TownThemeId } from '../town/appearance'
import { residentImage } from '../town/residents'
import { LiveStage } from './LiveStage'
import type { LiveEvent } from './events'
import type { LiveSnapshot } from './scrub'
import type { LiveLayout } from './LiveView'
import { contentAt, landscapeText, sourceName } from './content'
import { LIVE_RESIDENT_IDS, liveResidentName, liveResidentSpeech } from './liveResidents'
import { useLiveResident } from './useLiveResident'
import { activeCompanionAction } from './companion'
import './studio.css'

export function StudioScene({ snap, model, note, stale, bubble, recent, layout, style, theme }: {
  snap: LiveSnapshot | null; model: TownModel | null; note: LiveNote | null; stale: boolean
  bubble: LiveEvent | null; recent: LiveEvent | null; layout: LiveLayout; style: LiveStyle; theme: TownThemeId
}) {
  const [now, setNow] = useState(Date.now)
  useEffect(() => { const timer = window.setInterval(() => setNow(Date.now()), 1000); return () => window.clearInterval(timer) }, [])
  const resident = useLiveResident(note?.resident_control, note?.companion)
  const action = activeCompanionAction(note?.companion, now)
  const gesture = action && (!action.resident || action.resident === resident) ? action.kind : 'idle'
  const content = contentAt(note?.content, now)
  const landscape = layout === 'landscape'
  const publicText = (text: string) => landscapeText(text, landscape)
  const reading = note?.content?.focus === 'reading' && !!content.item
  const working = model?.counts.working ?? 0
  const name = liveResidentName(resident)
  return <main className={`live-view studio-scene is-${layout}${reading ? ' is-reading' : ''}`} data-town-theme={theme} data-live-style={style} lang="zh-CN">
    <header className="studio-heading"><div><p><i />工作小镇 · 安静陪伴</p><h1>{publicText(note?.doing?.trim() || '今天，也让小镇往前一点。')}</h1><span>{publicText(note?.thinking?.trim() || '一边认真做事，一边慢慢生活。')}</span></div><div className="studio-presence"><b>{String(working).padStart(2, '0')}</b><span>位助手<br />正在工作</span></div></header>
    <div className="studio-composition">
      <section className={`studio-town town-view${theme === 'miniature' ? ' is-miniature' : theme === 'storybook' ? ' is-storybook' : ''}`} aria-label="此刻的小镇实况">
        <header><span><i />此刻的小镇</span><small>房子是项目 · 小人是 AI 助手</small></header>
        <div className="studio-town-canvas">{snap && model ? <LiveStage model={model} snap={snap} bubble={bubble} residents initialAspect={landscape ? 1.4 : 1.3} /> : <p className="live-loading">小镇正在亮灯…</p>}</div>
        <p className="studio-town-caption">七位居民，自在走走。<span>展示最近 {Math.min(8, model?.buildings.filter(b => b.repo).length ?? 0)} 个项目</span></p>
      </section>
      <aside className="studio-sidebar">
        <section className={`studio-reading${content.item ? ' has-content' : ''}`} aria-label="公开内容卡片">
          {content.item ? <article className="studio-reading-card" key={content.item.id}>
            <header><span>{sourceName(content.item.source, landscape)}</span><small>{reading ? '今晚，读到这里' : '小镇的放映角'}</small></header>
            <h2>{publicText(content.item.title)}</h2><p>{publicText(content.item.body)}</p>
            <footer><span>{publicText(content.item.credit) || '一张公开的内容卡'}</span><b>{String(content.index + 1).padStart(2, '0')} / {String(content.total).padStart(2, '0')}</b></footer>
            <div className="studio-reading-progress" aria-hidden="true"><i style={{ transform: `scaleX(${content.progress})` }} /></div>
          </article> : <article className="studio-reading-card is-empty"><header><span>小镇的放映角</span><small>慢慢来</small></header><h2>把日子，过成<br />自己的作品。</h2><p>这里会放些想法、阅读和做好的小作品。现在，先陪小镇坐一会儿。</p><footer><span>留一点时间，给喜欢的事。</span><b>✦</b></footer></article>}
        </section>
        <section className={`studio-resident is-${gesture}`} aria-label={`${name}在这里陪你`}><div className="studio-resident-portrait" key={resident}><i /><img src={residentImage(resident, { idle: 'idle', pat: 'pat', walk: 'activity', home: 'greet' }[gesture])} alt={`${name} · 小镇居民`} /></div><div className="studio-resident-message"><p>{liveResidentSpeech(resident, gesture)}</p><span><i />{name}<small>今晚的陪伴</small></span></div></section>
        <section className="studio-activity" aria-label="小镇刚刚发生"><span><i />小镇刚刚发生</span><p>{stale ? '小镇正在重新连接，先在这里歇一会儿。' : recent ? publicText(recent.text) : snap ? `此刻 ${working} 位助手在工作，灯光慢慢亮着。` : '正在连接小镇…'}</p><small>{publicText(note?.contact?.trim() || '在直播间打个招呼，休息时回来聊。')}</small></section>
      </aside>
    </div>
    <footer className="studio-footer"><div className="studio-roster" aria-label="七位小镇居民">{LIVE_RESIDENT_IDS.map(id => <div key={id} className={resident === id ? 'is-current' : undefined}><img src={residentImage(id, 'avatar')} alt="" /><span>{liveResidentName(id)}</span><i /></div>)}</div><p>做点喜欢的事，也欢迎你安静待一会儿。</p></footer>
    <div className="studio-safe-area" aria-label="直播间评论预留区"><span>路过，也可以坐一会儿。</span></div>
  </main>
}
