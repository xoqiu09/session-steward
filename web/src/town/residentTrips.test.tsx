import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { createResidentStore, loadResidentLife, newResidentLife, serializeResidentLife, tickResidentLife } from './residentLife'
import { RESIDENT_IDS, homePoint, pointDistance } from './residents'
import { ResidentRoomVisitors } from './ResidentVisits'
import { cellOrigin, projectRoute, readResidentTrip, returnResidentTrip, startResidentTrip, type ResidentWorld } from './residentTrips'

const now = 100_000
const world: ResidentWorld = { home: { cx: 0, cy: -1 }, destinations: [
  { id: 'self#1', key: 'repo-1', name: '合成小屋甲', cell: { cx: 0, cy: 0 }, door: { x: 3.3, y: 4.5 } },
  { id: 'self#2', key: 'repo-2', name: '合成小屋乙', cell: { cx: 2, cy: 1 }, door: { x: 25.3, y: 14.5 } },
] }
const memory = () => { const values = new Map<string, string>(); return { getItem: (k: string) => values.get(k) ?? null, setItem: (k: string, v: string) => { values.set(k, v) } } }
const storeAt = () => { const store = createResidentStore(memory(), now); store.setWorld(world); return store }
const walk = (store: ReturnType<typeof storeAt>, from: number, ms: number) => { for (let t = from + 500; t <= from + ms; t += 500) store.tick(t) }

describe('居民去其他项目串门', () => {
  it('路线沿街道拐弯，最后从项目房前的小路走到门口', () => {
    const route = projectRoute(world.home, world.destinations[1])
    expect(route.at(-1)).toEqual(world.destinations[1].door)
    expect(route).toContainEqual({ x: 31.7, y: 8.9 })
    expect(route).toContainEqual({ x: 31.7, y: 18.9 })
    for (let i = 1; i < route.length; i++) expect(route[i].x === route[i - 1].x || route[i].y === route[i - 1].y).toBe(true)
  })

  it('走到项目门口后进入屋内，能看见来访立绘，逛完后沿路回家', () => {
    const store = storeAt(), original = JSON.stringify(world)
    expect(store.visit('qwen', 'self#1', now)).toBe(true)
    let at = now
    while (at < now + 60_000 && store.getSnapshot().actors.qwen.trip?.phase !== 'inside') { at += 500; store.tick(at) }
    expect(store.getSnapshot().actors.qwen.trip?.phase).toBe('inside')
    const room = renderToStaticMarkup(<svg><ResidentRoomVisitors store={store} projectId="self#1" /></svg>)
    expect(room).toContain('来访居民 Qwen 在屋内参观')
    expect(room).toContain('data-resident-id="qwen"')
    const otherRoom = renderToStaticMarkup(<svg><ResidentRoomVisitors store={store} projectId="self#2" /></svg>)
    expect(otherRoom).not.toContain('data-resident-id="qwen"')
    walk(store, at, 80_000)
    expect(store.getSnapshot().actors.qwen.trip).toBeUndefined()
    expect(Object.keys(store.getSnapshot().actors)).toEqual([...RESIDENT_IDS])
    expect(JSON.stringify(world)).toBe(original)
  })

  it('任意居民都能选择不同项目，不能把已有串门直接瞬移成另一趟', () => {
    const store = storeAt()
    for (const id of RESIDENT_IDS) expect(store.visit(id, id === 'grok' ? 'self#2' : 'self#1', now)).toBe(true)
    expect(store.getSnapshot().actors.grok.trip?.projectId).toBe('self#2')
    expect(store.visit('grok', 'self#1', now + 1)).toBe(false)
    expect(store.visit('qwen', 'missing', now + 1)).toBe(false)
    expect(store.getSnapshot().actors.qwen.trip?.projectId).toBe('self#1')
  })

  it('途中叫回家会按已经走过的路返回，反复点击回家不重置返程', () => {
    const store = storeAt(); store.visit('grok', 'self#2', now); walk(store, now, 9000)
    store.go('grok', true, now + 9000)
    const path = store.getSnapshot().actors.grok.trip!.path
    store.go('grok', true, now + 9100)
    expect(store.getSnapshot().actors.grok.trip!.path).toEqual(path)
    walk(store, now + 9100, 65_000)
    expect(store.getSnapshot().actors.grok).toMatchObject({ ...homePoint('grok'), mode: 'home', pose: 'sleep' })
    expect(store.getSnapshot().actors.grok.trip).toBeUndefined()
  })

  it('刷新保留目的项目、路线和屋内停留，离线八小时不补跑整趟', () => {
    const store = storeAt(); store.visit('claude', 'self#2', now); walk(store, now, 6000)
    const saved = serializeResidentLife(store.getSnapshot()), before = store.getSnapshot().actors.claude.trip!
    let life = loadResidentLife(saved, now + 8 * 3600_000)
    expect(life.actors.claude.trip).toEqual(before)
    life = tickResidentLife(life, life.now + 500, world)
    expect(pointDistance(before, life.actors.claude.trip!)).toBeLessThanOrEqual(1.051)
    expect(life.actors.claude.trip?.phase).toBe('outbound')
  })

  it('目的项目从地图中移除后安全回家，不篡改项目和工作数据', () => {
    const store = storeAt(); store.visit('deepseek', 'self#1', now); walk(store, now, 10_000)
    store.setWorld({ ...world, destinations: [] }); walk(store, now + 10_000, 90_000)
    expect(store.getSnapshot().actors.deepseek.trip).toBeUndefined()
    expect(Object.keys(store.getSnapshot().actors)).toHaveLength(7)
  })

  it('住宅坐标变了时回到当前住处，失效旧路线不会在错误的格子乱跑', () => {
    const store = storeAt(); store.visit('glm', 'self#2', now); walk(store, now, 5000)
    store.setWorld({ ...world, home: { cx: -4, cy: 3 } }); store.tick(now + 5500)
    expect(store.getSnapshot().actors.glm.trip).toBeUndefined()
    expect(store.getSnapshot().actors.glm).toMatchObject(homePoint('glm'))
  })

  it('自动串门一次只安排一位，并且关闭后不自行出门', () => {
    let life = tickResidentLife(newResidentLife(now), now + 91_000, world)
    expect(RESIDENT_IDS.filter((id) => life.actors[id].trip)).toHaveLength(1)
    life = tickResidentLife(life, now + 500_000, world)
    expect(RESIDENT_IDS.filter((id) => life.actors[id].trip)).toHaveLength(1)
    const off = tickResidentLife({ ...newResidentLife(now), autoVisit: false }, now + 91_000, world)
    expect(RESIDENT_IDS.filter((id) => off.actors[id].trip)).toHaveLength(0)
  })

  it('不同地点的居民不因为旧花园坐标相近而隔空增加友谊', () => {
    const life = newResidentLife(now)
    life.actors.claude.trip = startResidentTrip('claude', life.actors.claude, world, world.destinations[1])
    for (const id of RESIDENT_IDS) if (id !== 'claude' && id !== 'qwen') life.actors[id].mode = 'home'
    expect(tickResidentLife(life, now + 7000, world).friendship['claude+qwen']).toBeUndefined()
  })

  it('损坏的串门记录被忽略，原来的七只生活记录继续可用', () => {
    const trip = startResidentTrip('gpt', { x: 5, y: 3.5 }, world, world.destinations[0])
    expect(readResidentTrip({ ...trip, path: [{ x: Infinity, y: 3 }] })).toBeUndefined()
    expect(readResidentTrip({ ...trip, phase: 'working' })).toBeUndefined()
    const back = readResidentTrip(trip)!
    expect(back.origin).toEqual(cellOrigin(world.home))
    expect(returnResidentTrip(back, 'gpt', true).restOnReturn).toBe(true)
  })
})
