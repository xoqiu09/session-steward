import { describe, expect, it } from 'vitest'
import { createResidentStore, loadResidentLife, newResidentLife, RESIDENT_STORAGE_KEY, serializeResidentLife, tickResidentLife } from './residentLife'
import { GARDEN_SPOTS, RESIDENT_IDS, gardenDrop, gardenRoute, homePoint, pointDistance } from './residents'

const now = 100_000
const memory = () => {
  const values = new Map<string, string>()
  return { values, getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value) } }
}

describe('七位居民的本地生活', () => {
  it('旧记录损坏、缺角色或写了未知角色，仍保留完整的七位居民', () => {
    for (const raw of [null, 'broken', '{"version":2}', '{"version":1,"actors":{"stranger":{"x":4,"y":5}}}', '{"version":1,"actors":{"deepseek":{"x":100,"y":-100}}}']) {
      const life = loadResidentLife(raw, now)
      expect(Object.keys(life.actors)).toEqual([...RESIDENT_IDS])
      expect(life.actors.deepseek.x).toBe(GARDEN_SPOTS.lake.x)
    }
  })

  it('从湖边回家经过小路路口，拖进湖里或房子里会落到最近的小路', () => {
    const route = gardenRoute(GARDEN_SPOTS.lake, 'home', homePoint('deepseek'))
    expect(route).toContainEqual(GARDEN_SPOTS.east)
    expect(route).toContainEqual(GARDEN_SPOTS.cross)
    expect(route.at(-1)).toEqual(homePoint('deepseek'))
    const lakeDrop = gardenDrop({ x: 8, y: 1 })
    expect(lakeDrop).toEqual({ x: 7.4, y: 3.2 })
    const houseDrop = gardenDrop({ x: 2, y: 1 })
    expect(houseDrop.y).toBeGreaterThanOrEqual(3.5)
  })

  it('送回家会走完整条路，到家后持续休息，点散步才出门', () => {
    const store = createResidentStore(memory(), now)
    store.go('deepseek', true, now)
    expect(store.getSnapshot().actors.deepseek.route.length).toBeGreaterThan(0)
    for (let t = now + 500; t <= now + 50_000; t += 500) store.tick(t)
    const atHome = store.getSnapshot().actors.deepseek
    expect(atHome).toMatchObject({ ...homePoint('deepseek'), mode: 'home', pose: 'sleep', route: [] })
    store.tick(now + 600_000)
    expect(store.getSnapshot().actors.deepseek).toMatchObject({ ...homePoint('deepseek'), mode: 'home', route: [] })
    store.go('deepseek', false, now + 601_000)
    expect(store.getSnapshot().actors.deepseek.mode).toBe('roam')
    expect(store.getSnapshot().actors.deepseek.route.length).toBeGreaterThan(0)
  })

  it('位置、摸头次数、回家意图和友谊能保存，刷新不伪造离线活动', () => {
    const storage = memory(), store = createResidentStore(storage, now)
    store.drop('grok', { x: 5, y: 6.5 }, now)
    store.pat('grok', now + 1)
    store.go('qwen', true, now + 2)
    const saved = JSON.parse(storage.values.get(RESIDENT_STORAGE_KEY)!)
    saved.friendship['claude+qwen'] = { points: 3, lastAt: now }
    const back = loadResidentLife(JSON.stringify(saved), now + 86_400_000)
    expect(back.actors.grok).toMatchObject({ x: 5, y: 6.5, pats: 1 })
    expect(back.actors.qwen.mode).toBe('home')
    expect(back.actors.qwen.route.length).toBeGreaterThan(0)
    expect(back.friendship['claude+qwen'].points).toBe(3)
    expect(back.journal).toHaveLength(saved.journal.length)
    expect(JSON.parse(serializeResidentLife(back)).version).toBe(1)
  })

  it('电脑睡眠八小时后，一拍最多走一秒，不能补跑一夜路线和友谊', () => {
    const store = createResidentStore(memory(), now)
    store.go('deepseek', true, now)
    const before = store.getSnapshot().actors.deepseek
    store.tick(now + 8 * 3600_000)
    expect(pointDistance(before, store.getSnapshot().actors.deepseek)).toBeLessThanOrEqual(0.681)
    expect(store.getSnapshot().actors.deepseek.route.length).toBeGreaterThan(0)
  })

  it('碰面会有一场前后对话，并在冷却期内只记一次友谊', () => {
    let life = newResidentLife(now)
    for (const id of RESIDENT_IDS) life.actors[id] = { ...life.actors[id], mode: id === 'claude' || id === 'qwen' ? 'roam' : 'home', nextAt: Infinity }
    life = tickResidentLife(life, now + 7000)
    const a = life.actors.claude.bubble!, b = life.actors.qwen.bubble!
    expect(a.text.length).toBeGreaterThan(0)
    expect(b.from).toBeGreaterThan(a.from)
    expect(life.friendship['claude+qwen'].points).toBe(1)
    for (let t = now + 7500; t < now + 80_000; t += 500) life = tickResidentLife(life, t)
    expect(life.friendship['claude+qwen'].points).toBe(1)
  })

  it('暂停散步保持位置，但摸头气泡仍会到时结束；安静模式不发起对话', () => {
    const store = createResidentStore(memory(), now)
    store.go('gpt', true, now)
    const life = { ...store.getSnapshot(), paused: true }
    life.actors.gpt = { ...life.actors.gpt, pose: 'pat', bubble: { text: '摸摸头', from: now, until: now + 4000 } }
    const next = tickResidentLife(life, now + 5000)
    expect(next.actors.gpt.x).toBe(life.actors.gpt.x)
    expect(next.actors.gpt.y).toBe(life.actors.gpt.y)
    expect(next.actors.gpt.bubble).toBeUndefined()
    const quiet = tickResidentLife({ ...newResidentLife(now), quiet: true }, now + 7000)
    expect(quiet.friendship).toEqual({})
  })

  it('浏览器禁止存储时仍能生活和摸头，不影响工作接口', () => {
    const storage = { getItem: () => { throw new Error('disabled') }, setItem: () => { throw new Error('disabled') } }
    const store = createResidentStore(storage, now)
    expect(() => { store.pat('qwen', now); store.save() }).not.toThrow()
    expect(store.getSnapshot().actors.qwen.pats).toBe(1)
  })
})
