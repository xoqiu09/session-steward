import { describe, expect, it } from 'vitest'
import { buildTown } from './townModel'
import { demoSnapshot } from './fixtures'
import { newWorldMemo, stableLayout } from './world'
import { buildRoadGraph, homeGardenPoint, roadRoute, worldRoads } from './roadNetwork'
import { createResidentStore, loadResidentLife, newResidentLife, serializeResidentLife, tickResidentLife } from './residentLife'
import { RESIDENT_IDS, homePoint, pointDistance } from './residents'
import { residentWorld } from './residentTrips'
import { readResidentWander } from './residentWander'

const now=100_000
const layout=stableLayout(buildTown(demoSnapshot).buildings,()=>false,undefined,newWorldMemo(),b=>b.key,true)
const world=residentWorld(layout)!
const storage=()=>{ const values=new Map<string,string>(); return {getItem:(k:string)=>values.get(k)??null,setItem:(k:string,v:string)=>{values.set(k,v)}} }
const advance=(life:ReturnType<typeof newResidentLife>,ms:number)=> {
  for (let at=life.now+500, end=life.now+ms;at<=end;at+=500) life=tickResidentLife(life,at,world)
  return life
}
const onRoad=(p:{x:number;y:number})=>worldRoads(layout).some(s=>
  Math.abs(s.from.x-s.to.x)<.001 ? Math.abs(p.x-s.from.x)<.001&&p.y>=s.from.y-.001&&p.y<=s.to.y+.001
    : Math.abs(p.y-s.from.y)<.001&&p.x>=s.from.x-.001&&p.x<=s.to.x+.001)

describe('居民沿共用道路自由漫步',()=> {
  it('交叉口真正连通，转弯和从路段中间回去都有连续路面',()=> {
    const graph=buildRoadGraph([
      {from:{x:-10,y:0},to:{x:10,y:0},kind:'street'},
      {from:{x:0,y:-10},to:{x:0,y:10},kind:'street'},
    ])
    expect(graph.neighbors.get(graph.nodes.findIndex(p=>p.x===0&&p.y===0))).toHaveLength(4)
    const route=roadRoute(graph,{x:-3,y:0},{x:0,y:7})
    expect(route).toContainEqual({x:0,y:0})
    expect(route.at(-1)).toEqual({x:0,y:7})
    for(let i=1;i<route.length;i++) expect(route[i].x===route[i-1].x||route[i].y===route[i-1].y).toBe(true)
  })

  it('七只可以同时散步，选不同路口，多分钟行走不穿房屋、不跳出道路',()=> {
    let life={...newResidentLife(now),autoVisit:false,quiet:true}
    const targets=new Set<string>(), outside=new Set<string>()
    for(let at=now+500;at<=now+240_000;at+=500) {
      const before=life; life=tickResidentLife(life,at,world)
      for(const id of RESIDENT_IDS) {
        const walk=life.actors[id].wander, old=before.actors[id].wander
        if (!walk) continue
        if (old) expect(pointDistance(old,walk)).toBeLessThanOrEqual(.626)
        const target=walk.path.at(-1)
        if(target) targets.add(`${target.x.toFixed(2)},${target.y.toFixed(2)}`)
        expect(!!homeGardenPoint(walk,world.home)||onRoad(walk)).toBe(true)
        if(!homeGardenPoint(walk,world.home)) outside.add(id)
      }
    }
    expect(RESIDENT_IDS.every(id=>!!life.actors[id].wander)).toBe(true)
    expect(outside.size).toBe(7)
    expect(targets.size).toBeGreaterThan(8)
    expect(life.journal.some(j=>j.text.includes('串门'))).toBe(false)
  })

  it('暂停、隐藏和手动回家意图优先，不因为随机散步再次出门',()=> {
    let life=advance({...newResidentLife(now),autoVisit:false},65_000)
    const before=life.actors.gpt.wander!
    expect(before).toBeDefined()
    const paused=tickResidentLife({...life,paused:true},life.now+500,world)
    expect(paused.actors.gpt.wander).toEqual(before)
    const hidden=tickResidentLife({...life,enabled:false},life.now+500,world)
    expect(hidden.actors.gpt.wander).toEqual(before)
    const store=createResidentStore(storage(),now); store.setWorld(world)
    for(let at=now+500;at<=now+65_000;at+=500)store.tick(at)
    store.go('gpt',true,now+65_000)
    for(let at=now+65_500;at<=now+240_000;at+=500)store.tick(at)
    expect(store.getSnapshot().actors.gpt).toMatchObject({...homePoint('gpt'),mode:'home',pose:'sleep',wander:undefined})
    life=advance({...life,paused:true},1000)
    expect(life.actors.gpt.wander).toEqual(before)
  })

  it('漫步记录刷新保持坐标，睡眠八小时最多前进一秒，坏记录不影响七位居民',()=> {
    const life=advance({...newResidentLife(now),autoVisit:false},60_000)
    const saved=serializeResidentLife(life), back=loadResidentLife(saved,now+8*3600_000)
    expect(back.actors.claude.wander).toEqual(life.actors.claude.wander)
    const next=tickResidentLife(back,back.now+8*3600_000,world)
    expect(pointDistance(back.actors.claude.wander!,next.actors.claude.wander!)).toBeLessThanOrEqual(1.251)
    expect(readResidentWander({...life.actors.claude.wander,path:[{x:Infinity,y:0}]})).toBeUndefined()
    const corrupt=JSON.parse(saved); corrupt.actors.gpt.wander={seed:0}
    expect(Object.keys(loadResidentLife(JSON.stringify(corrupt),now).actors)).toEqual([...RESIDENT_IDS])
  })

  it('散步途中改去串门保留当前位置，能进屋并沿道路回家',()=> {
    const store=createResidentStore(storage(),now); store.setWorld(world)
    for(let at=now+500;at<=now+55_000;at+=500) store.tick(at)
    const from=store.getSnapshot().actors.qwen.wander!
    expect(from).toBeDefined()
    expect(store.visit('qwen',world.destinations[0].id,now+55_000)).toBe(true)
    expect(pointDistance(from,store.getSnapshot().actors.qwen.trip!)).toBe(0)
    expect(store.getSnapshot().actors.qwen.wander).toBeUndefined()
    let entered=false
    for(let at=now+55_500;at<=now+250_000;at+=500) {
      store.tick(at)
      if(store.getSnapshot().actors.qwen.trip?.phase==='inside') { entered=true; store.go('qwen',true,at) }
    }
    expect(entered).toBe(true)
    expect(store.getSnapshot().actors.qwen).toMatchObject({mode:'home',trip:undefined,wander:undefined})
  })
})
