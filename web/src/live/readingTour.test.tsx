import { afterEach, describe, expect, it, vi } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { createResidentStore, newResidentLife, tickResidentLife } from '../town/residentLife'
import { residentWorld } from '../town/residentTrips'
import { RESIDENT_IDS, pointDistance } from '../town/residents'
import { liveWorld } from './layout'
import { topicTown, TOPIC_SIGN_SCALE } from './topicTown'
import { createReadingTour } from './readingTour'
import { LIVE_TOPICS, topicHouseKey } from './topics'
import { publicLiveContent } from './content'
import { LiveScreen } from './LiveView'
import { demoSnapshot } from '../town/fixtures'
import type { LiveNote, PublicLiveContent } from '../api'

const NOW = Date.parse('2026-11-12T00:00:00Z')
const { model } = topicTown(new Date(NOW).toISOString())
const world = residentWorld(liveWorld(model.buildings, undefined, 1.3, 'storybook', true, { limit: 13, signScale: TOPIC_SIGN_SCALE }).world)!
const place = (a: ReturnType<typeof newResidentLife>['actors']['gpt']) => a.trip ?? a.wander ?? a
const content: PublicLiveContent = { playing: false, interval_seconds: 40, focus: 'town', selected_id: 'a', anchor: '', items: [{ id: 'a', source: 'kuangye', title: '合成阅读标题', body: '合成阅读正文', credit: '阅读摘意 · 非逐字原文', topic: 'emotion' }] }
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals() })

describe('直播阅读串门', () => {
  it.each(LIVE_TOPICS)('能到达 $name 并持续陪读，输入生活状态不被改写', topic => {
    const tour = createReadingTour(), before = newResidentLife(NOW), original = structuredClone(before)
    tour.setReading({ topic: topic.id, resident: 'gpt' })
    let life = before
    for (let t = 0; t <= 20_000; t += 500) life = tour.advance(life, NOW + t, world)
    expect(life.actors.gpt.trip?.projectId).toBe(topicHouseKey(topic.id))
    expect(life.actors.gpt.trip?.phase).toBe('inside')
    for (let t = 20_500; t <= 90_000; t += 500) life = tour.advance(life, NOW + t, world)
    expect(life.actors.gpt.trip?.phase).toBe('inside')
    expect(before).toEqual(original)
    expect(RESIDENT_IDS.some(id => id !== 'gpt' && pointDistance(place(life.actors[id]), place(before.actors[id])) > 0.1)).toBe(true)
  })

  it('快速切换只走向最新小屋，从当前路上重新规划，重复同主题不会重启路线', () => {
    const tour = createReadingTour()
    tour.setReading({ topic: 'emotion', resident: 'gpt' })
    let life = tour.advance(newResidentLife(NOW), NOW + 500, world)
    const position = { ...place(life.actors.gpt) }
    tour.setReading({ topic: 'wealth', resident: 'gpt' })
    tour.setReading({ topic: 'family', resident: 'gpt' })
    life = tour.advance(life, life.now, world)
    expect(pointDistance(position, place(life.actors.gpt))).toBe(0)
    expect(life.actors.gpt.trip?.projectId).toBe(topicHouseKey('family'))
    const oldTrip = life.actors.gpt.trip
    tour.setReading({ topic: 'family', resident: 'gpt' })
    life = tour.advance(life, life.now, world)
    expect(life.actors.gpt.trip).toEqual(oldTrip)
  })

  it('内容取消联动或换一位居民时，原居民从所在位置回家', () => {
    const tour = createReadingTour()
    tour.setReading({ topic: 'emotion', resident: 'gpt' })
    let life = tour.advance(newResidentLife(NOW), NOW + 500, world)
    const at = { ...place(life.actors.gpt) }
    tour.setReading({ topic: 'growth', resident: 'claude' })
    life = tour.advance(life, life.now, world)
    expect(pointDistance(at, place(life.actors.gpt))).toBe(0)
    expect(life.actors.gpt.trip?.phase).toBe('returning')
    expect(life.actors.claude.trip?.projectId).toBe(topicHouseKey('growth'))
    const nextAt = { ...place(life.actors.claude) }
    tour.setReading(null)
    life = tour.advance(life, life.now, world)
    expect(pointDistance(nextAt, place(life.actors.claude))).toBe(0)
    expect(life.actors.claude.trip?.phase).toBe('returning')
  })

  it('没有联动时行为与普通生活时钟一致，普通 store 仍沿用原算法', () => {
    const life = newResidentLife(NOW), tour = createReadingTour()
    expect(tour.advance(life, NOW + 500, world)).toEqual(tickResidentLife(life, NOW + 500, world))
    const storage = { getItem: () => null, setItem: vi.fn() }, ordinary = createResidentStore(storage, NOW)
    ordinary.setWorld(world); ordinary.tick(NOW + 500)
    expect(ordinary.getSnapshot()).toEqual(tickResidentLife(life, NOW + 500, world))
  })

  it('浏览器长时间没有计时后恢复，每拍仍限速，不瞬移到终点', () => {
    const tour = createReadingTour(); tour.setReading({ topic: 'family', resident: 'gpt' })
    let life = tour.advance(newResidentLife(NOW), NOW, world)
    const at = { ...place(life.actors.gpt) }
    life = tour.advance(life, NOW + 300_000, world)
    expect(pointDistance(at, place(life.actors.gpt))).toBeLessThanOrEqual(16.8)
    expect(life.actors.gpt.trip?.phase).toBe('outbound')
  })

  it('未知主题不进入公开标签，旧卡片保持可播放', () => {
    expect(publicLiveContent({ ...content, items: [{ ...content.items[0], topic: '/PRIVATE_CANARY' }] })?.items[0]).not.toHaveProperty('topic')
    expect(publicLiveContent({ ...content, items: [{ ...content.items[0], topic: undefined }] })?.items).toHaveLength(1)
  })

  it('三种布局仅点亮对应小屋，暂停卡片保留灯光，公开画面无操作入口或来源提示', () => {
    vi.useFakeTimers(); vi.setSystemTime(NOW)
    const storage = { getItem: vi.fn(), setItem: vi.fn() }; vi.stubGlobal('localStorage', storage)
    for (const presentation of ['studio', 'companion', 'town'] as const) for (const layout of ['portrait', 'landscape'] as const) {
      const note: LiveNote = { doing: '', thinking: '', contact: '', updated_at: '', presentation, content }
      const html = renderToStaticMarkup(<LiveScreen snap={demoSnapshot} note={note} stale={false} bubble={null} layout={layout} />)
      expect(html.match(/data-live-reading="true"/g)).toHaveLength(1)
      expect(html).toContain('data-reading-topic="emotion"')
      expect(html).toContain('正在读 · 心理与情绪')
      expect(html).not.toMatch(/旷野之心|想法便笺|项目 [A-Z]|<(button|input|a|select)\b|tabindex=/)
    }
    expect(storage.getItem).not.toHaveBeenCalled(); expect(storage.setItem).not.toHaveBeenCalled()
  })
})
