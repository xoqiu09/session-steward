import { gardenRoute, GARDEN_SPOTS, homePoint, pointDistance, RESIDENT_IDS, type GardenPoint, type GardenSpot, type ResidentId } from './residents'
import { homeGate, homeGardenPoint, roadRoute } from './roadNetwork'
import { addPoint, cellOrigin, type ResidentWorld } from './residentTrips'

export interface ResidentWander extends GardenPoint {
  origin: GardenPoint
  path: GardenPoint[]
  seed: number
  previous?: GardenPoint
  returnTarget?: GardenSpot
}

// 每位居民独立的随机序列；存档后继续，不需要共享时钟或在渲染时掷骰子。
function random(seed:number):[number,number] {
  let next=seed|0
  next^=next<<13; next^=next>>>17; next^=next<<5
  return [next>>>0,(next>>>0)/4294967296]
}
export function wanderSeed(id:ResidentId,now:number) { return ((Math.floor(now) ^ ((RESIDENT_IDS.indexOf(id)+1)*0x9e3779b9))>>>0)||1 }
export function wanderPause(seed:number) { return 3000+(seed%5500) }

export function nextResidentWander(id:ResidentId,from:GardenPoint,world:ResidentWorld,now:number,before?:ResidentWander,occupied:GardenPoint[]=[]):ResidentWander|undefined {
  const graph=world.roads
  if (!graph?.nodes.length) return undefined
  const origin=cellOrigin(world.home), local=before?homeGardenPoint(before,world.home):from
  const at=before&&!local?before:homeGate(world.home)
  const [seed,choice]=random(before?.seed??wanderSeed(id,now))
  // 多在邻近街区散步，偶尔去远一点；不连着折返同一个路口，也尽量错开朋友的落脚点。
  const nearby=graph.nodes.filter((p,i)=> (graph.neighbors.get(i)?.length??0)>1 && pointDistance(at,p)>3 &&
    pointDistance(at,p)<(seed%5===0?60:27) && (!before?.previous||pointDistance(p,before.previous)>1) && occupied.every(other=>pointDistance(p,other)>1))
  const choices=nearby.length?nearby:graph.nodes.filter(p=>pointDistance(at,p)>3)
  if (!choices.length) return undefined
  const target=choices[Math.min(choices.length-1,Math.floor(choice*choices.length))]
  const route=roadRoute(graph,at,target)
  if (!route.length) return undefined
  const position=before?{x:before.x,y:before.y}:addPoint(origin,from)
  const prefix=local?gardenRoute(local,'square').map(p=>addPoint(origin,p)):[]
  return {...position,origin,path:[...prefix,...route],seed,previous:{x:at.x,y:at.y}}
}

export function returnResidentWander(walk:ResidentWander,id:ResidentId,world:ResidentWorld,target:GardenSpot='home'):ResidentWander {
  if (walk.returnTarget===target) return walk
  const local=homeGardenPoint(walk,world.home)
  if (local) return {...walk,path:gardenRoute(local,target,target==='home'?homePoint(id):GARDEN_SPOTS[target]).map(p=>addPoint(walk.origin,p)),returnTarget:target}
  const gate=homeGate(world.home)
  const road=world.roads?roadRoute(world.roads,walk,gate):[]
  const end=target==='home'?homePoint(id):GARDEN_SPOTS[target]
  const garden=gardenRoute(GARDEN_SPOTS.square,target,end).map(p=>addPoint(walk.origin,p))
  return {...walk,path:[...road,...garden],returnTarget:target}
}

export function tickResidentWander(before:ResidentWander,dt:number):{walk:ResidentWander;facing?:1|-1} {
  const walk={...before,path:[...before.path]}
  let remaining=dt*1.25, facing:1|-1|undefined
  while (remaining>0&&walk.path.length) {
    const to=walk.path[0], distance=pointDistance(walk,to)
    if (distance>.001) facing=(to.x-walk.x)-(to.y-walk.y)<0?-1:1
    if (distance<=remaining) { walk.x=to.x; walk.y=to.y; walk.path.shift(); remaining-=distance }
    else { walk.x+=(to.x-walk.x)*remaining/distance; walk.y+=(to.y-walk.y)*remaining/distance; remaining=0 }
  }
  return {walk,facing}
}

export function readResidentWander(raw:unknown):ResidentWander|undefined {
  if (!raw||typeof raw!=='object') return undefined
  const r=raw as ResidentWander
  const point=(p:GardenPoint)=>p&&Number.isFinite(p.x)&&Number.isFinite(p.y)&&Math.abs(p.x)<100_000&&Math.abs(p.y)<100_000
  if (!point(r)||!point(r.origin)||!Array.isArray(r.path)||r.path.length>1200||!r.path.every(point)||
    !Number.isSafeInteger(r.seed)||r.seed<=0||r.seed>4294967295||r.previous&&!point(r.previous)||
    r.returnTarget!==undefined&&!Object.hasOwn(GARDEN_SPOTS,r.returnTarget)) return undefined
  return {x:r.x,y:r.y,origin:{...r.origin},path:r.path.map(p=>({...p})),seed:r.seed,
    ...(r.previous?{previous:{...r.previous}}:{}),...(r.returnTarget?{returnTarget:r.returnTarget}:{})}
}
