import type { LiveCompanionAction, LiveResidents } from '../api'
import { residentSpec, type ResidentId } from '../town/residents'

export const LIVE_RESIDENT_IDS: readonly ResidentId[] = ['gpt', 'claude', 'deepseek', 'gemini', 'glm', 'grok', 'qwen']
export const liveResidentName = (id: ResidentId) => id === 'gpt' ? 'ChatGPT' : residentSpec(id).name
export const validLiveResident = (id: unknown): id is ResidentId => LIVE_RESIDENT_IDS.includes(id as ResidentId)
export const DEFAULT_RESIDENT_CONTROL: LiveResidents = { resident: 'gpt', mode: 'auto', interval_seconds: 120, anchor: '1970-01-01T00:00:00Z' }

export function publicLiveResidents(value: unknown): LiveResidents | undefined {
  if (!value || typeof value !== 'object') return undefined
  const c = value as Partial<LiveResidents>
  if (!validLiveResident(c.resident) || !['auto', 'fixed'].includes(c.mode ?? '') || ![60, 120, 300].includes(c.interval_seconds ?? 0) || typeof c.anchor !== 'string' || !/^\d{4}-\d\d-\d\dT/.test(c.anchor) || !Number.isFinite(Date.parse(c.anchor))) return undefined
  return { resident: c.resident, mode: c.mode!, interval_seconds: c.interval_seconds!, anchor: c.anchor }
}

/** Shared wall clock + saved anchor keeps independent App/OBS pages on the same resident. */
export function liveResidentAt(control: LiveResidents | undefined, now: number, activeGesture?: LiveCompanionAction | null): ResidentId {
  const c = publicLiveResidents(control) ?? DEFAULT_RESIDENT_CONTROL
  const selectedAt = (at: number): ResidentId => {
    if (c.mode === 'fixed') return c.resident
    const step = Math.max(0, Math.floor((at - Date.parse(c.anchor)) / (c.interval_seconds * 1000)))
    return LIVE_RESIDENT_IDS[(LIVE_RESIDENT_IDS.indexOf(c.resident) + step) % LIVE_RESIDENT_IDS.length]
  }
  // Let a gesture finish before an automatic handoff; a newer manual selection takes priority.
  if (activeGesture && Date.parse(activeGesture.at) >= Date.parse(c.anchor) && validLiveResident(activeGesture.resident) && selectedAt(Date.parse(activeGesture.at)) === activeGesture.resident) return activeGesture.resident
  return selectedAt(now)
}

const IDLE: Record<ResidentId, string> = {
  gpt: '你忙你的，我就在这里陪你。', claude: '茶刚泡好，给你留一个位置。', deepseek: '饭团分你一口，慢慢来呀。',
  gemini: '今天也想把你画进画里。', glm: '点心给你留着，别太累哦。', grok: '路过也可以坐一会儿。', qwen: '奶茶和点心，大家都有份。',
}
export function liveResidentSpeech(id: ResidentId, gesture: 'idle' | 'pat' | 'walk' | 'home'): string {
  if (gesture === 'pat') return residentSpec(id).pat
  if (gesture === 'walk') return '去小院转一圈，一会儿就回来。'
  if (gesture === 'home') return '好啦，回家给你留一盏灯。'
  return IDLE[id]
}
