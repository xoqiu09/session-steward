import type { LiveContentCard, LiveContentSource, PublicLiveContent } from '../api'
import { liveTopic } from './topics'

export const CONTENT_SOURCES: readonly LiveContentSource[] = ['compass', 'kuangye', 'shufang']
export const sourceName = (source: LiveContentSource, landscape = false) => ({ compass: '罗盘', kuangye: landscape ? '想法便笺' : '旷野之心', shufang: '书房' })[source]
/** Apply to every public string before rendering, including accessible names and attribution. */
export const landscapeText = (text: string, landscape: boolean) => landscape ? text.replaceAll('旷野之心', '想法便笺') : text
const text = (v: unknown, max: number) => typeof v === 'string' && Array.from(v).length <= max && !/[\u0000-\u001f\u007f-\u009f]/.test(v)
export function publicLiveContent(value: unknown): PublicLiveContent | undefined {
  if (!value || typeof value !== 'object') return undefined
  const c = value as Partial<PublicLiveContent>
  if ((c.mode !== undefined && c.mode !== 'random') || !Array.isArray(c.items) || c.items.length > 24 || ![20, 40, 60].includes(c.interval_seconds ?? 0) || !['town', 'reading'].includes(c.focus ?? '') || typeof c.playing !== 'boolean' || !text(c.selected_id, 64) || typeof c.anchor !== 'string' || (c.anchor !== '' && !Number.isFinite(Date.parse(c.anchor)))) return undefined
  const ids = new Set<string>(), items: LiveContentCard[] = []
  for (const item of c.items) {
    if (!item || !text(item.id, 64) || !item.id || ids.has(item.id) || !CONTENT_SOURCES.includes(item.source) || !text(item.title, 48) || !text(item.body, 240) || !text(item.credit, 80)) return undefined
    ids.add(item.id)
    const topic = liveTopic(item.topic)?.id
    items.push({ id: item.id, source: item.source, title: item.title, body: item.body, credit: item.credit, ...(topic ? { topic } : {}) })
  }
  return { ...(c.mode ? { mode: c.mode } : {}), items, playing: c.playing, interval_seconds: c.interval_seconds!, selected_id: c.selected_id!, anchor: c.anchor, focus: c.focus! }
}
export function contentAt(content: PublicLiveContent | undefined, now: number) {
  const c = publicLiveContent(content)
  if (!c?.items.length) return { item: null, index: 0, total: 0, progress: 0 }
  const start = Math.max(0, c.items.findIndex(item => item.id === c.selected_id))
  const age = Number.isFinite(Date.parse(c.anchor)) ? Math.max(0, now - Date.parse(c.anchor)) : 0
  const duration = c.interval_seconds * 1000
  const step = start + (c.playing ? Math.floor(age / duration) : 0)
  const index = c.mode === 'random' ? Math.min(step, c.items.length - 1) : step % c.items.length
  return { item: c.items[index], index, total: c.items.length, progress: c.playing ? (c.mode === 'random' && step >= c.items.length ? 1 : age % duration / duration) : 0 }
}
