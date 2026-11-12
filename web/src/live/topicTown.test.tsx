import { describe, expect, it, vi, afterEach } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { demoSnapshot } from '../town/fixtures'
import { buildTown } from '../town/townModel'
import { LiveScreen } from './LiveView'
import { liveBodyBox, liveSignBox, liveWorld, overlaps } from './layout'
import { TOPIC_HOUSES, TOPIC_SIGN_SCALE, topicEvent, topicTown } from './topicTown'

afterEach(() => vi.unstubAllGlobals())

describe('仅直播使用的主题小镇', () => {
  it('主题不依赖真实项目，且没有捏造工作或改写原快照', () => {
    const before = structuredClone(demoSnapshot)
    const ordinary = buildTown(demoSnapshot, demoSnapshot.now)
    const town = topicTown(demoSnapshot.now)
    expect(town.model.buildings.map(b => b.name)).toEqual(TOPIC_HOUSES)
    expect(town.model.buildings.every(b => !b.characters.length && !b.items.length && !b.parcels.length)).toBe(true)
    expect(town.model.counts.working).toBe(0)
    expect(town.snap.sessions).toEqual([])
    expect(demoSnapshot).toEqual(before)
    expect(buildTown(demoSnapshot, demoSnapshot.now)).toEqual(ordinary)
    expect(ordinary.buildings.map(b => b.name)).toContain('pixel-ledger')
  })

  it('真实进度不冒充某间主题小屋的进度，也不携带项目名或编号', () => {
    expect(topicEvent(null)).toBeNull()
    const event = topicEvent({ key: 'synthetic', kind: 'delivered', repoId: 42, text: 'PRIVATE_CANARY · 任意数据' })!
    expect(event).toEqual({ key: 'synthetic', kind: 'delivered', repoId: null, text: '后台动态 · 完成一项交付' })
  })

  for (const presentation of ['studio', 'companion', 'town'] as const) {
    it(`${presentation}横竖屏都展示完整主题，不展示项目代号或来源，也不读写本地存储`, () => {
      const storage = { getItem: vi.fn(() => null), setItem: vi.fn() }
      vi.stubGlobal('localStorage', storage)
      for (const layout of ['portrait', 'landscape'] as const) {
        const html = renderToStaticMarkup(<LiveScreen snap={demoSnapshot} note={{ doing: '', thinking: '', contact: '', updated_at: '', presentation }} stale={false} bubble={{ key: 'b', kind: 'started', repoId: 3, text: '项目 C · 开始' }} layout={layout} />)
        for (const name of TOPIC_HOUSES) expect(html).toContain(name)
        expect(html).not.toMatch(/项目 (?:[A-Z]|\d+)/)
        expect(html).not.toMatch(/旷野之心|PRIVATE_CANARY|pixel-ledger|morning-brief|town-workshop/)
        expect(html).not.toMatch(/<(button|input|a|select)\b|tabindex=/)
        expect(new Set([...html.matchAll(/data-repo-id="(-\d+)"/g)].map(m => m[1])).size).toBe(13)
      }
      expect(storage.getItem).not.toHaveBeenCalled()
      expect(storage.setItem).not.toHaveBeenCalled()
    })
  }

  for (const aspect of [1.1, 1.3, 1.8, 3.5]) for (const art of ['original', 'storybook', 'miniature'] as const) {
    it(`13间小屋在${art}、比例${aspect}下名牌不遮挡，所有房子在取景范围内`, () => {
      const { model } = topicTown(demoSnapshot.now)
      const live = liveWorld(model.buildings, undefined, aspect, art, true, { limit: TOPIC_HOUSES.length, signScale: TOPIC_SIGN_SCALE })
      const districts = live.world.districts
      expect(districts).toHaveLength(13)
      const signs = districts.map(d => liveSignBox(d, live.dress.signs.get(d.key)!, live.dress.signK))
      const bodies = districts.map(d => liveBodyBox(d, art))
      for (let i = 0; i < districts.length; i++) {
        for (let j = 0; j < districts.length; j++) if (i !== j) {
          expect(overlaps(signs[i], signs[j]), `名牌${i}/${j}`).toBe(false)
          expect(overlaps(signs[i], bodies[j]), `名牌${i}/建筑${j}`).toBe(false)
        }
        for (const box of [signs[i], bodies[i]]) {
          expect(box.x).toBeGreaterThanOrEqual(live.frame.x)
          expect(box.y).toBeGreaterThanOrEqual(live.frame.y)
          expect(box.x + box.w).toBeLessThanOrEqual(live.frame.x + live.frame.w + 0.001)
          expect(box.y + box.h).toBeLessThanOrEqual(live.frame.y + live.frame.h + 0.001)
        }
      }
    })
  }
})
