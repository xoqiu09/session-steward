import { describe, expect, it } from 'vitest'
import { canvasLayout, canvasReadingViewport, CARD_W, CARD_H } from './canvasLayout'
import type { Group } from './model'
import { fakeItem } from './town/fixtures'
import type { Dep } from './types'

const group = (id: number, count = 1): Group => ({ key: `g-${id}`, repoId: id, name: `合成项目 ${id}`, sessions: [], items: Array.from({ length: count }, (_, i) => fakeItem({ id: `SYN-${id}-${i}`, title: `合成工作 ${i}`, repo_id: id, status: 'in_progress' })) })
describe('readable project canvas', () => {
  it('uses horizontal room instead of placing every project in one long column', () => {
    const projects = canvasLayout(Array.from({ length: 12 }, (_, i) => group(i)), [], 1100, new Set())
    expect(new Set(projects.map(p => p.x)).size).toBeGreaterThan(1)
    expect(new Set(projects.map(p => p.y)).size).toBeLessThan(12)
    for (let i = 0; i < projects.length; i++) for (let j = i + 1; j < projects.length; j++) {
      const a = projects[i], b = projects[j]
      expect(a.x + a.width <= b.x || b.x + b.width <= a.x || a.y + a.height <= b.y || b.y + b.height <= a.y).toBe(true)
    }
  })
  it('fits three independent tasks into a compact two-column project', () => {
    const [p] = canvasLayout([group(1, 3)], [], 1000, new Set())
    expect(new Set(p.cards.map(c => c.x)).size).toBe(2)
    for (const c of p.cards) { expect(c.x + CARD_W).toBeLessThanOrEqual(p.x + p.width); expect(c.y + CARD_H).toBeLessThanOrEqual(p.y + p.height) }
  })
  it('keeps dependency direction while avoiding overlaps with the next project', () => {
    const a = group(1, 4), b = group(2)
    const deps: Dep[] = a.items.slice(1).map((w, i) => ({ upstream: a.items[i].id, downstream: w.id, cond: 'accepted', satisfied: false }))
    const [p, next] = canvasLayout([a, b], deps, 700, new Set())
    expect(p.cards.map(c => c.x)).toEqual([...p.cards.map(c => c.x)].sort((a, b) => a - b))
    expect(next.y).toBeGreaterThanOrEqual(p.y + p.height)
  })
  it('collapsed and empty projects retain only their compact header', () => {
    const p = canvasLayout([group(1, 8), group(2, 0)], [], 1000, new Set(['g-1']))
    expect(p.every(x => x.cards.length === 0 && x.height < 100 && x.width < 400)).toBe(true)
  })
  it('keeps reading zoom independent of board height, including narrow screens', () => {
    for (const width of [360, 800, 1800]) {
      const p = canvasReadingViewport({ x: 1500, y: 10000 }, width)
      expect(p.zoom).toBeGreaterThanOrEqual(0.8)
      expect(p.x + 1500 * p.zoom).toBe(24)
      expect(p.y + 10000 * p.zoom).toBe(20)
    }
  })
})
