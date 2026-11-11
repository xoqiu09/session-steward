import { GARDEN_SPOTS, RESIDENT_IDS, gardenDrop, gardenRoute, homePoint, pointDistance, residentConversation, residentSpec, visitingPoint, type GardenPoint, type GardenSpot, type ResidentId } from './residents'
import { cellOrigin, readResidentTrip, returnResidentTrip, startResidentTrip, tickResidentTrip, type ResidentTrip, type ResidentWorld } from './residentTrips'
import { nextResidentWander, readResidentWander, returnResidentWander, tickResidentWander, wanderPause, type ResidentWander } from './residentWander'

export const RESIDENT_STORAGE_KEY = 'ss.town.residents.v1'
type Pose = 'idle' | 'pat' | 'sleep' | 'activity' | 'greet'
export interface ResidentActor extends GardenPoint {
  id: ResidentId; target: GardenSpot; route: GardenPoint[]; mode: 'roam' | 'home'
  pose: Pose; facing: 1 | -1; nextAt: number; holdUntil: number; visits: number; pats: number
  bubble?: { text: string; from: number; until: number }
  trip?: ResidentTrip
  wander?: ResidentWander
}
export interface Friendship { points: number; lastAt: number }
export interface ResidentLife {
  version: 1; enabled: boolean; quiet: boolean; paused: boolean; now: number; nextChat: number
  actors: Record<ResidentId, ResidentActor>; friendship: Record<string, Friendship>
  journal: { at: number; text: string }[]
  autoVisit: boolean; nextVisitAt: number; visitCursor: number
}
type ResidentStorage = Pick<Storage, 'getItem' | 'setItem'>
const isId = (id: string): id is ResidentId => (RESIDENT_IDS as readonly string[]).includes(id)
const isSpot = (spot: unknown): spot is GardenSpot => typeof spot === 'string' && Object.hasOwn(GARDEN_SPOTS, spot)
const finite = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n)
const count = (n: unknown) => finite(n) ? Math.max(0, Math.min(9999, Math.floor(n))) : 0
const pairKey = (a: ResidentId, b: ResidentId) => [a, b].sort().join('+')
const addJournal = (life: ResidentLife, text: string) => { life.journal = [{ at: life.now, text }, ...life.journal].slice(0, 16) }

export function newResidentLife(now: number): ResidentLife {
  const actors = {} as Record<ResidentId, ResidentActor>
  RESIDENT_IDS.forEach((id, i) => {
    const favorite = residentSpec(id).favorite, spot = GARDEN_SPOTS[favorite]
    // 两位喜欢茶桌的居民分开站，初次打开就能看见七只。
    const at = id === 'qwen' ? { x: 2.5, y: 6.2 } : spot
    actors[id] = { id, x: at.x, y: at.y, target: favorite, route: [], mode: 'roam', pose: 'activity', facing: 1,
      nextAt: now + 9000 + i * 2100, holdUntil: 0, visits: 0, pats: 0 }
  })
  return { version: 1, enabled: true, quiet: false, paused: false, now, nextChat: now + 6500, actors, friendship: {}, journal: [{ at: now, text: '七只搬进了小屋。今天也一起慢慢过。' }], autoVisit: true, nextVisitAt: now + 90_000, visitCursor: 0 }
}

export function loadResidentLife(raw: string | null, now: number): ResidentLife {
  const life = newResidentLife(now)
  try {
    const saved = JSON.parse(raw || 'null')
    if (saved?.version !== 1) return life
    for (const key of ['enabled', 'quiet', 'paused', 'autoVisit'] as const) if (typeof saved[key] === 'boolean') life[key] = saved[key]
    life.visitCursor = count(saved.visitCursor)
    for (const id of RESIDENT_IDS) {
      const a = saved.actors?.[id]
      if (!a || !finite(a.x) || !finite(a.y) || a.x < 0 || a.x > 10 || a.y < 0 || a.y > 10) continue
      const home = a.mode === 'home', target = home ? 'home' : isSpot(a.target) ? a.target : residentSpec(id).favorite
      const route = home && pointDistance(a, homePoint(id)) > 0.05 ? gardenRoute(a, 'home', homePoint(id)) : []
      life.actors[id] = { ...life.actors[id], x: a.x, y: a.y, target, mode: home ? 'home' : 'roam', pats: count(a.pats), visits: count(a.visits),
        pose: route.length ? 'idle' : home ? 'sleep' : 'activity', route, trip: readResidentTrip(a.trip), wander: readResidentWander(a.wander), nextAt: now + 4000 + RESIDENT_IDS.indexOf(id) * 1300 }
      if (life.actors[id].trip) life.actors[id].wander = undefined
    }
    for (const [key, value] of Object.entries(saved.friendship ?? {})) {
      const ids = key.split('+'), v = value as Friendship
      if (ids.length === 2 && ids.every(isId) && ids[0] !== ids[1] && v && finite(v.points) && finite(v.lastAt)) {
        life.friendship[key] = { points: count(v.points), lastAt: Math.min(now, Math.max(0, v.lastAt)) }
      }
    }
    if (Array.isArray(saved.journal)) life.journal = saved.journal.filter((j: { at: number; text: string }) => j && finite(j.at) && typeof j.text === 'string' && j.text.length < 200).slice(0, 16)
  } catch { /* 损坏的旧记录只影响居民，工作数据和小镇布局不受影响。 */ }
  return life
}

export function serializeResidentLife(life: ResidentLife): string {
  return JSON.stringify({ version: 1, enabled: life.enabled, quiet: life.quiet, paused: life.paused, autoVisit: life.autoVisit, visitCursor: life.visitCursor,
    actors: Object.fromEntries(RESIDENT_IDS.map((id) => { const a = life.actors[id]; return [id, { x: a.x, y: a.y, target: a.target, mode: a.mode, visits: a.visits, pats: a.pats, trip: a.trip, wander: a.wander }] })),
    friendship: life.friendship, journal: life.journal })
}

function travel(actor: ResidentActor, target: GardenSpot, now: number, mode: 'home' | 'roam' = 'roam', end?: GardenPoint): ResidentActor {
  return { ...actor, target, mode, pose: 'idle', bubble: undefined, holdUntil: 0, route: gardenRoute(actor, target, mode === 'home' ? homePoint(actor.id) : end ?? visitingPoint(actor.id, target)), nextAt: now }
}

/** 只走本轮经过的短时间；后台停留和电脑睡眠不会补演一夜、刷友谊。 */
export function tickResidentLife(before: ResidentLife, now: number, world?: ResidentWorld): ResidentLife {
  const dt = Math.min(1, Math.max(0, (now - before.now) / 1000))
  const life: ResidentLife = { ...before, now, actors: { ...before.actors }, friendship: { ...before.friendship } }
  if (!life.enabled) return life
  for (const id of RESIDENT_IDS) {
    let a = { ...life.actors[id] }
    if (a.bubble && a.bubble.until <= now) { a.bubble = undefined; a.pose = a.route.length ? 'idle' : a.mode === 'home' ? 'sleep' : 'activity' }
    if (life.paused) { life.actors[id] = a; continue }
    if (a.holdUntil > now) { life.actors[id] = a; continue }
    if (a.trip) {
      if (!world) { life.actors[id] = a; continue }
      const destination = world.destinations.find((d) => d.id === a.trip!.projectId)
      if (pointDistance(a.trip.origin, cellOrigin(world.home)) > 0.1) {
        a = { ...a, ...homePoint(id), trip: undefined, route: [], pose: 'idle', nextAt: now + 15_000 }
      } else {
        let trip = { ...a.trip, projectName: destination?.name ?? a.trip.projectName }
        if (!destination && trip.phase !== 'returning') trip = returnResidentTrip(trip, id, false, world)
        const next = tickResidentTrip(trip, id, dt, world)
        if (next.trip) {
          a.trip = next.trip; a.pose = next.trip.phase === 'inside' ? 'activity' : 'idle'
          if (next.entered) addJournal(life, `${residentSpec(id).name} 到「${trip.projectName}」屋里串门了。`)
        } else {
          a = { ...a, ...homePoint(id), trip: undefined, route: [], mode: trip.restOnReturn ? 'home' : 'roam', pose: trip.restOnReturn ? 'sleep' : 'activity', nextAt: now + 12_000 }
          if (!trip.restOnReturn) a = travel(a, trip.returnTarget ?? residentSpec(id).favorite, now)
          addJournal(life, `${residentSpec(id).name} 从「${trip.projectName}」回家了。`)
        }
      }
      life.actors[id] = a; continue
    }
    if (a.wander && world?.roads) {
      if (pointDistance(a.wander.origin,cellOrigin(world.home))>.1) {
        a = {...a,...homePoint(id),wander:undefined,route:[],pose:'activity',nextAt:now+9000}
      } else if (a.wander.path.length) {
        const next=tickResidentWander(a.wander,dt)
        a.wander=next.walk; a.pose='idle'; if (next.facing) a.facing=next.facing
        if (!next.walk.path.length) {
          if (next.walk.returnTarget) {
            const target=next.walk.returnTarget, at={x:next.walk.x-next.walk.origin.x,y:next.walk.y-next.walk.origin.y}
            a={...a,...at,wander:undefined,target,mode:target==='home'?'home':'roam',pose:target==='home'?'sleep':'activity',nextAt:now+15_000}
          } else { a.pose='activity'; a.visits++; a.nextAt=now+wanderPause(next.walk.seed) }
        }
      } else if (a.nextAt<=now) {
        a.wander=nextResidentWander(id,a,world,now,a.wander,RESIDENT_IDS.filter(other=>other!==id).map(other=>life.actors[other].wander?.path.at(-1)).filter((p):p is GardenPoint=>!!p))??a.wander
        a.pose=a.wander.path.length?'idle':'activity'
      }
      life.actors[id]=a; continue
    }
    if (a.route.length) {
      let left = dt * 0.68
      a.route = [...a.route]
      while (left > 0 && a.route.length) {
        const to = a.route[0], distance = pointDistance(a, to)
        if (distance > 0.001) a.facing = (to.x - a.x) - (to.y - a.y) < 0 ? -1 : 1
        if (distance <= left) { a.x = to.x; a.y = to.y; left -= distance; a.route.shift() }
        else { a.x += (to.x - a.x) * left / distance; a.y += (to.y - a.y) * left / distance; left = 0 }
      }
      if (!a.route.length) {
        a.pose = a.mode === 'home' ? 'sleep' : 'activity'; a.visits++; a.nextAt = now + 16_000 + RESIDENT_IDS.indexOf(id) * 900
        if (a.mode === 'home') addJournal(life, `${residentSpec(id).name} 回小屋休息了。`)
      }
    } else if (a.mode === 'roam' && a.nextAt <= now) {
      const wander=world?.roads?nextResidentWander(id,a,world,now):undefined
      if (wander) { life.actors[id]={...a,wander,route:[],pose:'idle',bubble:undefined}; continue }
      const favorites: GardenSpot[] = [residentSpec(id).favorite, 'square', 'tea', 'flowers', residentSpec(id).favorite, 'market']
      const start = (a.visits + RESIDENT_IDS.indexOf(id) * 2) % favorites.length
      const target = Array.from({ length: favorites.length }, (_, i) => favorites[(start + i) % favorites.length]).find((spot) => spot !== a.target) ?? 'square'
      a = travel(a, target, now)
      // 原地也算停下来做自己的事，避免零长度路线每拍重新出发。
      if (!a.route.length) { a.visits++; a.nextAt = now + 20_000; a.pose = 'activity' }
    }
    life.actors[id] = a
  }
  // 自动串门一次只派一位，其他居民仍在家附近生活；手动可以给不同居民指定不同项目。
  if (world && life.autoVisit && !life.paused && now >= life.nextVisitAt && !RESIDENT_IDS.some((id) => life.actors[id].trip)) {
    const eligible = RESIDENT_IDS.map((_, i) => RESIDENT_IDS[(i + life.visitCursor) % RESIDENT_IDS.length]).find((id) => life.actors[id].mode === 'roam' && life.actors[id].holdUntil <= now)
    const destinations = world.destinations.slice().sort((a, b) =>
      (Math.abs(a.cell.cx - world.home.cx) + Math.abs(a.cell.cy - world.home.cy)) - (Math.abs(b.cell.cx - world.home.cx) + Math.abs(b.cell.cy - world.home.cy)) || a.id.localeCompare(b.id)).slice(0, 12)
    if (eligible && destinations.length) {
      const destination = destinations[life.visitCursor % destinations.length], a = life.actors[eligible]
      life.actors[eligible] = { ...a, route: [], pose: 'idle', bubble: undefined, wander: undefined, trip: startResidentTrip(eligible, a, world, destination, a.wander) }
      life.visitCursor++; addJournal(life, `${residentSpec(eligible).name} 出门去「${destination.name}」串门。`)
    }
    life.nextVisitAt = now + 120_000
  }
  // 一次只发生一场两人对话；每对三分钟记一次碰面，后台不累计。
  if (!life.paused && !life.quiet && now >= life.nextChat) {
    outer: for (let i = 0; i < RESIDENT_IDS.length; i++) for (let j = i + 1; j < RESIDENT_IDS.length; j++) {
      const a = life.actors[RESIDENT_IDS[i]], b = life.actors[RESIDENT_IDS[j]], key = pairKey(a.id, b.id)
      if (a.trip || b.trip || !!a.wander!==!!b.wander || a.mode === 'home' || b.mode === 'home' || a.holdUntil > now || b.holdUntil > now || pointDistance(a.wander??a, b.wander??b) > 1.55 || now - (life.friendship[key]?.lastAt ?? -Infinity) < 180_000) continue
      const lines = residentConversation(a.id, b.id)
      life.actors[a.id] = { ...a, pose: 'greet', holdUntil: now + 8500, bubble: { text: lines[0], from: now, until: now + 5200 } }
      life.actors[b.id] = { ...b, pose: 'greet', holdUntil: now + 8500, bubble: { text: lines[1], from: now + 2800, until: now + 8500 } }
      life.friendship[key] = { points: Math.min(9999, (life.friendship[key]?.points ?? 0) + 1), lastAt: now }
      life.nextChat = now + 38_000
      addJournal(life, `${residentSpec(a.id).name} 和 ${residentSpec(b.id).name} 碰面聊了几句。`)
      break outer
    }
  }
  return life
}

function browserStorage(): ResidentStorage | undefined { try { return globalThis.localStorage } catch { return undefined } }
export function createResidentStore(storage = browserStorage(), now = Date.now()) {
  let life: ResidentLife
  try { life = loadResidentLife(storage?.getItem(RESIDENT_STORAGE_KEY) ?? null, now) } catch { life = newResidentLife(now) }
  const listeners = new Set<() => void>()
  let world: ResidentWorld | undefined
  let lastSave = now
  const save = () => { try { storage?.setItem(RESIDENT_STORAGE_KEY, serializeResidentLife(life)); lastSave = life.now } catch { /* 存储禁用时仍可在本次打开的小镇里生活。 */ } }
  const publish = (next: ResidentLife, persist = false) => { life = next; if (persist || life.now - lastSave > 10_000) save(); for (const fn of listeners) fn() }
  return {
    getSnapshot: () => life,
    subscribe: (fn: () => void) => { listeners.add(fn); return () => { listeners.delete(fn) } },
    save,
    tick: (at: number) => publish(tickResidentLife(life, at, world)),
    setWorld: (value: ResidentWorld | undefined) => { world = value },
    resetClock: (at: number) => { life = { ...life, now: at } },
    configure: (key: 'enabled' | 'quiet' | 'paused' | 'autoVisit', value: boolean) => publish({ ...life, [key]: value, now: Date.now() }, true),
    visit: (id: ResidentId, projectId: string, at = Date.now()) => {
      const destination = world?.destinations.find((d) => d.id === projectId), a = life.actors[id]
      if (!life.enabled || !world || !destination || a.trip) return false
      const next = { ...life, now: at, nextVisitAt: at + 120_000, actors: { ...life.actors, [id]: { ...a, mode: 'roam', route: [], pose: 'idle', bubble: undefined, holdUntil: 0, wander: undefined, trip: startResidentTrip(id, a, world, destination, a.wander) } } } as ResidentLife
      addJournal(next, `${residentSpec(id).name} 出门去「${destination.name}」串门。`); publish(next, true); return true
    },
    pat: (id: ResidentId, at = Date.now()) => {
      const actor = life.actors[id], next = { ...life, now: at, actors: { ...life.actors, [id]: { ...actor, pose: 'pat', pats: actor.pats + 1, holdUntil: at + 4500, bubble: { text: residentSpec(id).pat, from: at, until: at + 4500 } } } } as ResidentLife
      addJournal(next, `你摸了摸 ${residentSpec(id).name} 的头。`); publish(next, true)
    },
    go: (id: ResidentId, home: boolean, at = Date.now()) => {
      if (life.actors[id].trip) {
        const a = life.actors[id]
        publish({ ...life, now: at, actors: { ...life.actors, [id]: { ...a, pose: 'idle', bubble: undefined, holdUntil: 0, trip: returnResidentTrip(a.trip!, id, home, world) } } }, true)
        return
      }
      if (life.actors[id].wander && world?.roads) {
        const actor=life.actors[id]
        const wander=home?returnResidentWander(actor.wander!,id,world):nextResidentWander(id,actor,world,at,actor.wander)
        publish({...life,now:at,actors:{...life.actors,[id]:{...actor,wander,pose:'idle',bubble:undefined,holdUntil:0,nextAt:at}}},true)
        return
      }
      const a = travel(life.actors[id], home ? 'home' : residentSpec(id).favorite, at, home ? 'home' : 'roam')
      if (!a.route.length) { a.pose = home ? 'sleep' : 'activity'; a.nextAt = at + 20_000 }
      publish({ ...life, now: at, actors: { ...life.actors, [id]: a } }, true)
    },
    gather: (at = Date.now()) => {
      const actors = { ...life.actors }
      RESIDENT_IDS.forEach((id, i) => {
        if (actors[id].trip) { actors[id] = { ...actors[id], trip: { ...returnResidentTrip(actors[id].trip!, id, false, world), returnTarget: 'tea' } }; return }
        if (actors[id].wander && world?.roads) { actors[id]={...actors[id],wander:returnResidentWander(actors[id].wander!,id,world,'tea'),holdUntil:0,bubble:undefined}; return }
        const angle = i / 7 * Math.PI * 2; actors[id] = travel(actors[id], 'tea', at, 'roam', { x: 2.4 + Math.cos(angle) * 1.9, y: 6.4 + Math.sin(angle) * 1.65 })
      })
      const next = { ...life, now: at, actors, nextChat: at + 3000 }; addJournal(next, '你叫大家来树下喝下午茶。'); publish(next, true)
    },
    drop: (id: ResidentId, point: GardenPoint, at = Date.now()) => {
      if (life.actors[id].trip || life.actors[id].wander) return
      const p = gardenDrop(point), a = { ...life.actors[id], ...p, route: [], mode: 'roam' as const, pose: 'idle' as const, bubble: undefined, holdUntil: 0, nextAt: at + 20_000 }
      publish({ ...life, now: at, actors: { ...life.actors, [id]: a } }, true)
    },
  }
}
export type ResidentStore = ReturnType<typeof createResidentStore>
export function residentStatus(actor: ResidentActor): string {
  if (actor.pose === 'pat') return '被摸头，心情很好'
  if (actor.trip) return actor.trip.phase === 'inside' ? `在「${actor.trip.projectName}」屋里串门` : actor.trip.phase === 'returning' ? `从「${actor.trip.projectName}」回家` : `去「${actor.trip.projectName}」串门`
  if (actor.wander) return actor.wander.returnTarget ? actor.wander.returnTarget==='home'?'沿小路回家':'沿小路去喝茶' : actor.wander.path.length?'在小镇随意散步':'在路边歇一会儿'
  if (actor.route.length) return actor.mode === 'home' ? '正在回家' : `走去${GARDEN_SPOTS[actor.target].name}`
  if (actor.mode === 'home') return '在小屋休息'
  return actor.target === residentSpec(actor.id).favorite ? residentSpec(actor.id).activity : `在${GARDEN_SPOTS[actor.target].name}坐坐`
}
