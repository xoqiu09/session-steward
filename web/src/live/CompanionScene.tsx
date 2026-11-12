import { useEffect, useState } from 'react'
import type { LiveCompanionAction, LiveNote, LiveStyle } from '../api'
import type { TownModel } from '../town/townModel'
import type { TownThemeId } from '../town/appearance'
import { LiveStage } from './LiveStage'
import type { LiveEvent } from './events'
import type { LiveSnapshot } from './scrub'
import { activeCompanionAction, COMPANION_ACTION_MS } from './companion'
import type { LiveLayout } from './LiveView'
import { residentImage } from '../town/residents'
import { liveResidentName, liveResidentSpeech } from './liveResidents'
import { useLiveResident } from './useLiveResident'
import { TOPIC_HOUSES, TOPIC_SIGN_SCALE } from './topicTown'
import './companion.css'

const POSE = { idle: 'idle', pat: 'pat', walk: 'activity', home: 'greet' }

function useGesture(action: LiveCompanionAction | undefined) {
  const [active, setActive] = useState<LiveCompanionAction | null>(null)
  useEffect(() => {
    const next = activeCompanionAction(action, Date.now())
    setActive(next)
    if (!next) return
    const t = window.setTimeout(() => setActive(null), COMPANION_ACTION_MS - (Date.now() - Date.parse(next.at)))
    return () => window.clearTimeout(t)
  }, [action?.id])
  return active?.kind ?? 'idle'
}

/** Theme houses and residents are scenery. The aggregate work count and events remain real. */
export function CompanionScene({ snap, model, note, stale, bubble, recent, layout, style, theme }: {
  snap: LiveSnapshot | null; model: TownModel | null; note: LiveNote | null; stale: boolean
  bubble: LiveEvent | null; recent: LiveEvent | null; layout: LiveLayout; style: LiveStyle; theme: TownThemeId
}) {
  const gesture = useGesture(note?.companion)
  const resident = useLiveResident(note?.resident_control, note?.companion)
  const name = liveResidentName(resident)
  const shownGesture = note?.companion?.resident && note.companion.resident !== resident ? 'idle' : gesture
  const working = model?.counts.working ?? 0
  return <main className={`live-view live-companion is-${layout}`} data-town-theme={theme} data-live-style={style} lang="zh-CN">
    <section className="companion-hero" aria-label={`${name}的陪伴小院`}>
      <img className="companion-courtyard" src="/town/live/courtyard.png" alt="花园小院里亮着暖灯" />
      <div className="companion-shade" />
      <header className="companion-title">
        <p className="companion-eyebrow"><i />工作小镇 · 安静陪伴</p>
        <h1 className={Array.from(note?.doing ?? '').length > 32 ? 'is-long' : undefined}>{note?.doing?.trim() || '认真做事，\n也慢慢生活。'}</h1>
        <p className="companion-thought">{note?.thinking?.trim() || '你也可以只是在这里，安静待一会儿。'}</p>
      </header>
      <aside className="companion-cards" aria-label="小镇动态与留言方式">
        <section className="companion-info" aria-label="小镇刚刚发生">
          <span className="companion-card-label"><i />小镇刚刚发生</span>
          <p>{recent?.text || (snap ? `现在 ${working} 位助手在工作，小镇慢慢向前。` : '正在连接小镇…')}</p>
        </section>
        <section className="companion-info companion-invitation" aria-label={`给 ${name} 留句话`}>
          <span className="companion-card-label">给 {name} 留句话</span>
          <p>{note?.contact?.trim() || '在直播间打个招呼，休息时回来聊。'}</p>
          <small>也可以只是安静陪伴</small>
        </section>
      </aside>
      <div key={resident} className={`companion-resident is-${shownGesture}`} data-resident={resident}>
        <p className="companion-speech" role="status">{liveResidentSpeech(resident, shownGesture)}</p>
        <div className="companion-pet"><i className="companion-shadow" /><img src={residentImage(resident, POSE[shownGesture])} alt={`${name} · ${shownGesture === 'walk' ? '在小院散步' : shownGesture === 'home' ? '回家休息' : shownGesture === 'pat' ? '开心地回应摸摸' : '在小院陪你'}`} />{shownGesture === 'pat' && <span className="companion-heart" aria-hidden="true">♡</span>}</div>
        <p className="companion-name"><i />{name}<span>小镇居民</span></p>
      </div>
      <span className="companion-courtyard-caption">{name}的小院</span>
    </section>
    <section className="companion-town-panel" aria-label="主题小镇">
      <header className="companion-town-heading"><div><i /><h2>今晚的主题小镇</h2><span>{TOPIC_HOUSES.length} 间主题小屋</span></div><small>一间小屋，一个方向 · 七位居民自在散步</small></header>
      <div className={`town-view live-town companion-town${theme === 'storybook' ? ' is-storybook' : theme === 'miniature' ? ' is-miniature' : ''}`}>
        {snap && model ? <LiveStage model={model} snap={snap} bubble={bubble} residents maxBuildings={TOPIC_HOUSES.length} signScale={TOPIC_SIGN_SCALE} initialAspect={layout === 'portrait' ? 1.8 : 3.5} /> : <p className="live-loading">小镇加载中…</p>}
      </div>
      {stale && <p className="companion-connection" role="status">小镇画面正在重连</p>}
    </section>
    <div className="companion-safe-area" aria-label="直播间评论预留区" />
  </main>
}
