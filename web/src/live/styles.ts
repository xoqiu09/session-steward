import type { LiveStyle } from '../api'
import type { TownThemeId } from '../town/appearance'

export const LIVE_STYLES: readonly { id: LiveStyle; name: string; description: string; art: TownThemeId }[] = [
  { id: 'cozy-night', name: '温暖夜景', description: '蓝夜色 · 小屋灯光 · 安静陪伴', art: 'miniature' },
  { id: 'storybook-day', name: '清新绘本', description: '奶油纸色 · 手绘小屋 · 花园日常', art: 'storybook' },
  { id: 'ai-studio', name: 'AI 工作室', description: '深色场景 · 青色光路 · 几何建筑', art: 'original' },
]

export function liveStyle(value: unknown): LiveStyle {
  return LIVE_STYLES.some(s => s.id === value) ? value as LiveStyle : 'cozy-night'
}

/** Only a known preview value can override the saved style; no browser storage. */
export function requestedLiveStyle(search: string): LiveStyle | null {
  const id = new URLSearchParams(search).get('live-style')
  return LIVE_STYLES.some(s => s.id === id) ? id as LiveStyle : null
}

export function liveStyleArt(style: LiveStyle): TownThemeId {
  return LIVE_STYLES.find(s => s.id === style)!.art
}
